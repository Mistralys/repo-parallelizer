import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
    RepositoryInfoSyncOrchestrator,
    SyncPreconditionError,
    PendingChangesError,
    RemoteOperationError,
    buildDefaultInfoCommitMessage,
    describeInfoChangeAreas,
} from '../orchestration/repository-info-sync.js';
import { resolveMainFolderPath } from '../orchestration/repository-main-folder.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { RepositoryFileManager } from '../models/repository/repository-file.manager.js';
import { ErrorLogManager } from '../error-log/error-log.manager.js';
import { NotFoundError } from '../errors.js';
import { makeTestConfig } from './test-helpers.js';
import { INFO_COMMIT_AUTHOR_EMAIL, INFO_COMMIT_AUTHOR_NAME } from '../config/config.constants.js';
import { REPOSITORY_FILE_MAX_COUNT } from '../models/repository/repository-file.js';

// ─── Fixture setup ────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-info-sync-test-'));

process.on('exit', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function git(args: string, cwd: string): string {
    return execSync(`git ${args}`, { cwd }).toString().trim();
}

let originCounter = 0;

/**
 * Creates a fresh "origin" repository with one commit on `main`. When
 * `infoJson` is `null`, the commit has no `.workspace/` folder at all. When
 * omitted, a sensible default payload is written. Pass an explicit object to
 * control the committed content (e.g. a mismatched `Id`, or a differing
 * `Name`/`Description`).
 */
function buildOrigin(options: { withFilter?: boolean; infoJson?: Record<string, unknown> | null; repoId?: string } = {}): string {
    const { withFilter = true, infoJson, repoId = 'repo' } = options;
    const originPath = path.join(tmpDir, `origin-${++originCounter}`);
    fs.mkdirSync(originPath);
    git('init -q -b main', originPath);
    git('config user.email "origin@test.local"', originPath);
    git('config user.name "Origin Author"', originPath);
    fs.writeFileSync(path.join(originPath, 'README.md'), 'hello');

    if (infoJson !== null) {
        fs.mkdirSync(path.join(originPath, '.workspace'), { recursive: true });
        const payload = infoJson ?? {
            SchemaVersion: 1,
            Id: repoId,
            Name: 'Upstream Name',
            Url: 'https://example.invalid/upstream.git',
            Description: 'Upstream description',
            Settings: {},
        };
        fs.writeFileSync(
            path.join(originPath, '.workspace', 'info.json'),
            `${JSON.stringify(payload, null, 4)}\n`,
        );
    }

    git('add .', originPath);
    git('commit -q -m initial', originPath);
    if (withFilter) {
        git('config uploadpack.allowFilter true', originPath);
    }
    // These origins are plain (non-bare) working copies checked out on
    // "main", and commitAndPush() pushes straight to that branch. Without
    // this, git refuses the push ("refusing to update checked out branch").
    // updateInstead additionally keeps origin's own working tree in sync
    // with what was pushed, which `git log`/`git show` assertions rely on.
    git('config receive.denyCurrentBranch updateInstead', originPath);
    return originPath;
}

/**
 * Lands the repository's first sync write upstream via `commitAndPush()`, so
 * a subsequent simulated upstream change (via {@link commitInfoJsonChange} or
 * {@link commitInfoJsonDeletion}) starts from a clean, already-synced
 * baseline rather than racing the still-uncommitted initial write.
 */
async function landInitialSync(orchestrator: RepositoryInfoSyncOrchestrator, repoId: string): Promise<void> {
    await orchestrator.commitAndPush(repoId);
}

/** Creates a fresh, empty "origin" repository (no commits, no branches). */
function buildEmptyOrigin(): string {
    const originPath = path.join(tmpDir, `origin-empty-${++originCounter}`);
    fs.mkdirSync(originPath);
    git('init -q -b main', originPath);
    return originPath;
}

/** Simulates an upstream change: writes, stages and commits a new `.workspace/info.json` directly in `originPath`. */
function commitInfoJsonChange(originPath: string, payload: Record<string, unknown>): void {
    fs.mkdirSync(path.join(originPath, '.workspace'), { recursive: true });
    fs.writeFileSync(
        path.join(originPath, '.workspace', 'info.json'),
        `${JSON.stringify(payload, null, 4)}\n`,
    );
    git('add .workspace/info.json', originPath);
    git('commit -q -m "upstream update"', originPath);
}

/** Simulates an upstream deletion of `.workspace/info.json`. */
function commitInfoJsonDeletion(originPath: string): void {
    git('rm -q .workspace/info.json', originPath);
    git('commit -q -m "upstream delete"', originPath);
}

/** Simulates a teammate committing a file directly under `.workspace/files/` in `originPath`. */
function commitFilesFolderChange(originPath: string, relPath: string, content: string | Buffer): void {
    const target = path.join(originPath, '.workspace', 'files', ...relPath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    git('add .workspace/files', originPath);
    git('commit -q -m "upstream file change"', originPath);
}

/** Simulates a teammate removing a file directly under `.workspace/files/` in `originPath`. */
function commitFilesFolderRemoval(originPath: string, relPath: string): void {
    git(`rm -q .workspace/files/${relPath}`, originPath);
    git('commit -q -m "upstream file removal"', originPath);
}

let repoCounter = 0;
function nextRepoId(): string {
    return `repo-${++repoCounter}`;
}

interface Harness {
    repositoryManager: RepositoryManager;
    repositoryFileManager: RepositoryFileManager;
    errorLogManager: ErrorLogManager;
    orchestrator: RepositoryInfoSyncOrchestrator;
    config: ReturnType<typeof makeTestConfig>;
}

function makeHarness(): Harness {
    const base = fs.mkdtempSync(path.join(tmpDir, 'case-'));
    const config = makeTestConfig(base);
    const repositoryManager = new RepositoryManager(config);
    const repositoryFileManager = new RepositoryFileManager(config, repositoryManager);
    const errorLogManager = new ErrorLogManager(config);
    const orchestrator = new RepositoryInfoSyncOrchestrator(config, repositoryManager, repositoryFileManager, errorLogManager);
    return { repositoryManager, repositoryFileManager, errorLogManager, orchestrator, config };
}

function readManagedInfoJson(config: ReturnType<typeof makeTestConfig>, repoId: string): Record<string, unknown> {
    const mainFolder = resolveMainFolderPath(config, repoId);
    const raw = fs.readFileSync(path.join(mainFolder, '.workspace', 'info.json'), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
}

/** Absolute path to a repository's `repository-files/{repoId}.json` store file. */
function fileStorePath(config: ReturnType<typeof makeTestConfig>, repoId: string): string {
    return path.join(config.storageFolder, 'repository-files', `${repoId}.json`);
}

/**
 * Writes a repository's file store directly, bypassing `RepositoryFileManager`
 * (and therefore `validateRepositoryFileSet()`) entirely — simulates a legacy
 * row written by M2's unvalidated `replaceAll()` before WP-001 added
 * validation there.
 */
function seedLegacyFileStore(
    config: ReturnType<typeof makeTestConfig>,
    repoId: string,
    files: Array<Record<string, unknown>>,
): void {
    const storePath = fileStorePath(config, repoId);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, `${JSON.stringify({ SchemaVersion: 1, Files: files }, null, 4)}\n`);
}

// ─── buildDefaultInfoCommitMessage() ──────────────────────────────────────────

test('buildDefaultInfoCommitMessage() includes the repository ID and stays short', () => {
    const message = buildDefaultInfoCommitMessage('my-repo');
    assert.ok(message.includes('my-repo'));
    assert.ok(message.length <= 500);
});

test('buildDefaultInfoCommitMessage() with no pending changes is byte-identical to M1\'s message', () => {
    assert.equal(buildDefaultInfoCommitMessage('my-repo'), 'Update .workspace for "my-repo" via Paralizer');
    assert.equal(buildDefaultInfoCommitMessage('my-repo', []), 'Update .workspace for "my-repo" via Paralizer');
});

test('buildDefaultInfoCommitMessage() appends the changed areas in parentheses, in info.json/README/files order', () => {
    const message = buildDefaultInfoCommitMessage('my-repo', [
        '.workspace/files/build.sh',
        '.workspace/README.md',
        '.workspace/info.json',
    ]);
    assert.equal(message, 'Update .workspace for "my-repo" via Paralizer (info.json, README, files)');
});

test('describeInfoChangeAreas() maps .workspace/info.json, .workspace/README.md and any .workspace/files/* path, with no duplicates', () => {
    assert.deepEqual(describeInfoChangeAreas([]), []);
    assert.deepEqual(describeInfoChangeAreas(['.workspace/info.json']), ['info.json']);
    assert.deepEqual(describeInfoChangeAreas(['.workspace/README.md']), ['README']);
    assert.deepEqual(describeInfoChangeAreas(['.workspace/files/a.sh', '.workspace/files/sub/b.sh']), ['files']);
    assert.deepEqual(
        describeInfoChangeAreas(['.workspace/info.json', '.workspace/README.md', '.workspace/files/a.sh']),
        ['info.json', 'README', 'files'],
    );
});

test('getStatus()\'s defaultCommitMessage reflects pending file changes', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await landInitialSync(orchestrator, repoId);

    const statusBefore = await orchestrator.getStatus(repoId);
    assert.equal(statusBefore.defaultCommitMessage, `Update .workspace for "${repoId}" via Paralizer`);

    repositoryFileManager.add(repoId, {
        Directory: '', FileName: 'build.sh', Label: 'Build', Description: '', Content: 'echo hi\n', Executable: false, ListInAgents: false,
    });
    orchestrator.syncRepository(repoId);

    const statusAfter = await orchestrator.getStatus(repoId);
    // Adding a file also changes the synced payload hash, so info.json is
    // rewritten alongside the new file under files/.
    assert.equal(statusAfter.defaultCommitMessage, `Update .workspace for "${repoId}" via Paralizer (info.json, files)`);
});

// ─── syncRepository() — disabled / unavailable short-circuits ───────────────

test('syncRepository() returns state "disabled" without touching the filesystem when info sync is not enabled', () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const repo = repositoryManager.add({ id: nextRepoId(), url: 'https://example.invalid/repo.git' });

    const result = orchestrator.syncRepository(repo.Id);

    assert.deepStrictEqual(result, { state: 'disabled', written: false });
});

test('syncRepository() returns state "main-folder-unavailable" when enabled but the managed clone does not exist', () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const repo = repositoryManager.add({ id: nextRepoId(), url: 'https://example.invalid/repo.git' });
    repositoryManager.setInfoSyncSettings(repo.Id, { Enabled: true });

    const result = orchestrator.syncRepository(repo.Id);

    assert.deepStrictEqual(result, { state: 'main-folder-unavailable', written: false });
});

// ─── saveSettings(): enabling (AC-03, AC-07b, AC-17b) ────────────────────────

test('saveSettings({enabled: true}) on a repository with no .workspace/ folder creates the file on first sync, with no health issue for the absence', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'My Repo', description: 'A description' });

    const status = await orchestrator.saveSettings(repo.Id, { enabled: true });

    // saveSettings() runs syncRepository() (which performs the write and
    // records the baseline) before returning getStatus() — by the time the
    // status is read back, the just-written file already matches the
    // baseline, so the settled state is "in-sync", not "write-required".
    assert.strictEqual(status.state, 'in-sync');
    // The freshly created file is itself an (expected) pending change to
    // commit — but its mere absence before this sync must never have raised
    // a health issue of its own (there is no "info-sync-file-missing" type).
    assert.ok(
        status.health.issues.every((i) => i.type === 'info-sync-pending-changes'),
        `unexpected health issue(s): ${JSON.stringify(status.health.issues)}`,
    );
    const written = readManagedInfoJson(config, repoId);
    assert.strictEqual(written['Id'], repoId);
    assert.strictEqual(written['Name'], 'My Repo');
    assert.strictEqual(written['Description'], 'A description');

    const updatedRepo = repositoryManager.getById(repoId)!;
    assert.strictEqual(updatedRepo.InfoSync?.Enabled, true);
    assert.ok(updatedRepo.InfoSync?.LastWrittenHash, 'a baseline hash should have been recorded');
});

test('saveSettings({enabled: true}) against a repository whose upstream .workspace/info.json already differs results in state "conflict" with an info-sync-conflict issue and no write (AC-17b)', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const repoId = nextRepoId();
    const originPath = buildOrigin({
        repoId,
        infoJson: { SchemaVersion: 1, Id: repoId, Name: 'Colleague Name', Url: 'https://example.invalid/x.git', Description: 'Colleague description', Settings: {} },
    });
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'My Local Name', description: 'My local description' });

    const status = await orchestrator.saveSettings(repo.Id, { enabled: true });

    assert.strictEqual(status.state, 'conflict');
    assert.ok(status.health.issues.some((i) => i.type === 'info-sync-conflict' && i.fixAction === 'import'));

    const onDisk = readManagedInfoJson(config, repoId);
    assert.strictEqual(onDisk['Name'], 'Colleague Name', 'the conflicting file must not have been overwritten');

    const updatedRepo = repositoryManager.getById(repoId)!;
    assert.strictEqual(updatedRepo.InfoSync?.LastWrittenHash, undefined, 'no baseline should be recorded for an unresolved conflict');
});

test('saveSettings({enabled: true}) against an empty remote throws SyncPreconditionError and persists no InfoSync setting or folder', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildEmptyOrigin();
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });

    await assert.rejects(
        () => orchestrator.saveSettings(repo.Id, { enabled: true }),
        SyncPreconditionError,
    );

    assert.strictEqual(repositoryManager.getById(repoId)!.InfoSync, undefined);
    assert.ok(!fs.existsSync(resolveMainFolderPath(config, repoId)));
});

test('saveSettings({enabled: true}) flags filterFallback when the server does not support partial-clone filtering', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ withFilter: false, infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });

    const status = await orchestrator.saveSettings(repo.Id, { enabled: true });

    // See the note in the preceding test: the settled state after
    // saveSettings() is "in-sync" because the write already landed.
    assert.strictEqual(status.state, 'in-sync');
    // The health report itself doesn't carry filterFallback, but the sync must
    // still have succeeded via a full clone rather than failing outright.
    assert.ok(status.mainFolder?.isGitRepository);
    assert.strictEqual(status.filterFallback, true);
});

test('saveSettings({enabled: true}) omits filterFallback when the server supports partial-clone filtering', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });

    const status = await orchestrator.saveSettings(repo.Id, { enabled: true });

    assert.strictEqual(status.filterFallback, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(status, 'filterFallback'));
});

test('saveSettings({enabled: false}) omits filterFallback (no clone/fetch performed)', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const status = await orchestrator.saveSettings(repoId, { enabled: false, discardPendingChanges: true });

    assert.strictEqual(status.filterFallback, undefined);
});

test('getStatus() never includes filterFallback', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ withFilter: false, infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const status = await orchestrator.getStatus(repoId);

    assert.ok(!Object.prototype.hasOwnProperty.call(status, 'filterFallback'));
});

// ─── syncRepository(): decision table (AC-02b, AC-07, AC-07b) ────────────────

test('a local description edit is written silently (write-required, no health issue)', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    repositoryManager.update(repoId, { name: repo.Name, description: 'An updated description' });
    const result = orchestrator.syncRepository(repoId);

    assert.strictEqual(result.state, 'write-required');
    assert.strictEqual(result.written, true);
    assert.strictEqual(readManagedInfoJson(config, repoId)['Description'], 'An updated description');
});

test('a file deleted upstream after an earlier sync is recreated silently on the next sync and shows as a pending change (AC-07b)', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'My Repo' });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    // Land the just-synced file upstream so the subsequent deletion has something to remove.
    await landInitialSync(orchestrator, repoId);
    const mainFolder = resolveMainFolderPath(config, repoId);

    commitInfoJsonDeletion(originPath);

    const status = await orchestrator.refresh(repoId);

    // refresh() runs syncRepository() (which recreates the file) before
    // returning getStatus(); by the time the status is read back, the
    // recreated file already matches the baseline, so the settled state is
    // "in-sync" — the recreation itself shows up as a pending change instead.
    assert.strictEqual(status.state, 'in-sync');
    assert.ok(fs.existsSync(path.join(mainFolder, '.workspace', 'info.json')), 'the file should have been recreated');
    assert.ok(status.pendingChanges.length > 0, 'the recreated file should show as a pending change');
});

test('refresh() flags filterFallback when the server stops supporting partial-clone filtering between enable and refresh', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    // Disable partial-clone filter support on the "server" and make an
    // upstream change so refresh() actually performs a fetch.
    git('config uploadpack.allowFilter false', originPath);
    commitInfoJsonChange(originPath, {
        SchemaVersion: 1, Id: repoId, Name: 'Changed Upstream', Url: 'https://example.invalid/x.git', Description: 'desc', Settings: {},
    });

    const status = await orchestrator.refresh(repoId);

    assert.strictEqual(status.filterFallback, true);
});

test('refresh() omits filterFallback when the server supports partial-clone filtering', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const status = await orchestrator.refresh(repoId);

    assert.strictEqual(status.filterFallback, undefined);
});

test('an incoming-only change yields state "incoming" with an info-sync-import-available issue and no write', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'My Repo', description: 'desc' });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await landInitialSync(orchestrator, repoId);
    const beforeHash = repositoryManager.getById(repoId)!.InfoSync?.LastWrittenHash;

    commitInfoJsonChange(originPath, {
        SchemaVersion: 1, Id: repoId, Name: 'Changed Upstream', Url: 'https://example.invalid/x.git', Description: 'desc', Settings: {},
    });

    const status = await orchestrator.refresh(repoId);

    assert.strictEqual(status.state, 'incoming');
    assert.ok(status.health.issues.some((i) => i.type === 'info-sync-import-available' && i.fixAction === 'import'));
    assert.strictEqual(repositoryManager.getById(repoId)!.InfoSync?.LastWrittenHash, beforeHash, 'baseline must not change for an incoming state');
});

test('changing both sides yields state "conflict" and no write', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'My Repo', description: 'desc' });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await landInitialSync(orchestrator, repoId);

    commitInfoJsonChange(originPath, {
        SchemaVersion: 1, Id: repoId, Name: 'Changed Upstream', Url: 'https://example.invalid/x.git', Description: 'desc', Settings: {},
    });
    repositoryManager.update(repoId, { name: repo.Name, description: 'Changed locally too' });

    const status = await orchestrator.refresh(repoId);

    assert.strictEqual(status.state, 'conflict');
    assert.ok(status.health.issues.some((i) => i.type === 'info-sync-conflict'));
});

test('a file whose only upstream change is Url evaluates as in-sync (no write, no pending change); a later local description edit still writes the local Url', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'My Repo', description: 'desc' });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await landInitialSync(orchestrator, repoId);
    const beforeHash = repositoryManager.getById(repoId)!.InfoSync?.LastWrittenHash;

    commitInfoJsonChange(originPath, {
        SchemaVersion: 1, Id: repoId, Name: 'My Repo', Url: 'https://example.invalid/some-other-form.git', Description: 'desc', Settings: {},
    });

    const status = await orchestrator.refresh(repoId);

    assert.strictEqual(status.state, 'in-sync');
    assert.deepStrictEqual(status.pendingChanges, []);
    assert.strictEqual(repositoryManager.getById(repoId)!.InfoSync?.LastWrittenHash, beforeHash);
    assert.strictEqual(readManagedInfoJson(config, repoId)['Url'], 'https://example.invalid/some-other-form.git');

    repositoryManager.update(repoId, { name: repo.Name, description: 'A new local description' });
    const syncResult = orchestrator.syncRepository(repoId);

    assert.strictEqual(syncResult.state, 'write-required');
    assert.strictEqual(readManagedInfoJson(config, repoId)['Url'], `file://${originPath}`);
});

// ─── getImportPreview() / applyImport() (AC-10) ──────────────────────────────

test('getImportPreview() lists only the differing fields and applyImport() applies the selection, resolves to in-sync, writes an audit entry, and never touches Url/CredentialId', async () => {
    const { repositoryManager, orchestrator, errorLogManager, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'Local Name', description: 'Local description' });
    repositoryManager.updateCredential(repoId, 'some-credential');
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await landInitialSync(orchestrator, repoId);

    commitInfoJsonChange(originPath, {
        SchemaVersion: 1, Id: repoId, Name: 'Upstream Name', Url: 'https://example.invalid/upstream-form.git', Description: 'Local description', Settings: {},
    });
    await orchestrator.refresh(repoId);

    const preview = await orchestrator.getImportPreview(repoId);
    assert.strictEqual(preview.state, 'incoming');
    assert.deepStrictEqual(preview.fields, [{ field: 'Name', current: 'Local Name', incoming: 'Upstream Name' }]);
    assert.deepStrictEqual(preview.files, []);

    const status = await orchestrator.applyImport(repoId, { fields: ['Name'] });

    assert.strictEqual(status.state, 'in-sync');
    const updatedRepo = repositoryManager.getById(repoId)!;
    assert.strictEqual(updatedRepo.Name, 'Upstream Name');
    assert.strictEqual(updatedRepo.Description, 'Local description');
    assert.strictEqual(updatedRepo.Url, `file://${originPath}`, 'Url must be untouched by import');
    assert.strictEqual(updatedRepo.CredentialId, 'some-credential', 'CredentialId must be untouched by import');

    const auditEntries = errorLogManager.list({ source: 'workspace-info' }).entries.filter((e) => e.Operation === 'import');
    assert.strictEqual(auditEntries.length, 1);
    assert.strictEqual(auditEntries[0]!.Severity, 'audit');
});

test('applyImport() with an empty field selection keeps all local values, rewrites the file and resolves to in-sync', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'Local Name', description: 'Local description' });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await landInitialSync(orchestrator, repoId);

    commitInfoJsonChange(originPath, {
        SchemaVersion: 1, Id: repoId, Name: 'Upstream Name', Url: 'https://example.invalid/upstream.git', Description: 'Upstream description', Settings: {},
    });
    await orchestrator.refresh(repoId);

    const status = await orchestrator.applyImport(repoId, { fields: [] });

    assert.strictEqual(status.state, 'in-sync');
    assert.strictEqual(repositoryManager.getById(repoId)!.Name, 'Local Name');
    assert.strictEqual(readManagedInfoJson(config, repoId)['Name'], 'Local Name');
});

test('getImportPreview() throws SyncPreconditionError when the state is not incoming/conflict', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    await assert.rejects(() => orchestrator.getImportPreview(repoId), SyncPreconditionError);
});

// ─── getImportPreview() / applyImport(): per-file actions (Milestone 2) ─────

test('applyImport() "add" imports a teammate-added incoming-only file into local data, keeps it in the managed clone, resolves to in-sync, and the audit entry lists the action', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, errorLogManager, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await landInitialSync(orchestrator, repoId);

    commitFilesFolderChange(originPath, 'build.sh', '#!/bin/sh\necho build\n');
    await orchestrator.refresh(repoId);

    const preview = await orchestrator.getImportPreview(repoId);
    assert.deepStrictEqual(preview.files, [{ path: 'build.sh', kind: 'incoming-only' }]);

    const status = await orchestrator.applyImport(repoId, { fields: [], files: [{ path: 'build.sh', action: 'add' }] });

    assert.strictEqual(status.state, 'in-sync');
    const files = repositoryFileManager.list(repoId);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0]!.FileName, 'build.sh');
    assert.strictEqual(files[0]!.Content, '#!/bin/sh\necho build\n');
    assert.strictEqual(files[0]!.Executable, true, 'a shebang file is heuristically executable');

    const mainFolder = resolveMainFolderPath(config, repoId);
    assert.ok(fs.existsSync(path.join(mainFolder, '.workspace', 'files', 'build.sh')));

    const auditEntries = errorLogManager.list({ source: 'workspace-info' }).entries.filter((e) => e.Operation === 'import');
    assert.ok(auditEntries[0]!.Message.includes('add: build.sh'));
});

test('applyImport() defaults an omitted incoming-only file to "discard", removing it from the managed clone and not importing it', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, errorLogManager, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await landInitialSync(orchestrator, repoId);

    commitFilesFolderChange(originPath, 'build.sh', 'echo build\n');
    await orchestrator.refresh(repoId);

    const status = await orchestrator.applyImport(repoId, { fields: [] });

    assert.strictEqual(status.state, 'in-sync');
    assert.deepStrictEqual(repositoryFileManager.list(repoId), []);
    const mainFolder = resolveMainFolderPath(config, repoId);
    assert.ok(!fs.existsSync(path.join(mainFolder, '.workspace', 'files', 'build.sh')), 'the discarded file must be removed from the managed clone');

    const auditEntries = errorLogManager.list({ source: 'workspace-info' }).entries.filter((e) => e.Operation === 'import');
    assert.ok(auditEntries[0]!.Message.includes('discard: build.sh'));
});

test('applyImport() "overwrite" replaces a local file\'s content with a teammate\'s incoming change', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    const file = repositoryFileManager.add(repoId, {
        Directory: '', FileName: 'build.sh', Label: 'Build', Description: '', Content: 'echo old\n', Executable: false, ListInAgents: false,
    });
    orchestrator.syncRepository(repoId);
    await landInitialSync(orchestrator, repoId);

    commitFilesFolderChange(originPath, 'build.sh', 'echo new\n');
    await orchestrator.refresh(repoId);

    const preview = await orchestrator.getImportPreview(repoId);
    assert.strictEqual(preview.files.length, 1);
    assert.strictEqual(preview.files[0]!.kind, 'changed');

    const status = await orchestrator.applyImport(repoId, { fields: [], files: [{ path: 'build.sh', action: 'overwrite' }] });

    assert.strictEqual(status.state, 'in-sync');
    const updatedFiles = repositoryFileManager.list(repoId);
    assert.strictEqual(updatedFiles.length, 1);
    assert.strictEqual(updatedFiles[0]!.Id, file.Id, 'the file identity must be preserved across an overwrite');
    assert.strictEqual(updatedFiles[0]!.Content, 'echo new\n');
    const mainFolder = resolveMainFolderPath(config, repoId);
    assert.strictEqual(fs.readFileSync(path.join(mainFolder, '.workspace', 'files', 'build.sh'), 'utf8'), 'echo new\n');
});

test('applyImport() defaults an omitted "changed" file to "keep", rewriting the managed clone back to Paralizer\'s own content', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    repositoryFileManager.add(repoId, {
        Directory: '', FileName: 'build.sh', Label: 'Build', Description: '', Content: 'echo old\n', Executable: false, ListInAgents: false,
    });
    orchestrator.syncRepository(repoId);
    await landInitialSync(orchestrator, repoId);

    commitFilesFolderChange(originPath, 'build.sh', 'echo new\n');
    await orchestrator.refresh(repoId);

    const status = await orchestrator.applyImport(repoId, { fields: [] });

    assert.strictEqual(status.state, 'in-sync');
    assert.strictEqual(repositoryFileManager.list(repoId)[0]!.Content, 'echo old\n');
    const mainFolder = resolveMainFolderPath(config, repoId);
    assert.strictEqual(
        fs.readFileSync(path.join(mainFolder, '.workspace', 'files', 'build.sh'), 'utf8'),
        'echo old\n',
        'the managed clone must be rewritten with Paralizer\'s own content, overriding the teammate\'s change',
    );
});

test('applyImport() "delete" removes a local-only file (removed upstream, or not yet pulled)', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    repositoryFileManager.add(repoId, {
        Directory: '', FileName: 'build.sh', Label: 'Build', Description: '', Content: 'echo hi\n', Executable: false, ListInAgents: false,
    });
    orchestrator.syncRepository(repoId);
    await landInitialSync(orchestrator, repoId);

    commitFilesFolderRemoval(originPath, 'build.sh');
    await orchestrator.refresh(repoId);

    const preview = await orchestrator.getImportPreview(repoId);
    assert.deepStrictEqual(preview.files, [{ path: 'build.sh', kind: 'local-only' }]);

    const status = await orchestrator.applyImport(repoId, { fields: [], files: [{ path: 'build.sh', action: 'delete' }] });

    assert.strictEqual(status.state, 'in-sync');
    assert.deepStrictEqual(repositoryFileManager.list(repoId), []);
    const mainFolder = resolveMainFolderPath(config, repoId);
    assert.ok(!fs.existsSync(path.join(mainFolder, '.workspace', 'files', 'build.sh')), '"delete" must leave the file absent from the managed clone');
});

test('applyImport() defaults an omitted "local-only" file to "keep", restoring it in the managed clone', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    repositoryFileManager.add(repoId, {
        Directory: '', FileName: 'build.sh', Label: 'Build', Description: '', Content: 'echo hi\n', Executable: false, ListInAgents: false,
    });
    orchestrator.syncRepository(repoId);
    await landInitialSync(orchestrator, repoId);

    commitFilesFolderRemoval(originPath, 'build.sh');
    await orchestrator.refresh(repoId);

    const status = await orchestrator.applyImport(repoId, { fields: [] });

    assert.strictEqual(status.state, 'in-sync');
    assert.strictEqual(repositoryFileManager.list(repoId).length, 1);
    const mainFolder = resolveMainFolderPath(config, repoId);
    assert.ok(
        fs.existsSync(path.join(mainFolder, '.workspace', 'files', 'build.sh')),
        '"keep" must restore the file in the managed clone',
    );
});

test('applyImport() rejects an action not in the diff kind\'s action table', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await landInitialSync(orchestrator, repoId);

    commitFilesFolderChange(originPath, 'build.sh', 'echo hi\n');
    await orchestrator.refresh(repoId);

    await assert.rejects(
        () => orchestrator.applyImport(repoId, { fields: [], files: [{ path: 'build.sh', action: 'skip' as never }] }),
        /Unsupported import action/,
    );
});

test('applyImport() rejects a path that is not part of the current import diff', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await landInitialSync(orchestrator, repoId);

    commitFilesFolderChange(originPath, 'build.sh', 'echo hi\n');
    await orchestrator.refresh(repoId);

    await assert.rejects(
        () => orchestrator.applyImport(repoId, { fields: [], files: [{ path: 'does-not-exist.sh', action: 'discard' }] }),
        /not part of the current import diff/,
    );
});

test('applyImport() refuses "add" on a binary incoming-only file (a problem file); its default "discard" removes it from the managed clone', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await landInitialSync(orchestrator, repoId);

    commitFilesFolderChange(originPath, 'binary.dat', Buffer.from([0, 1, 2, 3]));
    await orchestrator.refresh(repoId);

    const preview = await orchestrator.getImportPreview(repoId);
    assert.strictEqual(preview.files.length, 1);
    assert.strictEqual(preview.files[0]!.kind, 'incoming-only');
    assert.ok(preview.files[0]!.problem);

    await assert.rejects(
        () => orchestrator.applyImport(repoId, { fields: [], files: [{ path: 'binary.dat', action: 'add' }] }),
        /cannot be imported as-is/,
    );

    const status = await orchestrator.applyImport(repoId, { fields: [] });
    assert.strictEqual(status.state, 'in-sync');
    assert.deepStrictEqual(repositoryFileManager.list(repoId), []);
    const mainFolder = resolveMainFolderPath(config, repoId);
    assert.ok(!fs.existsSync(path.join(mainFolder, '.workspace', 'files', 'binary.dat')));
});

// ─── applyImport(): atomic set validation (WP-004) ───────────────────────────

test('applyImport() atomically rejects a mutating import that would exceed the 64-file cap, leaving fields, the file store, the managed clone and the recorded hash all untouched (AC-05)', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'Local Name', description: 'Local description' });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    for (let i = 0; i < REPOSITORY_FILE_MAX_COUNT; i++) {
        repositoryFileManager.add(repoId, {
            Directory: '', FileName: `f${i}.txt`, Label: `L${i}`, Description: '', Content: `content ${i}\n`, Executable: false, ListInAgents: false,
        });
    }
    orchestrator.syncRepository(repoId);
    await landInitialSync(orchestrator, repoId);

    commitFilesFolderChange(originPath, 'extra.sh', 'echo extra\n');
    await orchestrator.refresh(repoId);

    const storePath = fileStorePath(config, repoId);
    const storeBefore = fs.readFileSync(storePath, 'utf8');
    const mainFolder = resolveMainFolderPath(config, repoId);
    const cloneFilesBefore = fs.readdirSync(path.join(mainFolder, '.workspace', 'files')).sort();
    const hashBefore = repositoryManager.getById(repoId)!.InfoSync!.LastWrittenHash;

    await assert.rejects(
        () => orchestrator.applyImport(repoId, { fields: [], files: [{ path: 'extra.sh', action: 'add' }] }),
        new RegExp(String(REPOSITORY_FILE_MAX_COUNT)),
    );

    const afterRepo = repositoryManager.getById(repoId)!;
    assert.strictEqual(afterRepo.Name, 'Local Name');
    assert.strictEqual(afterRepo.Description, 'Local description');
    assert.strictEqual(fs.readFileSync(storePath, 'utf8'), storeBefore, 'the file store must be byte-identical');
    assert.deepStrictEqual(
        fs.readdirSync(path.join(mainFolder, '.workspace', 'files')).sort(),
        cloneFilesBefore,
        'the managed clone\'s files/ folder must be untouched',
    );
    assert.strictEqual(afterRepo.InfoSync!.LastWrittenHash, hashBefore, 'the recorded hash must be untouched');
});

test('applyImport() refuses "add" on an incoming file whose declared Label exceeds the limit (a problem file, like the existing binary/path-segment cases)', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await landInitialSync(orchestrator, repoId);

    const overLongLabel = 'L'.repeat(200);
    commitFilesFolderChange(originPath, 'labeled.sh', 'echo hi\n');
    commitInfoJsonChange(originPath, {
        SchemaVersion: 1,
        Id: repoId,
        Name: 'Repo',
        Url: 'https://example.invalid/upstream.git',
        Description: '',
        Settings: {},
        Files: [{ Path: 'labeled.sh', Label: overLongLabel, Description: '', Executable: false, ListInAgents: false }],
    });
    await orchestrator.refresh(repoId);

    const preview = await orchestrator.getImportPreview(repoId);
    assert.strictEqual(preview.files.length, 1);
    assert.ok(preview.files[0]!.problem, 'an over-length Label must surface as a problem, like a binary or oversized file');

    await assert.rejects(
        () => orchestrator.applyImport(repoId, { fields: [], files: [{ path: 'labeled.sh', action: 'add' }] }),
        /cannot be imported as-is/,
    );
});

test('applyImport() skips replaceAll() and set validation for a field-only import, even when the store already holds a rule-breaking legacy file, but a mutating import on that same store fails and names the legacy file (AC-06, AC-14)', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'Local Name' });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const overLongLabel = 'L'.repeat(200);
    seedLegacyFileStore(config, repoId, [{
        Id: 'legacy-id',
        Directory: '',
        FileName: 'legacy.sh',
        Label: overLongLabel,
        Description: '',
        Content: 'echo legacy\n',
        Executable: false,
        ListInAgents: false,
        DateModified: '2026-01-01T00:00:00.000Z',
    }]);

    // `syncRepository()` is the only choke point that reads the file store
    // via `RepositoryFileManager.list()` (a plain read, not a validating
    // mutator) and writes the legacy file into the managed clone.
    orchestrator.syncRepository(repoId);
    await landInitialSync(orchestrator, repoId);

    commitInfoJsonChange(originPath, {
        SchemaVersion: 1, Id: repoId, Name: 'Upstream Name', Url: 'https://example.invalid/upstream.git', Description: '', Settings: {},
    });
    await orchestrator.refresh(repoId);

    const storePath = fileStorePath(config, repoId);
    const storeBefore = fs.readFileSync(storePath, 'utf8');

    const status = await orchestrator.applyImport(repoId, { fields: ['Name'] });
    assert.strictEqual(status.state, 'in-sync');
    assert.strictEqual(repositoryManager.getById(repoId)!.Name, 'Upstream Name', 'the field-only import must still apply');
    assert.strictEqual(
        fs.readFileSync(storePath, 'utf8'),
        storeBefore,
        'a field-only import must not call replaceAll() or rewrite the file store',
    );
    assert.strictEqual(repositoryFileManager.list(repoId)[0]!.Label, overLongLabel, 'the legacy row itself must be untouched');

    // Land the field-only import so the managed clone has no pending changes
    // of its own, which is what lets the next `refresh()` fast-forward onto
    // the upcoming upstream commit below.
    await landInitialSync(orchestrator, repoId);

    commitFilesFolderChange(originPath, 'new.sh', 'echo new\n');
    await orchestrator.refresh(repoId);

    const storeBeforeMutatingImport = fs.readFileSync(storePath, 'utf8');
    await assert.rejects(
        () => orchestrator.applyImport(repoId, { fields: [], files: [{ path: 'new.sh', action: 'add' }] }),
        /legacy\.sh/,
    );
    assert.strictEqual(
        fs.readFileSync(storePath, 'utf8'),
        storeBeforeMutatingImport,
        'the rejected mutating import must leave the file store untouched',
    );
});

// ─── syncRepository() / applyImport(): files write-pass logging (AC-08) ─────

test('syncRepository() logs an info entry for a removed file and a warning entry for a refused write', { skip: process.platform === 'win32' }, async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, errorLogManager, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    const keepFile = repositoryFileManager.add(repoId, {
        Directory: '', FileName: 'keep.sh', Label: 'Keep', Description: '', Content: 'echo keep\n', Executable: false, ListInAgents: false,
    });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const mainFolder = resolveMainFolderPath(config, repoId);
    const filesRoot = path.join(mainFolder, '.workspace', 'files');
    const outside = fs.mkdtempSync(path.join(tmpDir, 'outside-'));
    fs.symlinkSync(outside, path.join(filesRoot, 'linked'));
    repositoryFileManager.add(repoId, {
        Directory: 'linked', FileName: 'a.sh', Label: 'A', Description: '', Content: 'echo a\n', Executable: false, ListInAgents: false,
    });
    repositoryFileManager.remove(repoId, keepFile.Id);

    orchestrator.syncRepository(repoId);

    const entries = errorLogManager.list({ source: 'workspace-info' }).entries.filter((e) => e.Operation === 'sync-files');
    const infoEntry = entries.find((e) => e.Severity === 'info');
    const warningEntry = entries.find((e) => e.Severity === 'warning');
    assert.ok(infoEntry, 'expected an info entry for the removed file');
    assert.ok(infoEntry!.Message.includes('keep.sh'));
    assert.ok(warningEntry, 'expected a warning entry for the refused write');
    assert.ok(warningEntry!.Message.includes('linked'));
});

test('syncRepository() logs nothing when the files write skips and removes nothing', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, errorLogManager } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    repositoryFileManager.add(repoId, {
        Directory: '', FileName: 'build.sh', Label: 'Build', Description: '', Content: 'echo build\n', Executable: false, ListInAgents: false,
    });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const entries = errorLogManager.list({ source: 'workspace-info' }).entries.filter((e) => e.Operation === 'sync-files');
    assert.deepStrictEqual(entries, []);
});

test('syncRepository() does not throw when a files write skips/removes files but no error-log manager was injected', { skip: process.platform === 'win32' }, async () => {
    const base = fs.mkdtempSync(path.join(tmpDir, 'case-no-log-'));
    const config = makeTestConfig(base);
    const repositoryManager = new RepositoryManager(config);
    const repositoryFileManager = new RepositoryFileManager(config, repositoryManager);
    const orchestrator = new RepositoryInfoSyncOrchestrator(config, repositoryManager, repositoryFileManager);

    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    const keepFile = repositoryFileManager.add(repoId, {
        Directory: '', FileName: 'keep.sh', Label: 'Keep', Description: '', Content: 'echo keep\n', Executable: false, ListInAgents: false,
    });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const mainFolder = resolveMainFolderPath(config, repoId);
    const filesRoot = path.join(mainFolder, '.workspace', 'files');
    const outside = fs.mkdtempSync(path.join(tmpDir, 'outside-'));
    fs.symlinkSync(outside, path.join(filesRoot, 'linked'));
    repositoryFileManager.add(repoId, {
        Directory: 'linked', FileName: 'a.sh', Label: 'A', Description: '', Content: 'echo a\n', Executable: false, ListInAgents: false,
    });
    repositoryFileManager.remove(repoId, keepFile.Id);

    assert.doesNotThrow(() => orchestrator.syncRepository(repoId));
});

// ─── commitAndPush() (AC-11) ──────────────────────────────────────────────────

test('commitAndPush() commits the staged .workspace changes with the fixed Paralizer identity, pushes to the default branch, and writes an audit entry', async () => {
    const { repositoryManager, orchestrator, errorLogManager, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'My Repo' });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const mainFolder = resolveMainFolderPath(config, repoId);

    const result = await orchestrator.commitAndPush(repoId, { message: 'Custom message' });

    assert.strictEqual(result.committed, true);
    assert.strictEqual(result.pushed, true);
    assert.ok(result.commitSha);

    const committedPaths = git(`show --name-only --pretty=format: ${result.commitSha}`, mainFolder)
        .split('\n')
        .filter((l) => l.length > 0);
    // syncRepository() also wrote the generated README alongside info.json on
    // the first sync.
    assert.deepStrictEqual(committedPaths.sort(), ['.workspace/README.md', '.workspace/info.json']);

    const authorName = git(`show -s --format=%an ${result.commitSha}`, mainFolder);
    const authorEmail = git(`show -s --format=%ae ${result.commitSha}`, mainFolder);
    assert.strictEqual(authorName, INFO_COMMIT_AUTHOR_NAME);
    assert.strictEqual(authorEmail, INFO_COMMIT_AUTHOR_EMAIL);

    // Verify it actually reached the origin.
    const originLog = git('log --oneline -1 main', originPath);
    assert.ok(originLog.includes('Custom message'));

    const auditEntries = errorLogManager.list({ source: 'workspace-info' }).entries.filter((e) => e.Operation === 'commit-push');
    assert.strictEqual(auditEntries.length, 1);
    assert.strictEqual(auditEntries[0]!.Severity, 'audit');
});

test('commitAndPush() throws SyncPreconditionError and creates no commit when a hand-staged path lies outside .workspace/', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const mainFolder = resolveMainFolderPath(config, repoId);
    const headBefore = git('rev-parse HEAD', mainFolder);
    fs.writeFileSync(path.join(mainFolder, 'unrelated.txt'), 'hand edit');
    git('add unrelated.txt', mainFolder);

    await assert.rejects(() => orchestrator.commitAndPush(repoId), SyncPreconditionError);

    assert.strictEqual(git('rev-parse HEAD', mainFolder), headBefore, 'no commit should have been created');
    const statusAfter = git('status --porcelain', mainFolder);
    assert.ok(statusAfter.includes('unrelated.txt'), 'the unrelated staged file must remain staged, untouched');
});

test('commitAndPush() commits an executable repository file as mode 100755, including on a clone with core.filemode=false', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const mainFolder = resolveMainFolderPath(config, repoId);
    git('config core.filemode false', mainFolder);

    repositoryFileManager.add(repoId, {
        Directory: '', FileName: 'build.sh', Label: 'Build', Description: '', Content: 'echo hi\n', Executable: true, ListInAgents: false,
    });
    orchestrator.syncRepository(repoId);

    const result = await orchestrator.commitAndPush(repoId);
    assert.strictEqual(result.committed, true);

    const mode = git(`show ${result.commitSha} --format= --raw -- .workspace/files/build.sh`, mainFolder)
        .trim()
        .split(' ')[1];
    assert.strictEqual(mode, '100755');
});

test('commitAndPush() refuses with SyncPreconditionError when checked out on a branch other than the default', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const mainFolder = resolveMainFolderPath(config, repoId);
    git('switch -c feature-branch', mainFolder);

    await assert.rejects(() => orchestrator.commitAndPush(repoId), SyncPreconditionError);
});

test('commitAndPush() refuses with SyncPreconditionError when there is nothing pending', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await orchestrator.commitAndPush(repoId);

    await assert.rejects(() => orchestrator.commitAndPush(repoId), SyncPreconditionError);
});

test('commitAndPush() refuses with SyncPreconditionError when upstream changed the info folder, instructing to import first', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'My Repo' });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    // Land the first sync's write upstream so there is something to fast-forward past.
    const mainFolder = resolveMainFolderPath(config, repoId);
    await orchestrator.commitAndPush(repoId);

    commitInfoJsonChange(originPath, {
        SchemaVersion: 1, Id: repoId, Name: 'Changed Upstream', Url: 'https://example.invalid/x.git', Description: '', Settings: {},
    });
    repositoryManager.update(repoId, { name: repo.Name, description: 'local change creating a pending write' });
    orchestrator.syncRepository(repoId);

    await assert.rejects(() => orchestrator.commitAndPush(repoId), SyncPreconditionError);
});

// ─── saveSettings(): disabling (AC-13) ────────────────────────────────────────

test('saveSettings({enabled: false}) with pending changes throws PendingChangesError; discardPendingChanges removes the clone and clears LastWrittenHash', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    await assert.rejects(
        () => orchestrator.saveSettings(repoId, { enabled: false }),
        PendingChangesError,
    );

    const status = await orchestrator.saveSettings(repoId, { enabled: false, discardPendingChanges: true });

    assert.strictEqual(status.enabled, false);
    assert.strictEqual(repositoryManager.getById(repoId)!.InfoSync, undefined);
    assert.ok(!fs.existsSync(resolveMainFolderPath(config, repoId)));
});

test('re-enabling after a disable starts without a baseline', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });
    await orchestrator.saveSettings(repoId, { enabled: false, discardPendingChanges: true });

    await orchestrator.saveSettings(repoId, { enabled: true });

    const refetched = repositoryManager.getById(repoId)!;
    assert.ok(refetched.InfoSync?.LastWrittenHash, 'a fresh baseline should be recorded for the newly created clone');
});

// ─── recreateManagedClone() (AC-13) ───────────────────────────────────────────

test('recreateManagedClone() refuses with pending changes unless discarded, and clears LastWrittenHash', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    await assert.rejects(
        () => orchestrator.recreateManagedClone(repoId),
        PendingChangesError,
    );

    const status = await orchestrator.recreateManagedClone(repoId, { discardPendingChanges: true });

    assert.ok(fs.existsSync(resolveMainFolderPath(config, repoId)));
    // The recreated clone is a fresh baseline-less folder against the same
    // (unchanged) upstream file, so the first post-recreate sync re-records a
    // fresh baseline rather than leaving the state as an unresolved conflict.
    assert.ok(status.state === 'in-sync' || status.state === 'write-required');
    assert.strictEqual(status.filterFallback, undefined);
});

test('recreateManagedClone() flags filterFallback when the server does not support partial-clone filtering', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ withFilter: false, infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const status = await orchestrator.recreateManagedClone(repoId, { discardPendingChanges: true });

    assert.strictEqual(status.filterFallback, true);
});

// ─── Serialisation (AC-14) ────────────────────────────────────────────────────

test('withRepositoryLock serialises two concurrent commitAndPush() calls on the same repository', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const [first, second] = await Promise.allSettled([
        orchestrator.commitAndPush(repoId),
        orchestrator.commitAndPush(repoId),
    ]);

    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
    const rejected = [first, second].filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    assert.strictEqual(fulfilled.length, 1, 'exactly one commitAndPush() call should succeed');
    assert.strictEqual(rejected.length, 1, 'the other must have been serialised behind it and found nothing pending');
    assert.ok(rejected[0]!.reason instanceof SyncPreconditionError);
});

// ─── Credential handling (AC-05) ──────────────────────────────────────────────

test('getStatus() reports an info-sync-credential-missing issue when no credential resolves for an HTTPS repository', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: 'https://example.invalid/needs-credential.git' });
    repositoryManager.setInfoSyncSettings(repoId, { Enabled: true });

    const status = await orchestrator.getStatus(repo.Id);

    assert.ok(status.health.issues.some((i) => i.type === 'info-sync-credential-missing' && i.fixAction === 'configure-credential'));
});

test('saveSettings({enabled: true}) throws RemoteOperationError when no credential resolves for an HTTPS repository', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: 'https://example.invalid/needs-credential.git' });

    await assert.rejects(() => orchestrator.saveSettings(repo.Id, { enabled: true }), RemoteOperationError);
    assert.strictEqual(repositoryManager.getById(repoId)!.InfoSync, undefined);
});

// ─── removeManagedFolder() ─────────────────────────────────────────────────────

test('removeManagedFolder() synchronously removes the managed clone', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    orchestrator.removeManagedFolder(repoId);

    assert.ok(!fs.existsSync(resolveMainFolderPath(config, repoId)));
});

// ─── syncRepository(): repository files (Milestone 2, WP-005, AC-01) ────────

test('syncRepository() writes the file set after info.json on write-required; a second sync with nothing changed leaves bytes and mtimes unchanged', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'My Repo' });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    repositoryFileManager.add(repoId, {
        Directory: '',
        FileName: 'build.sh',
        Label: 'Build',
        Description: 'Builds the project.',
        Content: '#!/bin/sh\necho build\n',
        Executable: true,
        ListInAgents: false,
    });

    const result = orchestrator.syncRepository(repoId);
    assert.strictEqual(result.state, 'write-required');
    assert.strictEqual(result.written, true);

    const mainFolder = resolveMainFolderPath(config, repoId);
    const filePath = path.join(mainFolder, '.workspace', 'files', 'build.sh');
    assert.ok(fs.existsSync(filePath), 'the file should have been written to the managed clone');
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '#!/bin/sh\necho build\n');

    const infoJson = readManagedInfoJson(config, repoId);
    const files = infoJson['Files'] as Array<Record<string, unknown>>;
    assert.deepStrictEqual(files.map((f) => f['Path']), ['build.sh']);
    assert.strictEqual(files[0]!['Label'], 'Build');
    assert.strictEqual(files[0]!['Executable'], true);
    assert.ok(!('Content' in files[0]!), 'info.json must never carry file content');

    const fileMtimeBefore = fs.statSync(filePath).mtimeMs;
    const infoMtimeBefore = fs.statSync(path.join(mainFolder, '.workspace', 'info.json')).mtimeMs;

    const second = orchestrator.syncRepository(repoId);

    assert.strictEqual(second.state, 'in-sync');
    assert.strictEqual(second.written, false);
    assert.strictEqual(fs.statSync(filePath).mtimeMs, fileMtimeBefore, 'the file must not be rewritten when nothing changed');
    assert.strictEqual(
        fs.statSync(path.join(mainFolder, '.workspace', 'info.json')).mtimeMs,
        infoMtimeBefore,
        'info.json must not be rewritten when nothing changed',
    );
});

test('removing a repository file makes the next sync delete its copy from the managed clone', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const file = repositoryFileManager.add(repoId, {
        Directory: '',
        FileName: 'build.sh',
        Label: 'Build',
        Description: '',
        Content: 'echo build\n',
        Executable: false,
        ListInAgents: false,
    });
    orchestrator.syncRepository(repoId);

    const mainFolder = resolveMainFolderPath(config, repoId);
    const filePath = path.join(mainFolder, '.workspace', 'files', 'build.sh');
    assert.ok(fs.existsSync(filePath));

    repositoryFileManager.remove(repoId, file.Id);
    const result = orchestrator.syncRepository(repoId);

    assert.strictEqual(result.state, 'write-required');
    assert.ok(!fs.existsSync(filePath), 'the removed file must be deleted from the managed clone');
});

// ─── assertSyncEnabled() / runLocked() (AC-03) ───────────────────────────────

test('assertSyncEnabled() throws while sync is disabled and does not throw once enabled', async () => {
    const { repositoryManager, orchestrator } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });

    assert.throws(() => orchestrator.assertSyncEnabled(repo.Id), SyncPreconditionError);

    await orchestrator.saveSettings(repo.Id, { enabled: true });

    assert.doesNotThrow(() => orchestrator.assertSyncEnabled(repo.Id));
});

test('assertSyncEnabled() throws NotFoundError for an unknown repository', () => {
    const { orchestrator } = makeHarness();
    assert.throws(() => orchestrator.assertSyncEnabled('does-not-exist'), NotFoundError);
});

test('runLocked() serialises two concurrent operations for the same repository in queued order', async () => {
    const { orchestrator } = makeHarness();
    const repoId = nextRepoId();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });

    const first = orchestrator.runLocked(repoId, async () => {
        order.push('first-start');
        await firstGate;
        order.push('first-end');
    });
    const second = orchestrator.runLocked(repoId, async () => {
        order.push('second-start');
    });

    releaseFirst();
    await Promise.all([first, second]);

    assert.deepStrictEqual(order, ['first-start', 'first-end', 'second-start']);
});

// ─── Health report: Milestone 2 files-folder issues (AC-04) ─────────────────

test('getStatus() reports info-sync-files-unsafe-entry for a symlink under files/, and the issue clears once it is removed', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const mainFolder = resolveMainFolderPath(config, repoId);
    const filesDir = path.join(mainFolder, '.workspace', 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    const linkPath = path.join(filesDir, 'evil-link');
    fs.symlinkSync(path.join(mainFolder, 'README.md'), linkPath);

    const status = await orchestrator.getStatus(repoId);
    assert.ok(status.health.issues.some((i) => i.type === 'info-sync-files-unsafe-entry' && i.fixAction === 'none'));

    fs.unlinkSync(linkPath);
    const statusAfter = await orchestrator.getStatus(repoId);
    assert.ok(!statusAfter.health.issues.some((i) => i.type === 'info-sync-files-unsafe-entry'));
});

test('getStatus() reports info-sync-files-invalid-incoming for a binary file committed under files/', async () => {
    const { repositoryManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const mainFolder = resolveMainFolderPath(config, repoId);
    const filesDir = path.join(mainFolder, '.workspace', 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(filesDir, 'binary.dat'), Buffer.from([0, 1, 2, 3]));

    const status = await orchestrator.getStatus(repoId);

    assert.ok(status.health.issues.some((i) => i.type === 'info-sync-files-invalid-incoming' && i.fixAction === 'import'));
});

test('getStatus() reports info-sync-files-write-skipped when a local file\'s write target is occupied by a directory', async () => {
    const { repositoryManager, repositoryFileManager, orchestrator, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}` });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    repositoryFileManager.add(repoId, {
        Directory: '',
        FileName: 'run.sh',
        Label: 'Run',
        Description: '',
        Content: 'echo hi\n',
        Executable: false,
        ListInAgents: false,
    });

    const mainFolder = resolveMainFolderPath(config, repoId);
    // Occupy the file's write target with a directory, so `guardedFileTarget()`
    // refuses it (the directory-shape check) without ever writing anything.
    fs.mkdirSync(path.join(mainFolder, '.workspace', 'files', 'run.sh'), { recursive: true });

    const status = await orchestrator.getStatus(repoId);

    assert.ok(status.health.issues.some((i) => i.type === 'info-sync-files-write-skipped' && i.fixAction === 'none'));
});
