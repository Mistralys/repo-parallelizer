/**
 * Unit tests for the api.repositories.infoSync.{status, saveSettings, refresh,
 * recreateMainFolder, importPreview, applyImport, commitPush} methods in api.js.
 *
 * Uses Node's built-in test runner and a lightweight fetch mock.
 * Run individually with:
 *   node --test gui/public/js/api.infoSync.test.mjs
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

test('api.repositories.infoSync is an object', () => {
    assert.equal(typeof api.repositories.infoSync, 'object');
    assert.notEqual(api.repositories.infoSync, null);
});

for (const method of ['status', 'saveSettings', 'refresh', 'recreateMainFolder', 'importPreview', 'applyImport', 'commitPush']) {
    test(`api.repositories.infoSync.${method} is exported as a function`, () => {
        assert.equal(typeof api.repositories.infoSync[method], 'function');
    });
}

// ---------------------------------------------------------------------------
// status()
// ---------------------------------------------------------------------------

test('infoSync.status() sends GET to the correct URL', async () => {
    await api.repositories.infoSync.status('my-repo');

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, '/api/repositories/my-repo/info-sync');
});

test('infoSync.status() encodes special characters in id', async () => {
    await api.repositories.infoSync.status('repo/a b');

    assert.equal(calls[0].url, '/api/repositories/repo%2Fa%20b/info-sync');
});

test('infoSync.status() sends no request body', async () => {
    await api.repositories.infoSync.status('my-repo');

    assert.equal(calls[0].body, undefined, 'no request body should be sent');
});

test('infoSync.status() returns the parsed JSON response', async () => {
    nextResponse = { status: 200, body: { enabled: true, state: 'in-sync' }, contentType: 'application/json' };

    const result = await api.repositories.infoSync.status('my-repo');

    assert.deepEqual(result, { enabled: true, state: 'in-sync' });
});

test('infoSync.status() throws on non-2xx response', async () => {
    nextResponse = { status: 404, body: { error: 'repository not found' }, contentType: 'application/json' };

    await assert.rejects(
        () => api.repositories.infoSync.status('missing-repo'),
        (err) => {
            assert.equal(err.message, 'repository not found');
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// saveSettings()
// ---------------------------------------------------------------------------

test('infoSync.saveSettings() sends PUT to the correct URL with the given body', async () => {
    await api.repositories.infoSync.saveSettings('my-repo', { enabled: true });

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].url, '/api/repositories/my-repo/info-sync');
    assert.deepEqual(calls[0].body, { enabled: true });
});

test('infoSync.saveSettings() forwards discardPendingChanges', async () => {
    await api.repositories.infoSync.saveSettings('my-repo', { enabled: false, discardPendingChanges: true });

    assert.deepEqual(calls[0].body, { enabled: false, discardPendingChanges: true });
});

test('infoSync.saveSettings() encodes special characters in id', async () => {
    await api.repositories.infoSync.saveSettings('repo/a b', { enabled: true });

    assert.equal(calls[0].url, '/api/repositories/repo%2Fa%20b/info-sync');
});

test('infoSync.saveSettings() throws on non-2xx response', async () => {
    nextResponse = { status: 400, body: { error: 'Field enabled is required and must be a boolean.' }, contentType: 'application/json' };

    await assert.rejects(
        () => api.repositories.infoSync.saveSettings('my-repo', {}),
        (err) => {
            assert.equal(err.message, 'Field enabled is required and must be a boolean.');
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// refresh()
// ---------------------------------------------------------------------------

test('infoSync.refresh() sends POST to the correct URL', async () => {
    await api.repositories.infoSync.refresh('my-repo');

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/api/repositories/my-repo/info-sync/refresh');
});

test('infoSync.refresh() encodes special characters in id', async () => {
    await api.repositories.infoSync.refresh('repo/a b');

    assert.equal(calls[0].url, '/api/repositories/repo%2Fa%20b/info-sync/refresh');
});

test('infoSync.refresh() sends no request body', async () => {
    await api.repositories.infoSync.refresh('my-repo');

    assert.equal(calls[0].body, undefined, 'no request body should be sent');
});

// ---------------------------------------------------------------------------
// recreateMainFolder()
// ---------------------------------------------------------------------------

test('infoSync.recreateMainFolder() sends POST to the correct URL with no body when discardPendingChanges omitted', async () => {
    await api.repositories.infoSync.recreateMainFolder('my-repo');

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/api/repositories/my-repo/info-sync/recreate-main-folder');
    assert.deepEqual(calls[0].body, {});
});

test('infoSync.recreateMainFolder() forwards discardPendingChanges when provided', async () => {
    await api.repositories.infoSync.recreateMainFolder('my-repo', true);

    assert.deepEqual(calls[0].body, { discardPendingChanges: true });
});

test('infoSync.recreateMainFolder() encodes special characters in id', async () => {
    await api.repositories.infoSync.recreateMainFolder('repo/a b');

    assert.equal(calls[0].url, '/api/repositories/repo%2Fa%20b/info-sync/recreate-main-folder');
});

// ---------------------------------------------------------------------------
// importPreview()
// ---------------------------------------------------------------------------

test('infoSync.importPreview() sends GET to the correct URL', async () => {
    await api.repositories.infoSync.importPreview('my-repo');

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, '/api/repositories/my-repo/info-sync/import');
});

test('infoSync.importPreview() encodes special characters in id', async () => {
    await api.repositories.infoSync.importPreview('repo/a b');

    assert.equal(calls[0].url, '/api/repositories/repo%2Fa%20b/info-sync/import');
});

test('infoSync.importPreview() returns the parsed JSON response', async () => {
    const preview = { state: 'incoming', fields: [{ field: 'Name', current: 'a', incoming: 'b' }] };
    nextResponse = { status: 200, body: preview, contentType: 'application/json' };

    const result = await api.repositories.infoSync.importPreview('my-repo');

    assert.deepEqual(result, preview);
});

// ---------------------------------------------------------------------------
// applyImport()
// ---------------------------------------------------------------------------

test('infoSync.applyImport() sends POST to the correct URL with the fields array', async () => {
    await api.repositories.infoSync.applyImport('my-repo', ['Name', 'Description']);

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/api/repositories/my-repo/info-sync/import');
    assert.deepEqual(calls[0].body, { fields: ['Name', 'Description'] });
});

test('infoSync.applyImport() sends an empty fields array as-is', async () => {
    await api.repositories.infoSync.applyImport('my-repo', []);

    assert.deepEqual(calls[0].body, { fields: [] });
});

test('infoSync.applyImport() encodes special characters in id', async () => {
    await api.repositories.infoSync.applyImport('repo/a b', []);

    assert.equal(calls[0].url, '/api/repositories/repo%2Fa%20b/info-sync/import');
});

test('infoSync.applyImport() throws on non-2xx response', async () => {
    nextResponse = {
        status: 400,
        body: { error: 'Field fields contains an unsupported value "Url".' },
        contentType: 'application/json',
    };

    await assert.rejects(
        () => api.repositories.infoSync.applyImport('my-repo', ['Url']),
        (err) => {
            assert.equal(err.message, 'Field fields contains an unsupported value "Url".');
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// commitPush()
// ---------------------------------------------------------------------------

test('infoSync.commitPush() sends POST to the correct URL with no body when message omitted', async () => {
    await api.repositories.infoSync.commitPush('my-repo');

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/api/repositories/my-repo/info-sync/commit-push');
    assert.deepEqual(calls[0].body, {});
});

test('infoSync.commitPush() forwards the message when provided', async () => {
    await api.repositories.infoSync.commitPush('my-repo', 'Sync workspace info');

    assert.deepEqual(calls[0].body, { message: 'Sync workspace info' });
});

test('infoSync.commitPush() encodes special characters in id', async () => {
    await api.repositories.infoSync.commitPush('repo/a b');

    assert.equal(calls[0].url, '/api/repositories/repo%2Fa%20b/info-sync/commit-push');
});

test('infoSync.commitPush() returns the parsed JSON response', async () => {
    const result = { committed: true, pushed: true, commitSha: 'abc123' };
    nextResponse = { status: 200, body: result, contentType: 'application/json' };

    const response = await api.repositories.infoSync.commitPush('my-repo', 'msg');

    assert.deepEqual(response, result);
});
