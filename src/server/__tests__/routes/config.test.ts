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
import type { PollingManager } from '../../pollingManager.js';

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
): Router {
    const router = new Router();
    registerConfigRoutes({ router, appConfig, configPath, pollingManager });
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
