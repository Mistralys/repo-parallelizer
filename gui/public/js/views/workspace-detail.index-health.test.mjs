/**
 * Tests for WP-08: workspace-index health-alert rendering.
 *
 * Acceptance Criteria verified:
 *   - A `workspace-index-unmanaged` health issue (fixAction: 'none') renders
 *     its message with no fix button (unrecognised/no-op fixActions render
 *     message-only rows).
 *   - A `workspace-index-missing` health issue (fixAction:
 *     'regenerate-workspace-file') renders the shared regenerate button,
 *     labelled "Regenerate Files".
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/views/workspace-detail.index-health.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup — install globals before any module is loaded
// ---------------------------------------------------------------------------

const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="toast-container"></div><div id="app"></div></body></html>',
    { url: 'http://localhost/' },
);

const { window } = dom;

globalThis.document    = window.document;
globalThis.window      = window;
globalThis.location    = window.location;
globalThis.HTMLElement = window.HTMLElement;
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

let healthReportOverride = { healthy: true, issues: [] };

api.workspaces.get    = async () => ({
    Id: 'DEV', id: 'DEV', Description: '', initialized: true, folderPath: '/tmp/dev',
});
api.workspaces.health = async () => healthReportOverride;
api.workspaces.setup  = async () => ({ results: [] });
api.workspaces.regenerateFile = async () => ({ success: true });
api.workspaces.launch = api.workspaces.launch || {};
api.workspaces.launch.githubDesktop = async () => ({ success: true });
api.workspaces.launch.vscode        = async () => ({ success: true });
api.projects.get      = async () => ({
    Id: 'my-project',
    Repositories: ['repo-alpha'],
});

let statusMapOverride = {};
api.status.refresh = async () => statusMapOverride;
api.status.get     = async () => statusMapOverride;

if (!api.config)          api.config          = {};
if (!api.config.polling)  api.config.polling  = {};
api.config.polling.get = async () => ({ gitPollingIntervalSeconds: 60 });
if (!api.config.webserverUrl) api.config.webserverUrl = {};
api.config.webserverUrl.get = async () => ({ webserverUrl: '' });

const { renderWorkspaceDetail } = await import('./workspace-detail.js');

// Local re-declaration — see gui/public/js/utils/dom.js for the canonical export.
// Static imports from ../utils/dom.js cannot be resolved in this Node.js jsdom harness.
function clearElement(el) { while (el.firstChild) el.removeChild(el.firstChild); }

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

    await new Promise((resolve) => {
        let ticks = 0;
        const poll = () => {
            ticks++;
            if (
                container.querySelector('table') ||
                container.querySelector('.workspace-detail-header') ||
                ticks > 200
            ) {
                resolve();
            } else {
                Promise.resolve().then(poll);
            }
        };
        Promise.resolve().then(poll);
    });

    return { container, cleanup };
}

beforeEach(() => {
    healthReportOverride = { healthy: true, issues: [] };
    statusMapOverride = {};
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('workspace-index-unmanaged issue renders a message row with no fix button', async () => {
    healthReportOverride = {
        healthy: false,
        issues: [
            {
                type: 'workspace-index-unmanaged',
                severity: 'warning',
                message: 'Index file(s) are hand-authored and not managed by paralizer: CLAUDE.md.',
                fixAction: 'none',
            },
        ],
    };

    const { container, cleanup } = await renderView();
    try {
        const healthAlert = container.querySelector('.health-alert');
        assert.ok(healthAlert, '.health-alert section should be present');

        const row = healthAlert.querySelector('.health-alert-issue');
        assert.ok(row, 'issue row should be present');

        const msg = row.querySelector('.health-alert-issue__message');
        assert.ok(msg, 'issue message should be present');
        assert.ok(msg.textContent.includes('CLAUDE.md'));

        const actionWrap = row.querySelector('.health-alert-issue__action');
        assert.strictEqual(actionWrap, null, 'workspace-index-unmanaged must not render a fix button');

        const button = row.querySelector('button');
        assert.strictEqual(button, null, 'no button of any kind should be present for fixAction: none');
    } finally {
        cleanup();
    }
});

test('workspace-index-missing issue renders the regenerate button labelled "Regenerate Files"', async () => {
    healthReportOverride = {
        healthy: false,
        issues: [
            {
                type: 'workspace-index-missing',
                severity: 'warning',
                message: 'Generated index file(s) missing: README.md, AGENTS.md, CLAUDE.md.',
                fixAction: 'regenerate-workspace-file',
            },
        ],
    };

    const { container, cleanup } = await renderView();
    try {
        const healthAlert = container.querySelector('.health-alert');
        assert.ok(healthAlert, '.health-alert section should be present');

        const button = healthAlert.querySelector('.health-alert-issue__action button');
        assert.ok(button, 'regenerate button should be present');
        assert.strictEqual(button.textContent, 'Regenerate Files');
    } finally {
        cleanup();
    }
});
