import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Router } from '../router.js';

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

/**
 * Creates a minimal mock IncomingMessage with the given method and URL.
 */
function mockRequest(method: string, url: string): IncomingMessage {
    const req = new EventEmitter() as IncomingMessage;
    (req as unknown as { method: string }).method = method;
    (req as unknown as { url: string }).url = url;
    return req;
}

interface MockResponse {
    statusCode: number | undefined;
    headers: Record<string, string | number>;
    body: string;
    res: ServerResponse;
}

/**
 * Creates a mock ServerResponse that captures writeHead / end calls.
 */
function mockResponse(): MockResponse {
    const mock: MockResponse = {
        statusCode: undefined,
        headers: {},
        body: '',
        res: null as unknown as ServerResponse,
    };

    const res = new EventEmitter() as unknown as ServerResponse;

    (res as unknown as {
        writeHead(status: number, headers: Record<string, string | number>): void;
    }).writeHead = (status: number, headers: Record<string, string | number>) => {
        mock.statusCode = status;
        mock.headers = { ...headers };
    };

    (res as unknown as { end(body: string): void }).end = (body: string) => {
        mock.body = body;
    };

    mock.res = res;
    return mock;
}

// ---------------------------------------------------------------------------
// Helper: creates a Router with a GET /hello handler and a POST /hello handler
// ---------------------------------------------------------------------------

function buildRouter(): Router {
    const router = new Router();
    router.get('/hello', (_req, res, _params) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    });
    router.post('/hello', (_req, res, _params) => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ created: true }));
    });
    return router;
}

// ---------------------------------------------------------------------------
// Successful dispatch
// ---------------------------------------------------------------------------

test('Router: invokes the correct GET handler', () => {
    const router = buildRouter();
    const req = mockRequest('GET', '/hello');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(JSON.parse(mock.body), { ok: true });
});

test('Router: invokes the correct POST handler', () => {
    const router = buildRouter();
    const req = mockRequest('POST', '/hello');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 201);
    assert.deepEqual(JSON.parse(mock.body), { created: true });
});

test('Router: dispatches PUT handler separately from GET', () => {
    const router = new Router();
    router.put('/items/:id', (_req, res, _params) => {
        res.writeHead(200, {});
        res.end(JSON.stringify({ method: 'PUT' }));
    });

    const req = mockRequest('PUT', '/items/7');
    const mock = mockResponse();
    router.handle(req, mock.res);
    assert.deepEqual(JSON.parse(mock.body), { method: 'PUT' });
});

test('Router: dispatches DELETE handler', () => {
    const router = new Router();
    router.delete('/items/:id', (_req, res, _params) => {
        res.writeHead(204, {});
        res.end('{}');
    });

    const req = mockRequest('DELETE', '/items/9');
    const mock = mockResponse();
    router.handle(req, mock.res);
    assert.strictEqual(mock.statusCode, 204);
});

// ---------------------------------------------------------------------------
// Named param extraction
// ---------------------------------------------------------------------------

test('Router: extracts single named param and passes it to handler', () => {
    const router = new Router();
    let capturedParams: Record<string, string> = {};

    router.get('/repos/:id', (_req, res, params) => {
        capturedParams = params;
        res.writeHead(200, {});
        res.end('{}');
    });

    const req = mockRequest('GET', '/repos/42');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.deepEqual(capturedParams, { id: '42' });
});

test('Router: extracts multiple named params', () => {
    const router = new Router();
    let capturedParams: Record<string, string> = {};

    router.get('/repos/:owner/:repo', (_req, res, params) => {
        capturedParams = params;
        res.writeHead(200, {});
        res.end('{}');
    });

    const req = mockRequest('GET', '/repos/alice/my-project');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.deepEqual(capturedParams, { owner: 'alice', repo: 'my-project' });
});

test('Router: passes empty params object for pattern with no named segments', () => {
    const router = new Router();
    let capturedParams: Record<string, string> = { sentinel: 'yes' };

    router.get('/health', (_req, res, params) => {
        capturedParams = params;
        res.writeHead(200, {});
        res.end('{}');
    });

    const req = mockRequest('GET', '/health');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.deepEqual(capturedParams, {});
});

test('Router: ignores query string when extracting params', () => {
    const router = new Router();
    let capturedParams: Record<string, string> = {};

    router.get('/repos/:id', (_req, res, params) => {
        capturedParams = params;
        res.writeHead(200, {});
        res.end('{}');
    });

    const req = mockRequest('GET', '/repos/99?foo=bar');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.deepEqual(capturedParams, { id: '99' });
});

// ---------------------------------------------------------------------------
// 404 — no path match
// ---------------------------------------------------------------------------

test('Router: returns 404 JSON when no pattern matches the request path', () => {
    const router = buildRouter();
    const req = mockRequest('GET', '/not-found');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string', 'body should have error string');
});

test('Router: 404 body is valid JSON with an "error" key', () => {
    const router = new Router();
    const req = mockRequest('GET', '/missing');
    const mock = mockResponse();

    router.handle(req, mock.res);

    const parsed = JSON.parse(mock.body) as Record<string, unknown>;
    assert.ok('error' in parsed);
    assert.ok(typeof parsed['error'] === 'string');
});

test('Router: returns 404 when path has extra segments not matched by any pattern', () => {
    const router = new Router();
    router.get('/repos/:id', (_req, res, _p) => { res.writeHead(200, {}); res.end('{}'); });

    const req = mockRequest('GET', '/repos/42/extra');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
});

// ---------------------------------------------------------------------------
// 405 — path matches but method not registered
// ---------------------------------------------------------------------------

test('Router: returns 405 when path matches but method is not registered', () => {
    const router = buildRouter(); // has GET /hello and POST /hello
    const req = mockRequest('DELETE', '/hello');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 405);
});

test('Router: 405 body is valid JSON with an "error" key', () => {
    const router = buildRouter();
    const req = mockRequest('PUT', '/hello');
    const mock = mockResponse();

    router.handle(req, mock.res);

    const parsed = JSON.parse(mock.body) as Record<string, unknown>;
    assert.ok('error' in parsed);
});

test('Router: 405 response includes Allow header with registered method', () => {
    const router = new Router();
    router.get('/items', (_req, res, _p) => { res.writeHead(200, {}); res.end('{}'); });

    const req = mockRequest('POST', '/items');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.ok(typeof mock.headers['Allow'] === 'string', 'Allow header should be present');
    assert.ok((mock.headers['Allow'] as string).includes('GET'), `Allow header should include GET, got: ${mock.headers['Allow']}`);
});

test('Router: Allow header lists all registered methods for the matched path', () => {
    const router = buildRouter(); // GET /hello, POST /hello
    const req = mockRequest('DELETE', '/hello');
    const mock = mockResponse();

    router.handle(req, mock.res);

    const allow = mock.headers['Allow'] as string;
    assert.ok(allow.includes('GET'), `Expected GET in Allow, got: ${allow}`);
    assert.ok(allow.includes('POST'), `Expected POST in Allow, got: ${allow}`);
});

test('Router: Allow header does not contain duplicate methods', () => {
    // Register GET /ping twice (e.g. from separate calls) — Allow should list GET once.
    const router = new Router();
    router.get('/ping', (_req, res, _p) => { res.writeHead(200, {}); res.end('{}'); });
    router.get('/ping', (_req, res, _p) => { res.writeHead(200, {}); res.end('{}'); });

    const req = mockRequest('DELETE', '/ping');
    const mock = mockResponse();
    router.handle(req, mock.res);

    const allow = (mock.headers['Allow'] as string).split(', ').map(s => s.trim());
    const unique = new Set(allow);
    assert.strictEqual(unique.size, allow.length, `Duplicate methods in Allow: ${mock.headers['Allow']}`);
});

// ---------------------------------------------------------------------------
// Method normalisation
// ---------------------------------------------------------------------------
// NOTE: ErrorLogManager integration (setErrorLogManager / rejection logging)
// is not covered in this suite. Those behaviours are verified by a dedicated
// edge-case harness (WP-003 QA) that runs independently from this regression
// suite to avoid test interdependencies.

test('Router: method matching is case-insensitive for incoming request', () => {
    const router = new Router();
    router.get('/ping', (_req, res, _p) => {
        res.writeHead(200, {});
        res.end(JSON.stringify({ pong: true }));
    });

    // Some older HTTP libraries may send lowercase method strings.
    const req = mockRequest('get', '/ping');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
});
