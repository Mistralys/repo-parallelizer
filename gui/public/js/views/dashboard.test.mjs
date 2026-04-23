/**
 * Unit tests for views/dashboard.js — WP-003.
 *
 * Acceptance Criteria verified:
 *   AC1 — Freeform search filters the project list in real-time by matching
 *         against project name, ID, and description (case-insensitive substring).
 *   AC2 — Repository filter dropdown filters the project list to only projects
 *         containing the selected repository.
 *   AC3 — Sort selector toggles between alphabetical and last-activity.
 *   AC4 — Clearing all filters restores the full project list.
 *   AC5 — "No projects match the current filters." is shown when zero results.
 *   AC6 — After creating a new project, data is re-fetched and current
 *         filter/sort state is re-applied.
 *   AC7 — DOM clearing uses clearElement() — no innerHTML = '' pattern in the
 *         module (structural, verified via source inspection).
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/views/dashboard.test.mjs
 */

import { test } from 'node:test';
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

const REPO_A = { Id: 'repo-a', Name: 'Repository A' };
const REPO_B = { Id: 'repo-b', Name: 'Repository B' };

/**
 * Three projects with varying names, descriptions, repos, and LastActivity.
 *
 * alpha    — name "Alpha Project", repo-a only, activity 2024-03-01
 * beta     — name "Beta Project",  repo-a + repo-b, activity 2024-01-15
 * zeta     — name "Zeta Search",   repo-b only, activity null
 */
const PROJECT_ALPHA = {
    Id: 'alpha',
    Name: 'Alpha Project',
    Description: 'The first project',
    Repositories: [REPO_A],
    LastActivity: '2024-03-01T00:00:00Z',
};

const PROJECT_BETA = {
    Id: 'beta',
    Name: 'Beta Project',
    Description: 'Second project with search keyword',
    Repositories: [REPO_A, REPO_B],
    LastActivity: '2024-01-15T00:00:00Z',
};

const PROJECT_ZETA = {
    Id: 'zeta',
    Name: 'Zeta Search',
    Description: 'Third project, no activity',
    Repositories: [REPO_B],
    LastActivity: null,
};

// ---------------------------------------------------------------------------
// Import API and set up mocks
// ---------------------------------------------------------------------------

const { api } = await import('../api.js');

/** Default project list returned by api.projects.list(). */
let _projectListResponse = [PROJECT_ALPHA, PROJECT_BETA, PROJECT_ZETA];

api.repositories.list = async () => [REPO_A, REPO_B];

// projects.list() returns stubs; projects.get() returns the full fixture.
api.projects.list = async () => _projectListResponse;
api.projects.get  = async (id) => {
    const map = { alpha: PROJECT_ALPHA, beta: PROJECT_BETA, zeta: PROJECT_ZETA };
    return map[id] ?? { Id: id, Name: id };
};
api.projects.create = async () => ({});

// workspaces.list() returns an empty array (no workspaces needed for filtering).
api.workspaces = { list: async () => [] };

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { renderDashboard, setRouter } = await import('./dashboard.js');

// Provide a minimal no-op router so navigation clicks don't error.
setRouter({ navigate: () => {} });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render the dashboard into a fresh container and wait for all async
 * operations (API fetches, toolbar init, project list render) to settle.
 *
 * @returns {Promise<HTMLElement>} The container element.
 */
async function renderAndWait() {
    const container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);

    await renderDashboard(container, {});

    // Allow any pending micro-tasks / debounced callbacks to flush.
    await new Promise((resolve) => setTimeout(resolve, 50));

    return container;
}

/**
 * Fire an input event on `el` and wait for the debounce (250ms + slack).
 * @param {HTMLInputElement} el
 * @param {string} value
 */
async function setSearchAndWait(el, value) {
    el.value = value;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 350));
}

/**
 * Fire a change event on a <select> element.
 * @param {HTMLSelectElement} el
 * @param {string} value
 */
async function setSelectAndWait(el, value) {
    el.value = value;
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Remove all rendered #app containers after each test. */
function cleanup() {
    document.body.querySelectorAll('#app').forEach((el) => el.remove());
}

/** Return the names of all visible project cards in order. */
function getCardNames(container) {
    return [...container.querySelectorAll('.project-card-title')].map((el) => el.textContent);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('AC1 — search by name (case-insensitive substring) filters cards', async () => {
    const container = await renderAndWait();
    try {
        const searchInput = container.querySelector('input.project-filter-search');
        assert.ok(searchInput, 'Search input must exist');

        await setSearchAndWait(searchInput, 'alpha');

        const names = getCardNames(container);
        assert.deepEqual(names, ['Alpha Project'], `Expected only "Alpha Project", got: ${JSON.stringify(names)}`);
    } finally {
        cleanup();
    }
});

test('AC1 — search by project ID (case-insensitive) filters cards', async () => {
    const container = await renderAndWait();
    try {
        const searchInput = container.querySelector('input.project-filter-search');
        await setSearchAndWait(searchInput, 'ZETA');

        const names = getCardNames(container);
        assert.deepEqual(names, ['Zeta Search'], `Expected only "Zeta Search", got: ${JSON.stringify(names)}`);
    } finally {
        cleanup();
    }
});

test('AC1 — search by description (substring) filters cards', async () => {
    const container = await renderAndWait();
    try {
        const searchInput = container.querySelector('input.project-filter-search');
        // "search keyword" is only in PROJECT_BETA's description; "Search" is also
        // in Zeta Search's name — use a term unique to beta's description.
        await setSearchAndWait(searchInput, 'keyword');

        const names = getCardNames(container);
        assert.deepEqual(names, ['Beta Project'], `Expected only "Beta Project", got: ${JSON.stringify(names)}`);
    } finally {
        cleanup();
    }
});

test('AC2 — repository filter shows only projects containing the selected repo', async () => {
    const container = await renderAndWait();
    try {
        const repoSelect = container.querySelector('select.project-filter-repo');
        assert.ok(repoSelect, 'Repository filter select must exist');

        // Filter to repo-b → should show Beta and Zeta (both contain repo-b)
        await setSelectAndWait(repoSelect, 'repo-b');

        const names = getCardNames(container);
        assert.ok(names.includes('Beta Project'), `"Beta Project" should be visible; got: ${JSON.stringify(names)}`);
        assert.ok(names.includes('Zeta Search'),  `"Zeta Search" should be visible; got: ${JSON.stringify(names)}`);
        assert.ok(!names.includes('Alpha Project'), `"Alpha Project" should be hidden; got: ${JSON.stringify(names)}`);
    } finally {
        cleanup();
    }
});

test('AC2 — repository filter to repo-a shows only projects with repo-a', async () => {
    const container = await renderAndWait();
    try {
        const repoSelect = container.querySelector('select.project-filter-repo');
        await setSelectAndWait(repoSelect, 'repo-a');

        const names = getCardNames(container);
        assert.ok(names.includes('Alpha Project'), `"Alpha Project" should be visible`);
        assert.ok(names.includes('Beta Project'),  `"Beta Project" should be visible`);
        assert.ok(!names.includes('Zeta Search'),  `"Zeta Search" should be hidden`);
    } finally {
        cleanup();
    }
});

test('AC3 — alphabetical sort orders projects A→Z case-insensitively', async () => {
    const container = await renderAndWait();
    try {
        const sortSelect = container.querySelector('select.project-filter-sort');
        assert.ok(sortSelect, 'Sort select must exist');

        await setSelectAndWait(sortSelect, 'alpha');

        const names = getCardNames(container);
        assert.deepEqual(
            names,
            ['Alpha Project', 'Beta Project', 'Zeta Search'],
            `Expected alphabetical order; got: ${JSON.stringify(names)}`,
        );
    } finally {
        cleanup();
    }
});

test('AC3 — last-activity sort orders by descending timestamp; null sorts last', async () => {
    const container = await renderAndWait();
    try {
        const sortSelect = container.querySelector('select.project-filter-sort');
        await setSelectAndWait(sortSelect, 'activity');

        const names = getCardNames(container);
        // Alpha: 2024-03-01 (newest) → first
        // Beta:  2024-01-15          → second
        // Zeta:  null                → last
        assert.deepEqual(
            names,
            ['Alpha Project', 'Beta Project', 'Zeta Search'],
            `Expected activity order; got: ${JSON.stringify(names)}`,
        );
    } finally {
        cleanup();
    }
});

test('AC3 — last-activity sort tiebreaker is name ascending when timestamps are equal', async () => {
    // Temporarily override api.projects.get to return equal timestamps for all.
    const origGet = api.projects.get;
    api.projects.get = async (id) => ({
        ...{ alpha: PROJECT_ALPHA, beta: PROJECT_BETA, zeta: PROJECT_ZETA }[id],
        LastActivity: '2024-06-01T00:00:00Z',
    });

    const container = await renderAndWait();
    try {
        const sortSelect = container.querySelector('select.project-filter-sort');
        await setSelectAndWait(sortSelect, 'activity');

        const names = getCardNames(container);
        assert.deepEqual(
            names,
            ['Alpha Project', 'Beta Project', 'Zeta Search'],
            `Expected name tiebreaker order; got: ${JSON.stringify(names)}`,
        );
    } finally {
        api.projects.get = origGet;
        cleanup();
    }
});

test('AC4 — clearing search restores full list', async () => {
    const container = await renderAndWait();
    try {
        const searchInput = container.querySelector('input.project-filter-search');

        // Apply a filter first.
        await setSearchAndWait(searchInput, 'alpha');
        assert.equal(getCardNames(container).length, 1, 'Should show 1 card after filtering');

        // Clear the filter.
        await setSearchAndWait(searchInput, '');
        const names = getCardNames(container);
        assert.equal(names.length, 3, `All 3 projects should be visible after clearing; got: ${JSON.stringify(names)}`);
    } finally {
        cleanup();
    }
});

test('AC4 — resetting repo filter to "All repositories" restores full list', async () => {
    const container = await renderAndWait();
    try {
        const repoSelect = container.querySelector('select.project-filter-repo');

        await setSelectAndWait(repoSelect, 'repo-a');
        assert.equal(getCardNames(container).length, 2, 'Should show 2 cards for repo-a');

        await setSelectAndWait(repoSelect, '');
        assert.equal(getCardNames(container).length, 3, 'All 3 projects should be restored');
    } finally {
        cleanup();
    }
});

test('AC5 — "No projects match the current filters." shown when no results', async () => {
    const container = await renderAndWait();
    try {
        const searchInput = container.querySelector('input.project-filter-search');

        await setSearchAndWait(searchInput, 'zzznomatch999');

        const empty = container.querySelector('.empty-state');
        assert.ok(empty, 'Empty state element must exist');
        assert.strictEqual(
            empty.textContent,
            'No projects match the current filters.',
            `Unexpected empty state message: "${empty.textContent}"`,
        );
    } finally {
        cleanup();
    }
});

test('AC5 — empty-state message absent when projects are visible', async () => {
    const container = await renderAndWait();
    try {
        const empty = container.querySelector('.empty-state');
        assert.strictEqual(empty, null, 'No empty-state element should be present when projects exist');
    } finally {
        cleanup();
    }
});

test('AC6 — after create, data is re-fetched and filter state is preserved', async () => {
    // Simulate: user filters to "alpha", creates a new project "alpha-2",
    // which appears in the list returned by the re-fetch.
    const PROJECT_ALPHA2 = {
        Id: 'alpha-2',
        Name: 'Alpha Two',
        Description: 'Another alpha project',
        Repositories: [],
        LastActivity: null,
    };

    const origList = api.projects.list;
    const origGet  = api.projects.get;

    // First call: original 3 projects.
    let callCount = 0;
    api.projects.list = async () => {
        callCount++;
        if (callCount === 1) return _projectListResponse;
        // Second call (after create): includes the new project.
        return [..._projectListResponse, PROJECT_ALPHA2];
    };
    api.projects.get = async (id) => {
        const map = {
            alpha: PROJECT_ALPHA,
            beta: PROJECT_BETA,
            zeta: PROJECT_ZETA,
            'alpha-2': PROJECT_ALPHA2,
        };
        return map[id] ?? { Id: id, Name: id };
    };
    api.projects.create = async () => PROJECT_ALPHA2;

    const container = await renderAndWait();
    try {
        // Apply a search filter first.
        const searchInput = container.querySelector('input.project-filter-search');
        await setSearchAndWait(searchInput, 'alpha');

        let names = getCardNames(container);
        assert.deepEqual(names, ['Alpha Project'], 'Only Alpha Project should be visible before create');

        // Trigger the create-project success callback by simulating the form.
        // The onSuccess callback is wired internally; we trigger it by
        // submitting the create form.
        const toggleBtn = container.querySelector('.create-project-section .btn-primary');
        assert.ok(toggleBtn, 'Toggle button must exist');
        toggleBtn.click();

        const form = container.querySelector('form.create-project-form');
        assert.ok(form, 'Create project form must exist');

        const nameInput = form.querySelector('[name="name"]');
        nameInput.value = 'Alpha Two';

        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        // Wait for the async create + re-fetch to settle.
        await new Promise((resolve) => setTimeout(resolve, 100));

        // After re-fetch the search "alpha" should now match both Alpha Project and Alpha Two.
        names = getCardNames(container);
        assert.ok(names.includes('Alpha Project'), '"Alpha Project" should still be visible');
        assert.ok(names.includes('Alpha Two'), '"Alpha Two" should appear after re-fetch');
        assert.ok(!names.includes('Beta Project'), '"Beta Project" should still be hidden by filter');
        assert.ok(!names.includes('Zeta Search'), '"Zeta Search" should still be hidden by filter');
    } finally {
        api.projects.list   = origList;
        api.projects.get    = origGet;
        api.projects.create = async () => ({});
        cleanup();
    }
});

test('AC7 — source does not use innerHTML = \'\' for container clearing', async () => {
    // Structural check: read the source file and verify there is no
    // `innerHTML = ''` or `innerHTML=""` pattern used in the module.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname  = dirname(__filename);
    const src = readFileSync(join(__dirname, 'dashboard.js'), 'utf8');

    // Allow innerHTML for the loading skeleton (pre-existing showLoading helper)
    // but assert there is no `innerHTML = ''` used for container clearing.
    const hasInnerHTMLClear = /innerHTML\s*=\s*['"]{2}/.test(src);
    assert.strictEqual(
        hasInnerHTMLClear,
        false,
        'dashboard.js must not use innerHTML = \'\' for container clearing — use clearElement() instead',
    );
});
