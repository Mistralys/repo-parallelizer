/**
 * Unit tests for the api.config namespace in api.js.
 *
 * Uses Node's built-in test runner and a lightweight fetch mock.
 * Run individually with:
 *   node --test gui/public/js/api.config.test.mjs
 */

import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// fetch mock infrastructure
// ---------------------------------------------------------------------------

/**
 * Captured calls made to the mocked fetch.
 * @type {{ method: string, url: string, body?: unknown }[]}
 */
const calls = [];

/**
 * The response the next fetch call should simulate.
 * @type {{ status: number, body?: unknown, contentType?: string }}
 */
let nextResponse = { status: 200, body: {}, contentType: 'application/json' };

/**
 * Install a global fetch mock before any test runs.
 * The mock records the URL, method, and body, then returns the value of `nextResponse`.
 */
before(() => {
    globalThis.fetch = async (url, options = {}) => {
        const rawBody = options.body;
        calls.push({
            method: options.method ?? 'GET',
            url: String(url),
            body: rawBody ? JSON.parse(rawBody) : undefined,
        });

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
// Structure tests
// ---------------------------------------------------------------------------

test('api.config.polling is exported as part of the api object', () => {
    assert.ok(api.config, 'api.config should exist');
    assert.ok(api.config.polling, 'api.config.polling should exist');
    assert.equal(typeof api.config.polling.get, 'function', 'api.config.polling.get should be a function');
    assert.equal(typeof api.config.polling.set, 'function', 'api.config.polling.set should be a function');
});

// ---------------------------------------------------------------------------
// api.config.polling.get()
// ---------------------------------------------------------------------------

test('api.config.polling.get() sends GET /api/config/polling and returns the parsed response', async () => {
    const expected = { gitPollingIntervalSeconds: 30 };
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    const result = await api.config.polling.get();

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, '/api/config/polling');
    assert.deepEqual(result, expected);
});

test('api.config.polling.get() returns the gitPollingIntervalSeconds value', async () => {
    nextResponse = { status: 200, body: { gitPollingIntervalSeconds: 60 }, contentType: 'application/json' };

    const result = await api.config.polling.get();

    assert.equal(result.gitPollingIntervalSeconds, 60);
});

test('api.config.polling.get() throws when response is not ok', async () => {
    nextResponse = { status: 500, body: { error: 'Internal Server Error' }, contentType: 'application/json' };

    await assert.rejects(
        () => api.config.polling.get(),
        (err) => {
            assert.ok(err instanceof Error, 'should throw an Error');
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// api.config.polling.set()
// ---------------------------------------------------------------------------

test('api.config.polling.set(seconds) sends PUT /api/config/polling with { seconds } body', async () => {
    const expected = { gitPollingIntervalSeconds: 60 };
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    await api.config.polling.set(60);

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].url, '/api/config/polling');
    assert.deepEqual(calls[0].body, { seconds: 60 });
});

test('api.config.polling.set(seconds) returns the updated config on success', async () => {
    const expected = { gitPollingIntervalSeconds: 120 };
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    const result = await api.config.polling.set(120);

    assert.deepEqual(result, expected);
});

test('api.config.polling.set(seconds) throws when response is not ok', async () => {
    nextResponse = {
        status: 400,
        body: { error: 'Field "seconds" must be at least 10. Received: 5.' },
        contentType: 'application/json',
    };

    await assert.rejects(
        () => api.config.polling.set(5),
        (err) => {
            assert.ok(err instanceof Error, 'should throw an Error');
            return true;
        },
    );
});

test('api.config.polling.set(86400) succeeds at the maximum boundary', async () => {
    const expected = { gitPollingIntervalSeconds: 86400 };
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    const result = await api.config.polling.set(86400);

    assert.equal(calls[0].body.seconds, 86400);
    assert.deepEqual(result, expected);
});
