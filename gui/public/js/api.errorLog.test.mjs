/**
 * Unit tests for the api.errorLog namespace in api.js.
 *
 * Uses Node's built-in test runner and a lightweight fetch mock.
 * Run individually with:
 *   node --test gui/public/js/api.errorLog.test.mjs
 */

import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// fetch mock infrastructure
// ---------------------------------------------------------------------------

/**
 * Captured calls made to the mocked fetch.
 * @type {{ method: string, url: string }[]}
 */
const calls = [];

/**
 * The response the next fetch call should simulate.
 * @type {{ status: number, body?: unknown, contentType?: string }}
 */
let nextResponse = { status: 200, body: {}, contentType: 'application/json' };

/**
 * Install a global fetch mock before any test runs.
 * The mock records the URL and method, then returns the value of `nextResponse`.
 */
before(() => {
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ method: options.method ?? 'GET', url: String(url) });

        const { status, body, contentType = 'application/json' } = nextResponse;
        const bodyText = body !== undefined ? JSON.stringify(body) : '';

        return {
            status,
            ok: status >= 200 && status < 300,
            statusText: 'OK',
            headers: {
                get(name) {
                    if (name === 'Content-Type') return contentType;
                    return null;
                },
            },
            json() {
                return Promise.resolve(JSON.parse(bodyText));
            },
        };
    };
});

/** Reset captured calls and the next-response configuration after each test. */
afterEach(() => {
    calls.length = 0;
    nextResponse = { status: 200, body: {}, contentType: 'application/json' };
});

// ---------------------------------------------------------------------------
// Import the module under test
// Note: api.js is an ES module — import works directly in Node 18+.
// ---------------------------------------------------------------------------

const { api } = await import('./api.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('api.errorLog is exported as part of the api object', () => {
    assert.ok(api.errorLog, 'api.errorLog should exist');
    assert.equal(typeof api.errorLog.list,  'function', 'api.errorLog.list should be a function');
    assert.equal(typeof api.errorLog.get,   'function', 'api.errorLog.get should be a function');
    assert.equal(typeof api.errorLog.clear, 'function', 'api.errorLog.clear should be a function');
    assert.equal(typeof api.errorLog.count, 'function', 'api.errorLog.count should be a function');
});

test('api.errorLog.list() sends GET /api/error-log and returns the parsed response', async () => {
    const expected = { entries: [], total: 0 };
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    const result = await api.errorLog.list();

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, '/api/error-log');
    assert.deepEqual(result, expected);
});

test('api.errorLog.list() with no params sends no query string', async () => {
    nextResponse = { status: 200, body: { entries: [], total: 0 }, contentType: 'application/json' };

    await api.errorLog.list();

    assert.equal(calls[0].url, '/api/error-log');
});

test('api.errorLog.list({ severity, source, limit }) correctly appends query parameters', async () => {
    nextResponse = { status: 200, body: { entries: [], total: 0 }, contentType: 'application/json' };

    await api.errorLog.list({ severity: 'error', source: 'clone', limit: 10 });

    const url = new URL(calls[0].url, 'http://localhost');
    assert.equal(url.pathname, '/api/error-log');
    assert.equal(url.searchParams.get('severity'), 'error');
    assert.equal(url.searchParams.get('source'),   'clone');
    assert.equal(url.searchParams.get('limit'),    '10');
});

test('api.errorLog.get(42) sends GET /api/error-log/42 and returns the parsed response', async () => {
    const expected = { id: 42, message: 'test error' };
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    const result = await api.errorLog.get(42);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, '/api/error-log/42');
    assert.deepEqual(result, expected);
});

test('api.errorLog.clear() sends DELETE /api/error-log and returns undefined (204)', async () => {
    nextResponse = { status: 204, body: undefined, contentType: 'application/json' };

    const result = await api.errorLog.clear();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(calls[0].url, '/api/error-log');
    assert.equal(result, undefined, 'clear() should resolve with undefined on 204');
});

test('api.errorLog.count() sends GET /api/error-log?limit=0 and returns response containing total', async () => {
    const expected = { entries: [], total: 7 };
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    const result = await api.errorLog.count();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');

    const url = new URL(calls[0].url, 'http://localhost');
    assert.equal(url.pathname, '/api/error-log');
    assert.equal(url.searchParams.get('limit'), '0');
    assert.equal(result.total, 7);
});
