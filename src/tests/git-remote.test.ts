import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
    getRemoteUrl,
    setRemoteUrl,
    fetchBranch,
    pushHead,
    mergeFastForward,
    countAheadBehind,
    changedPathsBetween,
    remoteUrlsMatch,
} from '../git/git-remote.js';
import { setupFakeGit } from './test-helpers.js';

// ─── Fixture setup ────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-git-remote-test-'));
const originRepoPath = path.join(tmpDir, 'origin');
const clonePath = path.join(tmpDir, 'clone');

process.on('exit', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function git(args: string, cwd: string): string {
    return execSync(`git ${args}`, { cwd }).toString().trim();
}

(function buildFixture() {
    fs.mkdirSync(originRepoPath);
    git('init -b main', originRepoPath);
    git('config user.email "test@test.local"', originRepoPath);
    git('config user.name "Test"', originRepoPath);
    // Allow pushing to the checked-out branch: these fixtures are
    // non-bare "origins" for test simplicity, and pushHead() tests push
    // directly into the currently checked-out branch.
    git('config receive.denyCurrentBranch ignore', originRepoPath);
    fs.writeFileSync(path.join(originRepoPath, 'README.md'), 'hello');
    git('add .', originRepoPath);
    git('commit -m "initial"', originRepoPath);

    execSync(`git clone "${originRepoPath}" "${clonePath}"`, { cwd: tmpDir });
    git('config user.email "test@test.local"', clonePath);
    git('config user.name "Test"', clonePath);
})();

/** Runs `fn` with a fake `git` binary (from `setupFakeGit()`) prepended to PATH. */
async function withFakeGit(fn: (capturedArgsFile: string) => Promise<void>): Promise<void> {
    const fakeGitDir = fs.mkdtempSync(path.join(tmpDir, 'fake-git-'));
    const capturedArgsFile = setupFakeGit(fakeGitDir);
    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeGitDir}:${origPath}`;
    try {
        await fn(capturedArgsFile);
    } finally {
        process.env.PATH = origPath;
    }
}

function readCaptured(capturedArgsFile: string): string {
    return fs.existsSync(capturedArgsFile) ? fs.readFileSync(capturedArgsFile, 'utf8') : '';
}

// ─── getRemoteUrl() / setRemoteUrl() ──────────────────────────────────────────

test('getRemoteUrl() returns the configured origin URL', async () => {
    const url = await getRemoteUrl(clonePath);
    assert.ok(url?.includes(originRepoPath), `expected origin URL to include "${originRepoPath}", got: ${url}`);
});

test('getRemoteUrl() returns null for a non-existent remote', async () => {
    const url = await getRemoteUrl(clonePath, 'does-not-exist');
    assert.equal(url, null);
});

test('setRemoteUrl() changes the URL read back by getRemoteUrl()', async () => {
    const before = await getRemoteUrl(clonePath);
    await setRemoteUrl(clonePath, 'https://example.invalid/org/repo.git');
    const after = await getRemoteUrl(clonePath);
    assert.equal(after, 'https://example.invalid/org/repo.git');

    // Restore for subsequent tests.
    await setRemoteUrl(clonePath, before!);
    assert.equal(await getRemoteUrl(clonePath), before);
});

// ─── fetchBranch() ─────────────────────────────────────────────────────────────

test('fetchBranch() builds the exact refspec arguments', async () => {
    await withFakeGit(async (capturedArgsFile) => {
        await fetchBranch(clonePath, 'main');
        const captured = readCaptured(capturedArgsFile);
        assert.ok(
            captured.includes('fetch origin +refs/heads/main:refs/remotes/origin/main'),
            `expected refspec in captured args, got: "${captured}"`,
        );
    });
});

test('fetchBranch() includes --filter when provided', async () => {
    await withFakeGit(async (capturedArgsFile) => {
        await fetchBranch(clonePath, 'main', { filter: 'blob:none' });
        const captured = readCaptured(capturedArgsFile);
        assert.ok(
            captured.includes('--filter=blob:none'),
            `expected --filter=blob:none in captured args, got: "${captured}"`,
        );
    });
});

test('fetchBranch() rejects an invalid branch name without invoking git', async () => {
    await withFakeGit(async (capturedArgsFile) => {
        const result = await fetchBranch(clonePath, '-malicious');
        assert.equal(result.exitCode, 128);
        assert.ok(!fs.existsSync(capturedArgsFile), 'git must not have been invoked for an invalid branch name');
    });
});

test('fetchBranch() rejects a branch name containing ".."', async () => {
    const result = await fetchBranch(clonePath, 'foo/../bar');
    assert.equal(result.exitCode, 128);
});

test('fetchBranch() actually fetches the named branch from a real origin', async () => {
    // Create a second branch on origin with a new commit.
    git('checkout -b feature', originRepoPath);
    fs.writeFileSync(path.join(originRepoPath, 'feature.md'), 'feature content');
    git('add .', originRepoPath);
    git('commit -m "feature commit"', originRepoPath);
    git('checkout main', originRepoPath);

    const result = await fetchBranch(clonePath, 'feature');
    assert.equal(result.exitCode, 0, `fetch failed: ${result.stderr}`);

    const ref = git('rev-parse refs/remotes/origin/feature', clonePath);
    assert.ok(ref.length > 0, 'expected refs/remotes/origin/feature to exist after fetch');
});

// ─── pushHead() ────────────────────────────────────────────────────────────────

test('pushHead() builds the exact push arguments', async () => {
    await withFakeGit(async (capturedArgsFile) => {
        await pushHead(clonePath, 'main');
        const captured = readCaptured(capturedArgsFile);
        assert.ok(
            captured.includes('push origin HEAD:refs/heads/main'),
            `expected push arguments in captured args, got: "${captured}"`,
        );
    });
});

test('pushHead() rejects an invalid branch name without invoking git', async () => {
    await withFakeGit(async (capturedArgsFile) => {
        const result = await pushHead(clonePath, '-malicious');
        assert.equal(result.exitCode, 128);
        assert.ok(!fs.existsSync(capturedArgsFile), 'git must not have been invoked for an invalid branch name');
    });
});

test('pushHead() actually pushes a new commit to a real origin', async () => {
    fs.writeFileSync(path.join(clonePath, 'pushed.md'), 'pushed content');
    git('add .', clonePath);
    git('commit -m "pushed commit"', clonePath);

    const result = await pushHead(clonePath, 'main');
    assert.equal(result.exitCode, 0, `push failed: ${result.stderr}`);

    const originLog = git('log -1 --format=%s', originRepoPath);
    assert.equal(originLog, 'pushed commit');
});

// ─── mergeFastForward() / countAheadBehind() / changedPathsBetween() ─────────

test('mergeFastForward() fast-forwards after a fetch', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'ff-test-'));
    const ffOrigin = path.join(dir, 'origin');
    const ffClone = path.join(dir, 'clone');
    fs.mkdirSync(ffOrigin);
    git('init -b main', ffOrigin);
    git('config user.email "test@test.local"', ffOrigin);
    git('config user.name "Test"', ffOrigin);
    fs.writeFileSync(path.join(ffOrigin, 'a.md'), 'a');
    git('add .', ffOrigin);
    git('commit -m "a"', ffOrigin);

    execSync(`git clone "${ffOrigin}" "${ffClone}"`, { cwd: dir });

    fs.writeFileSync(path.join(ffOrigin, 'b.md'), 'b');
    git('add .', ffOrigin);
    git('commit -m "b"', ffOrigin);

    const fetchResult = await fetchBranch(ffClone, 'main');
    assert.equal(fetchResult.exitCode, 0, `fetch failed: ${fetchResult.stderr}`);

    const mergeResult = await mergeFastForward(ffClone, 'main');
    assert.equal(mergeResult.exitCode, 0, `merge failed: ${mergeResult.stderr}`);
    assert.ok(fs.existsSync(path.join(ffClone, 'b.md')), 'expected b.md to exist after fast-forward merge');
});

test('mergeFastForward() rejects an invalid branch name without invoking git', async () => {
    const result = await mergeFastForward(clonePath, '-malicious');
    assert.equal(result.exitCode, 128);
});

test('countAheadBehind() reports ahead and behind counts', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'ahead-behind-test-'));
    const abOrigin = path.join(dir, 'origin');
    const abClone = path.join(dir, 'clone');
    fs.mkdirSync(abOrigin);
    git('init -b main', abOrigin);
    git('config user.email "test@test.local"', abOrigin);
    git('config user.name "Test"', abOrigin);
    fs.writeFileSync(path.join(abOrigin, 'a.md'), 'a');
    git('add .', abOrigin);
    git('commit -m "a"', abOrigin);

    execSync(`git clone "${abOrigin}" "${abClone}"`, { cwd: dir });
    git('config user.email "test@test.local"', abClone);
    git('config user.name "Test"', abClone);

    // Origin gets one more commit (clone will be "behind" after fetch).
    fs.writeFileSync(path.join(abOrigin, 'b.md'), 'b');
    git('add .', abOrigin);
    git('commit -m "b"', abOrigin);
    await fetchBranch(abClone, 'main');

    // Clone gets one local commit (clone will be "ahead").
    fs.writeFileSync(path.join(abClone, 'c.md'), 'c');
    git('add .', abClone);
    git('commit -m "c"', abClone);

    const { ahead, behind } = await countAheadBehind(abClone, 'main');
    assert.equal(ahead, 1, `expected ahead: 1, got: ${ahead}`);
    assert.equal(behind, 1, `expected behind: 1, got: ${behind}`);
});

test('countAheadBehind() returns zeros for an invalid branch name', async () => {
    const result = await countAheadBehind(clonePath, '-malicious');
    assert.deepEqual(result, { ahead: 0, behind: 0 });
});

test('changedPathsBetween() lists paths that differ between two commits', async () => {
    const before = git('rev-parse HEAD', clonePath);
    fs.writeFileSync(path.join(clonePath, 'changed.md'), 'changed content');
    git('add .', clonePath);
    git('commit -m "changed commit"', clonePath);
    const after = git('rev-parse HEAD', clonePath);

    const paths = await changedPathsBetween(clonePath, before, after);
    assert.ok(paths.includes('changed.md'), `expected "changed.md" in: ${JSON.stringify(paths)}`);
});

test('changedPathsBetween() returns an empty array for an invalid ref', async () => {
    const paths = await changedPathsBetween(clonePath, '-malicious', 'HEAD');
    assert.deepEqual(paths, []);
});

// ─── remoteUrlsMatch() ──────────────────────────────────────────────────────────

test('remoteUrlsMatch() matches identical HTTPS URLs', () => {
    assert.equal(
        remoteUrlsMatch('https://github.com/org/repo.git', 'https://github.com/org/repo.git'),
        true,
    );
});

test('remoteUrlsMatch() matches URLs differing only by a trailing ".git" suffix', () => {
    assert.equal(
        remoteUrlsMatch('https://github.com/org/repo.git', 'https://github.com/org/repo'),
        true,
    );
});

test('remoteUrlsMatch() matches URLs differing only by a trailing slash', () => {
    assert.equal(
        remoteUrlsMatch('https://github.com/org/repo/', 'https://github.com/org/repo'),
        true,
    );
});

test('remoteUrlsMatch() matches URLs differing only by hostname case', () => {
    assert.equal(
        remoteUrlsMatch('https://GitHub.com/org/repo.git', 'https://github.com/org/repo.git'),
        true,
    );
});

test('remoteUrlsMatch() matches URLs differing only by an embedded credential', () => {
    assert.equal(
        remoteUrlsMatch('https://token@github.com/org/repo.git', 'https://github.com/org/repo.git'),
        true,
    );
});

test('remoteUrlsMatch() rejects URLs with a different path', () => {
    assert.equal(
        remoteUrlsMatch('https://github.com/org/repo-a.git', 'https://github.com/org/repo-b.git'),
        false,
    );
});

test('remoteUrlsMatch() rejects URLs with a different host', () => {
    assert.equal(
        remoteUrlsMatch('https://github.com/org/repo.git', 'https://gitlab.com/org/repo.git'),
        false,
    );
});

test('remoteUrlsMatch() matches SCP-style SSH URLs differing only by hostname case', () => {
    assert.equal(
        remoteUrlsMatch('git@GitHub.com:org/repo.git', 'git@github.com:org/repo.git'),
        true,
    );
});
