import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fetchAndGetStatus, getGitStatus } from '../git/git-status.js';

// ─── Fixture setup ─────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-status-test-'));
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

function makeClone(originPath: string = originRepoPath, dest: string = nextCloneDest()): string {
    execSync(`git clone "${originPath}" "${dest}"`);
    execSync('git config user.email "test@test.local"', { cwd: dest });
    execSync('git config user.name "Test"', { cwd: dest });
    return dest;
}

(function buildFixture() {
    // Origin repo
    fs.mkdirSync(originRepoPath);
    execSync('git init -b main', { cwd: originRepoPath });
    execSync('git config user.email "test@test.local"', { cwd: originRepoPath });
    execSync('git config user.name "Test"', { cwd: originRepoPath });

    fs.writeFileSync(path.join(originRepoPath, 'README.md'), 'hello');
    execSync('git add .', { cwd: originRepoPath });
    execSync('git commit -m "initial commit"', { cwd: originRepoPath });

    fs.writeFileSync(path.join(originRepoPath, 'file2.md'), 'second file');
    execSync('git add .', { cwd: originRepoPath });
    execSync('git commit -m "second commit"', { cwd: originRepoPath });

    // Primary clone: has `origin` remote, local `main` tracking origin/main
    makeClone(originRepoPath, primaryClonePath);
})();

// ─── AC 1: getGitStatus() returns a complete GitStatusInfo object ─────────────

test('getGitStatus returns all expected fields with correct types', async () => {
    const status = await getGitStatus(primaryClonePath);
    assert.ok(typeof status.currentBranch === 'string' || status.currentBranch === null);
    assert.ok(typeof status.localCommits === 'number');
    assert.ok(typeof status.unfetchedCommits === 'number');
    assert.ok(typeof status.modifiedFiles === 'number');
    assert.ok(typeof status.lastActivity === 'string' || status.lastActivity === null);
    assert.ok(typeof status.hasConflicts === 'boolean');
    assert.strictEqual(status.currentBranch, 'main');
    assert.strictEqual(status.localCommits, 0);
    assert.strictEqual(status.unfetchedCommits, 0);
    assert.strictEqual(status.modifiedFiles, 0);
    assert.strictEqual(status.hasConflicts, false);
    assert.ok(status.lastActivity !== null, 'lastActivity should be non-null for a repo with commits');
});

// ─── AC 2: localCommits counts commits ahead of upstream ──────────────────────

test('localCommits is 0 when clone has no unpushed commits', async () => {
    const status = await getGitStatus(primaryClonePath);
    assert.strictEqual(status.localCommits, 0);
});

test('localCommits increases when commits are added without pushing', async () => {
    const dest = makeClone();
    // Add 2 commits locally without pushing
    fs.writeFileSync(path.join(dest, 'local-a.md'), 'local a');
    execSync('git add .', { cwd: dest });
    execSync('git commit -m "local commit A"', { cwd: dest });

    fs.writeFileSync(path.join(dest, 'local-b.md'), 'local b');
    execSync('git add .', { cwd: dest });
    execSync('git commit -m "local commit B"', { cwd: dest });

    const status = await getGitStatus(dest);
    assert.strictEqual(status.localCommits, 2);
});

test('localCommits is 0 when no upstream is configured', async () => {
    // A standalone repo has no upstream
    const standalone = path.join(tmpDir, 'standalone-ahead');
    fs.mkdirSync(standalone);
    execSync('git init -b main', { cwd: standalone });
    execSync('git config user.email "test@test.local"', { cwd: standalone });
    execSync('git config user.name "Test"', { cwd: standalone });
    fs.writeFileSync(path.join(standalone, 'file.md'), 'content');
    execSync('git add .', { cwd: standalone });
    execSync('git commit -m "initial"', { cwd: standalone });

    const status = await getGitStatus(standalone);
    assert.strictEqual(status.localCommits, 0);
});

// ─── AC 3: unfetchedCommits counts commits behind upstream ────────────────────

test('unfetchedCommits is 0 when up to date with origin', async () => {
    const status = await getGitStatus(primaryClonePath);
    assert.strictEqual(status.unfetchedCommits, 0);
});

test('unfetchedCommits reflects new remote commits after a fetch (via fetchAndGetStatus)', async () => {
    // Create a fresh clone before adding new commits to origin
    const dest = makeClone();

    // Add a commit to origin after the clone was made
    fs.writeFileSync(path.join(originRepoPath, 'remote-new.md'), 'new remote file');
    execSync('git add .', { cwd: originRepoPath });
    execSync('git commit -m "remote-only commit"', { cwd: originRepoPath });

    // Before fetch: remote-tracking ref is stale; unfetchedCommits = 0
    const beforeFetch = await getGitStatus(dest);
    assert.strictEqual(beforeFetch.unfetchedCommits, 0, 'unfetchedCommits should be 0 before fetch');

    // After fetch: remote-tracking ref updated; unfetchedCommits = 1
    const afterFetch = await fetchAndGetStatus(dest);
    assert.ok(afterFetch.unfetchedCommits >= 1, `expected unfetchedCommits >= 1, got ${afterFetch.unfetchedCommits}`);
});

test('unfetchedCommits is 0 when no remote tracking is configured', async () => {
    const standalone = path.join(tmpDir, 'standalone-behind');
    fs.mkdirSync(standalone);
    execSync('git init -b main', { cwd: standalone });
    execSync('git config user.email "test@test.local"', { cwd: standalone });
    execSync('git config user.name "Test"', { cwd: standalone });
    fs.writeFileSync(path.join(standalone, 'file.md'), 'content');
    execSync('git add .', { cwd: standalone });
    execSync('git commit -m "initial"', { cwd: standalone });

    const status = await getGitStatus(standalone);
    assert.strictEqual(status.unfetchedCommits, 0);
});

// ─── AC 4: modifiedFiles counts lines in git status --porcelain ───────────────

test('modifiedFiles is 0 for a clean working tree', async () => {
    const dest = makeClone();
    const status = await getGitStatus(dest);
    assert.strictEqual(status.modifiedFiles, 0);
});

test('modifiedFiles reflects unstaged changes', async () => {
    const dest = makeClone();
    fs.writeFileSync(path.join(dest, 'modified.md'), 'changed content');
    fs.writeFileSync(path.join(dest, 'new-file.md'), 'brand new');

    const status = await getGitStatus(dest);
    // new-file.md (untracked) + modified.md (modified) = 2 lines
    assert.ok(status.modifiedFiles >= 2, `expected >= 2, got ${status.modifiedFiles}`);
});

test('modifiedFiles reflects staged changes', async () => {
    const dest = makeClone();
    fs.writeFileSync(path.join(dest, 'staged.md'), 'staged content');
    execSync('git add staged.md', { cwd: dest });

    const status = await getGitStatus(dest);
    assert.ok(status.modifiedFiles >= 1, `expected >= 1, got ${status.modifiedFiles}`);
});

// ─── AC 5: lastActivity returns ISO 8601 string or null for empty repos ───────

test('lastActivity returns a non-null ISO 8601 string for a repo with commits', async () => {
    const status = await getGitStatus(primaryClonePath);
    assert.ok(status.lastActivity !== null, 'lastActivity should not be null');
    // ISO 8601 format: YYYY-MM-DDTHH:MM:SS+HH:MM or similar
    assert.match(
        status.lastActivity,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
        'lastActivity should be an ISO 8601 timestamp',
    );
});

test('lastActivity is null for an empty repository with no commits', async () => {
    const emptyRepo = path.join(tmpDir, 'empty-repo');
    fs.mkdirSync(emptyRepo);
    execSync('git init -b main', { cwd: emptyRepo });
    execSync('git config user.email "test@test.local"', { cwd: emptyRepo });
    execSync('git config user.name "Test"', { cwd: emptyRepo });
    // No commits added

    const status = await getGitStatus(emptyRepo);
    assert.strictEqual(status.lastActivity, null);
});

// ─── AC 6: hasConflicts detects merge conflict markers ────────────────────────

test('hasConflicts is false for a clean working tree', async () => {
    const status = await getGitStatus(primaryClonePath);
    assert.strictEqual(status.hasConflicts, false);
});

test('hasConflicts is true when the working tree has unresolved merge conflicts', async () => {
    const dest = makeClone();

    // Modify the same line in the same file on two branches to force a conflict
    const conflictFile = path.join(dest, 'README.md');
    fs.writeFileSync(conflictFile, 'version from branch-a\n');
    execSync('git checkout -b branch-a', { cwd: dest });
    execSync('git add README.md', { cwd: dest });
    execSync('git commit -m "branch-a version"', { cwd: dest });

    execSync('git checkout main', { cwd: dest });
    fs.writeFileSync(conflictFile, 'version from main\n');
    execSync('git add README.md', { cwd: dest });
    execSync('git commit -m "main version"', { cwd: dest });

    // Merge branch-a into main — this will conflict (same line, different content)
    // Allow the merge command to fail (non-zero exit code) since we expect a conflict
    try {
        execSync('git merge branch-a --no-ff', { cwd: dest });
    } catch {
        // Expected: merge exits non-zero when conflicts exist
    }

    const status = await getGitStatus(dest);
    assert.strictEqual(status.hasConflicts, true, 'expected hasConflicts to be true after merge conflict');
});

// ─── AC 7: fetchAndGetStatus() calls fetch before gathering status ────────────

test('fetchAndGetStatus returns a valid GitStatusInfo even when remote is unreachable', async () => {
    // A repo with no remote configured — fetch will fail silently,
    // and getGitStatus should still return a valid snapshot.
    const standalone = path.join(tmpDir, 'standalone-no-remote');
    fs.mkdirSync(standalone);
    execSync('git init -b main', { cwd: standalone });
    execSync('git config user.email "test@test.local"', { cwd: standalone });
    execSync('git config user.name "Test"', { cwd: standalone });
    fs.writeFileSync(path.join(standalone, 'file.md'), 'content');
    execSync('git add .', { cwd: standalone });
    execSync('git commit -m "initial"', { cwd: standalone });

    // Should not throw, even though fetch will fail (no remote)
    const status = await fetchAndGetStatus(standalone);
    assert.ok(typeof status.localCommits === 'number');
    assert.ok(typeof status.unfetchedCommits === 'number');
    assert.ok(typeof status.modifiedFiles === 'number');
    assert.ok(typeof status.hasConflicts === 'boolean');
    assert.ok(status.lastActivity !== null);
});

test('fetchAndGetStatus updates unfetchedCommits by fetching remote commits first', async () => {
    // Create isolated origin + clone pair for this test to avoid
    // interference with origin commits added by earlier tests.
    const isolatedOrigin = path.join(tmpDir, 'isolated-origin');
    fs.mkdirSync(isolatedOrigin);
    execSync('git init -b main', { cwd: isolatedOrigin });
    execSync('git config user.email "test@test.local"', { cwd: isolatedOrigin });
    execSync('git config user.name "Test"', { cwd: isolatedOrigin });
    fs.writeFileSync(path.join(isolatedOrigin, 'README.md'), 'initial');
    execSync('git add .', { cwd: isolatedOrigin });
    execSync('git commit -m "initial"', { cwd: isolatedOrigin });

    const isolatedClone = makeClone(isolatedOrigin);

    // Confirm clean state
    const beforeStatus = await getGitStatus(isolatedClone);
    assert.strictEqual(beforeStatus.unfetchedCommits, 0);

    // Push a new commit to origin that the clone hasn't seen
    fs.writeFileSync(path.join(isolatedOrigin, 'new.md'), 'new file on remote');
    execSync('git add .', { cwd: isolatedOrigin });
    execSync('git commit -m "remote commit after clone"', { cwd: isolatedOrigin });

    // getGitStatus (no fetch) still shows 0
    const noFetchStatus = await getGitStatus(isolatedClone);
    assert.strictEqual(noFetchStatus.unfetchedCommits, 0, 'without fetch the remote commit is not visible');

    // fetchAndGetStatus (with fetch) shows 1
    const fetchedStatus = await fetchAndGetStatus(isolatedClone);
    assert.strictEqual(fetchedStatus.unfetchedCommits, 1, 'fetchAndGetStatus should pick up the remote commit');
});
