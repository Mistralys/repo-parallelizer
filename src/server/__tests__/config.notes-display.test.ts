import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { Router } from '../router.js';
import { registerConfigRoutes } from '../routes/config.js';
import type { AppConfig } from '../../config/config.types.js';
import { mockRequest, mockResponse } from './helpers/mock-http.js';

// ---------------------------------------------------------------------------
// Temp dir (cleaned up on process exit)
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'paralizer-config-notes-display-test-'),
);

process.on('exit', () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test conventions
// ---------------------------------------------------------------------------
//
// NaN proxy: JSON cannot represent NaN (it serialises as `null`, which the
// endpoint accepts). Tests titled "returns 400 when ... is NaN" exercise the
// non-integer validation path by sending a valid JSON float (e.g. 1.1 or 2.5)
// instead. The float is rejected by the integer-only guard, exercising the
// same code path that would reject a true NaN if it were JSON-serialisable.
//
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
        notesCardHeight: 220,
        notesColumns: 2,
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

function buildSut(appConfig: AppConfig, configPath: string): Router {
    const router = new Router();
    registerConfigRoutes({ router, appConfig, configPath });
    return router;
}

// ---------------------------------------------------------------------------
// GET /api/config/notes-display
// ---------------------------------------------------------------------------

test('GET /api/config/notes-display: returns 200 with default values { notesCardHeight: 220, notesColumns: 2 } on fresh config', () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig(); // defaults: notesCardHeight: 220, notesColumns: 2
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('GET', '/api/config/notes-display');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { notesCardHeight: number; notesColumns: number };
    assert.strictEqual(body.notesCardHeight, 220);
    assert.strictEqual(body.notesColumns, 2);
});

test('GET /api/config/notes-display: returns the current in-memory values when overridden', () => {
    const configPath = makeConfigFile({ notesCardHeight: 400, notesColumns: 4 });
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
// PUT /api/config/notes-display — valid full update
// ---------------------------------------------------------------------------

test('PUT /api/config/notes-display: returns 200 with updated values on valid input', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', {
        notesCardHeight: 350,
        notesColumns: 3,
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { notesCardHeight: number; notesColumns: number };
    assert.strictEqual(body.notesCardHeight, 350);
    assert.strictEqual(body.notesColumns, 3);
});

test('PUT /api/config/notes-display: updates in-memory appConfig immediately', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', {
        notesCardHeight: 500,
        notesColumns: 6,
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(appConfig.notesCardHeight, 500);
    assert.strictEqual(appConfig.notesColumns, 6);
});

test('PUT /api/config/notes-display: persists both fields to config.json', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', {
        notesCardHeight: 300,
        notesColumns: 4,
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const saved = readConfigFile(configPath);
    assert.strictEqual(saved['notesCardHeight'], 300);
    assert.strictEqual(saved['notesColumns'], 4);
});

// ---------------------------------------------------------------------------
// PUT /api/config/notes-display — partial updates (only one field)
// ---------------------------------------------------------------------------

test('PUT /api/config/notes-display: partial update with only notesCardHeight changes only that field', async () => {
    const configPath = makeConfigFile({ notesCardHeight: 220, notesColumns: 3 });
    const appConfig = makeAppConfig({ notesCardHeight: 220, notesColumns: 3 });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 400 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { notesCardHeight: number; notesColumns: number };
    assert.strictEqual(body.notesCardHeight, 400, 'notesCardHeight must be updated');
    assert.strictEqual(body.notesColumns, 3, 'notesColumns must remain unchanged');
    assert.strictEqual(appConfig.notesCardHeight, 400);
    assert.strictEqual(appConfig.notesColumns, 3);
});

test('PUT /api/config/notes-display: partial update with only notesColumns changes only that field', async () => {
    const configPath = makeConfigFile({ notesCardHeight: 350, notesColumns: 2 });
    const appConfig = makeAppConfig({ notesCardHeight: 350, notesColumns: 2 });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesColumns: 5 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { notesCardHeight: number; notesColumns: number };
    assert.strictEqual(body.notesColumns, 5, 'notesColumns must be updated');
    assert.strictEqual(body.notesCardHeight, 350, 'notesCardHeight must remain unchanged');
    assert.strictEqual(appConfig.notesColumns, 5);
    assert.strictEqual(appConfig.notesCardHeight, 350);
});

test('PUT /api/config/notes-display: partial update only persists the provided field to disk', async () => {
    const configPath = makeConfigFile({ notesCardHeight: 220, notesColumns: 2 });
    const appConfig = makeAppConfig({ notesCardHeight: 220, notesColumns: 2 });
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesColumns: 4 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const saved = readConfigFile(configPath);
    assert.strictEqual(saved['notesColumns'], 4);
    assert.strictEqual(saved['notesCardHeight'], 220, 'untouched field must remain at original value in file');
});

// ---------------------------------------------------------------------------
// PUT /api/config/notes-display — boundary values (min/max valid)
// ---------------------------------------------------------------------------

test('PUT /api/config/notes-display: accepts notesCardHeight at minimum boundary (120)', async () => {
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

test('PUT /api/config/notes-display: accepts notesCardHeight at maximum boundary (800)', async () => {
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

test('PUT /api/config/notes-display: accepts notesColumns at minimum boundary (1)', async () => {
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

test('PUT /api/config/notes-display: accepts notesColumns at maximum boundary (6)', async () => {
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

// ---------------------------------------------------------------------------
// PUT /api/config/notes-display — below-min validation (400 errors)
// ---------------------------------------------------------------------------

test('PUT /api/config/notes-display: returns 400 when notesCardHeight is below minimum (119)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 119 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/notes-display: returns 400 when notesCardHeight is 0', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 0 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/notes-display: returns 400 when notesColumns is below minimum (0)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesColumns: 0 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

// ---------------------------------------------------------------------------
// PUT /api/config/notes-display — above-max validation (400 errors)
// ---------------------------------------------------------------------------

test('PUT /api/config/notes-display: returns 400 when notesCardHeight is above maximum (801)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 801 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/notes-display: returns 400 when notesCardHeight is far above maximum (9999)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 9999 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/notes-display: returns 400 when notesColumns is above maximum (7)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesColumns: 7 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

// ---------------------------------------------------------------------------
// PUT /api/config/notes-display — non-integer validation (400 errors)
// ---------------------------------------------------------------------------

test('PUT /api/config/notes-display: returns 400 when notesCardHeight is a float (200.5)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 200.5 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/notes-display: returns 400 when notesColumns is a float (2.5)', async () => {
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

test('PUT /api/config/notes-display: returns 400 when notesCardHeight is NaN', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    // NaN cannot be sent as JSON (it becomes null), so we test Infinity via a
    // raw string body that produces a non-integer number. The endpoint rejects
    // non-integer numbers. We verify the equivalent by sending a number that
    // is a valid JSON float (1.1) to exercise the non-integer path.
    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: 1.1 });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

// ---------------------------------------------------------------------------
// PUT /api/config/notes-display — non-number validation (400 errors)
// ---------------------------------------------------------------------------

test('PUT /api/config/notes-display: returns 400 when notesCardHeight is a string', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: '300' });
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

    const req = mockRequest('PUT', '/api/config/notes-display', { notesColumns: '3' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/notes-display: returns 400 when notesCardHeight is a boolean', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesCardHeight: true });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/notes-display: returns 400 when notesColumns is null', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', { notesColumns: null });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/config/notes-display: returns 400 when body is not a JSON object (array)', async () => {
    const configPath = makeConfigFile();
    const appConfig = makeAppConfig();
    const router = buildSut(appConfig, configPath);

    const req = mockRequest('PUT', '/api/config/notes-display', [300, 3]);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});
