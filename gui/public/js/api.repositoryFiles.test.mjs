/**
 * Unit tests for `api.repositories.files.{list, create, update, remove}`
 * (Milestone 2's GUI API client for repository files), the `files` extension
 * to `api.repositories.infoSync.applyImport()`, and `normaliseRepositoryFile()`
 * in `utils/normalise.js`.
 *
 * Uses Node's built-in test runner and a lightweight fetch mock.
 * Run individually with:
 *   node --test gui/public/js/api.repositoryFiles.test.mjs
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
// Import the modules under test
// ---------------------------------------------------------------------------

const { api } = await import('./api.js');
const { normaliseRepositoryFile } = await import('./utils/normalise.js');

// ---------------------------------------------------------------------------
// Structure tests
// ---------------------------------------------------------------------------

test('api.repositories.files is an object', () => {
    assert.equal(typeof api.repositories.files, 'object');
    assert.notEqual(api.repositories.files, null);
});

for (const method of ['list', 'create', 'update', 'remove']) {
    test(`api.repositories.files.${method} is exported as a function`, () => {
        assert.equal(typeof api.repositories.files[method], 'function');
    });
}

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

test('files.list() sends GET to /api/repositories/:id/files', async () => {
    await api.repositories.files.list('my-repo');

    assert.equal(calls.length, 1, 'exactly one fetch call expected');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, '/api/repositories/my-repo/files');
    assert.equal(calls[0].body, undefined);
});

test('files.list() encodes special characters in the repository id', async () => {
    await api.repositories.files.list('repo/a b');

    assert.equal(calls[0].url, '/api/repositories/repo%2Fa%20b/files');
});

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

test('files.create() sends POST to /api/repositories/:id/files with the data body', async () => {
    const data = { fileName: 'build.sh', label: 'Build script', content: '#!/bin/sh\n' };
    await api.repositories.files.create('my-repo', data);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/api/repositories/my-repo/files');
    assert.deepEqual(calls[0].body, data);
});

test('files.create() encodes special characters in the repository id', async () => {
    await api.repositories.files.create('repo/a b', { fileName: 'x.sh', label: 'L', content: '' });

    assert.equal(calls[0].url, '/api/repositories/repo%2Fa%20b/files');
});

test('files.create() throws on non-2xx response', async () => {
    nextResponse = {
        status: 400,
        body: { error: 'File name is required.' },
        contentType: 'application/json',
    };

    await assert.rejects(
        () => api.repositories.files.create('my-repo', { fileName: '', label: 'L', content: '' }),
        (err) => {
            assert.equal(err.message, 'File name is required.');
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

test('files.update() sends PUT to /api/repositories/:id/files/:fileId with the data body', async () => {
    const data = { fileName: 'build.sh', label: 'Build script v2', content: '#!/bin/sh\necho hi\n' };
    await api.repositories.files.update('my-repo', 'file-1', data);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].url, '/api/repositories/my-repo/files/file-1');
    assert.deepEqual(calls[0].body, data);
});

test('files.update() encodes special characters in both the repository id and the file id', async () => {
    await api.repositories.files.update('repo/a b', 'file/1 x', { fileName: 'x.sh', label: 'L', content: '' });

    assert.equal(calls[0].url, '/api/repositories/repo%2Fa%20b/files/file%2F1%20x');
});

// ---------------------------------------------------------------------------
// remove()
// ---------------------------------------------------------------------------

test('files.remove() sends DELETE to /api/repositories/:id/files/:fileId', async () => {
    nextResponse = { status: 204 };
    await api.repositories.files.remove('my-repo', 'file-1');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(calls[0].url, '/api/repositories/my-repo/files/file-1');
    assert.equal(calls[0].body, undefined);
});

test('files.remove() encodes special characters in both the repository id and the file id', async () => {
    nextResponse = { status: 204 };
    await api.repositories.files.remove('repo/a b', 'file/1 x');

    assert.equal(calls[0].url, '/api/repositories/repo%2Fa%20b/files/file%2F1%20x');
});

test('files.remove() throws on non-2xx response', async () => {
    nextResponse = {
        status: 409,
        body: { error: 'Info sync is not enabled for this repository.' },
        contentType: 'application/json',
    };

    await assert.rejects(
        () => api.repositories.files.remove('my-repo', 'file-1'),
        (err) => {
            assert.equal(err.message, 'Info sync is not enabled for this repository.');
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// infoSync.applyImport() — files extension
// ---------------------------------------------------------------------------

test('infoSync.applyImport() still accepts a bare fields array (pre-Milestone-2 call shape)', async () => {
    await api.repositories.infoSync.applyImport('my-repo', ['Name', 'Description']);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/api/repositories/my-repo/info-sync/import');
    assert.deepEqual(calls[0].body, { fields: ['Name', 'Description'] });
});

test('infoSync.applyImport() sends both fields and files when both are provided', async () => {
    const files = [{ path: 'scripts/build.sh', action: 'overwrite' }];
    await api.repositories.infoSync.applyImport('my-repo', { fields: ['Name'], files });

    assert.deepEqual(calls[0].body, { fields: ['Name'], files });
});

test('infoSync.applyImport() omits the fields key when only files is provided', async () => {
    const files = [{ path: 'scripts/build.sh', action: 'add' }];
    await api.repositories.infoSync.applyImport('my-repo', { files });

    assert.deepEqual(calls[0].body, { files });
    assert.equal('fields' in calls[0].body, false);
});

test('infoSync.applyImport() omits the files key when only fields is provided', async () => {
    await api.repositories.infoSync.applyImport('my-repo', { fields: ['Description'] });

    assert.deepEqual(calls[0].body, { fields: ['Description'] });
    assert.equal('files' in calls[0].body, false);
});

test('infoSync.applyImport() sends an empty body when neither fields nor files is provided', async () => {
    await api.repositories.infoSync.applyImport('my-repo', {});

    assert.deepEqual(calls[0].body, {});
});

test('infoSync.applyImport() sends an empty body when called with no selections argument', async () => {
    await api.repositories.infoSync.applyImport('my-repo');

    assert.deepEqual(calls[0].body, {});
});

// ---------------------------------------------------------------------------
// normaliseRepositoryFile()
// ---------------------------------------------------------------------------

test('normaliseRepositoryFile() accepts PascalCase keys', () => {
    const result = normaliseRepositoryFile({
        Id: '1',
        Directory: 'scripts',
        FileName: 'build.sh',
        Label: 'Build script',
        Description: 'Builds the project',
        Content: '#!/bin/sh\n',
        Executable: true,
        ListInAgents: true,
        DateModified: '2026-11-20T00:00:00.000Z',
    });

    assert.deepEqual(result, {
        id: '1',
        directory: 'scripts',
        fileName: 'build.sh',
        label: 'Build script',
        description: 'Builds the project',
        content: '#!/bin/sh\n',
        executable: true,
        listInAgents: true,
        dateModified: '2026-11-20T00:00:00.000Z',
    });
});

test('normaliseRepositoryFile() accepts camelCase keys', () => {
    const result = normaliseRepositoryFile({
        id: '1',
        directory: 'scripts',
        fileName: 'build.sh',
        label: 'Build script',
        description: 'Builds the project',
        content: '#!/bin/sh\n',
        executable: true,
        listInAgents: true,
        dateModified: '2026-11-20T00:00:00.000Z',
    });

    assert.deepEqual(result, {
        id: '1',
        directory: 'scripts',
        fileName: 'build.sh',
        label: 'Build script',
        description: 'Builds the project',
        content: '#!/bin/sh\n',
        executable: true,
        listInAgents: true,
        dateModified: '2026-11-20T00:00:00.000Z',
    });
});

test('normaliseRepositoryFile() fills every field default for an empty object', () => {
    assert.deepEqual(normaliseRepositoryFile({}), {
        id: '',
        directory: '',
        fileName: '',
        label: '',
        description: '',
        content: '',
        executable: false,
        listInAgents: false,
        dateModified: '',
    });
});

test('normaliseRepositoryFile() strips unrecognised keys from the input object', () => {
    const result = normaliseRepositoryFile({
        Id: '1',
        FileName: 'build.sh',
        Label: 'L',
        UnknownField: 'should not appear',
        AnotherUnknown: 42,
    });

    assert.deepEqual(Object.keys(result).sort(), [
        'content', 'dateModified', 'description', 'directory', 'executable',
        'fileName', 'id', 'label', 'listInAgents',
    ]);
    assert.equal('UnknownField' in result, false);
    assert.equal('AnotherUnknown' in result, false);
    assert.equal('unknownField' in result, false);
});

test('normaliseRepositoryFile() coerces Executable/ListInAgents to a strict boolean', () => {
    assert.equal(normaliseRepositoryFile({ Executable: 1 }).executable, false);
    assert.equal(normaliseRepositoryFile({ Executable: 'true' }).executable, false);
    assert.equal(normaliseRepositoryFile({ Executable: true }).executable, true);
    assert.equal(normaliseRepositoryFile({ ListInAgents: 1 }).listInAgents, false);
    assert.equal(normaliseRepositoryFile({ ListInAgents: true }).listInAgents, true);
});
