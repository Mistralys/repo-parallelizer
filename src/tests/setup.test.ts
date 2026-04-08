/**
 * Tests for src/cli/setup.ts
 *
 * Strategy: `_promptPath` and `_promptNumber` accept injectable `_ask` /
 * `_confirm` callbacks so tests can simulate user input without touching stdin.
 * For `runSetup` integration tests we use a temp directory and patch
 * `getConfigPath` indirectly by writing a thin wrapper that calls the real
 * function but with an overridden config path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../config/config.js';
import { _promptPath, _promptNumber, runSetup, type SetupIO } from '../cli/setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-setup-test-'));
}

/** Creates a one-shot async function that returns successive values from `values`. */
function queue<T>(values: T[]): () => Promise<T> {
    let index = 0;
    return async () => {
        const value = values[index++];
        if (value === undefined) {
            throw new Error(`queue exhausted after ${values.length} calls`);
        }
        return value;
    };
}

// ---------------------------------------------------------------------------
// _promptNumber — defaults
// ---------------------------------------------------------------------------

test('_promptNumber returns default when input is empty', async () => {
    const ask = queue(['']); // empty input → default
    const result = await _promptNumber('Port', 4200, 1, 65535, ask);
    assert.strictEqual(result, 4200);
});

test('_promptNumber returns default 50 for cloneDepth when input is empty', async () => {
    const ask = queue(['']);
    const result = await _promptNumber('Clone depth', 50, 0, undefined as unknown as number, ask);
    assert.strictEqual(result, 50);
});

test('_promptNumber returns default 30 for pollingInterval when input is empty', async () => {
    const ask = queue(['']);
    const result = await _promptNumber('Interval', 30, 1, undefined as unknown as number, ask);
    assert.strictEqual(result, 30);
});

// ---------------------------------------------------------------------------
// _promptNumber — valid inputs
// ---------------------------------------------------------------------------

test('_promptNumber returns parsed integer on valid input', async () => {
    const ask = queue(['8080']);
    const result = await _promptNumber('Port', 4200, 1, 65535, ask);
    assert.strictEqual(result, 8080);
});

test('_promptNumber accepts 0 as valid cloneDepth (>= 0 range)', async () => {
    const ask = queue(['0']);
    const result = await _promptNumber('Clone depth', 50, 0, Infinity, ask);
    assert.strictEqual(result, 0);
});

test('_promptNumber accepts port 1 (lower boundary)', async () => {
    const ask = queue(['1']);
    const result = await _promptNumber('Port', 4200, 1, 65535, ask);
    assert.strictEqual(result, 1);
});

test('_promptNumber accepts port 65535 (upper boundary)', async () => {
    const ask = queue(['65535']);
    const result = await _promptNumber('Port', 4200, 1, 65535, ask);
    assert.strictEqual(result, 65535);
});

// ---------------------------------------------------------------------------
// _promptNumber — validation rejects bad input then accepts good input
// ---------------------------------------------------------------------------

test('_promptNumber rejects non-numeric input, then accepts valid input', async () => {
    const ask = queue(['abc', '9090']);
    const result = await _promptNumber('Port', 4200, 1, 65535, ask);
    assert.strictEqual(result, 9090);
});

test('_promptNumber rejects value below min, then accepts valid input', async () => {
    const ask = queue(['0', '1']); // 0 is below min=1
    const result = await _promptNumber('Port', 4200, 1, 65535, ask);
    assert.strictEqual(result, 1);
});

test('_promptNumber rejects value above max, then accepts valid input', async () => {
    const ask = queue(['99999', '3000']); // 99999 > 65535
    const result = await _promptNumber('Port', 4200, 1, 65535, ask);
    assert.strictEqual(result, 3000);
});

test('_promptNumber rejects negative cloneDepth (< 0), then accepts 0', async () => {
    const ask = queue(['-1', '0']);
    const result = await _promptNumber('Clone depth', 50, 0, Infinity, ask);
    assert.strictEqual(result, 0);
});

test('_promptNumber rejects zero pollingInterval (< 1), then accepts 1', async () => {
    const ask = queue(['0', '1']);
    const result = await _promptNumber('Interval', 30, 1, Infinity, ask);
    assert.strictEqual(result, 1);
});

test('_promptNumber rejects float input, then accepts integer', async () => {
    const ask = queue(['3.14', '30']);
    const result = await _promptNumber('Interval', 30, 1, Infinity, ask);
    assert.strictEqual(result, 30);
});

// ---------------------------------------------------------------------------
// _promptPath — existing directory
// ---------------------------------------------------------------------------

test('_promptPath returns resolved path when directory already exists', async () => {
    const dir = makeTempDir();
    const ask = queue([dir]);
    const confirm = queue<boolean>([]); // should not be called
    const result = await _promptPath('Label', undefined, ask, confirm);
    assert.strictEqual(result, dir);
});

test('_promptPath resolves absolute path as-is', async () => {
    const dir = makeTempDir();
    const ask = queue([dir]);
    const confirm = queue<boolean>([]);
    const result = await _promptPath('Projects folder', undefined, ask, confirm);
    assert.strictEqual(result, path.resolve(dir));
});

// ---------------------------------------------------------------------------
// _promptPath — default value
// ---------------------------------------------------------------------------

test('_promptPath uses defaultValue when input is empty and default provided', async () => {
    // The default hint is a relative path like 'data/storage'; the function
    // will try to resolve it against the tool root. We pre-create that path so
    // it exists (otherwise the creation prompt fires).
    const base = makeTempDir();
    const defaultRel = 'data/storage';
    const expectedAbs = path.resolve(base, defaultRel); // won't match tool root but...
    // Instead, supply an absolute path as default to keep test deterministic:
    fs.mkdirSync(expectedAbs, { recursive: true });

    // Supply empty input; default is the pre-existing absolute path.
    const ask = queue(['']); // empty → use default
    const confirm = queue<boolean>([]);
    const result = await _promptPath('Storage folder', expectedAbs, ask, confirm);
    assert.strictEqual(result, expectedAbs);
});

// ---------------------------------------------------------------------------
// _promptPath — directory creation
// ---------------------------------------------------------------------------

test('_promptPath creates directory when user confirms', async () => {
    const base = makeTempDir();
    const newDir = path.join(base, 'new-projects');
    assert.ok(!fs.existsSync(newDir), 'directory should not exist before test');

    const ask = queue([newDir]);
    const confirm = queue([true]); // user confirms creation
    const result = await _promptPath('Label', undefined, ask, confirm);

    assert.strictEqual(result, newDir);
    assert.ok(fs.existsSync(newDir), 'directory should have been created');
});

test('_promptPath loops when user declines creation, then accepts existing dir', async () => {
    const base = makeTempDir();
    const missingDir = path.join(base, 'missing');
    const existingDir = path.join(base, 'existing');
    fs.mkdirSync(existingDir, { recursive: true });

    // First attempt: missing dir, user declines → second attempt: existing dir
    const ask = queue([missingDir, existingDir]);
    const confirm = queue([false]); // declines creation once

    const result = await _promptPath('Label', undefined, ask, confirm);
    assert.strictEqual(result, existingDir);
    assert.ok(!fs.existsSync(missingDir), 'declined dir should not have been created');
});

test('_promptPath loops when input is empty and no default', async () => {
    const dir = makeTempDir();
    // First input empty (no default), second input valid
    const ask = queue(['', dir]);
    const confirm = queue<boolean>([]);

    const result = await _promptPath('Label', undefined, ask, confirm);
    assert.strictEqual(result, dir);
});

// ---------------------------------------------------------------------------
// runSetup integration — config file written and loadable
// ---------------------------------------------------------------------------

/**
 * A minimal integration harness: rather than patching `getConfigPath()` (which
 * would require module cache manipulation in ESM), we verify the contract at the
 * helper level and check that a config object built the same way as `runSetup`
 * can be loaded by `loadConfig()`.
 *
 * The key acceptance criterion is: "The generated config.json can be
 * successfully loaded by the existing loadConfig() function."
 */
test('config written by setup wizard passes loadConfig() validation', () => {
    const base = makeTempDir();
    const configPath = path.join(base, 'config.json');
    const projectsFolder = path.join(base, 'projects');
    const storageFolder = path.join(base, 'storage');

    fs.mkdirSync(projectsFolder, { recursive: true });
    fs.mkdirSync(storageFolder, { recursive: true });

    // Simulate what runSetup writes: JSON.stringify with 4-space indent + trailing newline
    const config = {
        projectsFolder,
        storageFolder,
        cloneDepth: 50,
        serverPort: 4200,
        gitPollingIntervalSeconds: 30,
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\n', 'utf8');

    const loaded = loadConfig(configPath);
    assert.strictEqual(loaded.projectsFolder, projectsFolder);
    assert.strictEqual(loaded.storageFolder, storageFolder);
    assert.strictEqual(loaded.cloneDepth, 50);
    assert.strictEqual(loaded.serverPort, 4200);
    assert.strictEqual(loaded.gitPollingIntervalSeconds, 30);
});

test('config written with custom numeric values passes loadConfig() validation', () => {
    const base = makeTempDir();
    const configPath = path.join(base, 'config.json');
    const projectsFolder = path.join(base, 'projects');
    const storageFolder = path.join(base, 'storage');

    fs.mkdirSync(projectsFolder, { recursive: true });
    fs.mkdirSync(storageFolder, { recursive: true });

    const config = {
        projectsFolder,
        storageFolder,
        cloneDepth: 0,
        serverPort: 8080,
        gitPollingIntervalSeconds: 60,
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\n', 'utf8');

    const loaded = loadConfig(configPath);
    assert.strictEqual(loaded.cloneDepth, 0);
    assert.strictEqual(loaded.serverPort, 8080);
    assert.strictEqual(loaded.gitPollingIntervalSeconds, 60);
});

// ---------------------------------------------------------------------------
// runSetup — module exports runSetup()
// ---------------------------------------------------------------------------

test('setup module exports runSetup as a function', async () => {
    const mod = await import('../cli/setup.js');
    assert.strictEqual(typeof mod.runSetup, 'function');
});

// ---------------------------------------------------------------------------
// runSetup — integration tests with injected IO stubs
// ---------------------------------------------------------------------------

/**
 * Runs `fn` with a temporary config path injected via `PARALIZER_CONFIG_PATH`.
 * Cleans up the file on completion regardless of outcome.
 *
 * @param fn - Async test body that receives the temp config path.
 */
async function withTempConfig(fn: (configPath: string) => Promise<void>): Promise<void> {
    const configPath = path.join(os.tmpdir(), `paralizer-test-config-${Date.now()}.json`);
    process.env['PARALIZER_CONFIG_PATH'] = configPath;

    process.on('exit', () => {
        try {
            if (fs.existsSync(configPath)) {
                fs.unlinkSync(configPath);
            }
        } catch {
            // Best-effort cleanup.
        }
    });

    try {
        await fn(configPath);
    } finally {
        delete process.env['PARALIZER_CONFIG_PATH'];
        try {
            if (fs.existsSync(configPath)) {
                fs.unlinkSync(configPath);
            }
        } catch {
            // Best-effort cleanup.
        }
    }
}

test('runSetup writes config.json with expected values via IO adapter', async () => {
    const base = makeTempDir();
    const projectsFolder = path.join(base, 'projects');
    const storageFolder = path.join(base, 'storage');
    fs.mkdirSync(projectsFolder, { recursive: true });
    fs.mkdirSync(storageFolder, { recursive: true });

    await withTempConfig(async (configPath) => {
        const answers = [
            projectsFolder,  // projects folder path
            storageFolder,   // storage folder path
            '10',            // clone depth
            '3500',          // server port
            '60',            // polling interval
        ];
        let answerIndex = 0;
        const io: SetupIO = {
            ask: async () => answers[answerIndex++] ?? '',
            confirm: async (_prompt: string, defaultYes?: boolean) => defaultYes ?? false,
        };

        await runSetup(io);

        const loaded = loadConfig(configPath);
        assert.strictEqual(loaded.projectsFolder, projectsFolder);
        assert.strictEqual(loaded.storageFolder, storageFolder);
        assert.strictEqual(loaded.cloneDepth, 10);
        assert.strictEqual(loaded.serverPort, 3500);
        assert.strictEqual(loaded.gitPollingIntervalSeconds, 60);

        assert.ok(fs.existsSync(storageFolder), 'storage folder should exist after setup');
    });
});

test('runSetup cancels cleanly when user declines overwrite', async () => {
    await withTempConfig(async (configPath) => {
        // Write a sentinel config so the overwrite prompt fires.
        const sentinel = JSON.stringify({
            projectsFolder: '/tmp/sentinel',
            storageFolder: '/tmp/sentinel-storage',
            cloneDepth: 5,
            serverPort: 9999,
            gitPollingIntervalSeconds: 15,
        });
        fs.writeFileSync(configPath, sentinel, 'utf8');

        const io: SetupIO = {
            ask: async () => { throw new Error('ask() should not be called when user cancels'); },
            confirm: async () => false, // decline overwrite
        };

        await assert.doesNotReject(async () => runSetup(io));

        const after = fs.readFileSync(configPath, 'utf8');
        assert.strictEqual(after, sentinel, 'config.json should not have been modified');
    });
});
