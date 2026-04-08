import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../config/config.js';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-config-test-'));
}

function writeConfig(dir: string, data: Record<string, unknown>): string {
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(data, null, 4) + '\n', 'utf8');
    return configPath;
}

// --- Happy path ---

test('loadConfig() loads a minimal valid config with defaults applied', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.projectsFolder, '/tmp/projects');
    assert.strictEqual(config.storageFolder, '/tmp/storage');
    assert.strictEqual(config.cloneDepth, 50);
    assert.strictEqual(config.serverPort, 4200);
    assert.strictEqual(config.gitPollingIntervalSeconds, 30);
});

test('loadConfig() respects explicit optional values', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        cloneDepth: 10,
        serverPort: 8080,
        gitPollingIntervalSeconds: 60,
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.cloneDepth, 10);
    assert.strictEqual(config.serverPort, 8080);
    assert.strictEqual(config.gitPollingIntervalSeconds, 60);
});

// --- Missing-file errors ---

test('loadConfig() throws when config.json does not exist', () => {
    assert.throws(
        () => loadConfig('/nonexistent/path/config.json'),
        /config\.json not found/
    );
});

test('missing-config error message mentions config.dist.json', () => {
    let msg = '';
    try {
        loadConfig('/nonexistent/path/config.json');
    } catch (err) {
        msg = (err as Error).message;
    }
    assert.ok(msg.includes('config.dist.json'), 'error should reference config.dist.json');
});

// --- Validation errors ---

test('loadConfig() throws when projectsFolder is absent', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, { storageFolder: '/tmp/storage' });
    assert.throws(() => loadConfig(configPath), /projectsFolder/);
});

test('loadConfig() throws when storageFolder is absent', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, { projectsFolder: '/tmp/projects' });
    assert.throws(() => loadConfig(configPath), /storageFolder/);
});

test('loadConfig() throws when storageFolder is empty string', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '',
    });
    assert.throws(() => loadConfig(configPath), /storageFolder/);
});

test('loadConfig() throws when projectsFolder is a number (non-string)', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: 123,
        storageFolder: '/tmp/storage',
    });
    assert.throws(() => loadConfig(configPath), /projectsFolder/);
});

test('loadConfig() throws when projectsFolder is null', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: null,
        storageFolder: '/tmp/storage',
    });
    assert.throws(() => loadConfig(configPath), /projectsFolder/);
});
