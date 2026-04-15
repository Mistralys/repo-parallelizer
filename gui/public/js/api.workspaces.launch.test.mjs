/**
 * Unit tests for the api.workspaces.launch.vscode and
 * api.workspaces.launch.githubDesktop methods in api.js.
 *
 * Uses Node's built-in test runner and a lightweight fetch mock.
 * Run individually with:
 *   node --test gui/public/js/api.workspaces.launch.test.mjs
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
let nextResponse = { status: 200, body: { success: true }, contentType: 'application/json' };

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
    nextResponse = { status: 200, body: { success: true }, contentType: 'application/json' };
});

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

const { api } = await import('./api.js');

// ---------------------------------------------------------------------------
// Structure tests
// ---------------------------------------------------------------------------

test('api.workspaces.launch is an object', () => {
    assert.equal(typeof api.workspaces.launch, 'object');
    assert.notEqual(api.workspaces.launch, null);
});

test('api.workspaces.launch.vscode is exported as a function', () => {
    assert.equal(typeof api.workspaces.launch.vscode, 'function');
});

test('api.workspaces.launch.githubDesktop is exported as a function', () => {
    assert.equal(typeof api.workspaces.launch.githubDesktop, 'function');
});

test('api.workspaces.openVscode no longer exists on the workspaces object', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(api.workspaces, 'openVscode'), false);
});

test('api.workspaces.openGithubDesktop no longer exists on the workspaces object', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(api.workspaces, 'openGithubDesktop'), false);
});

// ---------------------------------------------------------------------------
// api.workspaces.launch.vscode()
// ---------------------------------------------------------------------------

test('launch.vscode() sends POST to the correct URL', async () => {
    await api.workspaces.launch.vscode('my-project', 'my-workspace');

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/api/projects/my-project/workspaces/my-workspace/launch/vscode');
});

test('launch.vscode() encodes special characters in projectId and wid', async () => {
    await api.workspaces.launch.vscode('proj/a b', 'ws/x y');

    assert.equal(calls[0].url, '/api/projects/proj%2Fa%20b/workspaces/ws%2Fx%20y/launch/vscode');
});

test('launch.vscode() sends no request body', async () => {
    await api.workspaces.launch.vscode('my-project', 'my-workspace');

    assert.equal(calls[0].body, undefined, 'no request body should be sent');
});

test('launch.vscode() returns the parsed JSON response', async () => {
    nextResponse = { status: 200, body: { success: true }, contentType: 'application/json' };

    const result = await api.workspaces.launch.vscode('my-project', 'my-workspace');

    assert.deepEqual(result, { success: true });
});

test('launch.vscode() throws on non-2xx response', async () => {
    nextResponse = { status: 500, body: { error: 'launch failed' }, contentType: 'application/json' };

    await assert.rejects(
        () => api.workspaces.launch.vscode('my-project', 'my-workspace'),
        (err) => {
            assert.equal(err.message, 'launch failed');
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// api.workspaces.launch.githubDesktop()
// ---------------------------------------------------------------------------

test('launch.githubDesktop() sends POST to the correct URL', async () => {
    await api.workspaces.launch.githubDesktop('my-project', 'my-workspace', 'my-repo');

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/api/projects/my-project/workspaces/my-workspace/launch/github-desktop/my-repo');
});

test('launch.githubDesktop() encodes special characters in all three path parameters', async () => {
    await api.workspaces.launch.githubDesktop('proj/a b', 'ws/x y', 'repo/z w');

    assert.equal(
        calls[0].url,
        '/api/projects/proj%2Fa%20b/workspaces/ws%2Fx%20y/launch/github-desktop/repo%2Fz%20w',
    );
});

test('launch.githubDesktop() sends no request body', async () => {
    await api.workspaces.launch.githubDesktop('my-project', 'my-workspace', 'my-repo');

    assert.equal(calls[0].body, undefined, 'no request body should be sent');
});

test('launch.githubDesktop() returns the parsed JSON response', async () => {
    nextResponse = { status: 200, body: { success: true }, contentType: 'application/json' };

    const result = await api.workspaces.launch.githubDesktop('my-project', 'my-workspace', 'my-repo');

    assert.deepEqual(result, { success: true });
});

test('launch.githubDesktop() throws on non-2xx response', async () => {
    nextResponse = { status: 500, body: { error: 'app not installed' }, contentType: 'application/json' };

    await assert.rejects(
        () => api.workspaces.launch.githubDesktop('my-project', 'my-workspace', 'my-repo'),
        (err) => {
            assert.equal(err.message, 'app not installed');
            return true;
        },
    );
});
