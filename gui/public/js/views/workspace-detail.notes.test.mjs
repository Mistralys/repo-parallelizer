/**
 * Unit tests for the Notes section added to the workspace detail view — WP-007.
 *
 * Covers:
 *   - A <textarea> with label "Notes" is rendered below the status table.
 *   - The textarea is pre-populated with existing notes from the workspace.
 *   - Typing triggers `api.workspaces.update` after the 1000 ms debounce.
 *   - A "Saving…" indicator is visible during the save request.
 *   - A "Saved" indicator is visible after a successful save.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/views/workspace-detail.notes.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup — install globals before any module is loaded
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="toast-container"></div><div id="app"></div></body></html>', {
    url: 'http://localhost/',
});

const { window } = dom;

globalThis.document    = window.document;
globalThis.window      = window;
globalThis.location    = window.location;
globalThis.HTMLElement = window.HTMLElement;
// CSS.escape shim (jsdom may not expose CSS global)
globalThis.CSS = window.CSS ?? { escape: (s) => s.replace(/["\\]/g, '\\$&') };

// ---------------------------------------------------------------------------
// Timer stubs — allow fine-grained control in tests.
// The debounce inside buildNotesSection uses setTimeout(fn, 1000).
// We replace setTimeout/clearTimeout globally so tests can fire it
// synchronously via flushDebounce().
// ---------------------------------------------------------------------------

let _pendingDebounce = null;
let _originalSetTimeout;
let _originalClearTimeout;

/** Immediately execute the pending debounce callback and await the result. */
async function flushDebounce() {
    if (_pendingDebounce) {
        const fn = _pendingDebounce;
        _pendingDebounce = null;
        await fn();
    }
}

// Stub setInterval / clearInterval so the polling loop never fires.
let _intervalId = 0;
globalThis.setInterval  = () => ++_intervalId;
globalThis.clearInterval = () => {};

// ---------------------------------------------------------------------------
// Minimal fetch mock (required by api.js)
// ---------------------------------------------------------------------------

globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => ({}),
});

// ---------------------------------------------------------------------------
// Import dependencies and patch api
// ---------------------------------------------------------------------------

const { api } = await import('../api.js');

/** Calls recorded by api.workspaces.update spy. */
const updateCalls = [];
let updateDelay     = 0;   // ms to hold the update promise
let updateShouldFail = false;

/** The default (immediate) update stub — reinstated by beforeEach. */
const defaultUpdateStub = async (projectId, wid, data) => {
    updateCalls.push({ projectId, wid, data });
    if (updateDelay > 0) {
        await new Promise((resolve) => _originalSetTimeout(resolve, updateDelay));
    }
    if (updateShouldFail) {
        throw new Error('Storage error');
    }
    return { WorkspaceID: wid };
};

api.workspaces.update = defaultUpdateStub;

// Stub the remaining api calls used by renderWorkspaceDetail.
api.workspaces.health = async () => ({ healthy: true, issues: [] });
api.projects.get      = async () => ({ Id: 'my-project', Repositories: ['repo-a'] });
api.status.refresh    = async () => ({
    'repo-a': { currentBranch: 'main', localCommits: 0, unfetchedCommits: 0, modifiedFiles: 0, lastActivity: null, hasConflicts: false },
});
api.status.get = api.status.refresh;
if (!api.config)         api.config         = {};
if (!api.config.polling) api.config.polling = {};
api.config.polling.get = async () => ({ gitPollingIntervalSeconds: 60 });
if (!api.config.webserverUrl) api.config.webserverUrl = {};
api.config.webserverUrl.get = async () => ({ webserverUrl: '' });

// Default workspace stub — no notes.
let workspaceStub = { Id: 'DEV', Description: '', Initialized: true, FolderPath: '/tmp/dev', Notes: '' };
api.workspaces.get = async () => workspaceStub;

const { renderWorkspaceDetail } = await import('./workspace-detail.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const container = document.getElementById('app');

/**
 * Render the workspace-detail view and wait for async data to populate the DOM.
 *
 * @param {{ projectId?: string, wid?: string }} [opts]
 * @returns {Promise<void>}
 */
async function render({ projectId = 'my-project', wid = 'DEV' } = {}) {
    // Install per-render setTimeout stub so each test starts fresh.
    _pendingDebounce = null;
    _originalSetTimeout  = globalThis.setTimeout;
    _originalClearTimeout = globalThis.clearTimeout;

    let _timerId = 1000;
    globalThis.setTimeout = (fn, _delay) => {
        _pendingDebounce = fn;
        return ++_timerId;
    };
    globalThis.clearTimeout = (id) => {
        if (_timerId === id) _pendingDebounce = null;
    };

    renderWorkspaceDetail(container, { id: projectId, wid });
    // Let the Promise.all resolve.
    await new Promise((resolve) => _originalSetTimeout(resolve, 0));
    // Second tick — let the .then() render callbacks run.
    await new Promise((resolve) => _originalSetTimeout(resolve, 0));
}

/**
 * Restore native setTimeout/clearTimeout after each test.
 */
function restoreTimers() {
    if (_originalSetTimeout)  globalThis.setTimeout  = _originalSetTimeout;
    if (_originalClearTimeout) globalThis.clearTimeout = _originalClearTimeout;
    _pendingDebounce = null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
    updateCalls.length = 0;
    updateDelay      = 0;
    updateShouldFail = false;
    // Restore the default stub in case a test replaced api.workspaces.update.
    api.workspaces.update = defaultUpdateStub;
    workspaceStub = { Id: 'DEV', Description: '', Initialized: true, FolderPath: '/tmp/dev', Notes: '' };
});

test('Notes textarea is rendered in the workspace detail view', async () => {
    await render();
    const textarea = container.querySelector('textarea#workspace-notes-textarea');
    assert.ok(textarea, 'textarea#workspace-notes-textarea should be in the DOM');
    restoreTimers();
});

test('A label with text "Notes" is rendered', async () => {
    await render();
    const label = container.querySelector('label[for="workspace-notes-textarea"]');
    assert.ok(label, 'label[for="workspace-notes-textarea"] should be in the DOM');
    assert.strictEqual(label.textContent, 'Notes');
    restoreTimers();
});

test('Textarea is pre-populated with existing notes on page load', async () => {
    workspaceStub = { Id: 'DEV', Description: '', Initialized: true, FolderPath: '/tmp/dev', Notes: 'existing notes' };
    await render();
    const textarea = container.querySelector('textarea#workspace-notes-textarea');
    assert.strictEqual(textarea.value, 'existing notes');
    restoreTimers();
});

test('Textarea is empty when workspace has no notes', async () => {
    workspaceStub = { Id: 'DEV', Description: '', Initialized: true, FolderPath: '/tmp/dev', Notes: '' };
    await render();
    const textarea = container.querySelector('textarea#workspace-notes-textarea');
    assert.strictEqual(textarea.value, '');
    restoreTimers();
});

test('Typing triggers api.workspaces.update after the debounce fires', async () => {
    await render();
    const textarea = container.querySelector('textarea#workspace-notes-textarea');

    textarea.value = 'new notes';
    textarea.dispatchEvent(new window.Event('input'));

    // Debounce has not fired yet — no API call.
    assert.strictEqual(updateCalls.length, 0);

    // Fire and await the debounce.
    await flushDebounce();

    assert.strictEqual(updateCalls.length, 1);
    assert.deepStrictEqual(updateCalls[0].data, { notes: 'new notes' });
    assert.strictEqual(updateCalls[0].projectId, 'my-project');
    assert.strictEqual(updateCalls[0].wid, 'DEV');

    restoreTimers();
});

test('"Saving…" indicator is visible while the save is in flight', async () => {
    // Hold the update promise until we inspect the DOM.
    let resolveUpdate;
    api.workspaces.update = async (_pid, _wid, _data) => {
        updateCalls.push({ data: _data });
        await new Promise((resolve) => { resolveUpdate = resolve; });
        return {};
    };

    await render();
    const textarea = container.querySelector('textarea#workspace-notes-textarea');
    const statusEl = container.querySelector('.workspace-notes-status');

    textarea.value = 'draft';
    textarea.dispatchEvent(new window.Event('input'));

    // Start the debounce callback but do NOT await it — let it block on the held update.
    const debouncePromise = (async () => {
        if (_pendingDebounce) {
            const fn = _pendingDebounce;
            _pendingDebounce = null;
            fn(); // deliberately not awaited so we can inspect mid-flight DOM
        }
    })();
    await debouncePromise;

    // Give the async handler one tick to run up to the first await.
    await new Promise((resolve) => _originalSetTimeout(resolve, 0));

    assert.strictEqual(statusEl.hidden, false);
    assert.strictEqual(statusEl.textContent, 'Saving\u2026');

    // Resolve the held promise and wait for the "Saved" state.
    resolveUpdate();
    await new Promise((resolve) => _originalSetTimeout(resolve, 0));

    restoreTimers();
});

test('"Saved" indicator is visible after a successful save', async () => {
    await render();
    const textarea = container.querySelector('textarea#workspace-notes-textarea');
    const statusEl = container.querySelector('.workspace-notes-status');

    textarea.value = 'saved notes';
    textarea.dispatchEvent(new window.Event('input'));
    await flushDebounce();

    assert.strictEqual(statusEl.hidden, false);
    assert.strictEqual(statusEl.textContent, 'Saved');

    restoreTimers();
});
