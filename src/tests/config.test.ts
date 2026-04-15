import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { loadConfig, saveConfigField } from '../config/config.js';
import { createTempDirTracker } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-config-test-');

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

// --- gitCredentials ---

test('loadConfig() returns gitCredentials: undefined when field is absent', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.gitCredentials, undefined);
});

test('loadConfig() returns gitCredentials: undefined when field is null', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: null,
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.gitCredentials, undefined);
});

test('loadConfig() returns parsed gitCredentials when valid entries are present', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'github.com': 'ghp_token123', 'gitlab.com': 'glpat_abc' },
    });
    const config = loadConfig(configPath);
    assert.deepStrictEqual(config.gitCredentials, {
        'github.com': 'ghp_token123',
        'gitlab.com': 'glpat_abc',
    });
});

test('loadConfig() returns gitCredentials as empty object when field is {}', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: {},
    });
    const config = loadConfig(configPath);
    assert.deepStrictEqual(config.gitCredentials, {});
});

test('loadConfig() throws when gitCredentials is an array', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: ['token'],
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials.*plain object/);
});

test('loadConfig() throws when gitCredentials is a string', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: 'token',
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials.*plain object/);
});

test('loadConfig() throws when a gitCredentials value is a number', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'github.com': 12345 },
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials\["github\.com"\].*string/);
});

test('loadConfig() throws when a gitCredentials value is an empty string', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'github.com': '' },
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials\["github\.com"\].*empty/);
});

// --- saveConfigField() ---

test('saveConfigField() sets a new field while keeping all other fields intact', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        _instructions: 'Copy this file.',
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        cloneDepth: 10,
    });
    saveConfigField('gitCredentials', { 'github.com': 'token' }, configPath);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    assert.deepStrictEqual(raw['gitCredentials'], { 'github.com': 'token' });
    assert.strictEqual(raw['projectsFolder'], '/tmp/projects');
    assert.strictEqual(raw['storageFolder'], '/tmp/storage');
    assert.strictEqual(raw['cloneDepth'], 10);
    assert.strictEqual(raw['_instructions'], 'Copy this file.');
});

test('saveConfigField() removes the field when value is undefined', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'github.com': 'token' },
    });
    saveConfigField('gitCredentials', undefined, configPath);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    assert.ok(!Object.hasOwn(raw, 'gitCredentials'), 'gitCredentials should be absent after deletion');
    assert.strictEqual(raw['projectsFolder'], '/tmp/projects');
    assert.strictEqual(raw['storageFolder'], '/tmp/storage');
});

test('saveConfigField() preserves the _instructions field through a write round-trip', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        _instructions: 'Copy this file to config.json.',
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
    });
    saveConfigField('gitCredentials', { 'github.com': 'tok' }, configPath);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    assert.strictEqual(raw['_instructions'], 'Copy this file to config.json.');
});

test('saveConfigField() overwrites an existing field', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'github.com': 'old-token' },
    });
    saveConfigField('gitCredentials', { 'github.com': 'new-token' }, configPath);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    assert.deepStrictEqual(raw['gitCredentials'], { 'github.com': 'new-token' });
});

test('saveConfigField() is a no-op when deleting a non-existent field', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
    });
    saveConfigField('gitCredentials', undefined, configPath);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    assert.ok(!Object.hasOwn(raw, 'gitCredentials'));
    assert.strictEqual(raw['projectsFolder'], '/tmp/projects');
});

// --- File permissions ---

test('saveConfigField() sets file permissions to 0o600 on non-Windows platforms', () => {
    if (process.platform === 'win32') return; // skip on Windows

    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
    });
    saveConfigField('gitCredentials', { 'github.com': 'token' }, configPath);
    const mode = fs.statSync(configPath).mode & 0o777;
    assert.strictEqual(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
});

// --- webserverUrl ---

test('loadConfig() returns webserverUrl: undefined when field is absent', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.webserverUrl, undefined);
});

test('loadConfig() returns webserverUrl: undefined when field is null', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        webserverUrl: null,
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.webserverUrl, undefined);
});

test('loadConfig() returns webserverUrl: undefined when field is empty string', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        webserverUrl: '',
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.webserverUrl, undefined);
});

test('loadConfig() returns webserverUrl: undefined when field is whitespace-only', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        webserverUrl: '   ',
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.webserverUrl, undefined);
});

test('loadConfig() preserves a valid webserverUrl value', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        webserverUrl: 'http://localhost:8080',
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.webserverUrl, 'http://localhost:8080');
});

test('loadConfig() strips trailing slashes from webserverUrl', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        webserverUrl: 'http://localhost:8080///',
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.webserverUrl, 'http://localhost:8080');
});

test('loadConfig() trims leading/trailing whitespace from webserverUrl', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        webserverUrl: '  http://localhost:8080  ',
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.webserverUrl, 'http://localhost:8080');
});
