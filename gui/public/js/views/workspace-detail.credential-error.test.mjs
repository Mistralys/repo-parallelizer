/**
 * Tests for WP-010: GUI Credential-Missing Error Display.
 *
 * Acceptance Criteria verified:
 *   AC1 — When a repository's clone error contains the credential-missing
 *          sentinel text ("requires a credential for host"), the workspace
 *          detail view shows a "Missing Credential" badge instead of the
 *          generic "No data" badge.
 *   AC2 — The "Missing Credential" badge links to the repository detail view
 *          (#/repositories/:id) where the user can select a credential.
 *   AC3 — Non-credential clone errors continue to display as the generic
 *          "No data" badge (no regression in existing error display).
 *   AC4 — The credential-missing error detection uses the sentinel text
 *          ("requires a credential for host") from the orchestrator error
 *          messages (WP-007).
 *
 * Additional toast message tests:
 *   T1  — When all failures are credential-related, the toast mentions
 *          "credential errors" and the affected repository IDs.
 *   T2  — When failures are a mix of credential and non-credential, the
 *          toast distinguishes them with two segments:
 *          "Missing credentials for: <cred-repos>. Failed to clone: <other-repos>."
 *   T3  — When all failures are non-credential, the original toast message
 *          is shown unchanged.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/views/workspace-detail.credential-error.test.mjs
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

// Credential-missing sentinel — must match CREDENTIAL_MISSING_SENTINEL in
// workspace-detail.js and the error message template in the orchestrators.
const SENTINEL = 'requires a credential for host';

// Setup spy — controls what the API returns after workspace setup.
const setupCalls = [];
let setupResult  = { results: [] };
api.workspaces.setup = async (projectId, wid) => {
    setupCalls.push({ projectId, wid });
    return setupResult;
};

// Default stubs for the remaining api calls used by renderWorkspaceDetail.
api.workspaces.get    = async () => ({
    Id: 'DEV', id: 'DEV', Description: '', initialized: false, folderPath: '/tmp/dev',
});
api.workspaces.health = async () => ({ healthy: true, issues: [] });
api.workspaces.launch = api.workspaces.launch || {};
api.workspaces.launch.githubDesktop = async () => ({ success: true });
api.workspaces.launch.vscode        = async () => ({ success: true });
api.projects.get      = async () => ({
    Id: 'my-project',
    Repositories: ['repo-alpha', 'repo-beta'],
});

// Status refresh: by default, no repos have status data yet.
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

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

/**
 * Render the workspace-detail view and wait for the async bootstrap to settle.
 *
 * We poll until a `<table>` or `.workspace-detail-header` element appears, or
 * a maximum tick budget is exhausted.
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

/**
 * Simulate a setup button click and wait for the DOM to update.
 *
 * @param {HTMLElement} container
 */
async function clickSetupAndWait(container) {
    const setupBtn = [...container.querySelectorAll('button')]
        .find((b) => b.textContent.includes('Setup Workspace'));
    assert.ok(setupBtn, 'Setup Workspace button must be present to simulate setup');

    setupBtn.click();

    // Drain microtask queue — the click handler is async, so we need several
    // ticks for the await chain inside the click handler to settle.
    for (let i = 0; i < 20; i++) {
        await new Promise((r) => Promise.resolve().then(r));
    }
}

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
    setupCalls.length   = 0;
    setupResult         = { results: [] };
    statusMapOverride   = {};
    _intervals.clear();
    clearElement(document.getElementById('toast-container'));
    // Restore default: workspace NOT initialized so the Setup button is present.
    api.workspaces.get = async () => ({
        Id: 'DEV', id: 'DEV', Description: '', initialized: false, folderPath: '/tmp/dev',
    });
});

// ---------------------------------------------------------------------------
// AC1 — "Missing Credential" badge shown when credential error detected
// ---------------------------------------------------------------------------

test('AC1: setup result with credential-missing sentinel shows "Missing Credential" badge for that repo', async () => {
    // repo-alpha fails with the credential sentinel; repo-beta succeeds.
    setupResult = {
        results: [
            { repositoryId: 'repo-alpha', success: false, error: `Repository 'repo-alpha' ${SENTINEL} 'github.com'. Please select a credential in the repository settings.` },
            { repositoryId: 'repo-beta',  success: true },
        ],
    };

    const { container, cleanup } = await renderView();
    try {
        await clickSetupAndWait(container);

        const tbody = container.querySelector('tbody');
        assert.ok(tbody, 'status table tbody should exist');

        // repo-alpha row should have the credential badge.
        const alphaRow = tbody.querySelector('tr[data-repo-id="repo-alpha"]');
        assert.ok(alphaRow, 'repo-alpha row should be present');

        const badgeWrapper = alphaRow.querySelector('div[data-repo-id="repo-alpha"]');
        assert.ok(badgeWrapper, 'badge wrapper should be present');

        const credBadge = badgeWrapper.querySelector('.status-badge-credential');
        assert.ok(credBadge, 'Missing Credential badge (.status-badge-credential) should be present for repo-alpha');
        assert.ok(
            credBadge.textContent.includes('Missing Credential'),
            `badge text should contain "Missing Credential", got: "${credBadge.textContent}"`,
        );
    } finally {
        cleanup();
    }
});

test('AC1: repo with non-credential clone error retains generic "No data" badge', async () => {
    // repo-alpha fails with a generic error (not the sentinel).
    setupResult = {
        results: [
            { repositoryId: 'repo-alpha', success: false, error: 'fatal: repository not found' },
        ],
    };

    const { container, cleanup } = await renderView();
    try {
        await clickSetupAndWait(container);

        const tbody = container.querySelector('tbody');
        assert.ok(tbody, 'status table tbody should exist');

        const alphaRow = tbody.querySelector('tr[data-repo-id="repo-alpha"]');
        assert.ok(alphaRow, 'repo-alpha row should be present');

        const badgeWrapper = alphaRow.querySelector('div[data-repo-id="repo-alpha"]');
        assert.ok(badgeWrapper, 'badge wrapper should be present');

        // Must NOT have the credential badge.
        const credBadge = badgeWrapper.querySelector('.status-badge-credential');
        assert.strictEqual(credBadge, null, 'credential badge must NOT be shown for non-credential errors');

        // Should still have the generic error badge.
        const errorBadge = badgeWrapper.querySelector('.status-badge-error');
        assert.ok(errorBadge, 'generic error badge (.status-badge-error) should remain for non-credential errors');
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC2 — badge links to #/repositories/:id
// ---------------------------------------------------------------------------

test('AC2: "Missing Credential" badge href points to #/repositories/:repoId', async () => {
    setupResult = {
        results: [
            { repositoryId: 'repo-alpha', success: false, error: `repo-alpha ${SENTINEL} 'example.com'` },
        ],
    };

    const { container, cleanup } = await renderView();
    try {
        await clickSetupAndWait(container);

        const badgeWrapper = container.querySelector('div[data-repo-id="repo-alpha"]');
        assert.ok(badgeWrapper, 'badge wrapper should be present');

        const credBadge = badgeWrapper.querySelector('.status-badge-credential');
        assert.ok(credBadge, 'credential badge should be present');

        const href = credBadge.getAttribute('href');
        assert.ok(
            href && href.includes('#/repositories/repo-alpha'),
            `href should point to #/repositories/repo-alpha, got: "${href}"`,
        );
    } finally {
        cleanup();
    }
});

test('AC2: "Missing Credential" badge href URL-encodes the repository ID', async () => {
    // Use a repo ID with characters that require encoding.
    api.projects.get = async () => ({
        Id: 'my-project',
        Repositories: ['repo/with spaces'],
    });
    setupResult = {
        results: [
            { repositoryId: 'repo/with spaces', success: false, error: `${SENTINEL} 'example.com'` },
        ],
    };

    const { container, cleanup } = await renderView();
    try {
        await clickSetupAndWait(container);

        const badgeWrapper = container.querySelector('div[data-repo-id="repo/with spaces"]');
        assert.ok(badgeWrapper, 'badge wrapper should be present for repo with spaces');

        const credBadge = badgeWrapper.querySelector('.status-badge-credential');
        assert.ok(credBadge, 'credential badge should be present');

        const href = credBadge.getAttribute('href');
        // encodeURIComponent('repo/with spaces') === 'repo%2Fwith%20spaces'
        assert.ok(
            href && href.includes('repo%2Fwith%20spaces'),
            `href should URL-encode the repo ID, got: "${href}"`,
        );
    } finally {
        cleanup();
        // Restore default projects.get stub.
        api.projects.get = async () => ({ Id: 'my-project', Repositories: ['repo-alpha', 'repo-beta'] });
    }
});

// ---------------------------------------------------------------------------
// AC3 — Non-credential errors are not affected (regression guard)
// ---------------------------------------------------------------------------

test('AC3: non-credential errors show the original "No data" badge, not the credential badge', async () => {
    setupResult = {
        results: [
            { repositoryId: 'repo-alpha', success: false, error: 'Connection timeout' },
            { repositoryId: 'repo-beta',  success: false, error: 'Permission denied (publickey)' },
        ],
    };

    const { container, cleanup } = await renderView();
    try {
        await clickSetupAndWait(container);

        const tbody = container.querySelector('tbody');
        const rows  = tbody ? [...tbody.querySelectorAll('tr[data-repo-id]')] : [];
        assert.ok(rows.length > 0, 'expected at least one repo row');

        for (const row of rows) {
            const credBadge = row.querySelector('.status-badge-credential');
            assert.strictEqual(
                credBadge,
                null,
                `credential badge must NOT appear for row ${row.dataset.repoId} with non-credential error`,
            );
        }
    } finally {
        cleanup();
    }
});

test('AC3: repos that succeed during setup do not get a credential badge', async () => {
    setupResult = {
        results: [
            { repositoryId: 'repo-alpha', success: true },
            { repositoryId: 'repo-beta',  success: true },
        ],
    };

    const { container, cleanup } = await renderView();
    try {
        await clickSetupAndWait(container);

        const credBadges = container.querySelectorAll('.status-badge-credential');
        assert.strictEqual(
            credBadges.length,
            0,
            'no credential badges should appear when all repos succeed',
        );
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC4 — Sentinel text detection is exact substring match
// ---------------------------------------------------------------------------

test('AC4: only errors containing the exact sentinel text trigger the credential badge', async () => {
    // Mix: one with sentinel, one without.
    setupResult = {
        results: [
            {
                repositoryId: 'repo-alpha',
                success: false,
                error: `Repository 'repo-alpha' ${SENTINEL} 'github.com'. Please select a credential.`,
            },
            {
                repositoryId: 'repo-beta',
                success: false,
                error: 'fatal: could not read Username for https://github.com',
            },
        ],
    };

    const { container, cleanup } = await renderView();
    try {
        await clickSetupAndWait(container);

        const tbody = container.querySelector('tbody');
        assert.ok(tbody);

        // repo-alpha: has sentinel → credential badge expected.
        const alphaWrapper = tbody.querySelector('div[data-repo-id="repo-alpha"]');
        assert.ok(alphaWrapper, 'repo-alpha badge wrapper should exist');
        assert.ok(
            alphaWrapper.querySelector('.status-badge-credential'),
            'repo-alpha should have the credential badge (sentinel present)',
        );

        // repo-beta: no sentinel → NO credential badge.
        const betaWrapper = tbody.querySelector('div[data-repo-id="repo-beta"]');
        assert.ok(betaWrapper, 'repo-beta badge wrapper should exist');
        assert.strictEqual(
            betaWrapper.querySelector('.status-badge-credential'),
            null,
            'repo-beta must NOT have the credential badge (no sentinel)',
        );
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// T1 — Toast message for all-credential failures
// ---------------------------------------------------------------------------

test('T1: when all clone failures are credential-related, toast mentions "credential errors"', async () => {
    setupResult = {
        results: [
            { repositoryId: 'repo-alpha', success: false, error: `${SENTINEL} 'github.com'` },
            { repositoryId: 'repo-beta',  success: false, error: `${SENTINEL} 'gitlab.com'` },
        ],
    };

    const { container, cleanup } = await renderView();
    try {
        await clickSetupAndWait(container);

        const toastContainer = document.getElementById('toast-container');
        const toastText = toastContainer ? toastContainer.textContent : '';
        assert.ok(
            toastText.includes('credential'),
            `toast should mention "credential" for credential failures, got: "${toastText}"`,
        );
        // Both repo IDs should appear in the toast.
        assert.ok(toastText.includes('repo-alpha'), `toast should include "repo-alpha", got: "${toastText}"`);
        assert.ok(toastText.includes('repo-beta'),  `toast should include "repo-beta", got: "${toastText}"`);
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// T2 — Toast message for mixed credential and non-credential failures
// ---------------------------------------------------------------------------

test('T2: when failures are mixed (credential + non-credential), toast distinguishes them', async () => {
    // repo-alpha fails with the credential sentinel; repo-beta fails with a generic error.
    setupResult = {
        results: [
            { repositoryId: 'repo-alpha', success: false, error: `${SENTINEL} 'github.com'` },
            { repositoryId: 'repo-beta',  success: false, error: 'fatal: not found' },
        ],
    };

    const { container, cleanup } = await renderView();
    try {
        await clickSetupAndWait(container);

        const toastContainer = document.getElementById('toast-container');
        const toastText = toastContainer ? toastContainer.textContent : '';

        // The credential-missing repos must be listed in a "Missing credentials for:" segment.
        assert.ok(
            toastText.includes('Missing credentials for:'),
            `toast should contain "Missing credentials for:", got: "${toastText}"`,
        );
        assert.ok(
            toastText.includes('repo-alpha'),
            `toast should include "repo-alpha" in the credential segment, got: "${toastText}"`,
        );

        // The non-credential repos must be listed in a "Failed to clone:" segment.
        assert.ok(
            toastText.includes('Failed to clone:'),
            `toast should contain "Failed to clone:", got: "${toastText}"`,
        );
        assert.ok(
            toastText.includes('repo-beta'),
            `toast should include "repo-beta" in the clone-failure segment, got: "${toastText}"`,
        );
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// T3 — Toast message for non-credential failures is unchanged
// ---------------------------------------------------------------------------

test('T3: when no failures are credential-related, toast uses the original message format', async () => {
    setupResult = {
        results: [
            { repositoryId: 'repo-alpha', success: false, error: 'fatal: not found' },
        ],
    };

    const { container, cleanup } = await renderView();
    try {
        await clickSetupAndWait(container);

        const toastContainer = document.getElementById('toast-container');
        const toastText = toastContainer ? toastContainer.textContent : '';
        assert.ok(
            toastText.includes('Failed to clone'),
            `toast should say "Failed to clone" for non-credential failures, got: "${toastText}"`,
        );
        assert.ok(
            !toastText.includes('credential error'),
            `toast must NOT mention "credential error" for non-credential failures, got: "${toastText}"`,
        );
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// Health-report badge persistence (WP-002)
// ---------------------------------------------------------------------------

test('health-report: credential-missing issue in health report populates badge on initial load (no setup required)', async () => {
    // Return an initialized workspace so the table renders.
    api.workspaces.get = async () => ({
        Id: 'DEV', id: 'DEV', Description: '', initialized: true, folderPath: '/tmp/dev',
    });

    // Health report already contains a credential-missing issue for repo-alpha.
    api.workspaces.health = async () => ({
        healthy: false,
        issues: [
            {
                type: 'credential-missing',
                severity: 'warning',
                message: "Repository 'repo-alpha' requires a credential for host 'github.com'.",
                fixAction: 'configure-credential',
                repositoryId: 'repo-alpha',
            },
        ],
    });

    const { container, cleanup } = await renderView();
    try {
        const tbody = container.querySelector('tbody');
        assert.ok(tbody, 'status table tbody should be present');

        // repo-alpha should show the credential badge populated from the health report,
        // WITHOUT any setup button click.
        const alphaRow = tbody.querySelector('tr[data-repo-id="repo-alpha"]');
        assert.ok(alphaRow, 'repo-alpha row should exist');

        const badgeWrapper = alphaRow.querySelector('div[data-repo-id="repo-alpha"]');
        assert.ok(badgeWrapper, 'badge wrapper should exist for repo-alpha');

        const credBadge = badgeWrapper.querySelector('.status-badge-credential');
        assert.ok(
            credBadge,
            'Missing Credential badge should appear for repo-alpha from health report on page load',
        );
    } finally {
        cleanup();
        // Restore defaults for subsequent tests.
        api.workspaces.get = async () => ({
            Id: 'DEV', id: 'DEV', Description: '', initialized: false, folderPath: '/tmp/dev',
        });
        api.workspaces.health = async () => ({ healthy: true, issues: [] });
    }
});

test('health-report: non-credential health issues do not produce credential badges', async () => {
    api.workspaces.get = async () => ({
        Id: 'DEV', id: 'DEV', Description: '', initialized: true, folderPath: '/tmp/dev',
    });

    // Only a workspace-file-missing issue — no credential-missing.
    api.workspaces.health = async () => ({
        healthy: false,
        issues: [
            {
                type: 'workspace-file-missing',
                severity: 'warning',
                message: 'VS Code workspace file is missing.',
                fixAction: 'regenerate-workspace-file',
            },
        ],
    });

    const { container, cleanup } = await renderView();
    try {
        const credBadges = container.querySelectorAll('.status-badge-credential');
        assert.strictEqual(
            credBadges.length,
            0,
            'no credential badges should appear when health report has no credential-missing issues',
        );
    } finally {
        cleanup();
        api.workspaces.get = async () => ({
            Id: 'DEV', id: 'DEV', Description: '', initialized: false, folderPath: '/tmp/dev',
        });
        api.workspaces.health = async () => ({ healthy: true, issues: [] });
    }
});

// ---------------------------------------------------------------------------
// WP-005 — "Configure Credential" button in health alert section
// ---------------------------------------------------------------------------

test('WP-005: buildHealthAlertSection renders a "Configure" button for configure-credential fix action', async () => {
    api.workspaces.get = async () => ({
        Id: 'DEV', id: 'DEV', Description: '', initialized: true, folderPath: '/tmp/dev',
    });

    api.workspaces.health = async () => ({
        healthy: false,
        issues: [
            {
                type: 'credential-missing',
                severity: 'warning',
                message: "Repository 'repo-alpha' requires a credential for host 'github.com'.",
                fixAction: 'configure-credential',
                repositoryId: 'repo-alpha',
            },
        ],
    });

    const { container, cleanup } = await renderView();
    try {
        const healthAlert = container.querySelector('.health-alert');
        assert.ok(healthAlert, '.health-alert section should be present');

        // The "Configure" button must be present within the health alert.
        const buttons = [...healthAlert.querySelectorAll('button')];
        const configureBtn = buttons.find((b) => b.textContent.trim() === 'Configure');
        assert.ok(configureBtn, '"Configure" button should be rendered for configure-credential fix action');

        // Button must carry the expected CSS classes.
        assert.ok(
            configureBtn.classList.contains('btn'),
            'button should have class "btn"',
        );
        assert.ok(
            configureBtn.classList.contains('btn-secondary'),
            'button should have class "btn-secondary"',
        );
        assert.ok(
            configureBtn.classList.contains('btn-sm'),
            'button should have class "btn-sm"',
        );

        // Button click must navigate to #/repositories.
        configureBtn.click();
        assert.strictEqual(
            window.location.hash,
            '#/repositories',
            'clicking "Configure" should set window.location.hash to "#/repositories"',
        );

        // The button must be inside a .health-alert-issue__action wrapper span (same DOM
        // structure as 'regenerate-workspace-file' and 'setup-workspace' buttons).
        const actionWrap = configureBtn.closest('.health-alert-issue__action');
        assert.ok(
            actionWrap,
            'button should be nested inside a .health-alert-issue__action span',
        );
    } finally {
        cleanup();
        api.workspaces.get = async () => ({
            Id: 'DEV', id: 'DEV', Description: '', initialized: false, folderPath: '/tmp/dev',
        });
        api.workspaces.health = async () => ({ healthy: true, issues: [] });
    }
});
