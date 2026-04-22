/**
 * Unit tests for views/repositories.js — WP-004.
 *
 * Acceptance Criteria verified:
 *   AC1  — Each repository's Name column renders as a clickable <a> element.
 *   AC2  — Clicking a repository name navigates to #/repositories/:id
 *           (where :id is the repository's encoded ID).
 *   AC3  — The inline edit (Edit/Save/Cancel) behaviour on the Name cell
 *           continues to work correctly after the span→link refactor.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/views/repositories.test.mjs
 */

import { test, beforeEach } from 'node:test';
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

const REPO_ID        = 'my-repo';
const REPO_NAME      = 'My Repository';
const REPO_URL       = 'https://github.com/org/my-repo.git';
const REPO_ID_SPECIAL = 'org/repo with spaces';

// ---------------------------------------------------------------------------
// Import API and set up mocks
// ---------------------------------------------------------------------------

const { api } = await import('../api.js');

/** Tracks calls made to api.repositories.update. */
const updateCalls = [];

api.repositories.list = async () => [
    { Id: REPO_ID, Name: REPO_NAME, Url: REPO_URL },
];
api.repositories.update = async (id, data) => {
    updateCalls.push({ id, data });
    return {};
};
api.repositories.delete = async () => ({});
api.repositories.create = async () => ({});

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { renderRepositories } = await import('./repositories.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render the Repositories view into a fresh container and wait for async
 * bootstrap (API fetch + DOM construction).
 *
 * @returns {Promise<HTMLElement>} The outermost `#app` container element (a
 *   `<div id="app">` appended to `document.body`).  The repositories table and
 *   all row DOM nodes are nested inside this container, so callers must query
 *   from the returned element (e.g. `container.querySelector('table')`) rather
 *   than from `document` to avoid cross-test interference.
 */
async function renderAndWait() {
    const container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);

    await renderRepositories(container, {});

    // Flush any remaining micro-tasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    return container;
}

/**
 * Remove all rendered containers after each test.
 */
function cleanupContainers() {
    document.body.querySelectorAll('#app').forEach((el) => el.remove());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('AC1 — Name column renders as a clickable <a> element', async () => {
    const container = await renderAndWait();
    try {
        const table = container.querySelector('table.repositories-table');
        assert.ok(table, 'Repositories table should exist');

        const tbody = table.querySelector('tbody');
        assert.ok(tbody, 'tbody should exist');

        const rows = tbody.querySelectorAll('tr');
        assert.ok(rows.length > 0, 'Should have at least one repository row');

        const nameCell = rows[0].querySelector('td.repo-name-cell');
        assert.ok(nameCell, 'Name cell should exist');

        const nameLink = nameCell.querySelector('a.repo-name-display');
        assert.ok(nameLink, 'Name cell should contain an <a> element with class repo-name-display');
        assert.strictEqual(nameLink.tagName, 'A', 'Name display element should be an <a> tag');
        assert.strictEqual(nameLink.textContent, REPO_NAME);
    } finally {
        cleanupContainers();
    }
});

test('AC2 — Name link href points to #/repositories/:id (encoded)', async () => {
    const container = await renderAndWait();
    try {
        const nameLink = container.querySelector('td.repo-name-cell a.repo-name-display');
        assert.ok(nameLink, '<a> element should exist in the Name cell');

        const expectedSuffix = `#/repositories/${encodeURIComponent(REPO_ID)}`;
        assert.ok(
            nameLink.href.endsWith(expectedSuffix),
            `Name link href should end with "${expectedSuffix}", got: "${nameLink.href}"`,
        );
    } finally {
        cleanupContainers();
    }
});

test('AC2 — Name link href encodes special characters in repo ID', async () => {
    // Override list to return a repo with a special-character ID.
    const origList = api.repositories.list;
    api.repositories.list = async () => [
        { Id: REPO_ID_SPECIAL, Name: 'Special Repo', Url: REPO_URL },
    ];

    const container = await renderAndWait();
    try {
        const nameLink = container.querySelector('td.repo-name-cell a.repo-name-display');
        assert.ok(nameLink, '<a> element should exist for the special-ID repo');

        const expectedSuffix = `#/repositories/${encodeURIComponent(REPO_ID_SPECIAL)}`;
        assert.ok(
            nameLink.href.endsWith(expectedSuffix),
            `Name link href should end with "${expectedSuffix}", got: "${nameLink.href}"`,
        );
    } finally {
        api.repositories.list = origList;
        cleanupContainers();
    }
});

test('AC3 — Entering edit mode hides the name link and shows the input', async () => {
    const container = await renderAndWait();
    try {
        const nameCell  = container.querySelector('td.repo-name-cell');
        const nameLink  = nameCell.querySelector('a.repo-name-display');
        const nameInput = nameCell.querySelector('input.repo-name-input');
        const editBtn   = container.querySelector('td.repo-actions-cell .btn-secondary');

        assert.ok(nameLink,  'Name link should exist before edit');
        assert.ok(nameInput, 'Name input should exist before edit');
        assert.ok(editBtn,   'Edit button should exist');

        // Initially: link visible, input hidden.
        assert.strictEqual(nameLink.hidden,  false, 'Name link should be visible initially');
        assert.strictEqual(nameInput.hidden, true,  'Name input should be hidden initially');

        // Click Edit.
        editBtn.click();

        assert.strictEqual(nameLink.hidden,  true,  'Name link should be hidden in edit mode');
        assert.strictEqual(nameInput.hidden, false, 'Name input should be visible in edit mode');
    } finally {
        cleanupContainers();
    }
});

test('AC3 — Cancelling edit restores the name link', async () => {
    const container = await renderAndWait();
    try {
        const nameCell     = container.querySelector('td.repo-name-cell');
        const nameLink     = nameCell.querySelector('a.repo-name-display');
        const nameInput    = nameCell.querySelector('input.repo-name-input');
        const actionsCell  = container.querySelector('td.repo-actions-cell');
        const editBtn      = actionsCell.querySelector('.btn-secondary');

        // Enter edit mode.
        editBtn.click();
        assert.strictEqual(nameLink.hidden,  true);
        assert.strictEqual(nameInput.hidden, false);

        // Click the Cancel button (the second .btn-secondary, now visible).
        const cancelBtn = [...actionsCell.querySelectorAll('button')].find(
            (btn) => btn.textContent === 'Cancel' && !btn.hidden,
        );
        assert.ok(cancelBtn, 'Cancel button should be visible in edit mode');
        cancelBtn.click();

        assert.strictEqual(nameLink.hidden,  false, 'Name link should be restored after cancel');
        assert.strictEqual(nameInput.hidden, true,  'Name input should be hidden after cancel');
    } finally {
        cleanupContainers();
    }
});

test('AC3 — Saving updates the name link text', async () => {
    const container = await renderAndWait();
    try {
        const nameCell    = container.querySelector('td.repo-name-cell');
        const nameLink    = nameCell.querySelector('a.repo-name-display');
        const nameInput   = nameCell.querySelector('input.repo-name-input');
        const actionsCell = container.querySelector('td.repo-actions-cell');
        const editBtn     = actionsCell.querySelector('.btn-secondary');

        // Enter edit mode.
        editBtn.click();

        // Change the value.
        nameInput.value = 'Updated Name';

        // Click Save.
        const saveBtn = [...actionsCell.querySelectorAll('button')].find(
            (btn) => btn.textContent === 'Save' && !btn.hidden,
        );
        assert.ok(saveBtn, 'Save button should be visible in edit mode');
        saveBtn.click();

        // Flush micro-tasks for async save handler.
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.strictEqual(nameLink.textContent, 'Updated Name', 'Name link text should update after save');
        assert.strictEqual(nameLink.hidden,  false, 'Name link should be visible after save');
        assert.strictEqual(nameInput.hidden, true,  'Name input should be hidden after save');
    } finally {
        cleanupContainers();
    }
});
