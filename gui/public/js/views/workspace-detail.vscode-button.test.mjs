/**
 * QA tests for WP-004: "Open in VS Code" button in the workspace header.
 *
 * Acceptance Criteria verified:
 *   AC1 — When workspace.initialized is true, an "Open in VS Code" button
 *          appears in the management row between the Setup button position
 *          and the Rename button.
 *   AC2 — When workspace.initialized is false, the "Open in VS Code" button
 *          is not rendered.
 *   AC3 — Clicking the button calls api.workspaces.launch.vscode(projectId, wid)
 *          and shows a success toast on success.
 *   AC4 — If the API call fails, an error toast is shown with the error message.
 *   AC5 — After a successful workspace setup (via the Setup button), the
 *          "Open in VS Code" button is dynamically inserted into the management
 *          row without a full page re-render.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/views/workspace-detail.vscode-button.test.mjs
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
globalThis.CSS = window.CSS ?? { escape: (s) => s.replace(/["\\]/g, '\\$&') };

// Stub setInterval / clearInterval so the polling loop never fires.
let _intervalId = 0;
const _intervals = new Map();
globalThis.setInterval = (fn, delay) => {
    const id = ++_intervalId;
    _intervals.set(id, { fn, delay });
    return id;
};
globalThis.clearInterval = (id) => {
    _intervals.delete(id);
};

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
// Import dependencies and patch api + toast
// ---------------------------------------------------------------------------

const { api } = await import('../api.js');

/** Calls recorded by the launch.vscode spy. */
const vscodeCalls = [];
let vscodeShouldFail  = false;
let vscodeFailMessage = 'VS Code not found';

api.workspaces.launch.vscode = async (projectId, wid) => {
    vscodeCalls.push({ projectId, wid });
    if (vscodeShouldFail) {
        throw new Error(vscodeFailMessage);
    }
    return { success: true };
};

// Setup call spy — used for AC5
const setupCalls = [];
let setupShouldFail = false;
api.workspaces.setup = async (projectId, wid) => {
    setupCalls.push({ projectId, wid });
    if (setupShouldFail) throw new Error('Setup failed');
    return { results: [] };
};

// Other required stubs
api.workspaces.health = async () => ({ healthy: true, issues: [] });
api.projects.get      = async () => ({ Id: 'my-project', Repositories: ['repo-alpha'] });
api.status.refresh    = async () => ({
    'repo-alpha': { currentBranch: 'main', localCommits: 0, unfetchedCommits: 0, modifiedFiles: 0, lastActivity: null, hasConflicts: false },
});
api.status.get = api.status.refresh;
if (!api.config)         api.config         = {};
if (!api.config.polling) api.config.polling = {};
api.config.polling.get = async () => ({ gitPollingIntervalSeconds: 60 });

// Patch workspaces.get to control initialized state
let workspaceInitialized = true;
api.workspaces.get = async () => ({
    Id: 'DEV', id: 'DEV', Description: '', initialized: workspaceInitialized, folderPath: '/tmp/dev',
});

// We verify toast output by querying #toast-container directly, since showToast is
// imported at module load time and cannot be monkey-patched after the fact.
// The toast-container div is initialised in the JSDOM HTML string above and cleared
// in beforeEach, so each test gets a fresh view of whatever showToast rendered.

const { renderWorkspaceDetail } = await import('./workspace-detail.js');

// Local re-declaration — see gui/public/js/utils/dom.js for the canonical export.
// Static imports from ../utils/dom.js cannot be resolved in this Node.js jsdom harness.
function clearElement(el) { while (el.firstChild) el.removeChild(el.firstChild); }

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

/**
 * Render the workspace-detail view and wait for the async bootstrap to settle.
 *
 * @param {string} [projectId]
 * @param {string} [wid]
 * @returns {Promise<{ container: HTMLElement, cleanup: function }>}
 */
async function renderView(projectId = 'my-project', wid = 'DEV') {
    const container = window.document.getElementById('app');
    clearElement(container);

    const cleanup = renderWorkspaceDetail(container, { id: projectId, wid });

    // Poll until a .workspace-mgmt-row is present or we time out.
    await new Promise((resolve) => {
        let ticks = 0;
        const poll = () => {
            ticks++;
            if (container.querySelector('.workspace-mgmt-row') || ticks > 200) {
                resolve();
            } else {
                Promise.resolve().then(poll);
            }
        };
        Promise.resolve().then(poll);
    });

    return { container, cleanup };
}

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
    vscodeCalls.length   = 0;
    setupCalls.length    = 0;
    vscodeShouldFail     = false;
    vscodeFailMessage    = 'VS Code not found';
    setupShouldFail      = false;
    workspaceInitialized = true;
    _intervals.clear();
    clearElement(document.getElementById('toast-container'));
});

// ---------------------------------------------------------------------------
// AC1 — "Open in VS Code" button is present when workspace is initialized
// ---------------------------------------------------------------------------

test('AC1: "Open in VS Code" button is present in mgmt row when workspace.initialized is true', async () => {
    workspaceInitialized = true;
    const { container, cleanup } = await renderView();
    try {
        const mgmtRow = container.querySelector('.workspace-mgmt-row');
        assert.ok(mgmtRow, 'mgmt row should exist');

        const btns = [...mgmtRow.querySelectorAll('button')];
        const vscodeBtn = btns.find((b) => b.textContent.trim() === 'Open in VS Code');
        assert.ok(vscodeBtn, '"Open in VS Code" button should be rendered when initialized=true');
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC1 — button appears BEFORE Rename button in the DOM order
// ---------------------------------------------------------------------------

test('AC1: "Open in VS Code" button appears before the Rename button', async () => {
    workspaceInitialized = true;
    const { container, cleanup } = await renderView();
    try {
        const mgmtRow = container.querySelector('.workspace-mgmt-row');
        const btns = [...mgmtRow.querySelectorAll('button')];
        const vscodeIdx = btns.findIndex((b) => b.textContent.trim() === 'Open in VS Code');
        const renameIdx = btns.findIndex((b) => b.textContent.trim() === 'Rename');
        assert.ok(vscodeIdx !== -1, '"Open in VS Code" button should exist');
        assert.ok(renameIdx !== -1, '"Rename" button should exist');
        assert.ok(
            vscodeIdx < renameIdx,
            `"Open in VS Code" (index ${vscodeIdx}) should come before "Rename" (index ${renameIdx})`,
        );
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC2 — "Open in VS Code" button is absent when workspace is NOT initialized
// ---------------------------------------------------------------------------

test('AC2: "Open in VS Code" button is NOT rendered when workspace.initialized is false', async () => {
    workspaceInitialized = false;
    const { container, cleanup } = await renderView();
    try {
        const mgmtRow = container.querySelector('.workspace-mgmt-row');
        assert.ok(mgmtRow, 'mgmt row should exist');

        const btns = [...mgmtRow.querySelectorAll('button')];
        const vscodeBtn = btns.find((b) => b.textContent.trim() === 'Open in VS Code');
        assert.equal(
            vscodeBtn,
            undefined,
            '"Open in VS Code" button should NOT be rendered when initialized=false',
        );
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC2 — Setup button IS present when workspace is NOT initialized
// ---------------------------------------------------------------------------

test('AC2: "Setup Workspace" button IS present when workspace.initialized is false', async () => {
    workspaceInitialized = false;
    const { container, cleanup } = await renderView();
    try {
        const mgmtRow = container.querySelector('.workspace-mgmt-row');
        const setupBtn = [...mgmtRow.querySelectorAll('button')].find(
            (b) => b.textContent.trim() === 'Setup Workspace',
        );
        assert.ok(setupBtn, '"Setup Workspace" button should be present when initialized=false');
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC3 — clicking the button calls api.workspaces.launch.vscode with correct args
// ---------------------------------------------------------------------------

test('AC3: clicking "Open in VS Code" calls api.workspaces.launch.vscode(projectId, wid)', async () => {
    workspaceInitialized = true;
    const { container, cleanup } = await renderView('my-project', 'DEV');
    try {
        const mgmtRow = container.querySelector('.workspace-mgmt-row');
        const vscodeBtn = [...mgmtRow.querySelectorAll('button')].find(
            (b) => b.textContent.trim() === 'Open in VS Code',
        );
        assert.ok(vscodeBtn, '"Open in VS Code" button must exist for this test');

        vscodeBtn.click();

        // Drain microtask queue so async click handler runs.
        for (let i = 0; i < 5; i++) {
            await new Promise((r) => Promise.resolve().then(r));
        }

        assert.equal(vscodeCalls.length, 1, 'launch.vscode should have been called once');
        assert.equal(vscodeCalls[0].projectId, 'my-project', 'projectId should match');
        assert.equal(vscodeCalls[0].wid, 'DEV', 'wid should match');
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC3 — button is re-enabled (and label restored) after a successful call
// ---------------------------------------------------------------------------

test('AC3: button is re-enabled with original label after a successful launch.vscode call', async () => {
    workspaceInitialized = true;
    const { container, cleanup } = await renderView();
    try {
        const mgmtRow = container.querySelector('.workspace-mgmt-row');
        const vscodeBtn = [...mgmtRow.querySelectorAll('button')].find(
            (b) => b.textContent.trim() === 'Open in VS Code',
        );

        vscodeBtn.click();

        // Wait for the async handler's finally block to complete.
        for (let i = 0; i < 10; i++) {
            await new Promise((r) => Promise.resolve().then(r));
        }

        assert.equal(vscodeBtn.disabled, false, 'button should be re-enabled after success');
        assert.equal(vscodeBtn.textContent.trim(), 'Open in VS Code', 'button label should be restored');
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC4 — on API failure the button is re-enabled and an error path is taken
// ---------------------------------------------------------------------------

test('AC4: when launch.vscode rejects, the button is re-enabled after the error', async () => {
    workspaceInitialized = true;
    vscodeShouldFail     = true;
    vscodeFailMessage    = 'VS Code not installed';

    const { container, cleanup } = await renderView();
    try {
        const mgmtRow = container.querySelector('.workspace-mgmt-row');
        const vscodeBtn = [...mgmtRow.querySelectorAll('button')].find(
            (b) => b.textContent.trim() === 'Open in VS Code',
        );
        assert.ok(vscodeBtn, '"Open in VS Code" button must exist');

        vscodeBtn.click();

        // Drain enough microtask ticks for try/catch/finally to complete.
        for (let i = 0; i < 10; i++) {
            await new Promise((r) => Promise.resolve().then(r));
        }

        assert.equal(vscodeBtn.disabled, false, 'button should be re-enabled after error');
        assert.equal(
            vscodeBtn.textContent.trim(),
            'Open in VS Code',
            'button label should be restored after error',
        );
        assert.equal(vscodeCalls.length, 1, 'API should still have been called');
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC5 — "Open in VS Code" button is dynamically inserted after Setup success
// ---------------------------------------------------------------------------

test('AC5: "Open in VS Code" button is dynamically inserted after successful Setup, no full re-render', async () => {
    workspaceInitialized = false;
    const { container, cleanup } = await renderView();
    try {
        const mgmtRow = container.querySelector('.workspace-mgmt-row');

        // Confirm VS Code button absent before setup
        const beforeBtns = [...mgmtRow.querySelectorAll('button')];
        const vscodeBefore = beforeBtns.find((b) => b.textContent.trim() === 'Open in VS Code');
        assert.equal(vscodeBefore, undefined, '"Open in VS Code" should NOT exist before setup');

        // Find and click the Setup button
        const setupBtn = beforeBtns.find((b) => b.textContent.trim() === 'Setup Workspace');
        assert.ok(setupBtn, '"Setup Workspace" button must exist to trigger setup');

        // Capture a stable DOM reference — the mgmtRow should NOT be replaced
        const mgmtRowRef = mgmtRow;

        setupBtn.click();

        // Allow the async setup handler to complete.
        for (let i = 0; i < 20; i++) {
            await new Promise((r) => Promise.resolve().then(r));
        }

        // After setup the VS Code button should now be present
        const afterBtns = [...mgmtRow.querySelectorAll('button')];
        const vscodeAfter = afterBtns.find((b) => b.textContent.trim() === 'Open in VS Code');
        assert.ok(vscodeAfter, '"Open in VS Code" button should be present after successful setup');

        // Setup button should be removed
        const setupBtnAfter = afterBtns.find((b) => b.textContent.trim() === 'Setup Workspace');
        assert.equal(setupBtnAfter, undefined, '"Setup Workspace" button should be removed after setup');

        // Confirm no full re-render — mgmtRow reference must be the same DOM node
        assert.strictEqual(
            container.querySelector('.workspace-mgmt-row'),
            mgmtRowRef,
            'mgmtRow DOM node should be the same object (no full re-render)',
        );
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC5 — "Open in VS Code" button inserted BEFORE Rename after Setup
// ---------------------------------------------------------------------------

test('AC5: after Setup, dynamically-inserted "Open in VS Code" button is before "Rename"', async () => {
    workspaceInitialized = false;
    const { container, cleanup } = await renderView();
    try {
        const mgmtRow = container.querySelector('.workspace-mgmt-row');
        const setupBtn = [...mgmtRow.querySelectorAll('button')].find(
            (b) => b.textContent.trim() === 'Setup Workspace',
        );
        assert.ok(setupBtn, 'Setup button must exist');

        setupBtn.click();

        for (let i = 0; i < 20; i++) {
            await new Promise((r) => Promise.resolve().then(r));
        }

        const btnsAfter = [...mgmtRow.querySelectorAll('button')];
        const vscodeIdx = btnsAfter.findIndex((b) => b.textContent.trim() === 'Open in VS Code');
        const renameIdx = btnsAfter.findIndex((b) => b.textContent.trim() === 'Rename');

        assert.ok(vscodeIdx !== -1, '"Open in VS Code" should be present after setup');
        assert.ok(renameIdx !== -1, '"Rename" should still be present after setup');
        assert.ok(
            vscodeIdx < renameIdx,
            `"Open in VS Code" (index ${vscodeIdx}) should come before "Rename" (index ${renameIdx}) after setup`,
        );
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// Edge-case: rapid double-click does not fire launch.vscode twice while in-flight
// ---------------------------------------------------------------------------

test('Edge-case: rapid double-click on "Open in VS Code" only fires one API call', async () => {
    workspaceInitialized = true;
    const { container, cleanup } = await renderView();
    try {
        const mgmtRow = container.querySelector('.workspace-mgmt-row');
        const vscodeBtn = [...mgmtRow.querySelectorAll('button')].find(
            (b) => b.textContent.trim() === 'Open in VS Code',
        );
        assert.ok(vscodeBtn, '"Open in VS Code" button must exist');

        // Click twice rapidly — the button should be disabled after first click
        vscodeBtn.click();
        vscodeBtn.click();

        for (let i = 0; i < 10; i++) {
            await new Promise((r) => Promise.resolve().then(r));
        }

        assert.equal(vscodeCalls.length, 1, 'only one API call should be made despite double-click');
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// Edge-case: "Open in VS Code" button has correct styling
// ---------------------------------------------------------------------------

test('Edge-case: "Open in VS Code" button has btn btn-secondary btn-sm classes', async () => {
    workspaceInitialized = true;
    const { container, cleanup } = await renderView();
    try {
        const mgmtRow = container.querySelector('.workspace-mgmt-row');
        const vscodeBtn = [...mgmtRow.querySelectorAll('button')].find(
            (b) => b.textContent.trim() === 'Open in VS Code',
        );
        assert.ok(vscodeBtn, '"Open in VS Code" button must exist');
        assert.ok(vscodeBtn.classList.contains('btn'),           'missing class "btn"');
        assert.ok(vscodeBtn.classList.contains('btn-secondary'), 'missing class "btn-secondary"');
        assert.ok(vscodeBtn.classList.contains('btn-sm'),        'missing class "btn-sm"');
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC3 — success toast is shown in #toast-container after a successful launch
// ---------------------------------------------------------------------------

test('AC3: after a successful VS Code launch, #toast-container has a .toast-success with correct message', async () => {
    workspaceInitialized = true;
    vscodeShouldFail     = false;

    const { container, cleanup } = await renderView();
    try {
        const mgmtRow   = container.querySelector('.workspace-mgmt-row');
        const vscodeBtn = [...mgmtRow.querySelectorAll('button')].find(
            (b) => b.textContent.trim() === 'Open in VS Code',
        );
        assert.ok(vscodeBtn, '"Open in VS Code" button must exist');

        vscodeBtn.click();

        // Drain microtask queue so the async click handler (including showToast) runs.
        for (let i = 0; i < 10; i++) {
            await new Promise((r) => Promise.resolve().then(r));
        }

        const toastContainer = document.getElementById('toast-container');
        const successToast   = toastContainer.querySelector('.toast-success');
        assert.ok(successToast, '#toast-container should contain a .toast-success element');

        const msg = successToast.querySelector('.toast-message');
        assert.ok(msg, '.toast-success should contain a .toast-message element');
        assert.equal(msg.textContent, 'VS Code launched for this workspace.');
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC4 — error toast is shown in #toast-container after a failed launch
// ---------------------------------------------------------------------------

test('AC4: after a failed VS Code launch, #toast-container has a .toast-error with the error message', async () => {
    workspaceInitialized = true;
    vscodeShouldFail     = true;
    vscodeFailMessage    = 'VS Code not installed';

    const { container, cleanup } = await renderView();
    try {
        const mgmtRow   = container.querySelector('.workspace-mgmt-row');
        const vscodeBtn = [...mgmtRow.querySelectorAll('button')].find(
            (b) => b.textContent.trim() === 'Open in VS Code',
        );
        assert.ok(vscodeBtn, '"Open in VS Code" button must exist');

        vscodeBtn.click();

        // Drain enough microtask ticks for try/catch/finally to complete.
        for (let i = 0; i < 10; i++) {
            await new Promise((r) => Promise.resolve().then(r));
        }

        const toastContainer = document.getElementById('toast-container');
        const errorToast     = toastContainer.querySelector('.toast-error');
        assert.ok(errorToast, '#toast-container should contain a .toast-error element');

        const msg = errorToast.querySelector('.toast-message');
        assert.ok(msg, '.toast-error should contain a .toast-message element');
        assert.equal(msg.textContent, vscodeFailMessage);
    } finally {
        cleanup();
    }
});
