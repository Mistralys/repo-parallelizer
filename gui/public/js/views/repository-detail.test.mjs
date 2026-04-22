/**
 * Unit tests for views/repository-detail.js — WP-003.
 *
 * Acceptance Criteria verified:
 *   AC1  — Navigating to #/repositories/:id renders the repository overview view.
 *   AC2  — The header displays the repository name, ID, URL (as clickable external
 *           link), and a back link to #/repositories.
 *   AC3  — The table contains columns: Project, Workspace, Branch, Status, Actions.
 *   AC4  — Each Project cell is a clickable link navigating to #/projects/:pid.
 *   AC5  — Each Workspace cell is a clickable link navigating to
 *           #/projects/:pid/workspaces/:wid.
 *   AC6  — Branch, Status, and Actions cells are rendered via the shared
 *           buildRepoStatusCells component (verified by CSS class presence).
 *   AC7  — Branch-quick-switch works on non-STABLE workspace rows.
 *   AC8  — STABLE workspace rows show plain-text branch names (no trigger button).
 *   AC9  — The "Refresh" button re-fetches all status data and updates existing rows.
 *   AC10 — An empty state message is shown when no projects contain this repository.
 *   AC11 — Individual project/workspace fetch failures are handled gracefully.
 *   AC12 — The view follows the setRouter(router) / _router null-guard pattern.
 *   AC13 — The Git GUI button calls api.workspaces.launch.githubDesktop(pid, wid, repoId).
 *   AC14 — The Browse button appears when webserverUrl is configured.
 *   AC15 — No innerHTML assignments — all text set via textContent.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/views/repository-detail.test.mjs
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup — install globals before any module is imported
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="toast-container"></div></body></html>', {
    url: 'http://localhost/',
});

const { window } = dom;

globalThis.document    = window.document;
globalThis.window      = window;
globalThis.location    = window.location;
globalThis.HTMLElement = window.HTMLElement;
globalThis.CSS = window.CSS ?? { escape: (s) => s.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '\\$&') };

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
// Fixtures
// ---------------------------------------------------------------------------

const REPO_ID   = 'my-repo';
const REPO_NAME = 'My Repo';
const REPO_URL  = 'https://github.com/org/my-repo.git';

const PROJECT_ID   = 'proj-a';
const PROJECT_NAME = 'Project A';
const WS_ID        = 'DEV';
// Canonical definition lives in utils/constants.js; redeclared here because
// native browser imports cannot be resolved in the Node.js jsdom test harness.
const STABLE_WS_ID = 'STABLE';

const STATUS_INFO = {
    currentBranch:    'main',
    localCommits:     0,
    unfetchedCommits: 0,
    modifiedFiles:    0,
    lastActivity:     null,
    hasConflicts:     false,
};

// ---------------------------------------------------------------------------
// Import API and set up mocks
// ---------------------------------------------------------------------------

const { api } = await import('../api.js');

/** Calls recorded by the launch.githubDesktop spy. */
const ghDesktopCalls = [];
api.workspaces.launch.githubDesktop = async (projectId, wid, repoId) => {
    ghDesktopCalls.push({ projectId, wid, repoId });
    return { success: true };
};

/** URLs opened by window.open spy. */
const openedUrls = [];
globalThis.window.open = (url, target) => {
    openedUrls.push({ url, target });
};

// Default API mock state — overridden per-test where needed.
let mockRepoResponse = { Id: REPO_ID, Name: REPO_NAME, Url: REPO_URL };
let mockProjectsList = [{ Id: PROJECT_ID }];
let mockProjectDetail = {
    Id: PROJECT_ID, Name: PROJECT_NAME,
    Repositories: [{ Id: REPO_ID }],
};
let mockWorkspacesList = [
    { WorkspaceID: WS_ID, Initialized: true },
];
let mockStatusMap = { [REPO_ID]: STATUS_INFO };
let mockWebserverUrl = null;

api.repositories.get = async () => mockRepoResponse;
api.projects.list    = async () => mockProjectsList;
api.projects.get     = async () => mockProjectDetail;
api.workspaces.list  = async () => mockWorkspacesList;
api.status.get       = async () => mockStatusMap;
api.status.refresh   = async () => mockStatusMap;
api.config.webserverUrl = {
    get: async () => mockWebserverUrl,
};

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { renderRepositoryDetail, setRouter } = await import('./repository-detail.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render the view into a fresh container and wait for async bootstrap.
 *
 * @param {{ id?: string }} [params]
 * @returns {Promise<HTMLElement>}
 */
async function renderAndWait(params = { id: REPO_ID }) {
    const container = document.createElement('div');
    container.id = 'app';
    // Simulate connected state.
    document.body.appendChild(container);

    renderRepositoryDetail(container, params);

    // Flush all pending micro-tasks (Promise chains).
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    return container;
}

/**
 * Clean up all rendered containers after each test.
 */
function cleanupContainers() {
    document.body.querySelectorAll('#app').forEach((el) => el.remove());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('AC1 — renderRepositoryDetail renders the repository overview view', async () => {
    const container = await renderAndWait();
    try {
        // Should have content beyond the initial loading spinner.
        assert.ok(container.children.length > 0, 'Container should have children after render');
        // Loading spinner should be gone.
        assert.strictEqual(container.querySelector('.loading-indicator'), null, 'Loading indicator should be removed');
    } finally {
        cleanupContainers();
    }
});

test('AC2 — header displays repo name, ID, URL, and back link', async () => {
    const container = await renderAndWait();
    try {
        // Repository name as H1 heading
        const h1 = container.querySelector('h1');
        assert.ok(h1, 'H1 heading should exist');
        assert.strictEqual(h1.textContent, REPO_NAME);

        // URL as external link
        const urlLink = container.querySelector('a.repo-url-link');
        assert.ok(urlLink, 'URL link should exist');
        assert.strictEqual(urlLink.href, REPO_URL);
        assert.strictEqual(urlLink.target, '_blank');
        assert.strictEqual(urlLink.rel, 'noopener noreferrer');

        // Back link to #/repositories
        const backLink = container.querySelector('a.breadcrumb-link');
        assert.ok(backLink, 'Back link should exist');
        assert.ok(backLink.href.endsWith('#/repositories'), 'Back link should point to #/repositories');
    } finally {
        cleanupContainers();
    }
});

test('AC2 — header shows ID hint when name differs from ID', async () => {
    const container = await renderAndWait();
    try {
        // The ID hint should be visible when repo.name !== repo.id
        const idHint = container.querySelector('.project-meta-id');
        assert.ok(idHint, 'ID hint span should exist when name differs from ID');
        assert.strictEqual(idHint.textContent, REPO_ID);
    } finally {
        cleanupContainers();
    }
});

test('AC3 — table contains columns: Project, Workspace, Branch, Status, Actions', async () => {
    const container = await renderAndWait();
    try {
        const table = container.querySelector('table.repository-detail-table');
        assert.ok(table, 'Status table should exist');

        const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
        assert.deepStrictEqual(headers, ['Project', 'Workspace', 'Branch', 'Status', 'Actions']);
    } finally {
        cleanupContainers();
    }
});

test('AC4 — Project cell is a clickable link to #/projects/:pid', async () => {
    const container = await renderAndWait();
    try {
        const tbody = container.querySelector('tbody');
        assert.ok(tbody, 'tbody should exist');

        const rows = tbody.querySelectorAll('tr');
        assert.ok(rows.length > 0, 'Should have at least one row');

        const projectLink = rows[0].querySelector('.repo-detail-project-cell a');
        assert.ok(projectLink, 'Project cell should contain a link');
        assert.ok(
            projectLink.href.endsWith(`#/projects/${encodeURIComponent(PROJECT_ID)}`),
            `Project link should navigate to #/projects/${PROJECT_ID}`,
        );
        assert.strictEqual(projectLink.textContent, PROJECT_NAME);
    } finally {
        cleanupContainers();
    }
});

test('AC5 — Workspace cell is a clickable link to #/projects/:pid/workspaces/:wid', async () => {
    const container = await renderAndWait();
    try {
        const tbody = container.querySelector('tbody');
        const rows  = tbody.querySelectorAll('tr');

        const wsLink = rows[0].querySelector('.repo-detail-workspace-cell a');
        assert.ok(wsLink, 'Workspace cell should contain a link');
        assert.ok(
            wsLink.href.endsWith(`#/projects/${encodeURIComponent(PROJECT_ID)}/workspaces/${encodeURIComponent(WS_ID)}`),
            `Workspace link should navigate to #/projects/${PROJECT_ID}/workspaces/${WS_ID}`,
        );
        assert.strictEqual(wsLink.textContent, WS_ID);
    } finally {
        cleanupContainers();
    }
});

test('AC6 — Branch, Status, Actions cells are rendered via buildRepoStatusCells (CSS classes)', async () => {
    const container = await renderAndWait();
    try {
        const tbody = container.querySelector('tbody');
        const row   = tbody.querySelector('tr');

        assert.ok(row.querySelector('.repo-branch-cell'),  '.repo-branch-cell should exist');
        assert.ok(row.querySelector('.repo-badge-cell'),   '.repo-badge-cell should exist');
        assert.ok(row.querySelector('.repo-actions-cell'), '.repo-actions-cell should exist');
    } finally {
        cleanupContainers();
    }
});

test('AC7 — Branch-quick-switch trigger is present for non-STABLE rows', async () => {
    // DEV workspace (not STABLE) with status info → should have trigger button
    mockWorkspacesList = [{ WorkspaceID: WS_ID, Initialized: true }];
    mockStatusMap = { [REPO_ID]: STATUS_INFO };

    const container = await renderAndWait();
    try {
        const tbody   = container.querySelector('tbody');
        const devRow  = [...tbody.querySelectorAll('tr')].find((tr) => tr.dataset.wid === WS_ID);
        assert.ok(devRow, 'DEV row should exist');

        const trigger = devRow.querySelector('button.branch-switch-trigger');
        assert.ok(trigger, 'Branch switch trigger should exist for non-STABLE row');
        assert.strictEqual(trigger.textContent, STATUS_INFO.currentBranch);
    } finally {
        cleanupContainers();
    }
});

test('AC8 — STABLE workspace rows show plain-text branch name, no trigger button', async () => {
    mockWorkspacesList = [{ WorkspaceID: STABLE_WS_ID, Initialized: true }];
    mockStatusMap = { [REPO_ID]: STATUS_INFO };

    const container = await renderAndWait();
    try {
        const tbody     = container.querySelector('tbody');
        const stableRow = [...tbody.querySelectorAll('tr')].find((tr) => tr.dataset.wid === STABLE_WS_ID);
        assert.ok(stableRow, 'STABLE row should exist');

        // Branch cell should contain plain text, no trigger button
        const branchCell = stableRow.querySelector('.repo-branch-cell');
        assert.ok(branchCell, '.repo-branch-cell should exist');
        assert.strictEqual(branchCell.querySelector('button'), null, 'STABLE row should have no trigger button');
        assert.ok(branchCell.textContent.includes(STATUS_INFO.currentBranch), 'STABLE row should show branch name as plain text');
    } finally {
        cleanupContainers();
        // Restore defaults
        mockWorkspacesList = [{ WorkspaceID: WS_ID, Initialized: true }];
        mockStatusMap = { [REPO_ID]: STATUS_INFO };
    }
});

test('AC9 — Refresh button re-fetches status and updates rows in-place', async () => {
    let refreshCallCount = 0;
    const originalRefresh = api.status.refresh;
    api.status.refresh = async () => {
        refreshCallCount++;
        return { [REPO_ID]: { ...STATUS_INFO, currentBranch: 'feature-branch' } };
    };

    const container = await renderAndWait();
    try {
        const refreshBtn = container.querySelector('.btn');
        const matchingRefreshBtns = [...container.querySelectorAll('button')].filter(
            (b) => b.textContent === 'Refresh',
        );
        assert.ok(matchingRefreshBtns.length > 0, 'Refresh button should exist');

        const btn = matchingRefreshBtns[0];
        btn.click();

        // Flush async chains
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.ok(refreshCallCount > 0, 'api.status.refresh should have been called');
        assert.strictEqual(btn.textContent, 'Refresh', 'Button label should reset after refresh');
        assert.ok(!btn.disabled, 'Button should be re-enabled after refresh');
    } finally {
        api.status.refresh = originalRefresh;
        cleanupContainers();
    }
});

test('AC10 — Empty state message shown when no projects contain this repository', async () => {
    // Return a project that does NOT contain the repo
    mockProjectsList  = [{ Id: 'other-project' }];
    mockProjectDetail = { Id: 'other-project', Name: 'Other Project', Repositories: [] };

    const container = await renderAndWait();
    try {
        const empty = container.querySelector('.empty-state-inline');
        assert.ok(empty, 'Empty state element should exist');
        assert.ok(empty.textContent.includes('No projects contain this repository'));
    } finally {
        cleanupContainers();
        // Restore
        mockProjectsList  = [{ Id: PROJECT_ID }];
        mockProjectDetail = { Id: PROJECT_ID, Name: PROJECT_NAME, Repositories: [{ Id: REPO_ID }] };
    }
});

test('AC11 — Individual project fetch failure is handled gracefully (partial results)', async () => {
    // Two projects: one returns valid data, one rejects.
    const GOOD_PROJECT_ID = PROJECT_ID;
    const BAD_PROJECT_ID  = 'failing-project';

    mockProjectsList = [{ Id: GOOD_PROJECT_ID }, { Id: BAD_PROJECT_ID }];
    const originalGet = api.projects.get;
    api.projects.get = async (pid) => {
        if (pid === BAD_PROJECT_ID) throw new Error('Network error');
        return { Id: GOOD_PROJECT_ID, Name: PROJECT_NAME, Repositories: [{ Id: REPO_ID }] };
    };

    const container = await renderAndWait();
    try {
        // Good project's workspace row should still be present
        const tbody = container.querySelector('tbody');
        assert.ok(tbody, 'tbody should exist (partial results rendered)');

        const rows = tbody.querySelectorAll('tr');
        assert.ok(rows.length >= 1, 'At least one row should be rendered from the good project');
    } finally {
        api.projects.get = originalGet;
        mockProjectsList = [{ Id: PROJECT_ID }];
        cleanupContainers();
    }
});

test('AC12 — setRouter / _router null-guard: back link click calls router.navigate', async () => {
    const navigateCalls = [];
    const mockRouter = {
        navigate(target) { navigateCalls.push(target); },
    };

    setRouter(mockRouter);

    const container = await renderAndWait();
    try {
        const backLink = container.querySelector('a.breadcrumb-link');
        assert.ok(backLink, 'Back link should exist');

        // Simulate click — should call router.navigate, not reload the page
        const clickEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
        backLink.dispatchEvent(clickEvent);

        assert.ok(navigateCalls.length > 0, 'router.navigate should have been called');
        assert.strictEqual(navigateCalls[0], '#/repositories');
    } finally {
        setRouter(null);
        cleanupContainers();
    }
});

test('AC12 — Project cell link calls router.navigate when router is injected', async () => {
    const navigateCalls = [];
    const mockRouter = {
        navigate(target) { navigateCalls.push(target); },
    };

    setRouter(mockRouter);

    const container = await renderAndWait();
    try {
        const tbody      = container.querySelector('tbody');
        const row        = tbody.querySelector('tr');
        const projectLink = row.querySelector('.repo-detail-project-cell a');

        const clickEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
        projectLink.dispatchEvent(clickEvent);

        assert.ok(
            navigateCalls.some((t) => t.includes(`/projects/${encodeURIComponent(PROJECT_ID)}`)),
            'router.navigate should have been called with the project URL',
        );
    } finally {
        setRouter(null);
        cleanupContainers();
    }
});

test('AC13 — Git GUI button calls api.workspaces.launch.githubDesktop(pid, wid, repoId)', async () => {
    ghDesktopCalls.length = 0; // Reset spy
    mockWorkspacesList = [{ WorkspaceID: WS_ID, Initialized: true }];
    mockStatusMap = { [REPO_ID]: STATUS_INFO };

    const container = await renderAndWait();
    try {
        const gitGuiBtn = [...container.querySelectorAll('button')].find(
            (b) => b.textContent === 'Git GUI',
        );
        assert.ok(gitGuiBtn, 'Git GUI button should exist');

        gitGuiBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.ok(ghDesktopCalls.length > 0, 'githubDesktop should have been called');
        const call = ghDesktopCalls[ghDesktopCalls.length - 1];
        assert.strictEqual(call.projectId, PROJECT_ID);
        assert.strictEqual(call.wid,       WS_ID);
        assert.strictEqual(call.repoId,    REPO_ID);
    } finally {
        cleanupContainers();
    }
});

test('AC14 — Browse button appears when webserverUrl is configured', async () => {
    mockWebserverUrl = { webserverUrl: 'http://localhost:8080' };
    mockWorkspacesList = [{ WorkspaceID: WS_ID, Initialized: true }];
    mockStatusMap = { [REPO_ID]: STATUS_INFO };

    const container = await renderAndWait();
    try {
        const browseBtn = [...container.querySelectorAll('button')].find(
            (b) => b.textContent === 'Browse',
        );
        assert.ok(browseBtn, 'Browse button should exist when webserverUrl is configured');
    } finally {
        mockWebserverUrl = null;
        cleanupContainers();
    }
});

test('AC14 — Browse button is absent when webserverUrl is not configured', async () => {
    mockWebserverUrl = null;
    mockWorkspacesList = [{ WorkspaceID: WS_ID, Initialized: true }];
    mockStatusMap = { [REPO_ID]: STATUS_INFO };

    const container = await renderAndWait();
    try {
        const browseBtn = [...container.querySelectorAll('button')].find(
            (b) => b.textContent === 'Browse',
        );
        assert.strictEqual(browseBtn, undefined, 'Browse button should NOT exist when webserverUrl is absent');
    } finally {
        cleanupContainers();
    }
});

test('AC15 — No innerHTML assignments: header and table nodes are built via DOM APIs', async () => {
    // We verify indirectly: the header links are <a> elements with href and
    // textContent, not raw HTML strings. If innerHTML were used, the URL link
    // would still work but XSS could occur. We assert that the URL is correctly
    // encoded and that the structure matches the expected DOM, which is only
    // possible without innerHTML escaping issues.
    mockRepoResponse = {
        Id:   'repo-with-<special>&chars',
        Name: 'Repo <Name> & "Chars"',
        Url:  'https://github.com/org/repo.git',
    };

    const container = await renderAndWait({ id: 'repo-with-<special>&chars' });
    try {
        const h1 = container.querySelector('h1');
        assert.ok(h1, 'H1 should exist');
        // textContent should contain the raw special chars, not HTML-escaped sequences.
        assert.strictEqual(h1.textContent, 'Repo <Name> & "Chars"');
    } finally {
        mockRepoResponse = { Id: REPO_ID, Name: REPO_NAME, Url: REPO_URL };
        cleanupContainers();
    }
});

test('Uninitialized workspace rows show badge and empty status cells', async () => {
    mockWorkspacesList = [{ WorkspaceID: 'UNINIT', Initialized: false }];
    mockStatusMap = {};

    const container = await renderAndWait();
    try {
        const tbody = container.querySelector('tbody');
        assert.ok(tbody, 'tbody should exist');

        const row = tbody.querySelector('tr[data-wid="UNINIT"]');
        assert.ok(row, 'UNINIT row should exist');

        // Should have the "not initialized" badge
        const badge = row.querySelector('.ws-not-initialized-badge');
        assert.ok(badge, '"not initialized" badge should exist');
        assert.ok(badge.textContent.includes('not initialized'));

        // Branch, badge, and actions cells should be present but empty
        const branchCell  = row.querySelector('.repo-branch-cell');
        const badgeCell   = row.querySelector('.repo-badge-cell');
        const actionsCell = row.querySelector('.repo-actions-cell');
        assert.ok(branchCell,  '.repo-branch-cell should exist');
        assert.ok(badgeCell,   '.repo-badge-cell should exist');
        assert.ok(actionsCell, '.repo-actions-cell should exist');

        // No action buttons for uninitialized workspace
        assert.strictEqual(actionsCell.querySelector('button'), null, 'Uninitialized workspace should have no action buttons');
    } finally {
        cleanupContainers();
        mockWorkspacesList = [{ WorkspaceID: WS_ID, Initialized: true }];
        mockStatusMap = { [REPO_ID]: STATUS_INFO };
    }
});

test('Multiple workspace rows — one DEV and one STABLE', async () => {
    mockWorkspacesList = [
        { WorkspaceID: WS_ID,        Initialized: true },
        { WorkspaceID: STABLE_WS_ID, Initialized: true },
    ];
    mockStatusMap = { [REPO_ID]: STATUS_INFO };

    const container = await renderAndWait();
    try {
        const tbody = container.querySelector('tbody');
        const rows  = tbody.querySelectorAll('tr');
        assert.strictEqual(rows.length, 2, 'Should render two workspace rows');

        const devRow    = [...rows].find((r) => r.dataset.wid === WS_ID);
        const stableRow = [...rows].find((r) => r.dataset.wid === STABLE_WS_ID);

        // DEV should have a branch trigger
        assert.ok(devRow.querySelector('button.branch-switch-trigger'), 'DEV row should have trigger');

        // STABLE should NOT have a branch trigger
        assert.strictEqual(stableRow.querySelector('button.branch-switch-trigger'), null, 'STABLE row should have no trigger');
    } finally {
        cleanupContainers();
        mockWorkspacesList = [{ WorkspaceID: WS_ID, Initialized: true }];
    }
});

// ---------------------------------------------------------------------------
// Step 6 — 404 error state
// ---------------------------------------------------------------------------

test('Step6 — 404 response shows a "not found" message with a back link to #/repositories', async () => {
    const original404Get = api.repositories.get;
    api.repositories.get = async () => {
        const err = new Error('Not Found');
        err.status = 404;
        throw err;
    };

    const container = await renderAndWait({ id: 'nonexistent-repo' });
    try {
        // Should render a not-found message
        const text = container.textContent;
        assert.ok(text.includes('nonexistent-repo'), 'Not-found message should include the repo ID');
        assert.ok(text.includes('not found') || text.includes('Not Found') || text.includes('was not found'), 'Should indicate the repository was not found');

        // Should have a back link to repositories
        const backLink = container.querySelector('a[href="#/repositories"]');
        assert.ok(backLink, 'Should have a back link to #/repositories');
    } finally {
        api.repositories.get = original404Get;
        cleanupContainers();
    }
});

test('Step6 — non-404 error shows a generic error message', async () => {
    const originalGet = api.repositories.get;
    api.repositories.get = async () => {
        const err = new Error('Internal Server Error');
        err.status = 500;
        throw err;
    };

    const container = await renderAndWait({ id: REPO_ID });
    try {
        // Should render a generic error message, no back link
        const errorEl = container.querySelector('.empty-state-inline');
        assert.ok(errorEl, 'Generic error element should exist');
        assert.ok(errorEl.textContent.includes('Internal Server Error'), 'Should show the error message');
        assert.strictEqual(container.querySelector('a[href="#/repositories"]'), null, 'Should not have the not-found back link for generic errors');
    } finally {
        api.repositories.get = originalGet;
        cleanupContainers();
    }
});

// ---------------------------------------------------------------------------
// Step 7 — Auto-discovery on Refresh
// ---------------------------------------------------------------------------

test('Step7 — Refresh discovers a newly added workspace and appends its row', async () => {
    // Initial state: only DEV workspace.
    mockWorkspacesList = [{ WorkspaceID: WS_ID, Initialized: true }];
    mockStatusMap      = { [REPO_ID]: STATUS_INFO };

    const container = await renderAndWait();
    try {
        const tbody = container.querySelector('tbody');
        assert.ok(tbody, 'tbody should exist');
        assert.strictEqual(tbody.querySelectorAll('tr').length, 1, 'Should start with 1 row');

        // Simulate a new workspace being added.
        const NEW_WS = 'NEWWS';
        mockWorkspacesList = [
            { WorkspaceID: WS_ID, Initialized: true },
            { WorkspaceID: NEW_WS, Initialized: true },
        ];
        mockStatusMap = { [REPO_ID]: STATUS_INFO };

        const refreshBtn = [...container.querySelectorAll('button')].find(
            (b) => b.textContent === 'Refresh',
        );
        assert.ok(refreshBtn, 'Refresh button should exist');

        refreshBtn.click();

        // Flush async chains.
        for (let i = 0; i < 10; i++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        assert.strictEqual(
            container.querySelector('tbody').querySelectorAll('tr').length,
            2,
            'Should have 2 rows after discovering the new workspace',
        );
        const newRow = container.querySelector(`tr[data-wid="${NEW_WS}"]`);
        assert.ok(newRow, 'New workspace row should be present after refresh');
    } finally {
        mockWorkspacesList = [{ WorkspaceID: WS_ID, Initialized: true }];
        mockStatusMap = { [REPO_ID]: STATUS_INFO };
        cleanupContainers();
    }
});

test('Step7 — Refresh removes a row for a workspace no longer returned by discovery', async () => {
    // Initial state: DEV and STABLE workspaces.
    mockWorkspacesList = [
        { WorkspaceID: WS_ID,        Initialized: true },
        { WorkspaceID: STABLE_WS_ID, Initialized: true },
    ];
    mockStatusMap = { [REPO_ID]: STATUS_INFO };

    const container = await renderAndWait();
    try {
        const tbody = container.querySelector('tbody');
        assert.ok(tbody, 'tbody should exist');
        assert.strictEqual(tbody.querySelectorAll('tr').length, 2, 'Should start with 2 rows');

        // Simulate STABLE workspace being removed from the project.
        mockWorkspacesList = [{ WorkspaceID: WS_ID, Initialized: true }];

        const refreshBtn = [...container.querySelectorAll('button')].find(
            (b) => b.textContent === 'Refresh',
        );
        refreshBtn.click();

        for (let i = 0; i < 10; i++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        assert.strictEqual(
            container.querySelector('tbody').querySelectorAll('tr').length,
            1,
            'Should have 1 row after the removed workspace disappears',
        );
    } finally {
        mockWorkspacesList = [{ WorkspaceID: WS_ID, Initialized: true }];
        mockStatusMap = { [REPO_ID]: STATUS_INFO };
        cleanupContainers();
    }
});
