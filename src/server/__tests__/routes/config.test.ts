import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Router } from '../../router.js';
import { registerConfigRoutes } from '../../routes/config.js';
import type { AppConfig } from '../../../config/config.types.js';

// ---------------------------------------------------------------------------
// Temp dir (cleaned up on process exit)
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-config-routes-test-'));

process.on('exit', () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as other route tests)
// ---------------------------------------------------------------------------

function mockRequest(method: string, url: string, bodyJson?: unknown): IncomingMessage {
    const req = new EventEmitter() as IncomingMessage;
    (req as unknown as { method: string }).method = method;
    (req as unknown as { url: string }).url = url;
    (req as unknown as { destroy(): void }).destroy = () => {
        req.emit('error', new Error('destroyed'));
    };

    process.nextTick(() => {
        if (bodyJson !== undefined) {
            req.emit('data', Buffer.from(JSON.stringify(bodyJson)));
        }
        req.emit('end');
    });

    return req;
}

interface MockResponse {
    statusCode: number | undefined;
    body: string;
    res: ServerResponse;
}

function mockResponse(): MockResponse {
    const mock: MockResponse = {
        statusCode: undefined,
        body: '',
        res: null as unknown as ServerResponse,
    };

    const res = new EventEmitter() as unknown as ServerResponse;

    (res as unknown as {
        writeHead(status: number, headers?: Record<string, string | number>): void;
    }).writeHead = (status: number) => {
        mock.statusCode = status;
    };

    (res as unknown as { end(body?: string): void }).end = (body?: string) => {
        mock.body = body ?? '';
    };

    mock.res = res;
    return mock;
}

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
        ...overrides,
    };
}

function readConfigFile(configPath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function buildSut(appConfig: AppConfig, configPath: string): Router {
    const router = new Router();
    registerConfigRoutes(router, appConfig, configPath);
    return router;
}

// ---------------------------------------------------------------------------
// GET /api/config/credentials
// ---------------------------------------------------------------------------

test('GET /api/config/credentials: returns 200 with empty object when no credentials configured', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/credentials');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(mock.body), {});
});

test('GET /api/config/credentials: returns masked tokens for all configured hosts', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({
        gitCredentials: {
            'github.com': 'ghp_abcdefgh',
            'gitlab.com': 'glp_xyz',
        },
    });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/credentials');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as Record<string, string>;
    assert.strictEqual(body['github.com'], '****efgh');
    assert.strictEqual(body['gitlab.com'], '****_xyz');
});

test('GET /api/config/credentials: token shorter than 4 characters is fully masked', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({ gitCredentials: { 'example.com': 'abc' } });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/credentials');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as Record<string, string>;
    assert.strictEqual(body['example.com'], '****');
});

test('GET /api/config/credentials: full token value is never present in the response', () => {
    const configPath = makeConfigFile();
    const token = 'ghp_supersecrettoken';
    const appConfig = makeAppConfig({ gitCredentials: { 'github.com': token } });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/credentials');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.ok(!mock.body.includes(token), 'full token must not appear in the response body');
});

// ---------------------------------------------------------------------------
// PUT /api/config/credentials
// ---------------------------------------------------------------------------

test('PUT /api/config/credentials: returns 200 with masked map after adding entry', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        host: 'github.com',
        token: 'ghp_full_token',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as Record<string, string>;
    assert.ok('github.com' in body);
    assert.ok(!body['github.com'].includes('ghp_full_token'), 'full token must not appear');
    assert.ok(body['github.com'].startsWith('****'), 'masked token should start with ****');
});

test('PUT /api/config/credentials: persists new entry to config file on disk', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        host: 'github.com',
        token: 'ghp_stored_token',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    const saved = readConfigFile(configPath);
    assert.ok(
        typeof saved['gitCredentials'] === 'object' && saved['gitCredentials'] !== null,
    );
    const creds = saved['gitCredentials'] as Record<string, string>;
    assert.strictEqual(creds['github.com'], 'ghp_stored_token');
});

test('PUT /api/config/credentials: updates in-memory appConfig immediately', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        host: 'github.com',
        token: 'ghp_live',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(appConfig.gitCredentials?.['github.com'], 'ghp_live');
});

test('PUT /api/config/credentials: preserves existing entries when adding a new one', async () => {
    const configPath = makeConfigFile({ gitCredentials: { 'gitlab.com': 'existing_token' } });
    const appConfig = makeAppConfig({ gitCredentials: { 'gitlab.com': 'existing_token' } });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        host: 'github.com',
        token: 'ghp_new',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const saved = readConfigFile(configPath);
    const creds = saved['gitCredentials'] as Record<string, string>;
    assert.strictEqual(creds['gitlab.com'], 'existing_token');
    assert.strictEqual(creds['github.com'], 'ghp_new');
});

test('PUT /api/config/credentials: returns 400 when host is missing', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', { token: 'ghp_abc' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/credentials: returns 400 when token is missing', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', { host: 'github.com' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/credentials: returns 400 when host contains path separator', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        host: 'github.com/evil',
        token: 'ghp_abc',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/credentials: returns 400 when host contains whitespace', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        host: 'github com',
        token: 'ghp_abc',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

// ---------------------------------------------------------------------------
// DELETE /api/config/credentials/:host
// ---------------------------------------------------------------------------

test('DELETE /api/config/credentials/:host: returns 200 with updated masked map', () => {
    const configPath = makeConfigFile({
        gitCredentials: { 'github.com': 'ghp_abc', 'gitlab.com': 'glp_xyz123' },
    });
    const appConfig = makeAppConfig({
        gitCredentials: { 'github.com': 'ghp_abc', 'gitlab.com': 'glp_xyz123' },
    });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('DELETE', '/api/config/credentials/github.com');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as Record<string, string>;
    assert.ok(!('github.com' in body), 'deleted host must not appear in response');
    assert.ok('gitlab.com' in body, 'remaining host must still appear');
});

test('DELETE /api/config/credentials/:host: removes entry from in-memory config', () => {
    const configPath = makeConfigFile({ gitCredentials: { 'github.com': 'ghp_abc' } });
    const appConfig = makeAppConfig({ gitCredentials: { 'github.com': 'ghp_abc' } });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('DELETE', '/api/config/credentials/github.com');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.ok(!appConfig.gitCredentials || !('github.com' in appConfig.gitCredentials));
});

test('DELETE /api/config/credentials/:host: persists removal to config file', () => {
    const configPath = makeConfigFile({ gitCredentials: { 'github.com': 'ghp_abc' } });
    const appConfig = makeAppConfig({ gitCredentials: { 'github.com': 'ghp_abc' } });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('DELETE', '/api/config/credentials/github.com');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const saved = readConfigFile(configPath);
    const creds = saved['gitCredentials'] as Record<string, string> | undefined;
    assert.ok(!creds || !('github.com' in creds), 'deleted host must not appear in saved file');
});

test('DELETE /api/config/credentials/:host: returns 404 when host is not configured', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('DELETE', '/api/config/credentials/unknown.com');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
});

test('DELETE /api/config/credentials/:host: returns 404 when credentials map is empty', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig({ gitCredentials: undefined });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('DELETE', '/api/config/credentials/github.com');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
});

// ---------------------------------------------------------------------------
// DELETE — decodeURIComponent (Step 1)
// ---------------------------------------------------------------------------

test('DELETE /api/config/credentials/:host: decodes percent-encoded host (e.g. colon as %3A)', () => {
    const host = 'gitlab.com:8080';
    const configPath = makeConfigFile({ gitCredentials: { [host]: 'glpat_abc123' } });
    const appConfig = makeAppConfig({ gitCredentials: { [host]: 'glpat_abc123' } });
    const router = buildSut(appConfig, configPath);

    // Percent-encode the colon
    const req = mockRequest('DELETE', '/api/config/credentials/gitlab.com%3A8080');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as Record<string, string>;
    assert.ok(!(host in body), 'deleted host must not appear in response');
});

test('DELETE /api/config/credentials/:host: returns 400 for malformed percent-encoding', () => {
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
// PUT — prototype-key blocklist (Step 2)
// ---------------------------------------------------------------------------

test('PUT /api/config/credentials: returns 400 when host is "__proto__"', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        host: '__proto__',
        token: 'ghp_abc',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(body.error.includes('reserved'), 'error should mention reserved name');
});

test('PUT /api/config/credentials: returns 400 when host is "constructor"', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        host: 'constructor',
        token: 'ghp_abc',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/credentials: returns 400 when host is "prototype"', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/credentials', {
        host: 'prototype',
        token: 'ghp_abc',
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});
