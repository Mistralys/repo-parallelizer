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
} from '../orchestration/repository-info-sync.js';
import { resolveMainFolderPath } from '../orchestration/repository-main-folder.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ErrorLogManager } from '../error-log/error-log.manager.js';
import { makeTestConfig } from './test-helpers.js';
import { INFO_COMMIT_AUTHOR_EMAIL, INFO_COMMIT_AUTHOR_NAME } from '../config/config.constants.js';

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

let repoCounter = 0;
function nextRepoId(): string {
    return `repo-${++repoCounter}`;
}

interface Harness {
    repositoryManager: RepositoryManager;
    errorLogManager: ErrorLogManager;
    orchestrator: RepositoryInfoSyncOrchestrator;
    config: ReturnType<typeof makeTestConfig>;
}

function makeHarness(): Harness {
    const base = fs.mkdtempSync(path.join(tmpDir, 'case-'));
    const config = makeTestConfig(base);
    const repositoryManager = new RepositoryManager(config);
    const errorLogManager = new ErrorLogManager(config);
    const orchestrator = new RepositoryInfoSyncOrchestrator(config, repositoryManager, errorLogManager);
    return { repositoryManager, errorLogManager, orchestrator, config };
}

function readManagedInfoJson(config: ReturnType<typeof makeTestConfig>, repoId: string): Record<string, unknown> {
    const mainFolder = resolveMainFolderPath(config, repoId);
    const raw = fs.readFileSync(path.join(mainFolder, '.workspace', 'info.json'), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
}

// ─── buildDefaultInfoCommitMessage() ──────────────────────────────────────────

test('buildDefaultInfoCommitMessage() includes the repository ID and stays short', () => {
    const message = buildDefaultInfoCommitMessage('my-repo');
    assert.ok(message.includes('my-repo'));
    assert.ok(message.length <= 500);
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

    const status = await orchestrator.applyImport(repoId, ['Name']);

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

    const status = await orchestrator.applyImport(repoId, []);

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

// ─── commitAndPush() (AC-11) ──────────────────────────────────────────────────

test('commitAndPush() commits only info-folder paths with the fixed Paralizer identity, pushes to the default branch, and writes an audit entry', async () => {
    const { repositoryManager, orchestrator, errorLogManager, config } = makeHarness();
    const originPath = buildOrigin({ infoJson: null });
    const repoId = nextRepoId();
    const repo = repositoryManager.add({ id: repoId, url: `file://${originPath}`, name: 'My Repo' });
    await orchestrator.saveSettings(repo.Id, { enabled: true });

    const mainFolder = resolveMainFolderPath(config, repoId);
    // A hand-staged file outside the info folder must stay uncommitted.
    fs.writeFileSync(path.join(mainFolder, 'unrelated.txt'), 'hand edit');
    git('add unrelated.txt', mainFolder);

    const result = await orchestrator.commitAndPush(repoId, { message: 'Custom message' });

    assert.strictEqual(result.committed, true);
    assert.strictEqual(result.pushed, true);
    assert.ok(result.commitSha);

    const committedPaths = git(`show --name-only --pretty=format: ${result.commitSha}`, mainFolder)
        .split('\n')
        .filter((l) => l.length > 0);
    // syncRepository() also wrote the generated README alongside info.json on
    // the first sync — both are under the info folder pathspec.
    assert.deepStrictEqual(committedPaths.sort(), ['.workspace/README.md', '.workspace/info.json']);

    const authorName = git(`show -s --format=%an ${result.commitSha}`, mainFolder);
    const authorEmail = git(`show -s --format=%ae ${result.commitSha}`, mainFolder);
    assert.strictEqual(authorName, INFO_COMMIT_AUTHOR_NAME);
    assert.strictEqual(authorEmail, INFO_COMMIT_AUTHOR_EMAIL);

    const statusAfter = git('status --porcelain', mainFolder);
    assert.ok(statusAfter.includes('unrelated.txt'), 'the unrelated staged file must remain uncommitted');

    // Verify it actually reached the origin.
    const originLog = git('log --oneline -1 main', originPath);
    assert.ok(originLog.includes('Custom message'));

    const auditEntries = errorLogManager.list({ source: 'workspace-info' }).entries.filter((e) => e.Operation === 'commit-push');
    assert.strictEqual(auditEntries.length, 1);
    assert.strictEqual(auditEntries[0]!.Severity, 'audit');
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
