import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'node:path';
import { runGit, runGitOrThrow } from '../git/git-cli.js';

// ─── Fixture setup ────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-git-cli-test-'));

// Ensure the temporary directory is removed when the process exits.
process.on('exit', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── runGit() ─────────────────────────────────────────────────────────────────

test('runGit() resolves and captures stdout for git --version', async () => {
    const result = await runGit(['--version'], tmpDir);

    assert.equal(result.exitCode, 0);
    assert.ok(
        result.stdout.includes('git version'),
        `expected stdout to contain "git version", got: ${JSON.stringify(result.stdout)}`,
    );
});

test('runGit() resolves (does not reject) with a non-zero exit code for a bad command', async () => {
    // 'git' with an unknown subcommand always exits non-zero but does not
    // cause a spawn error — the promise must resolve, never reject.
    const result = await runGit(['invalid-subcommand-xyz'], tmpDir);

    assert.ok(
        result.exitCode !== 0,
        `expected non-zero exit code, got ${result.exitCode}`,
    );
});

test('runGit() resolves when cwd is omitted (uses process cwd)', async () => {
    // Calling without an explicit cwd should fall back to the calling
    // process's working directory and still resolve successfully.
    const result = await runGit(['--version']);

    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('git version'));
});

test('runGit() result contains stdout, stderr, and exitCode properties', async () => {
    const result = await runGit(['--version'], tmpDir);

    assert.ok(Object.hasOwn(result, 'exitCode'), 'exitCode property missing');
    assert.ok(Object.hasOwn(result, 'stdout'), 'stdout property missing');
    assert.ok(Object.hasOwn(result, 'stderr'), 'stderr property missing');
    assert.equal(typeof result.exitCode, 'number');
    assert.equal(typeof result.stdout, 'string');
    assert.equal(typeof result.stderr, 'string');
});

// ─── runGitOrThrow() ──────────────────────────────────────────────────────────

test('runGitOrThrow() returns trimmed stdout on success', async () => {
    const output = await runGitOrThrow(['--version'], tmpDir);

    assert.ok(
        output.includes('git version'),
        `expected output to contain "git version", got: ${JSON.stringify(output)}`,
    );
    // Trimmed: must not have leading/trailing whitespace
    assert.equal(output, output.trim());
});

test('runGitOrThrow() throws on a non-zero exit code', async () => {
    await assert.rejects(
        () => runGitOrThrow(['invalid-subcommand-xyz'], tmpDir),
        (err: unknown) => {
            assert.ok(err instanceof Error, 'expected an Error instance');
            return true;
        },
    );
});

test('runGitOrThrow() error message includes the exit code', async () => {
    await assert.rejects(
        () => runGitOrThrow(['invalid-subcommand-xyz'], tmpDir),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(
                /exit \d+/.test(err.message),
                `expected error message to contain "exit <n>", got: ${err.message}`,
            );
            return true;
        },
    );
});

// ─── Isolation: each test uses the shared tmpDir ──────────────────────────────
// tmpDir is created with mkdtempSync so it is unique per test run and is
// completely isolated from any real repository on the file system.

test('runGit() uses the provided cwd — operations are isolated in tmpDir', async () => {
    // Running git status in a plain (non-git) temp dir should fail gracefully:
    // exits non-zero, promise resolves.
    const result = await runGit(['status'], tmpDir);

    assert.ok(
        result.exitCode !== 0,
        `expected non-zero exit code in non-git directory, got ${result.exitCode}`,
    );
});

// ─── Timeout (AbortController) ────────────────────────────────────────────────

test('runGit() with timeoutMs aborts a hanging process and returns exitCode -1', async () => {
    // Start a TCP server that accepts connections but never sends data.
    // This stalls the git client at the protocol-handshake stage indefinitely.
    const server = net.createServer((_socket) => {
        // Deliberately stall: accept the connection but never write the initial
        // git protocol packet, so the git client blocks waiting for the server.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    const cloneDest = path.join(tmpDir, `timeout-clone-${Date.now()}`);

    try {
        const result = await runGit(
            ['clone', `git://127.0.0.1:${port}/repo`, cloneDest],
            tmpDir,
            { timeoutMs: 500 },
        );

        assert.strictEqual(result.exitCode, -1, `expected exitCode -1 (timed out), got ${result.exitCode}`);
        assert.ok(
            result.stderr.includes('timed out') || result.stderr.includes('aborted'),
            `expected timeout message in stderr, got: ${result.stderr}`,
        );
    } finally {
        server.close();
    }
});

test('runGit() completes normally when a generous timeoutMs is set', async () => {
    // git --version is fast; a 30-second timeout must never trigger.
    const result = await runGit(['--version'], tmpDir, { timeoutMs: 30_000 });

    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('git version'));
});

test('runGit() completes normally when timeoutMs is omitted', async () => {
    // Verify no timeout side-effect when the option is absent.
    const result = await runGit(['--version'], tmpDir);

    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('git version'));
});

// ─── Buffer limit ─────────────────────────────────────────────────────────────

test('runGit() with maxBufferBytes kills process when output exceeds limit and returns exitCode -1', async () => {
    // git --version outputs ~20 bytes; a 1-byte limit will be exceeded immediately.
    const result = await runGit(['--version'], tmpDir, { maxBufferBytes: 1 });

    assert.strictEqual(result.exitCode, -1, `expected exitCode -1 (buffer exceeded), got ${result.exitCode}`);
    assert.ok(
        result.stderr.includes('buffer limit'),
        `expected buffer-limit message in stderr, got: ${result.stderr}`,
    );
});
