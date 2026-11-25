/**
 * Unit tests for the "Workspace directives" section of the workspace detail
 * view (T-39): it is mounted below Notes and talks to the workspace endpoints
 * (`api.workspaces.directives`), never the project ones.
 *
 * Run individually with:
 *   node --test gui/public/js/views/workspace-detail.directives.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="toast-container"></div><div id="app"></div></body></html>', {
    url: 'http://localhost/',
});
const { window } = dom;
globalThis.document = window.document;
globalThis.window = window;
globalThis.location = window.location;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Event = window.Event;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.CSS = window.CSS ?? { escape: (s) => s.replace(/["\\]/g, '\\$&') };
globalThis.setInterval = () => 1;
globalThis.clearInterval = () => {};
globalThis.fetch = async () => ({
    status: 200, ok: true, statusText: 'OK',
    headers: { get: () => 'application/json' }, json: async () => ({}),
});

const { api } = await import('../api.js');

api.workspaces.health = async () => ({ healthy: true, issues: [] });
api.projects.get = async () => ({ Id: 'my-project', Repositories: ['repo-a'] });
api.status.refresh = async () => ({
    'repo-a': { currentBranch: 'main', localCommits: 0, unfetchedCommits: 0, modifiedFiles: 0, lastActivity: null, hasConflicts: false },
});
api.status.get = api.status.refresh;
if (!api.config) api.config = {};
if (!api.config.polling) api.config.polling = {};
api.config.polling.get = async () => ({ gitPollingIntervalSeconds: 60 });
if (!api.config.webserverUrl) api.config.webserverUrl = {};
api.config.webserverUrl.get = async () => ({ webserverUrl: '' });
api.workspaces.get = async () => ({ Id: 'DEV', Description: '', Initialized: true, FolderPath: '/tmp/dev', Notes: '' });

const { renderWorkspaceDetail } = await import('./workspace-detail.js');

const container = document.getElementById('app');
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };

test('shows a "Workspace directives" section below Notes', async () => {
    api.workspaces.directives.list = async () => [];
    renderWorkspaceDetail(container, { id: 'my-project', wid: 'DEV' });
    await flush();

    const notes = container.querySelector('.workspace-notes-section');
    const section = container.querySelector('.workspace-directives-section');
    assert.ok(notes && section);
    assert.equal(section.querySelector('h3').textContent, 'Workspace directives');
    assert.ok(notes.compareDocumentPosition(section) & window.Node.DOCUMENT_POSITION_FOLLOWING);
});

test('uses the workspace endpoints, not the project ones', async () => {
    const calls = [];
    let list = [{ Id: 'a1', Text: 'Rule one.' }];
    api.workspaces.directives.list = async (pid, wid) => { calls.push({ op: 'list', pid, wid }); return list; };
    api.workspaces.directives.create = async (pid, wid, text) => {
        calls.push({ op: 'create', pid, wid, text });
        list = [...list, { Id: 'n1', Text: text }];
        return list[1];
    };
    api.projects.directives.list = async () => { calls.push({ op: 'project-list' }); return []; };
    api.projects.directives.create = async () => { calls.push({ op: 'project-create' }); };

    renderWorkspaceDetail(container, { id: 'my-project', wid: 'DEV' });
    await flush();

    const section = container.querySelector('.workspace-directives-section');
    assert.equal(section.querySelectorAll('.directive-item').length, 1);

    section.querySelector('.directive-add-btn').click();
    section.querySelector('textarea').value = 'Only here.';
    section.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await flush();

    assert.ok(calls.some((c) => c.op === 'create' && c.pid === 'my-project' && c.wid === 'DEV' && c.text === 'Only here.'));
    assert.ok(!calls.some((c) => c.op.startsWith('project-')));
    assert.equal(section.querySelectorAll('.directive-item').length, 2);
});

test('a failed load is reported inline', async () => {
    api.workspaces.directives.list = async () => { throw new Error('boom'); };
    renderWorkspaceDetail(container, { id: 'my-project', wid: 'DEV' });
    await flush();
    assert.equal(container.querySelector('.workspace-directives-section [role="alert"]').textContent, 'boom');
});
