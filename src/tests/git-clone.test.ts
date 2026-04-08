import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { cloneRepository } from '../git/git-clone.js';

// ─── Fixture setup (runs synchronously before any test) ──────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-clone-test-'));
const originRepoPath = path.join(tmpDir, 'origin');
let cloneCounter = 0;

// Ensure the temporary directory is removed when the process exits.
process.on('exit', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function nextCloneDest(): string {
    return path.join(tmpDir, `clone-${++cloneCounter}`);
}

// Initialise a local git repo with two commits on `main` plus an `extra-branch`
// so we can exercise both shallow-clone and branch-selection tests.
(function buildOriginFixture() {
    fs.mkdirSync(originRepoPath);
    execSync('git init -b main', { cwd: originRepoPath });
    execSync('git config user.email "test@test.local"', { cwd: originRepoPath });
    execSync('git config user.name "Test"', { cwd: originRepoPath });

    // Commit 1
    fs.writeFileSync(path.join(originRepoPath, 'README.md'), 'hello');
    execSync('git add .', { cwd: originRepoPath });
    execSync('git commit -m "initial"', { cwd: originRepoPath });

    // Commit 2 — ensures a history depth > 1 against which shallow clones can be verified
    fs.writeFileSync(path.join(originRepoPath, 'file2.md'), 'content');
    execSync('git add .', { cwd: originRepoPath });
    execSync('git commit -m "second"', { cwd: originRepoPath });

    // Extra branch with one additional commit
    execSync('git checkout -b extra-branch', { cwd: originRepoPath });
    fs.writeFileSync(path.join(originRepoPath, 'extra.md'), 'extra');
    execSync('git add .', { cwd: originRepoPath });
    execSync('git commit -m "extra branch commit"', { cwd: originRepoPath });

    // Return to main before tests run
    execSync('git checkout main', { cwd: originRepoPath });
})();

// ─── AC 1: --depth is included in the argument array ─────────────────────────

test('cloneRepository includes --depth in arguments when depth option is provided', async () => {
    const dest = nextCloneDest();
    // Use the file:// protocol so that git respects the --depth flag for local repos
    const result = await cloneRepository(`file://${originRepoPath}`, dest, { depth: 1 });

    assert.strictEqual(result.exitCode, 0, `clone failed: ${result.stderr}`);

    // A shallow clone with depth=1 should contain exactly 1 commit in git log
    const logOutput = execSync('git log --oneline', { cwd: dest }).toString().trim();
    const commitCount = logOutput.split('\n').filter(Boolean).length;
    assert.strictEqual(commitCount, 1, `expected 1 commit with depth=1, got ${commitCount}`);
});

// ─── AC 2: --branch is included when the option is provided ──────────────────

test('cloneRepository includes --branch when branch option is provided', async () => {
    const dest = nextCloneDest();
    const result = await cloneRepository(originRepoPath, dest, { branch: 'extra-branch' });

    assert.strictEqual(result.exitCode, 0, `clone failed: ${result.stderr}`);

    const checkedOutBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dest })
        .toString()
        .trim();
    assert.strictEqual(
        checkedOutBranch,
        'extra-branch',
        'cloned working tree should be on extra-branch',
    );
});

// ─── AC 3: --branch is omitted when the option is not provided ───────────────

test('cloneRepository omits --branch when branch option is not provided', async () => {
    const dest = nextCloneDest();
    const result = await cloneRepository(originRepoPath, dest, {});

    assert.strictEqual(result.exitCode, 0, `clone failed: ${result.stderr}`);

    const checkedOutBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dest })
        .toString()
        .trim();
    assert.strictEqual(
        checkedOutBranch,
        'main',
        'cloned working tree should be on the default branch (main)',
    );
});

// ─── AC 4: GitResult with exitCode 0 on a successful clone ───────────────────

test('cloneRepository returns a GitResult with exitCode 0 on a successful clone', async () => {
    const dest = nextCloneDest();
    const result = await cloneRepository(originRepoPath, dest);

    assert.strictEqual(result.exitCode, 0);
    assert.ok(typeof result.stdout === 'string', 'stdout should be a string');
    assert.ok(typeof result.stderr === 'string', 'stderr should be a string');
    assert.ok(fs.existsSync(path.join(dest, 'README.md')), 'cloned repo should contain README.md');
});

// ─── AC 5: GitResult with non-zero exitCode on failure, no throw ─────────────

test('cloneRepository returns a GitResult with non-zero exitCode on failure without throwing', async () => {
    const dest = nextCloneDest();
    const result = await cloneRepository('/nonexistent/repo/path/that/does/not/exist', dest);

    assert.ok(result.exitCode !== 0, `expected a non-zero exit code, got ${result.exitCode}`);
    assert.ok(typeof result.stderr === 'string', 'stderr should be a string');
});

// ─── Real public repository clone ────────────────────────────────────────────

test('cloneRepository clones a real public repository and verifies it exists on disk', { skip: process.env['SKIP_NETWORK_TESTS'] === '1' ? 'SKIP_NETWORK_TESTS=1' : false }, async () => {
    const dest = nextCloneDest();
    // Use the project's own public remote with depth=1 to keep the test fast.
    const result = await cloneRepository(
        'https://github.com/Mistralys/repo-parallelizer.git',
        dest,
        { depth: 1 },
    );

    assert.strictEqual(result.exitCode, 0, `clone failed: ${result.stderr}`);
    assert.ok(
        fs.existsSync(path.join(dest, 'README.md')),
        'cloned repo should contain README.md',
    );
});

// ─── AC 6: URL scheme validation ─────────────────────────────────────────────

test('cloneRepository accepts an https:// URL without rejecting it at validation', async () => {
    // We just check that the URL validation does not reject the URL; git itself
    // will fail because the host isn't reachable, but exitCode should NOT be 128
    // (which is our validation-layer rejection code).
    const dest = nextCloneDest();
    const result = await cloneRepository('https://example.invalid/repo.git', dest);

    assert.ok(
        result.exitCode !== 128 || !result.stderr.includes('disallowed transport'),
        'https:// URL should pass validation (git may still fail for network reasons)',
    );
});

test('cloneRepository accepts a git@ SCP-style SSH URL without rejecting it at validation', async () => {
    const dest = nextCloneDest();
    const result = await cloneRepository('git@github.com:none/nonexistent.git', dest);

    assert.ok(
        result.exitCode !== 128 || !result.stderr.includes('disallowed transport'),
        'git@ SCP URL should pass validation',
    );
});

test('cloneRepository rejects an ext:: URL with exitCode 128', async () => {
    const dest = nextCloneDest();
    const result = await cloneRepository('ext::some-command %S', dest);

    assert.strictEqual(result.exitCode, 128, `expected exitCode 128, got ${result.exitCode}`);
    assert.ok(
        result.stderr.includes('disallowed transport'),
        `expected disallowed-transport message, got: ${result.stderr}`,
    );
});

test('cloneRepository rejects an rsh:: URL with exitCode 128', async () => {
    const dest = nextCloneDest();
    const result = await cloneRepository('rsh::user@host/repo', dest);

    assert.strictEqual(result.exitCode, 128, `expected exitCode 128, got ${result.exitCode}`);
    assert.ok(
        result.stderr.includes('disallowed transport'),
        `expected disallowed-transport message, got: ${result.stderr}`,
    );
});

test('cloneRepository rejects an empty URL with exitCode 128', async () => {
    const dest = nextCloneDest();
    const result = await cloneRepository('', dest);

    assert.strictEqual(result.exitCode, 128, `expected exitCode 128, got ${result.exitCode}`);
    assert.ok(
        result.stderr.includes('disallowed transport'),
        `expected disallowed-transport message, got: ${result.stderr}`,
    );
});

test('cloneRepository rejects a whitespace-only URL with exitCode 128', async () => {
    const dest = nextCloneDest();
    const result = await cloneRepository('   ', dest);

    assert.strictEqual(result.exitCode, 128, `expected exitCode 128, got ${result.exitCode}`);
});

// ─── Cleartext URL warning ────────────────────────────────────────────────────

test('cloneRepository emits console.warn with "cleartext" for an http:// URL', async () => {
    const dest = nextCloneDest();
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
        // The clone will fail (unreachable host) but the warning must fire before git is invoked
        await cloneRepository('http://example.invalid/repo.git', dest);
    } finally {
        console.warn = originalWarn;
    }

    assert.ok(
        warnings.length > 0,
        'expected console.warn to be called for an http:// URL',
    );
    const message = warnings[0]!.join(' ');
    assert.ok(
        message.includes('cleartext'),
        `warning message should contain "cleartext", got: ${message}`,
    );
    assert.ok(
        message.includes('http://'),
        `warning message should contain the protocol "http://", got: ${message}`,
    );
});

test('cloneRepository emits console.warn with "cleartext" for a git:// URL', async () => {
    const dest = nextCloneDest();
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
        await cloneRepository('git://example.invalid/repo.git', dest);
    } finally {
        console.warn = originalWarn;
    }

    assert.ok(
        warnings.length > 0,
        'expected console.warn to be called for a git:// URL',
    );
    const message = warnings[0]!.join(' ');
    assert.ok(
        message.includes('cleartext'),
        `warning message should contain "cleartext", got: ${message}`,
    );
    assert.ok(
        message.includes('git://'),
        `warning message should contain the protocol "git://", got: ${message}`,
    );
});

test('cloneRepository does NOT emit console.warn for https:// or ssh:// URLs', async () => {
    const dest = nextCloneDest();
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
        await cloneRepository('https://example.invalid/repo.git', dest);
        await cloneRepository('ssh://example.invalid/repo.git', dest);
    } finally {
        console.warn = originalWarn;
    }

    assert.strictEqual(
        warnings.length,
        0,
        `expected no console.warn for https:// or ssh:// URLs, got ${warnings.length} warning(s)`,
    );
});

// ─── AC 7: bare clone ─────────────────────────────────────────────────────────

test('cloneRepository with bare:true produces a bare repository', async () => {
    const dest = nextCloneDest();
    const result = await cloneRepository(originRepoPath, dest, { bare: true });

    assert.strictEqual(result.exitCode, 0, `bare clone failed: ${result.stderr}`);

    // A bare clone has no working tree: the HEAD file lives at the root and
    // there is no .git subdirectory.
    assert.ok(
        fs.existsSync(path.join(dest, 'HEAD')),
        'bare clone should have a HEAD file at the root',
    );
    assert.ok(
        !fs.existsSync(path.join(dest, '.git')),
        'bare clone should not have a .git subdirectory',
    );
});
