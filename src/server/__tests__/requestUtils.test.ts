import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import {
    parseJsonBody,
    sendJson,
    sendError,
    extractParams,
} from '../requestUtils.js';
import { mockResponse, type MockResponse } from './helpers/mock-http.js';

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

/**
 * Creates a mock IncomingMessage that emits the supplied body chunks then ends.
 * Pass `destroyOnData: true` to simulate the stream being destroyed mid-read
 * (used to test the over-limit path without actually exceeding 1 MB in tests).
 */
function mockRequest(chunks: Buffer[]): IncomingMessage {
    const emitter = new EventEmitter() as IncomingMessage;
    // Simulate async delivery of chunks
    process.nextTick(() => {
        for (const chunk of chunks) {
            emitter.emit('data', chunk);
        }
        emitter.emit('end');
    });
    // Add a no-op destroy so parseJsonBody can call it
    (emitter as unknown as { destroy(): void }).destroy = () => {
        emitter.emit('error', new Error('destroyed'));
    };
    return emitter;
}

/** Creates a mock IncomingMessage that emits an error immediately. */
function mockRequestWithError(err: Error): IncomingMessage {
    const emitter = new EventEmitter() as IncomingMessage;
    (emitter as unknown as { destroy(): void }).destroy = () => {};
    process.nextTick(() => emitter.emit('error', err));
    return emitter;
}

// ---------------------------------------------------------------------------
// parseJsonBody
// ---------------------------------------------------------------------------

test('parseJsonBody: resolves with parsed object for valid JSON', async () => {
    const payload = { hello: 'world', count: 42 };
    const req = mockRequest([Buffer.from(JSON.stringify(payload))]);
    const result = await parseJsonBody(req);
    assert.deepEqual(result, payload);
});

test('parseJsonBody: resolves with parsed array for valid JSON array', async () => {
    const payload = [1, 2, 3];
    const req = mockRequest([Buffer.from(JSON.stringify(payload))]);
    const result = await parseJsonBody(req);
    assert.deepEqual(result, payload);
});

test('parseJsonBody: resolves from multiple chunks', async () => {
    const full = JSON.stringify({ a: 1 });
    const half = Math.floor(full.length / 2);
    const chunks = [
        Buffer.from(full.slice(0, half)),
        Buffer.from(full.slice(half)),
    ];
    const req = mockRequest(chunks);
    const result = await parseJsonBody(req);
    assert.deepEqual(result, { a: 1 });
});

test('parseJsonBody: rejects with descriptive error on malformed JSON', async () => {
    const req = mockRequest([Buffer.from('not json at all {{{')]);
    await assert.rejects(
        () => parseJsonBody(req),
        (err: Error) => {
            assert.ok(err.message.startsWith('Invalid JSON body:'), err.message);
            return true;
        },
    );
});

test('parseJsonBody: rejects when body exceeds 1 MB', async () => {
    // Build a body just over the 1 MB limit
    const oversized = Buffer.alloc(1 * 1024 * 1024 + 1, 'x');
    const req = mockRequest([oversized]);
    await assert.rejects(
        () => parseJsonBody(req),
        /1 MB limit/,
    );
});

test('parseJsonBody: rejects on stream error', async () => {
    const req = mockRequestWithError(new Error('socket hang up'));
    await assert.rejects(
        () => parseJsonBody(req),
        /socket hang up/,
    );
});

// ---------------------------------------------------------------------------
// sendJson
// ---------------------------------------------------------------------------

test('sendJson: sets Content-Type to application/json', () => {
    const mock = mockResponse();
    sendJson(mock.res, 200, { ok: true });
    assert.strictEqual(mock.headers['Content-Type'], 'application/json');
});

test('sendJson: sets the correct status code (200)', () => {
    const mock = mockResponse();
    sendJson(mock.res, 200, {});
    assert.strictEqual(mock.statusCode, 200);
});

test('sendJson: sets the correct status code (201)', () => {
    const mock = mockResponse();
    sendJson(mock.res, 201, { id: 7 });
    assert.strictEqual(mock.statusCode, 201);
});

test('sendJson: sets the correct status code (404)', () => {
    const mock = mockResponse();
    sendJson(mock.res, 404, { error: 'not found' });
    assert.strictEqual(mock.statusCode, 404);
});

test('sendJson: body is valid JSON matching the supplied data', () => {
    const data = { repos: ['a', 'b'] };
    const mock = mockResponse();
    sendJson(mock.res, 200, data);
    assert.deepEqual(JSON.parse(mock.body), data);
});

test('sendJson: sets Content-Length header', () => {
    const mock = mockResponse();
    sendJson(mock.res, 200, { x: 1 });
    const body = JSON.stringify({ x: 1 });
    assert.strictEqual(mock.headers['Content-Length'], Buffer.byteLength(body));
});

// ---------------------------------------------------------------------------
// sendError
// ---------------------------------------------------------------------------

test('sendError: body has shape { error: string }', () => {
    const mock = mockResponse();
    sendError(mock.res, 400, 'bad input');
    const parsed = JSON.parse(mock.body) as unknown;
    assert.ok(
        parsed !== null && typeof parsed === 'object' && 'error' in (parsed as object),
        'body should have "error" key',
    );
    assert.strictEqual((parsed as { error: string }).error, 'bad input');
});

test('sendError: sets the specified HTTP status', () => {
    const mock = mockResponse();
    sendError(mock.res, 500, 'internal error');
    assert.strictEqual(mock.statusCode, 500);
});

test('sendError: sets Content-Type to application/json', () => {
    const mock = mockResponse();
    sendError(mock.res, 422, 'unprocessable');
    assert.strictEqual(mock.headers['Content-Type'], 'application/json');
});

test('sendError: body error property equals the provided message', () => {
    const mock = mockResponse();
    sendError(mock.res, 404, 'resource not found');
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.strictEqual(parsed.error, 'resource not found');
});

// ---------------------------------------------------------------------------
// extractParams
// ---------------------------------------------------------------------------

test('extractParams: extracts a single named segment', () => {
    assert.deepEqual(extractParams('/repos/:id', '/repos/42'), { id: '42' });
});

test('extractParams: extracts multiple named segments', () => {
    assert.deepEqual(
        extractParams('/repos/:owner/:repo', '/repos/alice/my-project'),
        { owner: 'alice', repo: 'my-project' },
    );
});

test('extractParams: returns empty object for pattern with no named segments', () => {
    assert.deepEqual(extractParams('/health', '/health'), {});
});

test('extractParams: returns null when segment count differs (extra segment in url)', () => {
    assert.strictEqual(extractParams('/repos/:id', '/repos/42/extra'), null);
});

test('extractParams: returns null when segment count differs (url is shorter)', () => {
    assert.strictEqual(extractParams('/repos/:id/branches', '/repos/42'), null);
});

test('extractParams: returns null when a static segment does not match', () => {
    assert.strictEqual(extractParams('/repos/:id', '/other/42'), null);
});

test('extractParams: ignores query string when matching', () => {
    assert.deepEqual(
        extractParams('/repos/:id', '/repos/99?foo=bar'),
        { id: '99' },
    );
});

test('extractParams: handles root path match', () => {
    assert.deepEqual(extractParams('/', '/'), {});
});

test('extractParams: returns null when root vs non-root', () => {
    assert.strictEqual(extractParams('/', '/repos'), null);
});
