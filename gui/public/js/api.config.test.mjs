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

// ---------------------------------------------------------------------------
// api.config.notesDisplay structure
// ---------------------------------------------------------------------------

test('api.config.notesDisplay is exported as part of the api object', () => {
    assert.ok(api.config, 'api.config should exist');
    assert.ok(api.config.notesDisplay, 'api.config.notesDisplay should exist');
    assert.equal(typeof api.config.notesDisplay.get, 'function', 'api.config.notesDisplay.get should be a function');
    assert.equal(typeof api.config.notesDisplay.set, 'function', 'api.config.notesDisplay.set should be a function');
});

// ---------------------------------------------------------------------------
// api.config.notesDisplay.get()
// ---------------------------------------------------------------------------

test('api.config.notesDisplay.get() sends GET /api/config/notes-display and returns the parsed response', async () => {
    const expected = { showEmptyNotes: true, sortOrder: 'alpha' };
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    const result = await api.config.notesDisplay.get();

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, '/api/config/notes-display');
    assert.deepEqual(result, expected);
});

test('api.config.notesDisplay.get() throws when response is not ok', async () => {
    nextResponse = { status: 500, body: { error: 'Internal Server Error' }, contentType: 'application/json' };

    await assert.rejects(
        () => api.config.notesDisplay.get(),
        (err) => {
            assert.ok(err instanceof Error, 'should throw an Error');
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// api.config.notesDisplay.set()
// ---------------------------------------------------------------------------

test('api.config.notesDisplay.set(data) sends PUT /api/config/notes-display with the provided data', async () => {
    const payload = { showEmptyNotes: false, sortOrder: 'recent' };
    const expected = { showEmptyNotes: false, sortOrder: 'recent' };
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    await api.config.notesDisplay.set(payload);

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].url, '/api/config/notes-display');
    assert.deepEqual(calls[0].body, payload);
});

test('api.config.notesDisplay.set(data) returns the updated config on success', async () => {
    const expected = { showEmptyNotes: true, sortOrder: 'alpha' };
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    const result = await api.config.notesDisplay.set(expected);

    assert.deepEqual(result, expected);
});

test('api.config.notesDisplay.set(data) throws when response is not ok', async () => {
    nextResponse = {
        status: 400,
        body: { error: 'Invalid display settings payload.' },
        contentType: 'application/json',
    };

    await assert.rejects(
        () => api.config.notesDisplay.set({ invalid: true }),
        (err) => {
            assert.ok(err instanceof Error, 'should throw an Error');
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// api.config.credentials structure
// ---------------------------------------------------------------------------

test('api.config.credentials is exported as part of the api object with add, update, remove methods', () => {
    assert.ok(api.config, 'api.config should exist');
    assert.ok(api.config.credentials, 'api.config.credentials should exist');
    assert.equal(typeof api.config.credentials.list,   'function', 'api.config.credentials.list should be a function');
    assert.equal(typeof api.config.credentials.add,    'function', 'api.config.credentials.add should be a function');
    assert.equal(typeof api.config.credentials.update, 'function', 'api.config.credentials.update should be a function');
    assert.equal(typeof api.config.credentials.remove, 'function', 'api.config.credentials.remove should be a function');
});

// ---------------------------------------------------------------------------
// api.config.credentials.list()
// ---------------------------------------------------------------------------

test('api.config.credentials.list() sends GET /api/config/credentials and returns the parsed response', async () => {
    const expected = [
        { id: 'cred-1', label: 'My Token', host: 'github.com', maskedToken: '****abc1' },
    ];
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    const result = await api.config.credentials.list();

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, '/api/config/credentials');
    assert.deepEqual(result, expected);
});

// ---------------------------------------------------------------------------
// api.config.credentials.add()
// ---------------------------------------------------------------------------

test('api.config.credentials.add(data) sends PUT /api/config/credentials with correct body (no id)', async () => {
    const payload  = { label: 'My GitHub Token', host: 'github.com', token: 'ghp_secret' };
    const expected = [{ id: 'cred-1', label: 'My GitHub Token', host: 'github.com', maskedToken: '****cret' }];
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    const result = await api.config.credentials.add(payload);

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].url, '/api/config/credentials');
    assert.deepEqual(calls[0].body, payload, 'request body should match the payload (no id field)');
    assert.equal(calls[0].body.id, undefined, 'request body should NOT contain an id field');
    assert.deepEqual(result, expected);
});

test('api.config.credentials.add(data) throws when response is not ok', async () => {
    nextResponse = { status: 400, body: { error: 'Missing required field.' }, contentType: 'application/json' };

    await assert.rejects(
        () => api.config.credentials.add({ label: 'Bad', host: '', token: '' }),
        (err) => {
            assert.ok(err instanceof Error, 'should throw an Error');
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// api.config.credentials.update()
// ---------------------------------------------------------------------------

test('api.config.credentials.update(id, data) sends PUT /api/config/credentials with the existing id in the body', async () => {
    const id       = 'cred-abc';
    const data     = { label: 'Updated Label', token: 'new_token' };
    const expected = [{ id: 'cred-abc', label: 'Updated Label', host: 'github.com', maskedToken: '****oken' }];
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    const result = await api.config.credentials.update(id, data);

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].url, '/api/config/credentials');
    assert.equal(calls[0].body.id, id, 'request body should contain the existing credential id');
    assert.equal(calls[0].body.label, data.label, 'request body should include the updated label');
    assert.equal(calls[0].body.token, data.token, 'request body should include the updated token');
    assert.deepEqual(result, expected);
});

test('api.config.credentials.update(id, data) throws when response is not ok', async () => {
    nextResponse = { status: 404, body: { error: 'Credential not found.' }, contentType: 'application/json' };

    await assert.rejects(
        () => api.config.credentials.update('nonexistent', { label: 'x' }),
        (err) => {
            assert.ok(err instanceof Error, 'should throw an Error');
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// api.config.credentials.remove()
// ---------------------------------------------------------------------------

test('api.config.credentials.remove(id) sends DELETE /api/config/credentials/:id', async () => {
    const id = 'cred-xyz';
    nextResponse = { status: 204, contentType: 'application/json' };

    await api.config.credentials.remove(id);

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(calls[0].url, `/api/config/credentials/${encodeURIComponent(id)}`);
});

test('api.config.credentials.remove(id) uses the credential id in the URL, not a host string', async () => {
    const id = 'cred-abc-123';
    nextResponse = { status: 204, contentType: 'application/json' };

    await api.config.credentials.remove(id);

    assert.ok(calls[0].url.includes(id), 'URL should contain the credential id');
    assert.ok(!calls[0].url.includes('github.com'), 'URL should NOT contain a host string');
});

test('api.config.credentials.remove(id) throws when response is not ok', async () => {
    nextResponse = { status: 404, body: { error: 'Credential not found.' }, contentType: 'application/json' };

    await assert.rejects(
        () => api.config.credentials.remove('nonexistent'),
        (err) => {
            assert.ok(err instanceof Error, 'should throw an Error');
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// api.repositories.credentialOptions()
// ---------------------------------------------------------------------------

test('api.repositories.credentialOptions(id) sends GET /api/repositories/:id/credential-options', async () => {
    const expected = [
        { credentialId: 'cred-1', label: 'My Token', host: 'github.com', auto: true },
    ];
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    const result = await api.repositories.credentialOptions('repo-abc');

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, '/api/repositories/repo-abc/credential-options');
    assert.deepEqual(result, expected);
});

test('api.repositories.credentialOptions(id) URL-encodes the repository ID', async () => {
    nextResponse = { status: 200, body: [], contentType: 'application/json' };

    await api.repositories.credentialOptions('org/repo with spaces');

    assert.equal(calls[0].url, `/api/repositories/${encodeURIComponent('org/repo with spaces')}/credential-options`);
});

test('api.repositories.credentialOptions(id) throws when response is not ok', async () => {
    nextResponse = { status: 404, body: { error: 'Repository not found.' }, contentType: 'application/json' };

    await assert.rejects(
        () => api.repositories.credentialOptions('nonexistent'),
        (err) => {
            assert.ok(err instanceof Error, 'should throw an Error');
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// api.repositories.updateCredential()
// ---------------------------------------------------------------------------

test('api.repositories.updateCredential(id, credentialId) sends PUT /api/repositories/:id/credential with correct body', async () => {
    const expected = { Id: 'repo-abc', CredentialId: 'cred-1' };
    nextResponse = { status: 200, body: expected, contentType: 'application/json' };

    const result = await api.repositories.updateCredential('repo-abc', 'cred-1');

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].url, '/api/repositories/repo-abc/credential');
    assert.deepEqual(calls[0].body, { credentialId: 'cred-1' });
    assert.deepEqual(result, expected);
});

test('api.repositories.updateCredential(id, "") sends empty credentialId to clear association', async () => {
    nextResponse = { status: 200, body: { Id: 'repo-abc', CredentialId: '' }, contentType: 'application/json' };

    await api.repositories.updateCredential('repo-abc', '');

    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].url, '/api/repositories/repo-abc/credential');
    assert.deepEqual(calls[0].body, { credentialId: '' });
});

test('api.repositories.updateCredential(id, credentialId) URL-encodes the repository ID', async () => {
    nextResponse = { status: 200, body: {}, contentType: 'application/json' };

    await api.repositories.updateCredential('org/repo with spaces', 'cred-1');

    assert.equal(calls[0].url, `/api/repositories/${encodeURIComponent('org/repo with spaces')}/credential`);
});

test('api.repositories.updateCredential(id, credentialId) throws when response is not ok', async () => {
    nextResponse = { status: 404, body: { error: 'Repository not found.' }, contentType: 'application/json' };

    await assert.rejects(
        () => api.repositories.updateCredential('nonexistent', 'cred-1'),
        (err) => {
            assert.ok(err instanceof Error, 'should throw an Error');
            return true;
        },
    );
});
