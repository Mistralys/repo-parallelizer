/**
 * Unit tests for views/error-log.js — WP-006.
 *
 * Acceptance Criteria verified:
 *   AC1  — SEVERITY_OPTIONS includes { value: 'audit', label: 'Audit' }.
 *   AC2  — SEVERITY_OPTIONS includes { value: 'info', label: 'Info' }.
 *   AC3  — The severity filter dropdown rendered by renderErrorLog contains
 *           an "Audit" option and an "Info" option.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/views/error-log.test.mjs
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
    json: async () => ({ entries: [], total: 0, sources: [] }),
});

// ---------------------------------------------------------------------------
// Import API and set up mocks
// ---------------------------------------------------------------------------

const { api } = await import('../api.js');

api.errorLog = {
    list:    async () => ({ entries: [], total: 0 }),
    sources: async () => ({ sources: [] }),
    clear:   async () => ({}),
};

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { renderErrorLog } = await import('./error-log.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render the Error Log view into a fresh container and wait for async
 * bootstrap (API fetch + DOM construction).
 *
 * @returns {Promise<HTMLElement>} The outermost container element.
 */
async function renderAndWait() {
    const container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);

    await renderErrorLog(container, {});

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

test('AC1 — severity filter dropdown contains an "Audit" option', async () => {
    const container = await renderAndWait();
    try {
        const select = container.querySelector('#error-log-severity-filter');
        assert.ok(select, 'Severity filter <select> should exist');

        const options = Array.from(select.querySelectorAll('option'));
        const auditOption = options.find((o) => o.value === 'audit');
        assert.ok(auditOption, 'Severity dropdown should have an option with value "audit"');
        assert.strictEqual(auditOption.textContent, 'Audit');
    } finally {
        cleanupContainers();
    }
});

test('AC2 — severity filter dropdown contains an "Info" option', async () => {
    const container = await renderAndWait();
    try {
        const select = container.querySelector('#error-log-severity-filter');
        assert.ok(select, 'Severity filter <select> should exist');

        const options = Array.from(select.querySelectorAll('option'));
        const infoOption = options.find((o) => o.value === 'info');
        assert.ok(infoOption, 'Severity dropdown should have an option with value "info"');
        assert.strictEqual(infoOption.textContent, 'Info');
    } finally {
        cleanupContainers();
    }
});

test('AC3 — severity filter dropdown retains existing "Error" and "Warning" options', async () => {
    const container = await renderAndWait();
    try {
        const select = container.querySelector('#error-log-severity-filter');
        assert.ok(select, 'Severity filter <select> should exist');

        const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
        assert.ok(values.includes('error'),   'Dropdown should still include "error"');
        assert.ok(values.includes('warning'), 'Dropdown should still include "warning"');
        assert.ok(values.includes('all'),     'Dropdown should still include "all"');
    } finally {
        cleanupContainers();
    }
});
