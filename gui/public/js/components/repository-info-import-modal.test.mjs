/**
 * Unit tests for components/repository-info-import-modal.js — WP-012.
 *
 * Acceptance Criteria verified (see WP-012 and the plan's step 15/AC-02b,
 * AC-10, AC-17, AC-17d):
 *   AC1 — Only differing fields are shown; `Url` is never rendered even when
 *         the preview's `fields` array (defensively) carries it.
 *   AC2 — Default radio choice is "import" for state `incoming` and "keep"
 *         for state `conflict`.
 *   AC3 — Apply sends only the selected (import-checked) fields to
 *         `applyImport()`; an empty selection is allowed and sent as `[]`.
 *   AC4 — Each field row is a `<fieldset>` with a `<legend>` naming the
 *         field; empty current/incoming values render "(empty)".
 *   AC5 — The modal opens no second overlay (a single `.modal-overlay` at a
 *         time).
 *   AC6 — Cancel/Escape/backdrop-click resolve with `{ applied: false }`
 *         without calling `applyImport()`.
 *   AC7 — While `applyImport()` is in flight, Apply/Cancel are disabled; a
 *         rejected call re-enables both and shows the error inline in a
 *         `role="alert"` region, keeping the modal open.
 *   AC8 — Initial focus is the first field's currently-selected radio; on
 *         close, focus returns to the element that opened the modal.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/components/repository-info-import-modal.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup — install globals before any module is imported
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
});

const { window } = dom;

globalThis.document      = window.document;
globalThis.window        = window;
globalThis.HTMLElement   = window.HTMLElement;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.MouseEvent    = window.MouseEvent;

globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => ({}),
});

const { api } = await import('../api.js');
const { showRepositoryInfoImportModal } = await import('./repository-info-import-modal.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INCOMING_PREVIEW = {
    state: 'incoming',
    fields: [
        { field: 'Name', current: 'Old Name', incoming: 'New Name' },
        { field: 'Description', current: '', incoming: 'New description' },
    ],
};

const CONFLICT_PREVIEW_WITH_URL = {
    state: 'conflict',
    fields: [
        { field: 'Name', current: 'Local Name', incoming: 'Remote Name' },
        { field: 'Url', current: 'https://local.example/repo.git', incoming: 'https://remote.example/repo.git' },
    ],
};

/** A promise that never settles, standing in for an in-flight API call. */
function pending() {
    return new Promise(() => {});
}

let applyImportCalls;

beforeEach(() => {
    document.body.innerHTML = '<button id="outside-btn" type="button">Outside</button>';
    applyImportCalls = [];

    api.repositories.infoSync.applyImport = async (id, fields) => {
        applyImportCalls.push({ id, fields });
        return {};
    };
});

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function dispatchKeydown(target, key) {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
}

function dispatchClick(target) {
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
}

function getFieldsets() {
    return Array.from(document.querySelectorAll('.modal fieldset'));
}

function getApplyBtn() {
    return Array.from(document.querySelectorAll('.modal-actions button'))
        .find((btn) => btn.textContent === 'Apply');
}

function getCancelBtn() {
    return Array.from(document.querySelectorAll('.modal-actions button'))
        .find((btn) => btn.textContent === 'Cancel');
}

function getOverlays() {
    return document.querySelectorAll('.modal-overlay');
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// AC1/AC2 — Rendering and defaults
// ---------------------------------------------------------------------------

test('AC1: only differing fields render, and Url is never shown even if present in the preview', async () => {
    const promise = showRepositoryInfoImportModal({
        repoId: 'repo-1',
        repoName: 'Repo One',
        preview: CONFLICT_PREVIEW_WITH_URL,
    });

    const fieldsets = getFieldsets();
    assert.equal(fieldsets.length, 1);
    assert.equal(fieldsets[0].querySelector('legend').textContent, 'Name');
    assert.equal(getOverlays().length, 1);

    dispatchClick(getCancelBtn());
    await promise;
});

test('AC2: default choice is "import" for state incoming', async () => {
    const promise = showRepositoryInfoImportModal({
        repoId: 'repo-1',
        preview: INCOMING_PREVIEW,
    });

    const fieldsets = getFieldsets();
    fieldsets.forEach((fs) => {
        const importRadio = fs.querySelector('input[value="import"]');
        assert.equal(importRadio.checked, true);
    });

    dispatchClick(getCancelBtn());
    await promise;
});

test('AC2: default choice is "keep" for state conflict', async () => {
    const promise = showRepositoryInfoImportModal({
        repoId: 'repo-1',
        preview: CONFLICT_PREVIEW_WITH_URL,
    });

    const fieldsets = getFieldsets();
    const keepRadio = fieldsets[0].querySelector('input[value="keep"]');
    assert.equal(keepRadio.checked, true);

    dispatchClick(getCancelBtn());
    await promise;
});

test('AC4: empty current/incoming values render "(empty)"', async () => {
    const promise = showRepositoryInfoImportModal({
        repoId: 'repo-1',
        preview: INCOMING_PREVIEW,
    });

    const descriptionFieldset = getFieldsets().find((fs) => fs.querySelector('legend').textContent === 'Description');
    const texts = Array.from(descriptionFieldset.querySelectorAll('.info-import-value__text')).map((el) => el.textContent);
    assert.deepEqual(texts, ['(empty)', 'New description']);

    dispatchClick(getCancelBtn());
    await promise;
});

// ---------------------------------------------------------------------------
// AC3 — Apply field selection
// ---------------------------------------------------------------------------

test('AC3: Apply sends only the selected (import-checked) fields', async () => {
    const promise = showRepositoryInfoImportModal({
        repoId: 'repo-1',
        preview: INCOMING_PREVIEW,
    });

    // Both default to "import" under state=incoming; flip Name back to "keep".
    const nameFieldset = getFieldsets().find((fs) => fs.querySelector('legend').textContent === 'Name');
    dispatchClick(nameFieldset.querySelector('input[value="keep"]'));

    dispatchClick(getApplyBtn());
    const result = await promise;

    assert.equal(applyImportCalls.length, 1);
    assert.deepEqual(applyImportCalls[0], { id: 'repo-1', fields: ['Description'] });
    assert.deepEqual(result, { applied: true });
});

test('AC3: an empty selection is allowed and sent as an empty array', async () => {
    const promise = showRepositoryInfoImportModal({
        repoId: 'repo-1',
        preview: CONFLICT_PREVIEW_WITH_URL,
    });

    // State=conflict defaults every field to "keep" already.
    dispatchClick(getApplyBtn());
    await promise;

    assert.equal(applyImportCalls.length, 1);
    assert.deepEqual(applyImportCalls[0], { id: 'repo-1', fields: [] });
});

// ---------------------------------------------------------------------------
// AC6 — Cancel / Escape / backdrop dismissal
// ---------------------------------------------------------------------------

test('AC6: Cancel resolves with { applied: false } and does not call applyImport()', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: INCOMING_PREVIEW });

    dispatchClick(getCancelBtn());
    const result = await promise;

    assert.deepEqual(result, { applied: false });
    assert.equal(applyImportCalls.length, 0);
});

test('AC6: Escape resolves with { applied: false }', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: INCOMING_PREVIEW });

    dispatchKeydown(document, 'Escape');
    const result = await promise;

    assert.deepEqual(result, { applied: false });
});

test('AC6: backdrop click resolves with { applied: false }', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: INCOMING_PREVIEW });

    const overlay = document.querySelector('.modal-overlay');
    dispatchClick(overlay);
    const result = await promise;

    assert.deepEqual(result, { applied: false });
});

// ---------------------------------------------------------------------------
// AC7 — Busy state and inline error
// ---------------------------------------------------------------------------

test('AC7: a rejected applyImport() shows an inline role="alert" error and re-enables the buttons', async () => {
    api.repositories.infoSync.applyImport = async () => {
        throw new Error('Server exploded.');
    };

    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: INCOMING_PREVIEW });

    dispatchClick(getApplyBtn());
    await wait(0);

    const errorEl = document.querySelector('[role="alert"].error-message');
    assert.equal(errorEl.hidden, false);
    assert.equal(errorEl.textContent, 'Server exploded.');
    assert.equal(getApplyBtn().disabled, false);
    assert.equal(getCancelBtn().disabled, false);

    dispatchClick(getCancelBtn());
    await promise;
});

test('AC7: Apply/Cancel are disabled while applyImport() is in flight', async () => {
    api.repositories.infoSync.applyImport = pending;

    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: INCOMING_PREVIEW });

    dispatchClick(getApplyBtn());
    await wait(0);

    assert.equal(getApplyBtn().disabled, true);
    assert.equal(getCancelBtn().disabled, true);

    promise.then(() => {});
});

// ---------------------------------------------------------------------------
// AC8 — Focus management
// ---------------------------------------------------------------------------

test('AC8: initial focus is the first field\'s currently-selected radio; focus returns to the opener on close', async () => {
    const opener = document.getElementById('outside-btn');
    opener.focus();

    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: INCOMING_PREVIEW });

    const nameFieldset = getFieldsets()[0];
    const checkedRadio = nameFieldset.querySelector('input:checked');
    assert.equal(document.activeElement, checkedRadio);

    dispatchClick(getCancelBtn());
    await promise;

    assert.equal(document.activeElement, opener);
});
