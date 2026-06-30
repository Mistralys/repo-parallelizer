import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { loadConfig, saveConfigField } from '../config/config.js';
import { MAX_CREDENTIAL_ID_LENGTH } from '../config/config.constants.js';
import { createTempDirTracker } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-config-test-');

function writeConfig(dir: string, data: Record<string, unknown>): string {
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(data, null, 4) + '\n', 'utf8');
    return configPath;
}

/**
 * Installs a `console.warn` spy, runs `fn`, restores the original, and returns
 * all captured warning strings (each joined from all arguments with a space).
 */
function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
        const result = fn();
        return { result, warnings };
    } finally {
        console.warn = originalWarn;
    }
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

// --- gitCredentials: absent / null ---

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

// --- gitCredentials: new array format ---

test('loadConfig() returns an empty array when gitCredentials is []', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [],
    });
    const config = loadConfig(configPath);
    assert.deepStrictEqual(config.gitCredentials, []);
});

test('loadConfig() returns parsed GitCredentialEntry[] when new-format array is provided', () => {
    const dir = makeTempDir();
    const entry = { id: 'github-com', label: 'GitHub', host: 'github.com', token: 'ghp_token123' };
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [entry],
    });
    const config = loadConfig(configPath);
    assert.deepStrictEqual(config.gitCredentials, [entry]);
});

test('loadConfig() returns multiple GitCredentialEntry objects for the same host', () => {
    const dir = makeTempDir();
    const entries = [
        { id: 'work-account', label: 'Work GitHub', host: 'github.com', token: 'ghp_work' },
        { id: 'personal-account', label: 'Personal GitHub', host: 'github.com', token: 'ghp_personal' },
    ];
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: entries,
    });
    const config = loadConfig(configPath);
    assert.deepStrictEqual(config.gitCredentials, entries);
});

test('loadConfig() throws when gitCredentials array has duplicate id values', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [
            { id: 'same-id', label: 'A', host: 'github.com', token: 'tok1' },
            { id: 'same-id', label: 'B', host: 'gitlab.com', token: 'tok2' },
        ],
    });
    assert.throws(() => loadConfig(configPath), /duplicate id "same-id"/);
});

test('loadConfig() throws when a GitCredentialEntry has an empty id', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [{ id: '', label: 'GitHub', host: 'github.com', token: 'tok' }],
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials\[0\]\.id.*non-empty/);
});

test('loadConfig() throws when a GitCredentialEntry has an empty label', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [{ id: 'github-com', label: '', host: 'github.com', token: 'tok' }],
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials\[0\]\.label.*non-empty/);
});

test('loadConfig() throws when a GitCredentialEntry has an empty host', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [{ id: 'github-com', label: 'GitHub', host: '', token: 'tok' }],
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials\[0\]\.host.*non-empty/);
});

test('loadConfig() throws when a GitCredentialEntry has an empty token', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [{ id: 'github-com', label: 'GitHub', host: 'github.com', token: '' }],
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials\[0\]\.token.*non-empty/);
});

test('loadConfig() throws when gitCredentials array contains a non-object element', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: ['raw-token'],
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials\[0\].*credential object/);
});

// --- gitCredentials: per-field length limits (WP-005) ---

test('loadConfig() throws when a GitCredentialEntry id exceeds 100 characters', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [{ id: 'a'.repeat(101), label: 'GitHub', host: 'github.com', token: 'tok' }],
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials\[0\]\.id.*100/);
});

test('loadConfig() throws when a GitCredentialEntry label exceeds 200 characters', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [{ id: 'github-com', label: 'a'.repeat(201), host: 'github.com', token: 'tok' }],
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials\[0\]\.label.*200/);
});

test('loadConfig() throws when a GitCredentialEntry host exceeds 253 characters', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [{ id: 'github-com', label: 'GitHub', host: 'a'.repeat(254), token: 'tok' }],
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials\[0\]\.host.*253/);
});

test('loadConfig() throws when a GitCredentialEntry token exceeds 500 characters', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [{ id: 'github-com', label: 'GitHub', host: 'github.com', token: 'a'.repeat(501) }],
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials\[0\]\.token.*500/);
});

test('loadConfig() accepts GitCredentialEntry fields exactly at each length limit', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [{
            id: 'a'.repeat(100),
            label: 'a'.repeat(200),
            host: 'a'.repeat(253),
            token: 'a'.repeat(500),
        }],
    });
    assert.doesNotThrow(() => loadConfig(configPath), 'fields at length limit should be accepted');
});

// --- gitCredentials: old Record<string, string> format — migration ---

test('loadConfig() migrates old Record<string,string> gitCredentials to GitCredentialEntry[]', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'github.com': 'ghp_token123', 'gitlab.com': 'glpat_abc' },
    });
    const config = loadConfig(configPath);
    assert.ok(Array.isArray(config.gitCredentials), 'gitCredentials should be an array after migration');
    const entries = config.gitCredentials!;
    assert.strictEqual(entries.length, 2);
    const github = entries.find(e => e.host === 'github.com');
    assert.ok(github, 'expected an entry for github.com');
    assert.strictEqual(github!.id, 'github-com');
    assert.strictEqual(github!.label, 'github.com');
    assert.strictEqual(github!.token, 'ghp_token123');
    const gitlab = entries.find(e => e.host === 'gitlab.com');
    assert.ok(gitlab, 'expected an entry for gitlab.com');
    assert.strictEqual(gitlab!.id, 'gitlab-com');
    assert.strictEqual(gitlab!.label, 'gitlab.com');
    assert.strictEqual(gitlab!.token, 'glpat_abc');
});

test('loadConfig() migration: id is derived from hostname in kebab-case', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'my.git.server.internal': 'secret' },
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.gitCredentials![0].id, 'my-git-server-internal');
});

test('loadConfig() migration: label is set to the original hostname', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'github.com': 'tok' },
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.gitCredentials![0].label, 'github.com');
});

test('loadConfig() migration: host field is preserved exactly', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'github.com': 'tok' },
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.gitCredentials![0].host, 'github.com');
});

test('loadConfig() migration: empty {} gitCredentials returns undefined', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: {},
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.gitCredentials, undefined);
});

test('loadConfig() migration: duplicate kebab-case IDs get numeric suffix disambiguation', () => {
    const dir = makeTempDir();
    // Two hostnames that both resolve to the same kebab-case slug.
    // "github.com" → "github-com" and "github-com" (if used as a hostname) → "github-com"
    // We craft a realistic case: "github.com" → "github-com" and "github-com" → "github-com"
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'github.com': 'token1', 'github-com': 'token2' },
    });
    const config = loadConfig(configPath);
    const entries = config.gitCredentials!;
    assert.strictEqual(entries.length, 2);
    const ids = entries.map(e => e.id);
    // Both should be present but with different IDs
    assert.ok(ids.includes('github-com'), 'first collision should get base id');
    assert.ok(ids.includes('github-com-2'), 'second collision should get -2 suffix');
});

test('loadConfig() migration is idempotent — re-parsing already-migrated array gives same result', () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();

    // First pass: parse old format to get migrated entries
    const configPath1 = writeConfig(dir1, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'github.com': 'ghp_tok', 'gitlab.com': 'glpat_tok' },
    });
    const first = loadConfig(configPath1);
    const migratedEntries = first.gitCredentials!;

    // Second pass: write migrated entries back and parse again
    const configPath2 = writeConfig(dir2, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: migratedEntries,
    });
    const second = loadConfig(configPath2);

    assert.deepStrictEqual(second.gitCredentials, migratedEntries);
});

test('loadConfig() throws when gitCredentials is a plain string', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: 'token',
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials/);
});

test('loadConfig() migration throws when a legacy credentials value is a number', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'github.com': 12345 },
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials entry #1 \(legacy format\).*string/);
});

test('loadConfig() migration throws when a legacy credentials value is an empty string', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'github.com': '' },
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials entry #1 \(legacy format\).*empty/);
});

// --- gitCredentials: whitespace trimming ---

test('loadConfig() trims leading/trailing whitespace from all four fields in new-format entries', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [
            { id: '  github-com  ', label: '  GitHub  ', host: '  github.com  ', token: '  ghp_token123  ' },
        ],
    });
    const config = loadConfig(configPath);
    const entry = config.gitCredentials![0];
    assert.strictEqual(entry.id, 'github-com');
    assert.strictEqual(entry.label, 'GitHub');
    assert.strictEqual(entry.host, 'github.com');
    assert.strictEqual(entry.token, 'ghp_token123');
});

test('loadConfig() trims all four fields across multiple new-format entries independently', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [
            { id: ' work  ', label: '\tWork GitHub\t', host: '\ngithub.com\n', token: '  tok1  ' },
            { id: '  personal  ', label: '  Personal  ', host: '  gitlab.com  ', token: '  tok2  ' },
        ],
    });
    const config = loadConfig(configPath);
    const [e1, e2] = config.gitCredentials!;
    assert.strictEqual(e1.id, 'work');
    assert.strictEqual(e1.label, 'Work GitHub');
    assert.strictEqual(e1.host, 'github.com');
    assert.strictEqual(e1.token, 'tok1');
    assert.strictEqual(e2.id, 'personal');
    assert.strictEqual(e2.label, 'Personal');
    assert.strictEqual(e2.host, 'gitlab.com');
    assert.strictEqual(e2.token, 'tok2');
});

test('loadConfig() new-format entries with already-trimmed values are unaffected', () => {
    const dir = makeTempDir();
    const entry = { id: 'github-com', label: 'GitHub', host: 'github.com', token: 'ghp_token' };
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [entry],
    });
    const config = loadConfig(configPath);
    assert.deepStrictEqual(config.gitCredentials![0], entry);
});

test('loadConfig() trims host and token in legacy-format entries', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { '  github.com  ': '  ghp_token123  ' },
    });
    const config = loadConfig(configPath);
    const entry = config.gitCredentials![0];
    assert.strictEqual(entry.host, 'github.com');
    assert.strictEqual(entry.token, 'ghp_token123');
});

test('loadConfig() trims label in legacy-format entries', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { '  github.com  ': 'ghp_token' },
    });
    const config = loadConfig(configPath);
    const entry = config.gitCredentials![0];
    assert.strictEqual(entry.label, 'github.com');
});

test('loadConfig() rejects GitCredentialEntry field whose raw length exceeds limit even if trimmed value would be within limit', () => {
    const dir = makeTempDir();
    // id limit is 100; raw length = 101 (100 'a' chars + 1 space), trimmed length = 100
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: [{ id: 'a'.repeat(MAX_CREDENTIAL_ID_LENGTH) + ' ', label: 'GitHub', host: 'github.com', token: 'tok' }],
    });
    assert.throws(() => loadConfig(configPath), /gitCredentials\[0\]\.id.*100/);
});

test('loadConfig() legacy-format entries with already-trimmed values are unaffected', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitCredentials: { 'github.com': 'ghp_token' },
    });
    const config = loadConfig(configPath);
    const entry = config.gitCredentials![0];
    assert.strictEqual(entry.host, 'github.com');
    assert.strictEqual(entry.token, 'ghp_token');
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

// --- notesCardHeight ---

test('loadConfig() returns notesCardHeight default (220) when field is absent', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.notesCardHeight, 220);
});

test('loadConfig() preserves an explicit notesCardHeight value', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        notesCardHeight: 350,
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.notesCardHeight, 350);
});

test('loadConfig() falls back to default notesCardHeight when field is a non-number', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        notesCardHeight: 'tall',
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.notesCardHeight, 220);
});

// --- notesColumns ---

test('loadConfig() returns notesColumns default (2) when field is absent', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.notesColumns, 2);
});

test('loadConfig() preserves an explicit notesColumns value', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        notesColumns: 4,
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.notesColumns, 4);
});

test('loadConfig() falls back to default notesColumns when field is a non-number', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        notesColumns: null,
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.notesColumns, 2);
});

// --- Float rejection (integer guard) ---

test('loadConfig() falls back to default notesCardHeight when value is a float', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        notesCardHeight: 220.5,
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.notesCardHeight, 220, 'float notesCardHeight should fall back to DEFAULT_NOTES_CARD_HEIGHT');
});

test('loadConfig() falls back to default notesColumns when value is a float', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        notesColumns: 2.5,
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.notesColumns, 2, 'float notesColumns should fall back to DEFAULT_NOTES_COLUMNS');
});

test('loadConfig() falls back to default cloneDepth when value is a float', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        cloneDepth: 10.1,
    });
    const config = loadConfig(configPath);
    assert.strictEqual(config.cloneDepth, 50, 'float cloneDepth should fall back to default (50)');
});

// --- Out-of-range warnings (console.warn spy) ---

test('loadConfig() emits console.warn when notesCardHeight is below MIN (120)', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        notesCardHeight: 50,
    });
    const { result: config, warnings } = captureWarnings(() => loadConfig(configPath));
    assert.strictEqual(config.notesCardHeight, 50, 'out-of-range value should be passed through without clamping');
    assert.ok(warnings.length >= 1, 'expected at least one console.warn call');
    assert.ok(warnings.some(w => w.includes('notesCardHeight')), 'warning should mention the field name');
});

test('loadConfig() emits console.warn when notesCardHeight is above MAX (800)', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        notesCardHeight: 1000,
    });
    const { result: config, warnings } = captureWarnings(() => loadConfig(configPath));
    assert.strictEqual(config.notesCardHeight, 1000, 'out-of-range value should be passed through without clamping');
    assert.ok(warnings.length >= 1, 'expected at least one console.warn call');
    assert.ok(warnings.some(w => w.includes('notesCardHeight')), 'warning should mention the field name');
});

test('loadConfig() emits console.warn when notesColumns is below MIN (1)', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        notesColumns: 0,
    });
    const { result: config, warnings } = captureWarnings(() => loadConfig(configPath));
    assert.strictEqual(config.notesColumns, 0, 'out-of-range value should be passed through without clamping');
    assert.ok(warnings.length >= 1, 'expected at least one console.warn call');
    assert.ok(warnings.some(w => w.includes('notesColumns')), 'warning should mention the field name');
});

test('loadConfig() emits console.warn when notesColumns is above MAX (6)', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        notesColumns: 10,
    });
    const { result: config, warnings } = captureWarnings(() => loadConfig(configPath));
    assert.strictEqual(config.notesColumns, 10, 'out-of-range value should be passed through without clamping');
    assert.ok(warnings.length >= 1, 'expected at least one console.warn call');
    assert.ok(warnings.some(w => w.includes('notesColumns')), 'warning should mention the field name');
});

test('loadConfig() emits console.warn when gitPollingIntervalSeconds is below MIN (10)', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        gitPollingIntervalSeconds: 5,
    });
    const { result: config, warnings } = captureWarnings(() => loadConfig(configPath));
    assert.strictEqual(config.gitPollingIntervalSeconds, 5, 'out-of-range value should be passed through without clamping');
    assert.ok(warnings.length >= 1, 'expected at least one console.warn call');
    assert.ok(warnings.some(w => w.includes('gitPollingIntervalSeconds')), 'warning should mention the field name');
});

test('loadConfig() does not emit console.warn for in-range numeric values', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        notesCardHeight: 300,
        notesColumns: 3,
        gitPollingIntervalSeconds: 60,
    });
    const { warnings } = captureWarnings(() => loadConfig(configPath));
    assert.strictEqual(warnings.length, 0, 'no console.warn expected for in-range values');
});

// --- cloneDepth out-of-range warnings ---

test('loadConfig() emits console.warn when cloneDepth is below MIN (0)', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        cloneDepth: -1,
    });
    const { result: config, warnings } = captureWarnings(() => loadConfig(configPath));
    assert.strictEqual(config.cloneDepth, -1, 'out-of-range value should be passed through without clamping');
    assert.ok(warnings.length >= 1, 'expected at least one console.warn call');
    assert.ok(warnings.some(w => w.includes('cloneDepth')), 'warning should mention the field name');
});

test('loadConfig() emits console.warn when cloneDepth is above MAX (2147483647)', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        cloneDepth: 2_147_483_648,
    });
    const { result: config, warnings } = captureWarnings(() => loadConfig(configPath));
    assert.strictEqual(config.cloneDepth, 2_147_483_648, 'out-of-range value should be passed through without clamping');
    assert.ok(warnings.length >= 1, 'expected at least one console.warn call');
    assert.ok(warnings.some(w => w.includes('cloneDepth')), 'warning should mention the field name');
});

// --- serverPort out-of-range warnings ---

test('loadConfig() emits console.warn when serverPort is below MIN (1)', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        serverPort: 0,
    });
    const { result: config, warnings } = captureWarnings(() => loadConfig(configPath));
    assert.strictEqual(config.serverPort, 0, 'out-of-range value should be passed through without clamping');
    assert.ok(warnings.length >= 1, 'expected at least one console.warn call');
    assert.ok(warnings.some(w => w.includes('serverPort')), 'warning should mention the field name');
});

test('loadConfig() emits console.warn when serverPort is above MAX (65535)', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        serverPort: 99999,
    });
    const { result: config, warnings } = captureWarnings(() => loadConfig(configPath));
    assert.strictEqual(config.serverPort, 99999, 'out-of-range value should be passed through without clamping');
    assert.ok(warnings.length >= 1, 'expected at least one console.warn call');
    assert.ok(warnings.some(w => w.includes('serverPort')), 'warning should mention the field name');
});
