import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
    getPathStatus,
    stagePaths,
    commitPaths,
    getIndexModes,
    setIndexExecutable,
    getStagedPaths,
    commitStaged,
} from '../git/git-commit.js';

// ─── Fixture setup ────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-git-commit-test-'));

process.on('exit', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function git(args: string, cwd: string): string {
    return execSync(`git ${args}`, { cwd }).toString().trim();
}

function makeRepo(): string {
    const repoPath = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    fs.mkdirSync(path.join(repoPath, 'sub'));
    git('init -b main', repoPath);
    git('config user.email "test@test.local"', repoPath);
    git('config user.name "Test"', repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'hello');
    fs.writeFileSync(path.join(repoPath, 'sub', 'tracked.md'), 'tracked');
    git('add .', repoPath);
    git('commit -m "initial"', repoPath);
    return repoPath;
}

const identity = { name: 'Paralizer', email: 'paralizer@mistralys.eu' };

// ─── getPathStatus() ──────────────────────────────────────────────────────────

test('getPathStatus() reports an untracked file matched by the pathspec', async () => {
    const repoPath = makeRepo();
    fs.writeFileSync(path.join(repoPath, 'sub', 'new.md'), 'new content');
    fs.writeFileSync(path.join(repoPath, 'unrelated.md'), 'unrelated content');

    const entries = await getPathStatus(repoPath, 'sub');

    assert.equal(entries.length, 1, `expected exactly 1 entry scoped to "sub", got: ${JSON.stringify(entries)}`);
    assert.equal(entries[0]!.path, 'sub/new.md');
    assert.equal(entries[0]!.code, '??');
});

test('getPathStatus() does not report changes outside the pathspec', async () => {
    const repoPath = makeRepo();
    fs.writeFileSync(path.join(repoPath, 'unrelated.md'), 'unrelated content');

    const entries = await getPathStatus(repoPath, 'sub');

    assert.deepEqual(entries, []);
});

test('getPathStatus() reports a modified tracked file matched by the pathspec', async () => {
    const repoPath = makeRepo();
    fs.writeFileSync(path.join(repoPath, 'sub', 'tracked.md'), 'modified content');

    const entries = await getPathStatus(repoPath, 'sub');

    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.path, 'sub/tracked.md');
    assert.equal(entries[0]!.code, ' M');
});

test('getPathStatus() returns an empty array when repoPath is not a git repository', async () => {
    const nonRepo = fs.mkdtempSync(path.join(tmpDir, 'non-repo-'));
    const entries = await getPathStatus(nonRepo, '.');
    assert.deepEqual(entries, []);
});

// ─── stagePaths() ─────────────────────────────────────────────────────────────

test('stagePaths() stages only files matched by the pathspec', async () => {
    const repoPath = makeRepo();
    fs.writeFileSync(path.join(repoPath, 'sub', 'new.md'), 'new content');
    fs.writeFileSync(path.join(repoPath, 'unrelated.md'), 'unrelated content');

    const result = await stagePaths(repoPath, 'sub');
    assert.equal(result.exitCode, 0, `stagePaths failed: ${result.stderr}`);

    const staged = git('diff --cached --name-only', repoPath);
    assert.equal(staged, 'sub/new.md');

    const untracked = git('status --porcelain', repoPath);
    assert.ok(untracked.includes('?? unrelated.md'), `expected unrelated.md to remain untracked, got: ${untracked}`);
});

// ─── commitPaths() ────────────────────────────────────────────────────────────

test('commitPaths() commits only staged changes matched by the pathspec, using the given identity', async () => {
    const repoPath = makeRepo();
    fs.writeFileSync(path.join(repoPath, 'sub', 'new.md'), 'new content');
    await stagePaths(repoPath, 'sub');

    const result = await commitPaths(repoPath, 'sub', 'sync: add new.md', identity);
    assert.equal(result.exitCode, 0, `commit failed: ${result.stderr}`);

    const authorName = git('log -1 --format=%an', repoPath);
    const authorEmail = git('log -1 --format=%ae', repoPath);
    assert.equal(authorName, 'Paralizer');
    assert.equal(authorEmail, 'paralizer@mistralys.eu');

    const subject = git('log -1 --format=%s', repoPath);
    assert.equal(subject, 'sync: add new.md');

    const committedFiles = git('log -1 --name-only --format=', repoPath);
    assert.equal(committedFiles, 'sub/new.md');
});

test('commitPaths() rejects an empty message without invoking git', async () => {
    const repoPath = makeRepo();
    fs.writeFileSync(path.join(repoPath, 'sub', 'new.md'), 'new content');
    await stagePaths(repoPath, 'sub');

    const result = await commitPaths(repoPath, 'sub', '', identity);
    assert.equal(result.exitCode, 128);
    assert.ok(result.stderr.includes('empty'), `expected an "empty message" error, got: ${result.stderr}`);

    // Verify nothing was committed: the staged change is still pending.
    const staged = git('diff --cached --name-only', repoPath);
    assert.equal(staged, 'sub/new.md');
});

test('commitPaths() rejects a whitespace-only message', async () => {
    const repoPath = makeRepo();
    const result = await commitPaths(repoPath, '.', '   ', identity);
    assert.equal(result.exitCode, 128);
});

test('commitPaths() rejects an identity name containing a newline', async () => {
    const repoPath = makeRepo();
    const result = await commitPaths(repoPath, '.', 'test message', { name: 'bad\nname', email: 'a@b.c' });
    assert.equal(result.exitCode, 128);
});

test('commitPaths() rejects an identity email starting with "-"', async () => {
    const repoPath = makeRepo();
    const result = await commitPaths(repoPath, '.', 'test message', { name: 'Good Name', email: '-malicious' });
    assert.equal(result.exitCode, 128);
});

test('commitPaths() rejects an identity name that is empty', async () => {
    const repoPath = makeRepo();
    const result = await commitPaths(repoPath, '.', 'test message', { name: '', email: 'a@b.c' });
    assert.equal(result.exitCode, 128);
});

// ─── getIndexModes() ──────────────────────────────────────────────────────────

test('getIndexModes() reports the staged mode for each path matched by the pathspec', async () => {
    const repoPath = makeRepo();
    const modes = await getIndexModes(repoPath, 'sub');

    assert.equal(modes.get('sub/tracked.md'), '100644');
});

test('getIndexModes() reflects a pending update-index --chmod change before it is committed', async () => {
    const repoPath = makeRepo();
    const before = await getIndexModes(repoPath, 'sub');
    assert.equal(before.get('sub/tracked.md'), '100644');

    const chmodResult = await setIndexExecutable(repoPath, ['sub/tracked.md'], true);
    assert.equal(chmodResult.exitCode, 0, `setIndexExecutable failed: ${chmodResult.stderr}`);

    const after = await getIndexModes(repoPath, 'sub');
    assert.equal(after.get('sub/tracked.md'), '100755');
});

test('getIndexModes() rejects a pathspec starting with "-" without invoking git, returning an empty map', async () => {
    const repoPath = makeRepo();
    const modes = await getIndexModes(repoPath, '-evil');
    assert.deepEqual(modes, new Map());
});

test('getIndexModes() returns an empty map when repoPath is not a git repository', async () => {
    const nonRepo = fs.mkdtempSync(path.join(tmpDir, 'non-repo-'));
    const modes = await getIndexModes(nonRepo, '.');
    assert.deepEqual(modes, new Map());
});

// ─── setIndexExecutable() ─────────────────────────────────────────────────────

test('setIndexExecutable(executable: true) sets the staged mode to 100755, and false clears it back to 100644', async () => {
    const repoPath = makeRepo();

    const setResult = await setIndexExecutable(repoPath, ['sub/tracked.md'], true);
    assert.equal(setResult.exitCode, 0, `setIndexExecutable failed: ${setResult.stderr}`);
    assert.equal((await getIndexModes(repoPath, 'sub')).get('sub/tracked.md'), '100755');

    const clearResult = await setIndexExecutable(repoPath, ['sub/tracked.md'], false);
    assert.equal(clearResult.exitCode, 0, `setIndexExecutable failed: ${clearResult.stderr}`);
    assert.equal((await getIndexModes(repoPath, 'sub')).get('sub/tracked.md'), '100644');
});

test('setIndexExecutable() resolves with no-op success for an empty paths array, without invoking git', async () => {
    const repoPath = makeRepo();
    const result = await setIndexExecutable(repoPath, [], true);
    assert.equal(result.exitCode, 0);
});

test('setIndexExecutable() rejects a path starting with "-" without invoking git', async () => {
    const repoPath = makeRepo();
    const result = await setIndexExecutable(repoPath, ['-evil'], true);
    assert.equal(result.exitCode, 128);
    assert.ok(result.stderr.includes('fatal:'), `expected a "fatal:" error, got: ${result.stderr}`);
});

// ─── getStagedPaths() ─────────────────────────────────────────────────────────

test('getStagedPaths() lists every currently staged path', async () => {
    const repoPath = makeRepo();
    fs.writeFileSync(path.join(repoPath, 'sub', 'new.md'), 'new content');
    fs.writeFileSync(path.join(repoPath, 'unrelated.md'), 'unrelated content');
    await stagePaths(repoPath, '.');

    const staged = await getStagedPaths(repoPath);
    assert.deepEqual(staged.sort(), ['sub/new.md', 'unrelated.md']);
});

test('getStagedPaths() returns an empty array when nothing is staged', async () => {
    const repoPath = makeRepo();
    const staged = await getStagedPaths(repoPath);
    assert.deepEqual(staged, []);
});

// ─── commitStaged() ───────────────────────────────────────────────────────────

test('commitStaged() commits whatever is currently staged, with no pathspec, using the given identity', async () => {
    const repoPath = makeRepo();
    fs.writeFileSync(path.join(repoPath, 'sub', 'new.md'), 'new content');
    await stagePaths(repoPath, '.');

    const result = await commitStaged(repoPath, 'sync: staged index', identity);
    assert.equal(result.exitCode, 0, `commit failed: ${result.stderr}`);

    const authorName = git('log -1 --format=%an', repoPath);
    const authorEmail = git('log -1 --format=%ae', repoPath);
    assert.equal(authorName, 'Paralizer');
    assert.equal(authorEmail, 'paralizer@mistralys.eu');

    const subject = git('log -1 --format=%s', repoPath);
    assert.equal(subject, 'sync: staged index');

    const committedFiles = git('log -1 --name-only --format=', repoPath);
    assert.equal(committedFiles, 'sub/new.md');
});

test('commitStaged() preserves an index-only update-index --chmod change (unlike commitPaths(), which rebuilds from the working tree)', async () => {
    const repoPath = makeRepo();
    git('config core.filemode false', repoPath);

    const chmodResult = await setIndexExecutable(repoPath, ['sub/tracked.md'], true);
    assert.equal(chmodResult.exitCode, 0, `setIndexExecutable failed: ${chmodResult.stderr}`);

    const result = await commitStaged(repoPath, 'sync: chmod', identity);
    assert.equal(result.exitCode, 0, `commit failed: ${result.stderr}`);

    const mode = git('show HEAD --format= --raw -- sub/tracked.md', repoPath).trim().split(' ')[1];
    assert.equal(mode, '100755');
});

test('commitStaged() rejects an empty message without invoking git', async () => {
    const repoPath = makeRepo();
    const result = await commitStaged(repoPath, '', identity);
    assert.equal(result.exitCode, 128);
    assert.ok(result.stderr.includes('empty'), `expected an "empty message" error, got: ${result.stderr}`);
});

test('commitStaged() rejects an identity email starting with "-"', async () => {
    const repoPath = makeRepo();
    const result = await commitStaged(repoPath, 'test message', { name: 'Good Name', email: '-malicious' });
    assert.equal(result.exitCode, 128);
});
