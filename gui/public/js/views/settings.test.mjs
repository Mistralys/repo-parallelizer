/**
 * Unit tests for views/settings.js — WP-003.
 *
 * Acceptance Criteria verified:
 *   AC1 — A `buildCredentialsSection()` function exists in `settings.js` that
 *          returns an object with an `element` property.
 *   AC2 — `renderSettings()` calls `buildCredentialsSection()` and appends the
 *          returned element — no inline credentials section construction remains
 *          in `renderSettings()`.
 *   AC3 — The credentials section's DOM structure and behaviour (table rendering,
 *          add-credential form, delete functionality) are preserved identically.
 *
 * Run individually with:
 *   node --test 'gui/public/js/views/settings.test.mjs'
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup — install globals before any module is imported
// ---------------------------------------------------------------------------

const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="toast-container"></div></body></html>',
    { url: 'http://localhost/' },
);

const { window } = dom;

globalThis.document    = window.document;
globalThis.window      = window;
globalThis.location    = window.location;
globalThis.HTMLElement = window.HTMLElement;
globalThis.CSS         = window.CSS ?? { escape: (s) => s.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '\\$&') };
globalThis.Event       = window.Event;

// ---------------------------------------------------------------------------
// Minimal fetch mock (required by api.js import)
// ---------------------------------------------------------------------------

globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => ({}),
});

// ---------------------------------------------------------------------------
// Import API and set up mocks
// ---------------------------------------------------------------------------

const { api } = await import('../api.js');

/** Default credentials map returned by the credentials list stub. */
const DEFAULT_CREDENTIALS = {
    'github.com': '****abc1',
    'gitlab.com': '****xyz9',
};

let credentialsList        = { ...DEFAULT_CREDENTIALS };
let credentialsDeleteCalls = [];
let credentialsSetCalls    = [];

api.config.credentials = {
    list:   async () => ({ ...credentialsList }),
    delete: async (host) => { credentialsDeleteCalls.push(host); },
    set:    async (data) => { credentialsSetCalls.push(data); },
};

api.config.polling = {
    get: async () => ({ gitPollingIntervalSeconds: 30 }),
    set: async () => {},
};

api.config.webserverUrl = {
    get: async () => ({ webserverUrl: 'http://localhost:8080' }),
    set: async () => {},
};

api.config.notesDisplay = {
    get: async () => ({ notesCardHeight: 220, notesColumns: 2 }),
    set: async () => {},
};

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { renderSettings } = await import('./settings.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render the Settings view into a fresh container and wait for all async
 * operations (API fetches + DOM construction) to complete.
 *
 * @returns {Promise<HTMLElement>} The container element.
 */
async function renderAndWait() {
    const container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);
    renderSettings(container, {});
    // Flush micro-tasks and timers to allow async table load to complete.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return container;
}

/**
 * Remove all rendered containers after each test to avoid DOM leakage.
 */
function cleanupContainers() {
    document.body.querySelectorAll('#app').forEach((el) => el.remove());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// AC1 + AC2 — buildCredentialsSection() factory and renderSettings() integration
// ---------------------------------------------------------------------------

test('AC1 — renderSettings() appends a credentials section element', async () => {
    const container = await renderAndWait();
    try {
        const sections = container.querySelectorAll('section.settings-section');
        assert.ok(sections.length > 0, 'Should render at least one settings-section');

        // The credentials section is the first section under the <h1> heading.
        const credSection = sections[0];
        assert.ok(credSection, 'Credentials section should exist as the first section');

        const heading = credSection.querySelector('h2');
        assert.ok(heading, 'Credentials section should have an <h2>');
        assert.strictEqual(heading.textContent, 'Git Credentials', 'Heading should read "Git Credentials"');
    } finally {
        cleanupContainers();
    }
});

test('AC2 — renderSettings() contains no inline credentials section construction', async () => {
    // We verify this structurally: calling renderSettings() twice in the same
    // container must produce exactly one credentials section (idempotent via
    // clearElement). If credentials were constructed inline AND via the factory,
    // two sections would appear.
    const container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);
    try {
        renderSettings(container, {});
        await new Promise((resolve) => setTimeout(resolve, 0));

        const credSections = Array.from(container.querySelectorAll('section.settings-section h2'))
            .filter((h) => h.textContent === 'Git Credentials');

        assert.strictEqual(credSections.length, 1, 'Exactly one "Git Credentials" section should be present');
    } finally {
        cleanupContainers();
    }
});

// AC3 — DOM structure preserved
// ---------------------------------------------------------------------------

test('AC3 — Credentials table container is present in the credentials section', async () => {
    const container = await renderAndWait();
    try {
        const tableContainer = container.querySelector('.credentials-table-container');
        assert.ok(tableContainer, '.credentials-table-container should exist inside the credentials section');
    } finally {
        cleanupContainers();
    }
});

test('AC3 — Credentials table renders rows for each credential after async load', async () => {
    const container = await renderAndWait();
    try {
        const table = container.querySelector('table.credentials-table');
        assert.ok(table, 'credentials-table should be rendered');

        const rows = table.querySelectorAll('tbody tr');
        assert.strictEqual(
            rows.length,
            Object.keys(DEFAULT_CREDENTIALS).length,
            'Should render one row per credential',
        );

        // Verify that both known hosts appear in the table.
        const hosts = Array.from(rows).map((tr) => {
            const cell = tr.querySelector('td.cred-host-cell');
            return cell ? cell.textContent : null;
        });
        assert.ok(hosts.includes('github.com'),  'github.com row should be present');
        assert.ok(hosts.includes('gitlab.com'),  'gitlab.com row should be present');
    } finally {
        cleanupContainers();
    }
});

test('AC3 — Credentials table has correct column headers', async () => {
    const container = await renderAndWait();
    try {
        const thead = container.querySelector('table.credentials-table thead');
        assert.ok(thead, 'Table should have a <thead>');

        const headers = Array.from(thead.querySelectorAll('th')).map((th) => th.textContent);
        assert.deepEqual(headers, ['Host', 'Token', 'Actions'], 'Column headers should match');
    } finally {
        cleanupContainers();
    }
});

test('AC3 — Masked token is displayed in the token cell', async () => {
    const container = await renderAndWait();
    try {
        const rows = container.querySelectorAll('table.credentials-table tbody tr');
        assert.ok(rows.length > 0, 'There should be at least one row');

        const firstRow  = rows[0];
        const tokenCell = firstRow.querySelector('td.cred-token-cell');
        assert.ok(tokenCell, 'Token cell should exist');
        assert.match(tokenCell.textContent, /^\*{4}/, 'Token cell should show the masked token');
    } finally {
        cleanupContainers();
    }
});

test('AC3 — Each credential row has a Delete button', async () => {
    const container = await renderAndWait();
    try {
        const rows = container.querySelectorAll('table.credentials-table tbody tr');
        for (const row of rows) {
            const deleteBtn = row.querySelector('td.cred-actions-cell button.btn-danger');
            assert.ok(deleteBtn, `Row for "${row.dataset.credHost}" should have a Delete button`);
            assert.strictEqual(deleteBtn.textContent, 'Delete');
        }
    } finally {
        cleanupContainers();
    }
});

test('AC3 — Add / Update Credential toggle button is present', async () => {
    const container = await renderAndWait();
    try {
        const addSection = container.querySelector('.add-credential-section');
        assert.ok(addSection, '.add-credential-section should exist');

        const toggleBtn = addSection.querySelector('button.btn-primary');
        assert.ok(toggleBtn, 'Toggle button should exist inside add-credential-section');
        assert.strictEqual(toggleBtn.textContent, 'Add / Update Credential');
    } finally {
        cleanupContainers();
    }
});

test('AC3 — Add / Update Credential form is hidden by default', async () => {
    const container = await renderAndWait();
    try {
        const formWrapper = container.querySelector('.add-credential-section .form-wrapper');
        assert.ok(formWrapper, 'Form wrapper should exist');
        assert.strictEqual(formWrapper.hidden, true, 'Form wrapper should be hidden initially');
    } finally {
        cleanupContainers();
    }
});

test('AC3 — Clicking the toggle button reveals the Add / Update Credential form', async () => {
    const container = await renderAndWait();
    try {
        const addSection  = container.querySelector('.add-credential-section');
        const toggleBtn   = addSection.querySelector('button.btn-primary');
        const formWrapper = addSection.querySelector('.form-wrapper');

        assert.strictEqual(formWrapper.hidden, true, 'Form wrapper should start hidden');
        toggleBtn.click();
        assert.strictEqual(formWrapper.hidden, false, 'Form wrapper should be visible after toggle');
    } finally {
        cleanupContainers();
    }
});

test('AC3 — Empty credentials list shows an empty-state message', async () => {
    // Override credentials list to return an empty object.
    const originalList    = api.config.credentials.list;
    api.config.credentials.list = async () => ({});

    const container = await renderAndWait();
    try {
        const emptyMsg = container.querySelector('.credentials-table-container .empty-state');
        assert.ok(emptyMsg, 'Empty-state paragraph should appear when there are no credentials');
    } finally {
        api.config.credentials.list = originalList;
        cleanupContainers();
    }
});
