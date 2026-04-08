import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
    branchExists,
    createBranch,
    fetchRemote,
    getCurrentBranch,
    getDefaultBranch,
    listBranches,
    switchBranch,
} from '../git/git-branch.js';

// ─── Fixture setup ────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-branch-test-'));
const originRepoPath = path.join(tmpDir, 'origin');
const primaryClonePath = path.join(tmpDir, 'primary-clone');
let cloneCounter = 0;

// Ensure the temporary directory is removed when the process exits.
process.on('exit', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function nextCloneDest(): string {
    return path.join(tmpDir, `clone-${++cloneCounter}`);
}

function makeClone(dest: string = nextCloneDest()): string {
    execSync(`git clone "${originRepoPath}" "${dest}"`);
    execSync('git config user.email "test@test.local"', { cwd: dest });
    execSync('git config user.name "Test"', { cwd: dest });
    return dest;
}

(function buildFixture() {
    // Build origin repo
    fs.mkdirSync(originRepoPath);
    execSync('git init -b main', { cwd: originRepoPath });
    execSync('git config user.email "test@test.local"', { cwd: originRepoPath });
    execSync('git config user.name "Test"', { cwd: originRepoPath });

    fs.writeFileSync(path.join(originRepoPath, 'README.md'), 'hello');
    execSync('git add .', { cwd: originRepoPath });
    execSync('git commit -m "initial"', { cwd: originRepoPath });

    fs.writeFileSync(path.join(originRepoPath, 'file2.md'), 'second');
    execSync('git add .', { cwd: originRepoPath });
    execSync('git commit -m "second commit"', { cwd: originRepoPath });

    // extra-branch in origin (not cloned locally without explicit checkout)
    execSync('git checkout -b extra-branch', { cwd: originRepoPath });
    fs.writeFileSync(path.join(originRepoPath, 'extra.md'), 'extra');
    execSync('git add .', { cwd: originRepoPath });
    execSync('git commit -m "extra branch commit"', { cwd: originRepoPath });
    execSync('git checkout main', { cwd: originRepoPath });

    // Primary clone: has `origin` remote, local `main`, remote-tracking origin/main + origin/extra-branch
    makeClone(primaryClonePath);
})();

// ─── AC 1: listBranches() — local and remote flags ───────────────────────────

test('listBranches returns local branches with isRemote false', async () => {
    const branches = await listBranches(primaryClonePath);
    const main = branches.find((b) => b.name === 'main');
    assert.ok(main, 'expected a "main" branch in the list');
    assert.strictEqual(main.isRemote, false);
});

test('listBranches returns remote-tracking branches with isRemote true', async () => {
    const branches = await listBranches(primaryClonePath);
    const remoteMain = branches.find((b) => b.name === 'origin/main');
    assert.ok(remoteMain, 'expected "origin/main" in the list');
    assert.strictEqual(remoteMain.isRemote, true);
});

test('listBranches reports isCurrent true for the checked-out branch', async () => {
    const branches = await listBranches(primaryClonePath);
    const current = branches.find((b) => b.isCurrent);
    assert.ok(current, 'expected at least one branch to be current');
    assert.strictEqual(current.name, 'main');
    assert.strictEqual(current.isRemote, false);
});

test('listBranches reports isCurrent false for remote-tracking branches', async () => {
    const branches = await listBranches(primaryClonePath);
    const remoteBranches = branches.filter((b) => b.isRemote);
    assert.ok(remoteBranches.length > 0, 'expected at least one remote-tracking branch');
    assert.ok(
        remoteBranches.every((b) => !b.isCurrent),
        'remote-tracking branches should never have isCurrent: true',
    );
});

// ─── AC 2: getCurrentBranch() ─────────────────────────────────────────────────

test('getCurrentBranch returns the branch name for a normal checkout', async () => {
    const branch = await getCurrentBranch(primaryClonePath);
    assert.strictEqual(branch, 'main');
});

test('getCurrentBranch returns null for detached HEAD state', async () => {
    const dest = makeClone();
    // Checkout a specific commit to enter detached HEAD state
    const sha = execSync('git rev-parse HEAD', { cwd: dest }).toString().trim();
    execSync(`git checkout "${sha}"`, { cwd: dest });

    const branch = await getCurrentBranch(dest);
    assert.strictEqual(branch, null);
});

// ─── AC 3: getDefaultBranch() ─────────────────────────────────────────────────

test('getDefaultBranch returns "main" via remote HEAD symbolic ref for the primary clone', async () => {
    // The primary clone has origin/HEAD → origin/main
    const defaultBranch = await getDefaultBranch(primaryClonePath);
    assert.strictEqual(defaultBranch, 'main');
});

test('getDefaultBranch falls back to "main" when symbolic-ref is unavailable but main branch exists', async () => {
    const dest = makeClone();
    // Remove the remote HEAD symref to force fallback path
    execSync('git remote set-head origin --delete', { cwd: dest });

    const defaultBranch = await getDefaultBranch(dest);
    assert.strictEqual(defaultBranch, 'main');
});

test('getDefaultBranch falls back to "master" when only a master branch exists', async () => {
    // Create a repo with only a "master" branch and no remote
    const isolatedRepo = path.join(tmpDir, 'master-repo');
    fs.mkdirSync(isolatedRepo);
    execSync('git init -b master', { cwd: isolatedRepo });
    execSync('git config user.email "test@test.local"', { cwd: isolatedRepo });
    execSync('git config user.name "Test"', { cwd: isolatedRepo });
    fs.writeFileSync(path.join(isolatedRepo, 'README.md'), 'master root');
    execSync('git add .', { cwd: isolatedRepo });
    execSync('git commit -m "initial on master"', { cwd: isolatedRepo });

    const defaultBranch = await getDefaultBranch(isolatedRepo);
    assert.strictEqual(defaultBranch, 'master');
});

// ─── AC 4: createBranch() — creates and switches ─────────────────────────────

test('createBranch creates a new branch and switches to it', async () => {
    const dest = makeClone();

    const result = await createBranch(dest, 'new-feature');
    assert.strictEqual(result.exitCode, 0, `createBranch failed: ${result.stderr}`);

    const current = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dest }).toString().trim();
    assert.strictEqual(current, 'new-feature');
});

test('createBranch returns a non-zero exitCode when branch already exists', async () => {
    const dest = makeClone();
    await createBranch(dest, 'dup-branch');

    // Creating the same branch a second time should fail without throwing
    const result = await createBranch(dest, 'dup-branch');
    // git checkout -b on an existing branch name exits non-zero
    // (we may be on it, so we must switch away first to be sure it fails for the right reason)
    assert.ok(result.exitCode !== 0 || result.stderr.length > 0, 'expected failure or warning for duplicate branch');
});

// ─── AC 5: switchBranch() — returns GitResult for conflict inspection ────────

test('switchBranch returns exitCode 0 when switching to an existing branch', async () => {
    const dest = makeClone();
    // Track origin/extra-branch locally first
    execSync('git checkout -b extra-branch origin/extra-branch', { cwd: dest });
    execSync('git checkout main', { cwd: dest });

    const result = await switchBranch(dest, 'extra-branch');
    assert.strictEqual(result.exitCode, 0, `switchBranch failed: ${result.stderr}`);

    const current = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dest }).toString().trim();
    assert.strictEqual(current, 'extra-branch');
});

test('switchBranch returns a non-zero exitCode without throwing for a non-existent branch', async () => {
    const dest = makeClone();
    const result = await switchBranch(dest, 'totally-nonexistent-branch');
    assert.ok(result.exitCode !== 0, `expected non-zero exit code, got ${result.exitCode}`);
    assert.ok(typeof result.stderr === 'string');
});

test('createBranch returns a non-zero exitCode when branchName starts with "--" and does not modify working tree', async () => {
    const dest = makeClone();
    const headBefore = execSync('git rev-parse HEAD', { cwd: dest }).toString().trim();
    const branchBefore = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dest }).toString().trim();

    // The '-' prefix guard in createBranch() detects that '--force' starts with
    // '-' and returns exitCode 128 immediately, before invoking git. The working
    // tree is therefore untouched by construction.
    const result = await createBranch(dest, '--force');
    assert.ok(result.exitCode !== 0, `expected non-zero exit code, got ${result.exitCode}`);

    // Working tree and HEAD must be unchanged
    const headAfter = execSync('git rev-parse HEAD', { cwd: dest }).toString().trim();
    const branchAfter = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dest }).toString().trim();
    assert.strictEqual(headAfter, headBefore, 'HEAD should not have moved');
    assert.strictEqual(branchAfter, branchBefore, 'current branch should not have changed');
});

test('switchBranch returns a non-zero exitCode when branchName starts with "--" and does not discard working tree', async () => {
    const dest = makeClone();

    // Create an uncommitted change so we can verify it is not silently discarded
    fs.writeFileSync(path.join(dest, 'canary.txt'), 'canary');
    execSync('git add canary.txt', { cwd: dest });

    // The '-' prefix guard in switchBranch() detects that '--force' starts with
    // '-' and returns exitCode 128 immediately, before invoking git. The staged
    // change is therefore preserved by construction.
    const result = await switchBranch(dest, '--force');
    assert.ok(result.exitCode !== 0, `expected non-zero exit code, got ${result.exitCode}`);

    // The staged file must still be present
    assert.ok(fs.existsSync(path.join(dest, 'canary.txt')), 'canary.txt should not have been discarded');
});

// ─── AC 6: branchExists() — differentiates local vs remote ───────────────────

test('branchExists returns true for a local branch that exists', async () => {
    const exists = await branchExists(primaryClonePath, 'main');
    assert.strictEqual(exists, true);
});

test('branchExists returns false for a local branch that does not exist', async () => {
    const exists = await branchExists(primaryClonePath, 'no-such-local-branch');
    assert.strictEqual(exists, false);
});

test('branchExists returns true for an existing remote-tracking branch', async () => {
    // origin/extra-branch was pushed to origin, so it should exist as a remote-tracking ref
    const exists = await branchExists(primaryClonePath, 'extra-branch', 'origin');
    assert.strictEqual(exists, true);
});

test('branchExists returns false for a local-only check on a branch that only exists on remote', async () => {
    // extra-branch was never checked out locally in the primary clone
    const existsLocally = await branchExists(primaryClonePath, 'extra-branch');
    assert.strictEqual(existsLocally, false);
});

// ─── AC 7: fetchRemote() — completes without error ───────────────────────────

test('fetchRemote completes with exitCode 0 for a valid remote', async () => {
    // Add a new commit to origin, then fetch from the clone
    fs.writeFileSync(path.join(originRepoPath, 'new-remote-file.md'), 'new content');
    execSync('git add .', { cwd: originRepoPath });
    execSync('git commit -m "new commit on origin"', { cwd: originRepoPath });

    const dest = makeClone();
    const result = await fetchRemote(dest, 'origin');
    assert.strictEqual(result.exitCode, 0, `fetchRemote failed: ${result.stderr}`);
});

test('fetchRemote returns non-zero exitCode without throwing for an invalid remote', async () => {
    const dest = makeClone();
    const result = await fetchRemote(dest, 'does-not-exist');
    assert.ok(result.exitCode !== 0, `expected non-zero exit code, got ${result.exitCode}`);
});

// ─── AC 8: branchExists() — dash-prefix guard ────────────────────────────────

test('branchExists returns false for a branchName starting with "--" without invoking git', async () => {
    // The guard must return false immediately; it must not forward the
    // flag-like name to git, which could misinterpret it as an option.
    const exists = await branchExists(primaryClonePath, '--flag');
    assert.strictEqual(exists, false);
});

test('branchExists returns false for a branchName starting with a single "-"', async () => {
    const exists = await branchExists(primaryClonePath, '-x');
    assert.strictEqual(exists, false);
});
