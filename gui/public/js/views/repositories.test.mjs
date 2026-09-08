/**
 * Unit tests for views/repositories.js — WP-004, WP-008.
 *
 * Acceptance Criteria verified:
 *   AC1  — Each repository's Name column renders as a clickable <a> element.
 *   AC2  — Clicking a repository name navigates to #/repositories/:id
 *           (where :id is the repository's encoded ID).
 *   AC3  — The Edit button opens the repository modal (showRepositoryModal)
 *           in edit mode, pre-filled with the row's data and a disabled ID
 *           field; Cancel makes no update call; a successful Save calls
 *           api.repositories.update({name, url}) and re-renders the table.
 *   AC-Add — The "+ Add Repository" button opens the repository modal in
 *           create mode; a successful create re-renders the table.
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

/** Tracks calls made to api.repositories.create. */
const createCalls = [];

api.repositories.list = async () => [
    { Id: REPO_ID, Name: REPO_NAME, Url: REPO_URL },
];
api.repositories.update = async (id, data) => {
    updateCalls.push({ id, data });
    return { Id: id, Name: data.name, Url: data.url };
};
api.repositories.delete = async () => ({});
api.repositories.create = async (data) => {
    createCalls.push(data);
    return { Id: 'new-repo', Name: data.name || '', Url: data.url };
};
api.repositories.credentialOptionsForUrl = async () => [];
api.repositories.updateCredential = async (id, credentialId) => ({ Id: id, CredentialId: credentialId || undefined });

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

test('AC3 — Edit button opens the repository modal pre-filled with the row\'s data, ID field disabled', async () => {
    const container = await renderAndWait();
    try {
        const editBtn = container.querySelector('td.repo-actions-cell .btn-secondary');
        assert.ok(editBtn, 'Edit button should exist');

        editBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const modal = document.querySelector('.modal--form');
        assert.ok(modal, 'Repository modal should be open');

        const urlInput  = modal.querySelector('[name="url"]');
        const nameInput = modal.querySelector('[name="name"]');
        const idInput   = modal.querySelector('[name="id"]');

        assert.equal(urlInput.value, REPO_URL);
        assert.equal(nameInput.value, REPO_NAME);
        assert.equal(idInput.value, REPO_ID);
        assert.equal(idInput.disabled, true, 'ID field should be disabled in edit mode');

        const cancelBtn = [...modal.querySelectorAll('.modal-actions button')].find((b) => b.textContent === 'Cancel');
        cancelBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
        cleanupContainers();
    }
});

test('AC3 — Cancelling the edit modal makes no api.repositories.update call, and the table is left unchanged', async () => {
    updateCalls.length = 0;
    const container = await renderAndWait();
    try {
        const editBtn = container.querySelector('td.repo-actions-cell .btn-secondary');
        editBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const modal = document.querySelector('.modal--form');
        assert.ok(modal, 'Repository modal should be open');

        const cancelBtn = [...modal.querySelectorAll('.modal-actions button')].find((b) => b.textContent === 'Cancel');
        cancelBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(updateCalls.length, 0, 'Cancel should not call api.repositories.update');
        assert.equal(document.querySelector('.modal--form'), null, 'modal should be closed after Cancel');

        const nameLink = container.querySelector('td.repo-name-cell a.repo-name-display');
        assert.equal(nameLink.textContent, REPO_NAME, 'table row should be left unchanged');
    } finally {
        cleanupContainers();
    }
});

test('AC3 — Saving the edit modal calls api.repositories.update(id, { name, url }) and re-renders the table', async () => {
    updateCalls.length = 0;
    const container = await renderAndWait();
    try {
        const editBtn = container.querySelector('td.repo-actions-cell .btn-secondary');
        editBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const modal = document.querySelector('.modal--form');
        const nameInput = modal.querySelector('[name="name"]');
        nameInput.value = 'Updated Name';

        const submitBtn = [...modal.querySelectorAll('.modal-actions button')].find((b) => b.type === 'submit');
        submitBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(updateCalls.length, 1);
        assert.equal(updateCalls[0].id, REPO_ID);
        assert.deepEqual(updateCalls[0].data, { name: 'Updated Name', url: REPO_URL });

        assert.equal(document.querySelector('.modal--form'), null, 'modal should close after a successful save');

        // Flush the renderRepoTable() re-render triggered by onChanged().
        await new Promise((resolve) => setTimeout(resolve, 0));
        const table = container.querySelector('table.repositories-table');
        assert.ok(table, 'table should still be present after re-render');
    } finally {
        cleanupContainers();
    }
});

// ---------------------------------------------------------------------------
// AC-Add — "+ Add Repository" button (create-mode modal)
// ---------------------------------------------------------------------------

test('AC-Add — clicking "+ Add Repository" opens the repository modal in create mode; a successful create re-renders the table', async () => {
    createCalls.length = 0;
    const container = await renderAndWait();
    try {
        const addBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '+ Add Repository');
        assert.ok(addBtn, '"+ Add Repository" button should exist');

        addBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const modal = document.querySelector('.modal--form');
        assert.ok(modal, 'Repository modal should open in create mode');

        const idInput = modal.querySelector('[name="id"]');
        assert.equal(idInput.disabled, false, 'ID field should be editable in create mode');

        modal.querySelector('[name="url"]').value = 'https://github.com/org/new-repo.git';

        const submitBtn = [...modal.querySelectorAll('.modal-actions button')].find((b) => b.type === 'submit');
        submitBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(createCalls.length, 1);
        assert.equal(createCalls[0].url, 'https://github.com/org/new-repo.git');
        assert.equal(document.querySelector('.modal--form'), null, 'modal should close after a successful create');

        // Flush the renderRepoTable() re-render triggered by onSuccess().
        await new Promise((resolve) => setTimeout(resolve, 0));
        const table = container.querySelector('table.repositories-table');
        assert.ok(table, 'table should still be present after re-render');
    } finally {
        cleanupContainers();
    }
});

test('AC-Add — Cancelling the create modal makes no api.repositories.create call', async () => {
    createCalls.length = 0;
    const container = await renderAndWait();
    try {
        const addBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '+ Add Repository');
        addBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const modal = document.querySelector('.modal--form');
        const cancelBtn = [...modal.querySelectorAll('.modal-actions button')].find((b) => b.textContent === 'Cancel');
        cancelBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(createCalls.length, 0, 'Cancel should not call api.repositories.create');
        assert.equal(document.querySelector('.modal--form'), null, 'modal should be closed after Cancel');
    } finally {
        cleanupContainers();
    }
});

// ---------------------------------------------------------------------------
// Credential status indicator tests
// ---------------------------------------------------------------------------

test('Credential — table header includes a "Credential" column', async () => {
    const container = await renderAndWait();
    try {
        const table = container.querySelector('table.repositories-table');
        assert.ok(table, 'Repositories table should exist');

        const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
        assert.ok(headers.includes('Credential'), 'Table header should include "Credential" column');
    } finally {
        cleanupContainers();
    }
});

test('Credential — row shows no-credential badge when repo has no CredentialId', async () => {
    // Default mock returns a repo without CredentialId.
    const container = await renderAndWait();
    try {
        const credCell = container.querySelector('td.repo-credential-cell');
        assert.ok(credCell, 'Credential cell should exist');

        const badge = credCell.querySelector('.credential-badge');
        assert.ok(badge, 'Credential badge should exist');
        assert.ok(badge.classList.contains('credential-badge--none'), 'Badge should have --none class when no credential');
    } finally {
        cleanupContainers();
    }
});

test('Credential — row shows set-credential badge when repo has a CredentialId', async () => {
    const origList = api.repositories.list;
    api.repositories.list = async () => [
        { Id: REPO_ID, Name: REPO_NAME, Url: REPO_URL, CredentialId: 'cred-abc' },
    ];

    const container = await renderAndWait();
    try {
        const credCell = container.querySelector('td.repo-credential-cell');
        assert.ok(credCell, 'Credential cell should exist');

        const badge = credCell.querySelector('.credential-badge');
        assert.ok(badge, 'Credential badge should exist');
        assert.ok(badge.classList.contains('credential-badge--set'), 'Badge should have --set class when credential is configured');
    } finally {
        api.repositories.list = origList;
        cleanupContainers();
    }
});
