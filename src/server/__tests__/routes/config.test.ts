import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { Router } from '../../router.js';
import { registerConfigRoutes } from '../../routes/config.js';
import type { AppConfig, GitCredentialEntry } from '../../../config/config.types.js';
import type { PollingManager } from '../../pollingManager.js';
import type { ErrorLogManager } from '../../../error-log/error-log.manager.js';
import { mockRequest, mockResponse } from '../helpers/mock-http.js';
import { makeMockErrorLogManager } from '../helpers/mock-error-log-manager.js';

// ---------------------------------------------------------------------------
// Temp dir (cleaned up on process exit)
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-config-routes-test-'));

process.on('exit', () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal valid config.json in a temp subdirectory.
 * Returns the absolute path to the config file.
 */
function makeConfigFile(initial: Record<string, unknown> = {}): string {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'cfg-'));
    const configPath = path.join(dir, 'config.json');
    const base = {
        projectsFolder: dir,
        storageFolder: dir,
        cloneDepth: 50,
        serverPort: 4200,
        gitPollingIntervalSeconds: 30,
        ...initial,
    };
    fs.writeFileSync(configPath, JSON.stringify(base));
    return configPath;
}

function makeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
        projectsFolder: tmpRoot,
        storageFolder: tmpRoot,
        cloneDepth: 50,
        serverPort: 4200,
        gitPollingIntervalSeconds: 30,
        notesCardHeight: 220,
        notesColumns: 2,
        ...overrides,
    };
}

function readConfigFile(configPath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

/**
 * Creates a minimal PollingManager stub that records restart() calls.
 */
function makeMockPollingManager(): PollingManager & { restartCalls: number[]; } {
    const stub = {
        restartCalls: [] as number[],
        restart(intervalSeconds: number): void {
            stub.restartCalls.push(intervalSeconds);
        },
    };
    return stub as unknown as PollingManager & { restartCalls: number[]; };
}


function buildSut(
    appConfig: AppConfig,
    configPath: string,
    pollingManager?: PollingManager,
    errorLogManager?: ErrorLogManager,
): Router {
    const router = new Router();
    registerConfigRoutes({ router, appConfig, configPath, pollingManager, errorLogManager });
    return router;
}

// ---------------------------------------------------------------------------
// Credential test helpers
// ---------------------------------------------------------------------------

function makeCredential(overrides: Partial<GitCredentialEntry> = {}): GitCredentialEntry {
    return {
        id: 'github-personal',
        label: 'GitHub Personal',
        host: 'github.com',
        token: 'ghp_abcdefgh1234',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// GET /api/config/credentials
// ---------------------------------------------------------------------------

test('GET /api/config/credentials: returns 200 with empty array when no credentials configured', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/credentials');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(mock.body), []);
});

test('GET /api/config/credentials: returns masked tokens for all configured credentials', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({
        gitCredentials: [
            makeCredential({ id: 'github-personal', host: 'github.com', token: 'ghp_abcdefgh' }),
            makeCredential({ id: 'gitlab-work', label: 'GitLab Work', host: 'gitlab.com', token: 'glp_xyz' }),
        ],
    });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/credentials');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as GitCredentialEntry[];
    assert.ok(Array.isArray(body), 'response must be an array');
    assert.strictEqual(body.length, 2);
    const githubEntry = body.find((e) => e.id === 'github-personal');
    const gitlabEntry = body.find((e) => e.id === 'gitlab-work');
    assert.ok(githubEntry, 'github-personal entry must be present');
    assert.ok(gitlabEntry, 'gitlab-work entry must be present');
    assert.strictEqual(githubEntry?.token, '****efgh');
    assert.strictEqual(gitlabEntry?.token, '****_xyz');
});

test('GET /api/config/credentials: token shorter than 4 characters is fully masked', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({
        gitCredentials: [makeCredential({ id: 'short-token', token: 'abc' })],
    });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/credentials');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as GitCredentialEntry[];
    assert.strictEqual(body[0]?.token, '****');
});

test('GET /api/config/credentials: full token value is never present in the response', () => {
    const configPath = makeConfigFile();
    const token = 'ghp_supersecrettoken';
    const appConfig = makeAppConfig({
        gitCredentials: [makeCredential({ token })],
    });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/credentials');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.ok(!mock.body.includes(token), 'full token must not appear in the response body');
});

test('GET /api/config/credentials: response entries include id, label, host fields', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({
        gitCredentials: [
            makeCredential({ id: 'my-cred', label: 'My Cred', host: 'github.com', token: 'ghp_abc' }),
        ],
    });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/credentials');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as GitCredentialEntry[];
    assert.strictEqual(body[0]?.id, 'my-cred');
    assert.strictEqual(body[0]?.label, 'My Cred');
    assert.strictEqual(body[0]?.host, 'github.com');
});

// ---------------------------------------------------------------------------
// PUT /api/config/credentials — new entry without id (auto-generates id)
// ---------------------------------------------------------------------------

test('PUT /api/config/credentials: creates new entry with auto-generated id from label', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'GitHub Personal',
        host: 'github.com',
        token: 'ghp_full_token',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as GitCredentialEntry[];
    assert.ok(Array.isArray(body), 'response must be an array');
    assert.strictEqual(body.length, 1);
    assert.strictEqual(body[0]?.id, 'github-personal', 'id should be kebab-case of label');
    assert.strictEqual(body[0]?.label, 'GitHub Personal');
    assert.strictEqual(body[0]?.host, 'github.com');
    assert.ok(body[0]?.token.startsWith('****'), 'token must be masked');
    assert.ok(!body[0]?.token.includes('ghp_full_token'), 'full token must not appear');
});

test('PUT /api/config/credentials: persists new entry to config file on disk', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'GitHub Personal',
        host: 'github.com',
        token: 'ghp_stored_token',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    const saved = readConfigFile(configPath);
    assert.ok(Array.isArray(saved['gitCredentials']), 'gitCredentials must be an array');
    const creds = saved['gitCredentials'] as GitCredentialEntry[];
    assert.strictEqual(creds.length, 1);
    assert.strictEqual(creds[0]?.token, 'ghp_stored_token', 'plaintext token must be persisted');
    assert.strictEqual(creds[0]?.host, 'github.com');
});

test('PUT /api/config/credentials: updates in-memory appConfig immediately', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'GitHub Live',
        host: 'github.com',
        token: 'ghp_live',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.ok(Array.isArray(appConfig.gitCredentials), 'gitCredentials must be set in memory');
    assert.strictEqual(appConfig.gitCredentials?.[0]?.token, 'ghp_live');
});

test('PUT /api/config/credentials: preserves existing entries when adding a new one', async () => {
    const existingCred = makeCredential({ id: 'gitlab-work', label: 'GitLab Work', host: 'gitlab.com', token: 'existing_token' });
    const configPath = makeConfigFile({ gitCredentials: [existingCred] });
    const appConfig = makeAppConfig({ gitCredentials: [existingCred] });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'GitHub Personal',
        host: 'github.com',
        token: 'ghp_new',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as GitCredentialEntry[];
    assert.strictEqual(body.length, 2, 'both entries must be present');
    assert.ok(body.some((e) => e.id === 'gitlab-work'), 'existing entry must be preserved');
    assert.ok(body.some((e) => e.id === 'github-personal'), 'new entry must appear');
});

test('PUT /api/config/credentials: auto-generates id with numeric suffix when base id is taken', async () => {
    const existingCred = makeCredential({ id: 'github-personal', label: 'GitHub Personal', host: 'github.com', token: 'ghp_existing' });
    const configPath = makeConfigFile({ gitCredentials: [existingCred] });
    const appConfig = makeAppConfig({ gitCredentials: [existingCred] });
    const router = buildSut(appConfig, configPath);

    // No id provided — same label → would generate 'github-personal' but it's taken
    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'GitHub Personal',
        host: 'github.com',
        token: 'ghp_second',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as GitCredentialEntry[];
    assert.strictEqual(body.length, 2);
    const newEntry = body.find((e) => e.id === 'github-personal-2');
    assert.ok(newEntry, 'new entry should have id github-personal-2');
});

// ---------------------------------------------------------------------------
// PUT /api/config/credentials — upsert with explicit id
// ---------------------------------------------------------------------------

test('PUT /api/config/credentials: with existing id updates (upserts) the existing entry', async () => {
    const existingCred = makeCredential({ id: 'github-personal', label: 'GitHub Personal', host: 'github.com', token: 'ghp_old' });
    const configPath = makeConfigFile({ gitCredentials: [existingCred] });
    const appConfig = makeAppConfig({ gitCredentials: [existingCred] });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        id: 'github-personal',
        label: 'GitHub Personal Updated',
        host: 'github.com',
        token: 'ghp_new_token',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as GitCredentialEntry[];
    assert.strictEqual(body.length, 1, 'upsert must not add a duplicate entry');
    assert.strictEqual(body[0]?.id, 'github-personal');
    assert.strictEqual(body[0]?.label, 'GitHub Personal Updated');

    // Verify in-memory update
    assert.strictEqual(appConfig.gitCredentials?.[0]?.token, 'ghp_new_token');
});

test('PUT /api/config/credentials: with new explicit id creates a new entry', async () => {
    const existingCred = makeCredential({ id: 'github-personal', host: 'github.com', token: 'ghp_old' });
    const configPath = makeConfigFile({ gitCredentials: [existingCred] });
    const appConfig = makeAppConfig({ gitCredentials: [existingCred] });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        id: 'github-work',
        label: 'GitHub Work',
        host: 'github.com',
        token: 'ghp_work_token',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as GitCredentialEntry[];
    assert.strictEqual(body.length, 2);
    assert.ok(body.some((e) => e.id === 'github-personal'), 'original entry must remain');
    assert.ok(body.some((e) => e.id === 'github-work'), 'new entry with explicit id must appear');
});

// ---------------------------------------------------------------------------
// PUT /api/config/credentials — validation errors
// ---------------------------------------------------------------------------

test('PUT /api/config/credentials: returns 400 when label is missing', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', { host: 'github.com', token: 'ghp_abc' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"label"'), 'error must mention field name');
});

test('PUT /api/config/credentials: returns 400 when host is missing', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', { label: 'GitHub', token: 'ghp_abc' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"host"'), 'error must mention field name');
});

test('PUT /api/config/credentials: returns 400 when token is missing', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', { label: 'GitHub', host: 'github.com' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"token"'), 'error must mention field name');
});

test('PUT /api/config/credentials: returns 400 when id is provided but empty string', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        id: '',
        label: 'GitHub',
        host: 'github.com',
        token: 'ghp_abc',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/credentials: returns 400 when body is not a JSON object', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', [{ label: 'G', host: 'h', token: 't' }]);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

// ---------------------------------------------------------------------------
// PUT /api/config/credentials — hostname format validation (WP-004)
// ---------------------------------------------------------------------------

test('PUT /api/config/credentials: returns 400 when host contains a forward slash', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'Bad Host',
        host: 'github.com/path',
        token: 'ghp_abc',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"host"'), 'error must mention field name');
});

test('PUT /api/config/credentials: returns 400 when host contains a backslash', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'Bad Host',
        host: 'github.com\\path',
        token: 'ghp_abc',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"host"'), 'error must mention field name');
});

test('PUT /api/config/credentials: returns 400 when host contains a null byte', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'Bad Host',
        host: 'github.com\0evil',
        token: 'ghp_abc',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"host"'), 'error must mention field name');
});

test('PUT /api/config/credentials: returns 400 when host contains whitespace', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'Bad Host',
        host: 'github .com',
        token: 'ghp_abc',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"host"'), 'error must mention field name');
});

test('PUT /api/config/credentials: accepts valid hostname without path separators or whitespace', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'GitHub',
        host: 'github.com',
        token: 'ghp_valid_token',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as GitCredentialEntry[];
    assert.ok(Array.isArray(body));
    assert.strictEqual(body[0]?.host, 'github.com');
});

// ---------------------------------------------------------------------------
// PUT /api/config/credentials — per-field length limits (WP-005)
// ---------------------------------------------------------------------------

test('PUT /api/config/credentials: returns 400 when id exceeds 100 characters', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        id: 'a'.repeat(101),
        label: 'GitHub',
        host: 'github.com',
        token: 'ghp_abc',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"id"'), 'error must mention field name');
});

test('PUT /api/config/credentials: returns 400 when label exceeds 200 characters', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'a'.repeat(201),
        host: 'github.com',
        token: 'ghp_abc',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"label"'), 'error must mention field name');
});

test('PUT /api/config/credentials: returns 400 when host exceeds 253 characters', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'GitHub',
        host: 'a'.repeat(254),
        token: 'ghp_abc',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"host"'), 'error must mention field name');
});

test('PUT /api/config/credentials: returns 400 when token exceeds 500 characters', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'GitHub',
        host: 'github.com',
        token: 'a'.repeat(501),
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"token"'), 'error must mention field name');
});

test('PUT /api/config/credentials: accepts values exactly at each length limit', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        id: 'a'.repeat(100),
        label: 'a'.repeat(200),
        host: 'a'.repeat(253),
        token: 'a'.repeat(500),
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200, 'values at the length limit must be accepted');
});

// ---------------------------------------------------------------------------
// DELETE /api/config/credentials/:id
// ---------------------------------------------------------------------------

test('DELETE /api/config/credentials/:id: returns 200 with updated masked array', () => {
    const cred1 = makeCredential({ id: 'github-personal', host: 'github.com', token: 'ghp_abc' });
    const cred2 = makeCredential({ id: 'gitlab-work', label: 'GitLab Work', host: 'gitlab.com', token: 'glp_xyz123' });
    const configPath = makeConfigFile({ gitCredentials: [cred1, cred2] });
    const appConfig = makeAppConfig({ gitCredentials: [cred1, cred2] });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('DELETE', '/api/config/credentials/github-personal');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as GitCredentialEntry[];
    assert.ok(Array.isArray(body), 'response must be an array');
    assert.ok(!body.some((e) => e.id === 'github-personal'), 'deleted entry must not appear in response');
    assert.ok(body.some((e) => e.id === 'gitlab-work'), 'remaining entry must still appear');
});

test('DELETE /api/config/credentials/:id: removes entry from in-memory config', () => {
    const cred = makeCredential({ id: 'github-personal', token: 'ghp_abc' });
    const configPath = makeConfigFile({ gitCredentials: [cred] });
    const appConfig = makeAppConfig({ gitCredentials: [cred] });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('DELETE', '/api/config/credentials/github-personal');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const remaining = appConfig.gitCredentials ?? [];
    assert.ok(!remaining.some((e) => e.id === 'github-personal'), 'entry must be removed from memory');
});

test('DELETE /api/config/credentials/:id: persists removal to config file', () => {
    const cred = makeCredential({ id: 'github-personal', token: 'ghp_abc' });
    const configPath = makeConfigFile({ gitCredentials: [cred] });
    const appConfig = makeAppConfig({ gitCredentials: [cred] });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('DELETE', '/api/config/credentials/github-personal');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const saved = readConfigFile(configPath);
    const creds = saved['gitCredentials'] as GitCredentialEntry[] | undefined;
    assert.ok(
        !creds || !creds.some((e) => e.id === 'github-personal'),
        'deleted entry must not appear in saved file',
    );
});

test('DELETE /api/config/credentials/:id: returns 404 when id is not configured', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('DELETE', '/api/config/credentials/nonexistent');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
});

test('DELETE /api/config/credentials/:id: returns 404 when credentials array is empty', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({ gitCredentials: undefined });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('DELETE', '/api/config/credentials/github-personal');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
});

test('DELETE /api/config/credentials/:id: returns 400 for malformed percent-encoding', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('DELETE', '/api/config/credentials/%ZZ');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('Malformed'), 'error should mention malformed parameter');
});

// ---------------------------------------------------------------------------
// GET /api/config/polling
// ---------------------------------------------------------------------------

test('GET /api/config/polling: returns 200 with default gitPollingIntervalSeconds of 30', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig(); // defaults to gitPollingIntervalSeconds: 30
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/polling');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { gitPollingIntervalSeconds: number };
    assert.strictEqual(body.gitPollingIntervalSeconds, 30);
});

test('GET /api/config/polling: returns the current in-memory value when overridden', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({ gitPollingIntervalSeconds: 60 });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/polling');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { gitPollingIntervalSeconds: number };
    assert.strictEqual(body.gitPollingIntervalSeconds, 60);
});

// ---------------------------------------------------------------------------
// PUT /api/config/polling — success
// ---------------------------------------------------------------------------

test('PUT /api/config/polling: returns 200 with updated value on valid input', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/polling', { seconds: 60 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { gitPollingIntervalSeconds: number };
    assert.strictEqual(body.gitPollingIntervalSeconds, 60);
});

test('PUT /api/config/polling: updates in-memory appConfig immediately', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/polling', { seconds: 60 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(appConfig.gitPollingIntervalSeconds, 60);
});

test('PUT /api/config/polling: persists the new value to config.json', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/polling', { seconds: 60 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    const saved = readConfigFile(configPath);
    assert.strictEqual(saved['gitPollingIntervalSeconds'], 60);
});

test('PUT /api/config/polling: calls pollingManager.restart() with the new interval', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const pollingManager = makeMockPollingManager();
    const router = buildSut(appConfig, configPath, pollingManager);

    const req = mockRequest('PUT', '/api/config/polling', { seconds: 60 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    assert.deepStrictEqual(pollingManager.restartCalls, [60]);
});

test('PUT /api/config/polling: accepts the minimum valid value of 10', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/polling', { seconds: 10 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(appConfig.gitPollingIntervalSeconds, 10);
});

// ---------------------------------------------------------------------------
// PUT /api/config/polling — validation errors (HTTP 400)
// ---------------------------------------------------------------------------

test('PUT /api/config/polling: returns 400 when seconds is below minimum (5 < 10)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/polling', { seconds: 5 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.length > 0, 'error message must be non-empty');
});

test('PUT /api/config/polling: returns 400 for seconds = 0', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/polling', { seconds: 0 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/polling: returns 400 for negative seconds', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/polling', { seconds: -1 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/polling: returns 400 when seconds is a fractional number', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/polling', { seconds: 30.5 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/polling: returns 400 when seconds is a string', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/polling', { seconds: '60' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/polling: returns 400 when seconds field is missing', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/polling', { other: 60 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/polling: returns 400 when body is not a JSON object', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/polling', [60]);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

// ---------------------------------------------------------------------------
// Backward-compatibility — existing callers without pollingManager
// ---------------------------------------------------------------------------

test('registerConfigRoutes: works without pollingManager argument (backward-compatible)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    // No pollingManager passed — existing caller pattern
    const router = new Router();
    registerConfigRoutes({ router, appConfig, configPath }); // must not throw

    const req = mockRequest('PUT', '/api/config/polling', { seconds: 60 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    // Should still update config successfully; just won't restart a manager.
    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(appConfig.gitPollingIntervalSeconds, 60);
});

// ---------------------------------------------------------------------------
// PUT /api/config/polling — upper bound (max 86400)
// ---------------------------------------------------------------------------

test('PUT /api/config/polling: accepts maximum valid value of 86400', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/polling', { seconds: 86400 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { gitPollingIntervalSeconds: number };
    assert.strictEqual(body.gitPollingIntervalSeconds, 86400);
});

test('PUT /api/config/polling: returns 400 when seconds exceeds 86400', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/polling', { seconds: 86401 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('86400'), 'error must mention max value');
    assert.ok(body.error.includes('86401'), 'error must echo received value');
});

// ---------------------------------------------------------------------------
// GET /api/config/webserver-url
// ---------------------------------------------------------------------------

test('GET /api/config/webserver-url: returns null when not configured', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/webserver-url');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { webserverUrl: string | null };
    assert.strictEqual(body.webserverUrl, null);
});

test('GET /api/config/webserver-url: returns the configured value', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({ webserverUrl: 'http://localhost:8080' });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/webserver-url');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { webserverUrl: string | null };
    assert.strictEqual(body.webserverUrl, 'http://localhost:8080');
});

// ---------------------------------------------------------------------------
// PUT /api/config/webserver-url
// ---------------------------------------------------------------------------

test('PUT /api/config/webserver-url: returns 400 when body is not an object', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/webserver-url', 'not-an-object');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/webserver-url: returns 400 when url field is missing', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/webserver-url', {});
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"url"'), 'error must mention field name');
});

test('PUT /api/config/webserver-url: returns 400 when url is a number', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/webserver-url', { url: 123 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/webserver-url: persists a valid URL and returns it', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/webserver-url', { url: 'http://localhost:8080' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { webserverUrl: string | null };
    assert.strictEqual(body.webserverUrl, 'http://localhost:8080');
    assert.strictEqual(appConfig.webserverUrl, 'http://localhost:8080');

    const saved = readConfigFile(configPath);
    assert.strictEqual(saved['webserverUrl'], 'http://localhost:8080');
});

test('PUT /api/config/webserver-url: strips trailing slashes before persisting', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/webserver-url', { url: 'http://localhost:8080///' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { webserverUrl: string | null };
    assert.strictEqual(body.webserverUrl, 'http://localhost:8080');
});

test('PUT /api/config/webserver-url: empty string clears the setting', async () => {
    const configPath = makeConfigFile({ webserverUrl: 'http://localhost:8080' });
    const appConfig = makeAppConfig({ webserverUrl: 'http://localhost:8080' });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/webserver-url', { url: '' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { webserverUrl: string | null };
    assert.strictEqual(body.webserverUrl, null);
    assert.strictEqual(appConfig.webserverUrl, undefined);

    const saved = readConfigFile(configPath);
    assert.ok(!Object.hasOwn(saved, 'webserverUrl'), 'webserverUrl should be absent after clearing');
});

test('PUT /api/config/webserver-url: whitespace-only string clears the setting', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({ webserverUrl: 'http://localhost:8080' });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/webserver-url', { url: '   ' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { webserverUrl: string | null };
    assert.strictEqual(body.webserverUrl, null);
});

test('PUT /api/config/webserver-url: rejects javascript: scheme with 400', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/webserver-url', { url: 'javascript:alert(1)' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('javascript'), 'error must mention the rejected scheme');
});

test('PUT /api/config/webserver-url: rejects data: scheme with 400', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/webserver-url', { url: 'data:text/html,<h1>test</h1>' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('data'), 'error must mention the rejected scheme');
});

test('PUT /api/config/webserver-url: rejects vbscript: scheme with 400', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/webserver-url', { url: 'vbscript:msgbox("xss")' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('vbscript'), 'error must mention the rejected scheme');
});

// ---------------------------------------------------------------------------
// GET /api/config/notes-display
// ---------------------------------------------------------------------------

test('GET /api/config/notes-display: returns 200 with current notesCardHeight and notesColumns', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({ notesCardHeight: 220, notesColumns: 2 });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/notes-display');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { notesCardHeight: number; notesColumns: number };
    assert.strictEqual(body.notesCardHeight, 220);
    assert.strictEqual(body.notesColumns, 2);
});

test('GET /api/config/notes-display: returns overridden in-memory values', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({ notesCardHeight: 400, notesColumns: 4 });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/notes-display');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { notesCardHeight: number; notesColumns: number };
    assert.strictEqual(body.notesCardHeight, 400);
    assert.strictEqual(body.notesColumns, 4);
});

// ---------------------------------------------------------------------------
// PUT /api/config/notes-display — success
// ---------------------------------------------------------------------------

test('PUT /api/config/notes-display: returns 200 with updated values when both fields provided', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 350, notesColumns: 3 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { notesCardHeight: number; notesColumns: number };
    assert.strictEqual(body.notesCardHeight, 350);
    assert.strictEqual(body.notesColumns, 3);
});

test('PUT /api/config/notes-display: updates in-memory appConfig when both fields provided', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 350, notesColumns: 3 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(appConfig.notesCardHeight, 350);
    assert.strictEqual(appConfig.notesColumns, 3);
});

test('PUT /api/config/notes-display: persists both fields to config.json', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 350, notesColumns: 3 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    const saved = readConfigFile(configPath);
    assert.strictEqual(saved['notesCardHeight'], 350);
    assert.strictEqual(saved['notesColumns'], 3);
});

test('PUT /api/config/notes-display: partial update — only notesCardHeight provided', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({ notesCardHeight: 220, notesColumns: 2 });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 500 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(appConfig.notesCardHeight, 500);
    assert.strictEqual(appConfig.notesColumns, 2, 'notesColumns must remain unchanged');
    const saved = readConfigFile(configPath);
    assert.strictEqual(saved['notesCardHeight'], 500);
    assert.ok(!Object.hasOwn(saved, 'notesColumns'), 'notesColumns should not be written to config file');
});

test('PUT /api/config/notes-display: partial update — only notesColumns provided', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({ notesCardHeight: 220, notesColumns: 2 });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesColumns: 5 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(appConfig.notesColumns, 5);
    assert.strictEqual(appConfig.notesCardHeight, 220, 'notesCardHeight must remain unchanged');
    const saved = readConfigFile(configPath);
    assert.strictEqual(saved['notesColumns'], 5);
});

test('PUT /api/config/notes-display: accepts minimum valid notesCardHeight (120)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 120 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(appConfig.notesCardHeight, 120);
});

test('PUT /api/config/notes-display: accepts maximum valid notesCardHeight (800)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 800 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(appConfig.notesCardHeight, 800);
});

test('PUT /api/config/notes-display: accepts minimum valid notesColumns (1)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesColumns: 1 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(appConfig.notesColumns, 1);
});

test('PUT /api/config/notes-display: accepts maximum valid notesColumns (6)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesColumns: 6 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(appConfig.notesColumns, 6);
});

test('PUT /api/config/notes-display: empty body returns 200 without changing any values', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({ notesCardHeight: 220, notesColumns: 2 });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', {});
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(appConfig.notesCardHeight, 220);
    assert.strictEqual(appConfig.notesColumns, 2);
    const body = JSON.parse(mock.body) as { notesCardHeight: number; notesColumns: number };
    assert.strictEqual(body.notesCardHeight, 220);
    assert.strictEqual(body.notesColumns, 2);
});

// ---------------------------------------------------------------------------
// PUT /api/config/notes-display — validation errors for notesCardHeight
// ---------------------------------------------------------------------------

test('PUT /api/config/notes-display: returns 400 when notesCardHeight is below minimum (119 < 120)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 119 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('120'), 'error must mention minimum value');
    assert.ok(body.error.includes('119'), 'error must echo received value');
});

test('PUT /api/config/notes-display: returns 400 when notesCardHeight exceeds maximum (801 > 800)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 801 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('800'), 'error must mention maximum value');
    assert.ok(body.error.includes('801'), 'error must echo received value');
});

test('PUT /api/config/notes-display: returns 400 when notesCardHeight is a fractional number', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 220.5 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/notes-display: returns 400 when notesCardHeight is a string', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: '220' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"notesCardHeight"'), 'error must mention field name');
});

test('PUT /api/config/notes-display: returns 400 when notesCardHeight is null', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: null });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

// ---------------------------------------------------------------------------
// PUT /api/config/notes-display — validation errors for notesColumns
// ---------------------------------------------------------------------------

test('PUT /api/config/notes-display: returns 400 when notesColumns is below minimum (0 < 1)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesColumns: 0 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('1'), 'error must mention minimum value');
});

test('PUT /api/config/notes-display: returns 400 when notesColumns exceeds maximum (7 > 6)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesColumns: 7 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('6'), 'error must mention maximum value');
    assert.ok(body.error.includes('7'), 'error must echo received value');
});

test('PUT /api/config/notes-display: returns 400 when notesColumns is a fractional number', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesColumns: 2.5 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/notes-display: returns 400 when notesColumns is a string', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesColumns: '2' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('"notesColumns"'), 'error must mention field name');
});

test('PUT /api/config/notes-display: returns 400 when body is not a JSON object', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', [220, 2]);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

// ---------------------------------------------------------------------------
// Audit logging — credential mutation operations
// ---------------------------------------------------------------------------

test('PUT /api/config/credentials: audit log entry produced with Source credential-audit and operation create-credential', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const errorLogManager = makeMockErrorLogManager();
    const router = buildSut(appConfig, configPath, undefined, errorLogManager);

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'GitHub Personal',
        host: 'github.com',
        token: 'ghp_secret',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(errorLogManager.appendedEntries.length, 1);
    const entry = errorLogManager.appendedEntries[0];
    assert.strictEqual(entry.Source, 'credential-audit');
    assert.strictEqual(entry.Severity, 'audit');
    assert.strictEqual(entry.Operation, 'create-credential');
});

test('PUT /api/config/credentials: audit log entry produced with operation update-credential when id matches existing entry', async () => {
    const existingCred = makeCredential({ id: 'github-personal', label: 'GitHub Personal', host: 'github.com', token: 'ghp_old' });
    const configPath = makeConfigFile({ gitCredentials: [existingCred] });
    const appConfig = makeAppConfig({ gitCredentials: [existingCred] });
    const errorLogManager = makeMockErrorLogManager();
    const router = buildSut(appConfig, configPath, undefined, errorLogManager);

    const req = mockRequest('PUT', '/api/config/credentials', {
        id: 'github-personal',
        label: 'GitHub Personal Updated',
        host: 'github.com',
        token: 'ghp_new',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(errorLogManager.appendedEntries.length, 1);
    const entry = errorLogManager.appendedEntries[0];
    assert.strictEqual(entry.Source, 'credential-audit');
    assert.strictEqual(entry.Severity, 'audit');
    assert.strictEqual(entry.Operation, 'update-credential');
});

test('DELETE /api/config/credentials/:id: audit log entry produced with Source credential-audit and operation delete-credential', () => {
    const cred = makeCredential({ id: 'github-personal', token: 'ghp_abc' });
    const configPath = makeConfigFile({ gitCredentials: [cred] });
    const appConfig = makeAppConfig({ gitCredentials: [cred] });
    const errorLogManager = makeMockErrorLogManager();
    const router = buildSut(appConfig, configPath, undefined, errorLogManager);

    const req = mockRequest('DELETE', '/api/config/credentials/github-personal');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(errorLogManager.appendedEntries.length, 1);
    const entry = errorLogManager.appendedEntries[0];
    assert.strictEqual(entry.Source, 'credential-audit');
    assert.strictEqual(entry.Severity, 'audit');
    assert.strictEqual(entry.Operation, 'delete-credential');
});

test('Credential audit log entries never contain the token value', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const errorLogManager = makeMockErrorLogManager();
    const router = buildSut(appConfig, configPath, undefined, errorLogManager);
    const secretToken = 'ghp_super_secret_token_value';

    const req = mockRequest('PUT', '/api/config/credentials', {
        label: 'My Cred',
        host: 'github.com',
        token: secretToken,
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(errorLogManager.appendedEntries.length, 1);
    const entry = errorLogManager.appendedEntries[0];
    // The token value must not appear in any logged field.
    const entryJson = JSON.stringify(entry);
    assert.ok(!entryJson.includes(secretToken), 'audit log entry must not contain the credential token');
});
