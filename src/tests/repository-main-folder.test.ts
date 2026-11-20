import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
    MANAGED_MAIN_FOLDER_DIR,
    getManagedMainFolderRoot,
    resolveMainFolderPath,
    inspectMainFolder,
    createManagedClone,
    removeManagedClone,
    deriveMainFolderIssues,
    isMainFolderUsable,
    MainFolderGitError,
    MainFolderPreconditionError,
} from '../orchestration/repository-main-folder.js';
import { makeTestConfig } from './test-helpers.js';
import type { Repository } from '../models/repository/repository.types.js';

// ─── Fixture setup ────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-main-folder-test-'));

process.on('exit', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function git(args: string, cwd: string): string {
    return execSync(`git ${args}`, { cwd }).toString().trim();
}

let originCounter = 0;

/** Creates a fresh bare-equivalent "origin" repository with one commit on `main`, with partial-clone filtering enabled. */
function buildOrigin(withFilter = true): string {
    const originPath = path.join(tmpDir, `origin-${++originCounter}`);
    fs.mkdirSync(originPath);
    git('init -q -b main', originPath);
    git('config user.email "test@test.local"', originPath);
    git('config user.name "Test"', originPath);
    fs.writeFileSync(path.join(originPath, 'README.md'), 'hello');
    fs.mkdirSync(path.join(originPath, 'other-dir'));
    fs.writeFileSync(path.join(originPath, 'other-dir', 'file.txt'), 'nested content');
    fs.mkdirSync(path.join(originPath, '.workspace'));
    fs.writeFileSync(path.join(originPath, '.workspace', 'info.json'), '{"Id":"placeholder"}\n');
    git('add .', originPath);
    git('commit -q -m initial', originPath);
    if (withFilter) {
        git('config uploadpack.allowFilter true', originPath);
    }
    return originPath;
}

/** Creates a fresh, empty "origin" repository (no commits, no branches). */
function buildEmptyOrigin(): string {
    const originPath = path.join(tmpDir, `origin-empty-${++originCounter}`);
    fs.mkdirSync(originPath);
    git('init -q -b main', originPath);
    return originPath;
}

function fakeRepo(id: string, url: string): Repository {
    return { Id: id, Name: id, Url: url };
}

let repoCounter = 0;
function nextRepoId(): string {
    return `repo-${++repoCounter}`;
}

// ─── MANAGED_MAIN_FOLDER_DIR / path resolution ────────────────────────────────

test('MANAGED_MAIN_FOLDER_DIR is "repositories"', () => {
    assert.strictEqual(MANAGED_MAIN_FOLDER_DIR, 'repositories');
});

test('getManagedMainFolderRoot() joins storageFolder with "repositories"', () => {
    const config = makeTestConfig(tmpDir);
    assert.strictEqual(
        getManagedMainFolderRoot(config),
        path.join(config.storageFolder, 'repositories'),
    );
});

test('resolveMainFolderPath() joins the managed root with the repository ID and accepts no other arguments', () => {
    const config = makeTestConfig(tmpDir);
    // resolveMainFolderPath()'s signature is (config, repoId) — this test
    // guards against ever growing a third "path" or "mode" parameter.
    assert.strictEqual(resolveMainFolderPath.length, 2);
    assert.strictEqual(
        resolveMainFolderPath(config, 'my-repo'),
        path.join(config.storageFolder, 'repositories', 'my-repo'),
    );
});

// ─── createManagedClone(): happy path (AC-03 / plan AC-03) ────────────────────

test('createManagedClone() creates a partial clone with cone sparse-checkout of .workspace, on the default branch', async () => {
    const originPath = buildOrigin(true);
    const config = makeTestConfig(tmpDir);
    const repo = fakeRepo(nextRepoId(), `file://${originPath}`);

    const result = await createManagedClone(config, repo, `file://${originPath}`);

    assert.strictEqual(result.path, resolveMainFolderPath(config, repo.Id));
    assert.strictEqual(result.defaultBranch, 'main');
    assert.strictEqual(result.filterFallback, false);

    assert.ok(fs.existsSync(path.join(result.path, '.git')), 'managed clone should be a git repository');

    const checkedOutBranch = git('rev-parse --abbrev-ref HEAD', result.path);
    assert.strictEqual(checkedOutBranch, 'main');

    const gitConfig = fs.readFileSync(path.join(result.path, '.git', 'config'), 'utf8');
    assert.ok(
        gitConfig.includes('partialclonefilter = blob:none'),
        `expected partialclonefilter recorded in .git/config, got: ${gitConfig}`,
    );

    const sparseConfig = git('config core.sparseCheckoutCone', result.path);
    assert.strictEqual(sparseConfig, 'true');

    // The info folder's own content must be checked out...
    assert.ok(fs.existsSync(path.join(result.path, '.workspace', 'info.json')), 'the .workspace folder should be checked out');
    // ...but a nested, non-root directory outside the sparse-checkout cone
    // must not be (cone mode always keeps root-level files/dirs visible, so
    // this is the meaningful exclusion check rather than a root-level file).
    assert.ok(!fs.existsSync(path.join(result.path, 'other-dir')), 'other-dir should not be checked out (outside sparse-checkout scope)');
});

// ─── createManagedClone(): filter fallback (AC-04 / plan AC-04) ───────────────

test('createManagedClone() reports filterFallback: true (without throwing) when the server does not support partial-clone filtering', async () => {
    const originPath = buildOrigin(false); // uploadpack.allowFilter left unset
    const config = makeTestConfig(tmpDir);
    const repo = fakeRepo(nextRepoId(), `file://${originPath}`);

    const result = await createManagedClone(config, repo, `file://${originPath}`);

    assert.strictEqual(result.filterFallback, true);
    assert.ok(fs.existsSync(path.join(result.path, '.git')), 'a full clone should still have been created');
    assert.strictEqual(git('rev-parse --abbrev-ref HEAD', result.path), 'main');
});

// ─── createManagedClone(): precondition / git failures (AC-09 / plan AC-09) ──

test('createManagedClone() throws MainFolderPreconditionError for an empty remote and leaves no destination folder', async () => {
    const originPath = buildEmptyOrigin();
    const config = makeTestConfig(tmpDir);
    const repo = fakeRepo(nextRepoId(), `file://${originPath}`);
    const destination = resolveMainFolderPath(config, repo.Id);

    await assert.rejects(
        () => createManagedClone(config, repo, `file://${originPath}`),
        MainFolderPreconditionError,
    );
    assert.ok(!fs.existsSync(destination), 'no destination folder should remain after a precondition failure');
});

test('createManagedClone() throws MainFolderGitError for an unreachable remote and leaves no destination folder', async () => {
    const config = makeTestConfig(tmpDir);
    const repo = fakeRepo(nextRepoId(), 'https://example.invalid/does-not-exist.git');
    const destination = resolveMainFolderPath(config, repo.Id);

    await assert.rejects(
        () => createManagedClone(config, repo, 'https://example.invalid/does-not-exist.git'),
        MainFolderGitError,
    );
    assert.ok(!fs.existsSync(destination), 'no destination folder should remain after a clone failure');
});

test('createManagedClone() throws MainFolderGitError (without touching the filesystem) when the destination already exists', async () => {
    const originPath = buildOrigin(true);
    const config = makeTestConfig(tmpDir);
    const repo = fakeRepo(nextRepoId(), `file://${originPath}`);
    const destination = resolveMainFolderPath(config, repo.Id);
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'marker.txt'), 'pre-existing');

    await assert.rejects(
        () => createManagedClone(config, repo, `file://${originPath}`),
        MainFolderGitError,
    );
    // The guard must not have deleted the pre-existing folder it did not create.
    assert.ok(fs.existsSync(path.join(destination, 'marker.txt')), 'pre-existing destination content must be left untouched');
});

// ─── removeManagedClone() (AC-13 / plan AC-13) ────────────────────────────────

test('removeManagedClone() removes an existing managed main folder and returns true', () => {
    const config = makeTestConfig(tmpDir);
    const repoId = nextRepoId();
    const destination = resolveMainFolderPath(config, repoId);
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'file.txt'), 'content');

    const removed = removeManagedClone(config, repoId);

    assert.strictEqual(removed, true);
    assert.ok(!fs.existsSync(destination));
});

test('removeManagedClone() returns false without touching the filesystem when the folder does not exist', () => {
    const config = makeTestConfig(tmpDir);
    const removed = removeManagedClone(config, nextRepoId());
    assert.strictEqual(removed, false);
});

test('removeManagedClone() refuses to remove a path outside the managed root via lexical traversal', () => {
    const config = makeTestConfig(tmpDir);
    const outsideTarget = path.join(tmpDir, 'outside-victim');
    fs.mkdirSync(outsideTarget, { recursive: true });
    fs.writeFileSync(path.join(outsideTarget, 'keepme.txt'), 'must survive');

    // A repoId containing path-traversal segments must not escape the managed root.
    const traversalId = `../../outside-victim`;
    const removed = removeManagedClone(config, traversalId);

    assert.strictEqual(removed, false);
    assert.ok(fs.existsSync(path.join(outsideTarget, 'keepme.txt')), 'the outside target must be left untouched');
});

test('removeManagedClone() refuses to remove a path outside the managed root via a planted symlink', { skip: process.platform === 'win32' ? 'symlinks need elevated privileges on Windows' : false }, () => {
    const config = makeTestConfig(tmpDir);
    const outsideTarget = path.join(tmpDir, 'symlink-victim');
    fs.mkdirSync(outsideTarget, { recursive: true });
    fs.writeFileSync(path.join(outsideTarget, 'keepme.txt'), 'must survive');

    const repoId = nextRepoId();
    const managedRoot = getManagedMainFolderRoot(config);
    fs.mkdirSync(managedRoot, { recursive: true });
    const destination = path.join(managedRoot, repoId);
    fs.symlinkSync(outsideTarget, destination, 'dir');

    const removed = removeManagedClone(config, repoId);

    assert.strictEqual(removed, false);
    assert.ok(fs.existsSync(path.join(outsideTarget, 'keepme.txt')), 'the symlink target must be left untouched');
});

// ─── inspectMainFolder() (AC-10 / plan AC-10 style coverage) ──────────────────

test('inspectMainFolder() reports a missing folder', async () => {
    const result = await inspectMainFolder(path.join(tmpDir, 'does-not-exist'), 'https://example.invalid/repo.git');

    assert.deepStrictEqual(result, {
        exists: false,
        isGitRepository: false,
        remoteUrl: null,
        remoteMatches: false,
        currentBranch: null,
        defaultBranch: null,
        ahead: 0,
        behind: 0,
        pendingChanges: [],
    });
});

test('inspectMainFolder() reports an existing folder that is not a git repository', async () => {
    const folder = path.join(tmpDir, 'plain-folder');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'file.txt'), 'content');

    const result = await inspectMainFolder(folder, 'https://example.invalid/repo.git');

    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.isGitRepository, false);
    assert.strictEqual(result.remoteUrl, null);
    assert.strictEqual(result.remoteMatches, false);
});

test('inspectMainFolder() reports a remote mismatch, the wrong branch, ahead/behind counts, and pending changes scoped to the info folder', async () => {
    const originPath = buildOrigin(true);
    const config = makeTestConfig(tmpDir);
    const repo = fakeRepo(nextRepoId(), `file://${originPath}`);
    const { path: managedPath, defaultBranch } = await createManagedClone(config, repo, `file://${originPath}`);

    // Wrong branch: create and switch to a feature branch.
    git('switch -c feature-branch', managedPath);

    // Pending change scoped to the info folder: modify the already-tracked
    // .workspace/info.json file checked out from origin.
    fs.writeFileSync(path.join(managedPath, '.workspace', 'info.json'), '{"Id":"changed"}\n');

    // Pending change OUTSIDE the info folder must never show up in pendingChanges.
    fs.writeFileSync(path.join(managedPath, 'unrelated.txt'), 'should not appear');

    // Remote mismatch: inspect against a different repo URL than the one actually configured.
    const result = await inspectMainFolder(managedPath, 'https://example.invalid/some-other-repo.git');

    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.isGitRepository, true);
    assert.strictEqual(result.remoteMatches, false);
    assert.strictEqual(result.currentBranch, 'feature-branch');
    assert.strictEqual(result.defaultBranch, defaultBranch);
    assert.deepStrictEqual(result.pendingChanges, ['.workspace/info.json']);
});

test('inspectMainFolder() reports remoteMatches: true and correct ahead/behind counts when the remote matches and HEAD is in sync', async () => {
    const originPath = buildOrigin(true);
    const config = makeTestConfig(tmpDir);
    const repo = fakeRepo(nextRepoId(), `file://${originPath}`);
    const { path: managedPath, defaultBranch } = await createManagedClone(config, repo, `file://${originPath}`);

    const result = await inspectMainFolder(managedPath, `file://${originPath}`);

    assert.strictEqual(result.remoteMatches, true);
    assert.strictEqual(result.currentBranch, defaultBranch);
    assert.strictEqual(result.ahead, 0);
    assert.strictEqual(result.behind, 0);
});

test('inspectMainFolder() strips embedded credentials from the reported remoteUrl', async () => {
    const originPath = buildOrigin(true);
    const config = makeTestConfig(tmpDir);
    const repoId = nextRepoId();
    const destination = resolveMainFolderPath(config, repoId);
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    const result0 = await createManagedClone(config, fakeRepo(repoId, `file://${originPath}`), `file://${originPath}`);
    // Simulate an authenticated URL being configured as origin, as createManagedClone() does in production.
    git(`remote set-url origin https://user:token123@example.invalid/repo.git`, result0.path);

    const result = await inspectMainFolder(result0.path, 'https://example.invalid/repo.git');

    assert.ok(result.remoteUrl !== null);
    assert.ok(!result.remoteUrl.includes('token123'), `remoteUrl should not contain the credential token, got: ${result.remoteUrl}`);
});

// ─── deriveMainFolderIssues() / isMainFolderUsable() ──────────────────────────

test('deriveMainFolderIssues() reports main-folder-missing and isMainFolderUsable() is false when the folder does not exist', async () => {
    const inspection = await inspectMainFolder(path.join(tmpDir, 'nope'), 'https://example.invalid/repo.git');
    const issues = deriveMainFolderIssues(inspection);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]!.type, 'main-folder-missing');
    assert.strictEqual(isMainFolderUsable(inspection), false);
});

test('deriveMainFolderIssues() reports main-folder-not-git and isMainFolderUsable() is false for a non-git folder', async () => {
    const folder = path.join(tmpDir, 'plain-folder-2');
    fs.mkdirSync(folder, { recursive: true });

    const inspection = await inspectMainFolder(folder, 'https://example.invalid/repo.git');
    const issues = deriveMainFolderIssues(inspection);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]!.type, 'main-folder-not-git');
    assert.strictEqual(isMainFolderUsable(inspection), false);
});

test('deriveMainFolderIssues() reports main-folder-remote-mismatch and isMainFolderUsable() is false when the remote does not match', async () => {
    const originPath = buildOrigin(true);
    const config = makeTestConfig(tmpDir);
    const repo = fakeRepo(nextRepoId(), `file://${originPath}`);
    const { path: managedPath } = await createManagedClone(config, repo, `file://${originPath}`);

    const inspection = await inspectMainFolder(managedPath, 'https://example.invalid/some-other-repo.git');
    const issues = deriveMainFolderIssues(inspection);

    assert.ok(issues.some((issue) => issue.type === 'main-folder-remote-mismatch'));
    assert.strictEqual(isMainFolderUsable(inspection), false);
});

test('deriveMainFolderIssues() reports main-folder-wrong-branch but isMainFolderUsable() stays true when only the branch differs', async () => {
    const originPath = buildOrigin(true);
    const config = makeTestConfig(tmpDir);
    const repo = fakeRepo(nextRepoId(), `file://${originPath}`);
    const { path: managedPath } = await createManagedClone(config, repo, `file://${originPath}`);
    git('switch -c feature-branch', managedPath);

    const inspection = await inspectMainFolder(managedPath, `file://${originPath}`);
    const issues = deriveMainFolderIssues(inspection);

    assert.ok(issues.some((issue) => issue.type === 'main-folder-wrong-branch'));
    assert.strictEqual(isMainFolderUsable(inspection), true);
});

test('deriveMainFolderIssues() reports no issues and isMainFolderUsable() is true for a healthy managed clone', async () => {
    const originPath = buildOrigin(true);
    const config = makeTestConfig(tmpDir);
    const repo = fakeRepo(nextRepoId(), `file://${originPath}`);
    const { path: managedPath } = await createManagedClone(config, repo, `file://${originPath}`);

    const inspection = await inspectMainFolder(managedPath, `file://${originPath}`);
    const issues = deriveMainFolderIssues(inspection);

    assert.deepStrictEqual(issues, []);
    assert.strictEqual(isMainFolderUsable(inspection), true);
});
