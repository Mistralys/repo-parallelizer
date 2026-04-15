/**
 * Unit tests for the "Open" button (Actions column) added to the repository
 * status table in workspace-detail.js — WP-005.
 *
 * Covers:
 *   - 4th column header labelled "Actions" is present in the table.
 *   - Each repository row has a 4th cell with a button styled
 *     `btn btn-secondary btn-sm`.
 *   - Clicking the button calls `api.workspaces.launch.githubDesktop(projectId, wid, repoId)`.
 *   - When the API call rejects, the button is re-enabled (error path).
 *   - Cell index 2 remains the badge cell (Actions column at index 3 does not
 *     shift existing indices, so updateStatusTable continues to work).
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/views/workspace-detail.open-button.test.mjs
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

// Stub setInterval / clearInterval so the polling loop never fires and the
// process exits cleanly after tests complete.
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
// Import dependencies and patch api
// ---------------------------------------------------------------------------

const { api } = await import('../api.js');

/** Calls recorded by the launch.githubDesktop spy. */
const ghDesktopCalls = [];
let ghDesktopShouldFail  = false;
let ghDesktopFailMessage = 'GitHub Desktop not found';

// Patch launch.githubDesktop on the live api object.
api.workspaces.launch.githubDesktop = async (projectId, wid, repoId) => {
    ghDesktopCalls.push({ projectId, wid, repoId });
    if (ghDesktopShouldFail) {
        throw new Error(ghDesktopFailMessage);
    }
    return { success: true };
};

// Stub the remaining api calls used by renderWorkspaceDetail.
api.workspaces.get    = async () => ({ Id: 'DEV', id: 'DEV', Description: '', initialized: true, folderPath: '/tmp/dev' });
api.workspaces.health = async () => ({ healthy: true, issues: [] });
api.projects.get      = async () => ({ Id: 'my-project', Repositories: ['repo-alpha', 'repo-beta'] });
api.status.refresh    = async () => ({
    'repo-alpha': { currentBranch: 'main', localCommits: 0, unfetchedCommits: 0, modifiedFiles: 0, lastActivity: null, hasConflicts: false },
    'repo-beta':  { currentBranch: 'dev',  localCommits: 1, unfetchedCommits: 0, modifiedFiles: 2, lastActivity: null, hasConflicts: false },
});
api.status.get = api.status.refresh;
if (!api.config)          api.config          = {};
if (!api.config.polling)  api.config.polling  = {};
api.config.polling.get = async () => ({ gitPollingIntervalSeconds: 60 });

const { renderWorkspaceDetail } = await import('./workspace-detail.js');

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

/**
 * Render the workspace detail view and wait for the async Promise.all inside
 * renderWorkspaceDetail to settle and populate the DOM.
 *
 * Returns both the container and the cleanup function so callers can stop
 * any pending interval.
 *
 * @param {string} [projectId]
 * @param {string} [wid]
 * @returns {Promise<{ container: HTMLElement, cleanup: function }>}
 */
async function renderView(projectId = 'my-project', wid = 'DEV') {
    const container = window.document.getElementById('app');
    container.innerHTML = '';

    const cleanup = renderWorkspaceDetail(container, { id: projectId, wid });

    // Wait for the internal async bootstrap to complete (Promise.all).
    // We poll until a <table> is present or a maximum wait is reached.
    await new Promise((resolve) => {
        let ticks = 0;
        const poll = () => {
            ticks++;
            if (container.querySelector('table') || ticks > 100) {
                resolve();
            } else {
                // Use the real (un-stubbed) Promise machinery to defer.
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
    ghDesktopCalls.length = 0;
    ghDesktopShouldFail   = false;
    ghDesktopFailMessage  = 'GitHub Desktop not found';
    _intervals.clear();
    document.getElementById('toast-container').innerHTML = '';
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// AC 1 — 4th column header "Actions"
test('status table has a 4th column header labelled "Actions"', async () => {
    const { container, cleanup } = await renderView();
    try {
        const headers = container.querySelectorAll('thead th');
        assert.ok(headers.length >= 4, `expected ≥4 <th> elements, got ${headers.length}`);
        assert.equal(headers[3].textContent, 'Actions');
    } finally {
        cleanup();
    }
});

// AC 2 — each row has a 4th cell with btn btn-secondary btn-sm
test('each repository row has a 4th cell with a correctly-styled "Open" button', async () => {
    const { container, cleanup } = await renderView();
    try {
        const rows = [...container.querySelectorAll('tbody tr[data-repo-id]')];
        assert.ok(rows.length > 0, 'expected at least one repository row');

        for (const row of rows) {
            assert.ok(row.cells.length >= 4, `expected ≥4 cells, got ${row.cells.length}`);
            const btn = row.cells[3].querySelector('button');
            assert.ok(btn, 'expected a <button> in cells[3]');
            assert.equal(btn.textContent.trim(), 'Open');
            assert.ok(btn.classList.contains('btn'),           'missing class "btn"');
            assert.ok(btn.classList.contains('btn-secondary'), 'missing class "btn-secondary"');
            assert.ok(btn.classList.contains('btn-sm'),        'missing class "btn-sm"');
        }
    } finally {
        cleanup();
    }
});

// AC 3 — clicking "Open" calls api.workspaces.launch.githubDesktop with correct args
test('clicking "Open" calls launch.githubDesktop with projectId, wid, and repoId', async () => {
    const { container, cleanup } = await renderView('my-project', 'DEV');
    try {
        const firstRow = container.querySelector('tbody tr[data-repo-id]');
        assert.ok(firstRow, 'expected at least one repository row');

        const repoId = firstRow.dataset.repoId;
        const btn    = firstRow.cells[3].querySelector('button');
        btn.click();

        // Drain microtask queue to let the async click handler run.
        await new Promise((r) => Promise.resolve().then(r));
        await new Promise((r) => Promise.resolve().then(r));

        assert.equal(ghDesktopCalls.length, 1, 'expected exactly 1 launch.githubDesktop call');
        assert.equal(ghDesktopCalls[0].projectId, 'my-project');
        assert.equal(ghDesktopCalls[0].wid,       'DEV');
        assert.equal(ghDesktopCalls[0].repoId,    repoId);
    } finally {
        cleanup();
    }
});

// AC 4 — on API failure the button is re-enabled (error path)
test('when launch.githubDesktop rejects, the button is re-enabled after the error', async () => {
    ghDesktopShouldFail  = true;
    ghDesktopFailMessage = 'app not installed';

    const { container, cleanup } = await renderView();
    try {
        const firstRow = container.querySelector('tbody tr[data-repo-id]');
        const btn      = firstRow.cells[3].querySelector('button');

        btn.click();

        // Drain enough microtask ticks for try/catch/finally to complete.
        for (let i = 0; i < 10; i++) {
            await new Promise((r) => Promise.resolve().then(r));
        }

        assert.equal(btn.disabled,           false,  'button should be re-enabled after error');
        assert.equal(btn.textContent.trim(), 'Open', 'button label should be restored after error');
        assert.equal(ghDesktopCalls.length,  1,      'API should have been called despite the error');
    } finally {
        cleanup();
    }
});

// AC 6 — cell index 2 is still the badge cell; Actions column is at index 3
test('cells[2] is repo-badge-cell and cells[3] is repo-actions-cell', async () => {
    const { container, cleanup } = await renderView();
    try {
        const firstRow = container.querySelector('tbody tr[data-repo-id]');
        assert.ok(firstRow, 'expected at least one repository row');

        const badgeCell   = firstRow.cells[2];
        const actionsCell = firstRow.cells[3];

        assert.ok(badgeCell,   'expected cells[2] to exist');
        assert.ok(actionsCell, 'expected cells[3] to exist');

        assert.ok(
            badgeCell.classList.contains('repo-badge-cell'),
            `cells[2] should have class "repo-badge-cell", got "${badgeCell.className}"`,
        );
        assert.ok(
            actionsCell.classList.contains('repo-actions-cell'),
            `cells[3] should have class "repo-actions-cell", got "${actionsCell.className}"`,
        );
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// Toast — error toast shown in #toast-container after a failed GitHub Desktop launch
// ---------------------------------------------------------------------------

test('when launch.githubDesktop rejects, #toast-container has a .toast-error with the error message', async () => {
    ghDesktopShouldFail  = true;
    ghDesktopFailMessage = 'GitHub Desktop not found';

    const { container, cleanup } = await renderView();
    try {
        const firstRow = container.querySelector('tbody tr[data-repo-id]');
        assert.ok(firstRow, 'expected at least one repository row');

        const btn = firstRow.cells[3].querySelector('button');
        btn.click();

        // Drain enough microtask ticks for try/catch/finally to complete.
        for (let i = 0; i < 10; i++) {
            await new Promise((r) => Promise.resolve().then(r));
        }

        const toastContainer = document.getElementById('toast-container');
        const errorToast     = toastContainer.querySelector('.toast-error');
        assert.ok(errorToast, '#toast-container should contain a .toast-error element');

        const msg = errorToast.querySelector('.toast-message');
        assert.ok(msg, '.toast-error should contain a .toast-message element');
        assert.equal(msg.textContent, ghDesktopFailMessage);
    } finally {
        cleanup();
    }
});
