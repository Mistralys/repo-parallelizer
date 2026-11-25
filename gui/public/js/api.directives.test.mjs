/**
 * Unit tests for `api.projects.directives` and `api.workspaces.directives`
 * (T-40, directives part): URL, verb and body of every call.
 *
 * Run individually with:
 *   node --test gui/public/js/api.directives.test.mjs
 */

import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];

before(() => {
    globalThis.fetch = async (url, options = {}) => {
        calls.push({
            method: options.method ?? 'GET',
            url: String(url),
            body: options.body ? JSON.parse(options.body) : undefined,
        });
        return {
            status: 200,
            ok: true,
            statusText: 'OK',
            headers: { get: (name) => (name === 'Content-Type' ? 'application/json' : null) },
            json: () => Promise.resolve({}),
        };
    };
});

afterEach(() => { calls.length = 0; });

const { api } = await import('./api.js');

test('projects.directives.list sends GET', async () => {
    await api.projects.directives.list('my-proj');
    assert.deepEqual(calls, [{ method: 'GET', url: '/api/projects/my-proj/directives', body: undefined }]);
});

test('projects.directives.create sends POST with { text }', async () => {
    await api.projects.directives.create('my-proj', 'Be nice.');
    assert.deepEqual(calls, [{ method: 'POST', url: '/api/projects/my-proj/directives', body: { text: 'Be nice.' } }]);
});

test('projects.directives.update sends PUT with { text }', async () => {
    await api.projects.directives.update('my-proj', 'd1', 'New.');
    assert.deepEqual(calls, [{ method: 'PUT', url: '/api/projects/my-proj/directives/d1', body: { text: 'New.' } }]);
});

test('projects.directives.remove sends DELETE', async () => {
    await api.projects.directives.remove('my-proj', 'd1');
    assert.deepEqual(calls, [{ method: 'DELETE', url: '/api/projects/my-proj/directives/d1', body: undefined }]);
});

test('workspaces.directives.list sends GET', async () => {
    await api.workspaces.directives.list('my-proj', 'DEV');
    assert.deepEqual(calls, [{ method: 'GET', url: '/api/projects/my-proj/workspaces/DEV/directives', body: undefined }]);
});

test('workspaces.directives.create sends POST with { text }', async () => {
    await api.workspaces.directives.create('my-proj', 'DEV', 'Rule.');
    assert.deepEqual(calls, [{ method: 'POST', url: '/api/projects/my-proj/workspaces/DEV/directives', body: { text: 'Rule.' } }]);
});

test('workspaces.directives.update sends PUT with { text }', async () => {
    await api.workspaces.directives.update('my-proj', 'DEV', 'd1', 'New.');
    assert.deepEqual(calls, [{ method: 'PUT', url: '/api/projects/my-proj/workspaces/DEV/directives/d1', body: { text: 'New.' } }]);
});

test('workspaces.directives.remove sends DELETE', async () => {
    await api.workspaces.directives.remove('my-proj', 'DEV', 'd1');
    assert.deepEqual(calls, [{ method: 'DELETE', url: '/api/projects/my-proj/workspaces/DEV/directives/d1', body: undefined }]);
});

test('ids are URL-encoded', async () => {
    await api.projects.directives.list('a/b c');
    assert.equal(calls[0].url, '/api/projects/a%2Fb%20c/directives');
});

test('projects.setRepositoryRole sends PUT with { role }', async () => {
    await api.projects.setRepositoryRole('my-proj', 'repo/a', 'Backend API');
    assert.deepEqual(calls, [{ method: 'PUT', url: '/api/projects/my-proj/repositories/repo%2Fa/role', body: { role: 'Backend API' } }]);
});

test('projects.setRepositoryRole sends an empty role to clear', async () => {
    await api.projects.setRepositoryRole('my-proj', 'repo-a', '');
    assert.deepEqual(calls, [{ method: 'PUT', url: '/api/projects/my-proj/repositories/repo-a/role', body: { role: '' } }]);
});
