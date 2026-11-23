/**
 * Unit tests for components/repository-info-import-modal.js — WP-012 (fields)
 * and WP-015 (Milestone 2: per-file choices).
 *
 * Acceptance Criteria verified (see WP-012 and the plan's step 15/AC-02b,
 * AC-10, AC-17, AC-17d, plus WP-015's own AC1-4):
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
 *   WP-015 AC1 — The Files table renders every diff kind with the correct
 *                default pre-selection per state; problem rows only offer
 *                their two allowed actions (the destructive one disabled).
 *   WP-015 AC2 — A selection containing `discard` opens the confirmation
 *                dialog listing exactly the affected paths; cancelling sends
 *                no request and preserves the selection; confirming sends it.
 *   WP-015 AC3 — A selection with no `discard` applies without confirmation.
 *   WP-015 AC4 — Payload shape, a rapid double-click sending exactly one
 *                request, and an empty `fields` array with only file diffs.
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

/** One diff of each kind, none with a `problem`. */
const FILE_DIFFS = [
    { path: 'scripts/new.sh', kind: 'incoming-only' },
    { path: 'scripts/removed.sh', kind: 'local-only' },
    { path: 'scripts/changed.sh', kind: 'changed', changes: [{ field: 'Content', local: 'a', incoming: 'b' }] },
];

const INCOMING_PREVIEW_WITH_FILES = {
    state: 'incoming',
    fields: [{ field: 'Name', current: 'Old Name', incoming: 'New Name' }],
    files: FILE_DIFFS,
};

const CONFLICT_PREVIEW_WITH_FILES = {
    state: 'conflict',
    fields: [{ field: 'Name', current: 'Local Name', incoming: 'Remote Name' }],
    files: FILE_DIFFS,
};

const PROBLEM_FILE_DIFFS = [
    { path: 'scripts/binary.sh', kind: 'incoming-only', problem: 'File content is not valid UTF-8 text.' },
    { path: 'scripts/toolarge.sh', kind: 'changed', changes: [{ field: 'Content', local: 'a', incoming: 'b' }], problem: 'File exceeds the maximum allowed size.' },
];

/** A promise that never settles, standing in for an in-flight API call. */
function pending() {
    return new Promise(() => {});
}

let applyImportCalls;

beforeEach(() => {
    document.body.innerHTML = '<button id="outside-btn" type="button">Outside</button>';
    applyImportCalls = [];

    api.repositories.infoSync.applyImport = async (id, selections) => {
        applyImportCalls.push({ id, selections });
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

function getFieldFieldsets() {
    return getFieldsets().filter((fs) => !fs.classList.contains('info-import-file'));
}

function getFileFieldsets() {
    return getFieldsets().filter((fs) => fs.classList.contains('info-import-file'));
}

function getApplyBtn() {
    return Array.from(document.querySelectorAll('.modal-actions button'))
        .find((btn) => btn.textContent === 'Apply');
}

function getCancelBtn() {
    return Array.from(document.querySelectorAll('.modal-actions button'))
        .find((btn) => btn.textContent === 'Cancel');
}

/** The Confirm/Cancel buttons of the (separately-overlaid) confirm-dialog.js modal, if any is open. */
function getConfirmDialogButtons() {
    const overlays = Array.from(document.querySelectorAll('.modal-overlay'));
    // The confirm dialog is the most recently appended overlay when two are stacked.
    const confirmOverlay = overlays[overlays.length - 1];
    const buttons = Array.from(confirmOverlay.querySelectorAll('.modal-actions button'));
    return {
        confirmBtn: buttons.find((b) => b.textContent === 'Confirm'),
        cancelBtn: buttons.find((b) => b.textContent === 'Cancel'),
    };
}

function getOverlays() {
    return document.querySelectorAll('.modal-overlay');
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushMicrotasks(times = 5) {
    for (let i = 0; i < times; i++) {
        await Promise.resolve();
    }
}

// ---------------------------------------------------------------------------
// AC1/AC2 — Rendering and defaults (fields)
// ---------------------------------------------------------------------------

test('AC1: only differing fields render, and Url is never shown even if present in the preview', async () => {
    const promise = showRepositoryInfoImportModal({
        repoId: 'repo-1',
        repoName: 'Repo One',
        preview: CONFLICT_PREVIEW_WITH_URL,
    });

    const fieldsets = getFieldFieldsets();
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

    const fieldsets = getFieldFieldsets();
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

    const fieldsets = getFieldFieldsets();
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

    const descriptionFieldset = getFieldFieldsets().find((fs) => fs.querySelector('legend').textContent === 'Description');
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
    const nameFieldset = getFieldFieldsets().find((fs) => fs.querySelector('legend').textContent === 'Name');
    dispatchClick(nameFieldset.querySelector('input[value="keep"]'));

    dispatchClick(getApplyBtn());
    const result = await promise;

    assert.equal(applyImportCalls.length, 1);
    assert.deepEqual(applyImportCalls[0], { id: 'repo-1', selections: { fields: ['Description'], files: [] } });
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
    assert.deepEqual(applyImportCalls[0], { id: 'repo-1', selections: { fields: [], files: [] } });
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

    const nameFieldset = getFieldFieldsets()[0];
    const checkedRadio = nameFieldset.querySelector('input:checked');
    assert.equal(document.activeElement, checkedRadio);

    dispatchClick(getCancelBtn());
    await promise;

    assert.equal(document.activeElement, opener);
});

// ---------------------------------------------------------------------------
// WP-015 AC1 — Files table rendering and per-state defaults
// ---------------------------------------------------------------------------

test('WP-015 AC1: a Files table row is rendered for every file diff kind, each as a <fieldset> with a <legend> naming the path', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: INCOMING_PREVIEW_WITH_FILES });

    const fileFieldsets = getFileFieldsets();
    assert.equal(fileFieldsets.length, 3);
    assert.deepEqual(
        fileFieldsets.map((fs) => fs.querySelector('legend').textContent),
        ['scripts/new.sh', 'scripts/removed.sh', 'scripts/changed.sh'],
    );

    dispatchClick(getCancelBtn());
    await promise;
});

test('WP-015 AC1: state=incoming defaults to the take-incoming action for every file kind (add/delete/overwrite)', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: INCOMING_PREVIEW_WITH_FILES });

    const [incomingOnly, localOnly, changed] = getFileFieldsets();
    assert.equal(incomingOnly.querySelector('input[value="add"]').checked, true);
    assert.equal(localOnly.querySelector('input[value="delete"]').checked, true);
    assert.equal(changed.querySelector('input[value="overwrite"]').checked, true);

    dispatchClick(getCancelBtn());
    await promise;
});

test('WP-015 AC1: state=conflict defaults to the keep-local action for every file kind (discard/keep/keep)', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: CONFLICT_PREVIEW_WITH_FILES });

    const [incomingOnly, localOnly, changed] = getFileFieldsets();
    assert.equal(incomingOnly.querySelector('input[value="discard"]').checked, true);
    assert.equal(localOnly.querySelector('input[value="keep"]').checked, true);
    assert.equal(changed.querySelector('input[value="keep"]').checked, true);

    dispatchClick(getCancelBtn());
    await promise;
});

test('WP-015 AC1: the changed-kind row renders the differing-field summary', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: INCOMING_PREVIEW_WITH_FILES });

    const changedRow = getFileFieldsets().find((fs) => fs.querySelector('legend').textContent === 'scripts/changed.sh');
    assert.equal(changedRow.querySelector('.info-import-file__changes').textContent, 'Content');

    dispatchClick(getCancelBtn());
    await promise;
});

test('WP-015 AC1: problem rows only offer their two allowed actions, with the destructive one disabled and the safe one forced', async () => {
    const promise = showRepositoryInfoImportModal({
        repoId: 'repo-1',
        preview: { state: 'incoming', fields: [], files: PROBLEM_FILE_DIFFS },
    });

    const [incomingOnlyProblem, changedProblem] = getFileFieldsets();

    // incoming-only problem: only "discard" (the safe action) is selectable; "add" is disabled.
    const addRadio = incomingOnlyProblem.querySelector('input[value="add"]');
    const discardRadio = incomingOnlyProblem.querySelector('input[value="discard"]');
    assert.equal(addRadio.disabled, true);
    assert.equal(discardRadio.disabled, false);
    assert.equal(discardRadio.checked, true);
    assert.equal(incomingOnlyProblem.querySelector('.info-import-file__problem').textContent, 'File content is not valid UTF-8 text.');

    // changed problem: only "keep" (the safe action) is selectable; "overwrite" is disabled —
    // even though state=incoming would otherwise default to "overwrite".
    const overwriteRadio = changedProblem.querySelector('input[value="overwrite"]');
    const keepRadio = changedProblem.querySelector('input[value="keep"]');
    assert.equal(overwriteRadio.disabled, true);
    assert.equal(keepRadio.disabled, false);
    assert.equal(keepRadio.checked, true);

    dispatchClick(getCancelBtn());
    await promise;
});

// ---------------------------------------------------------------------------
// WP-015 AC2/AC3 — discard confirmation flow
// ---------------------------------------------------------------------------

test('WP-015 AC2: a selection containing discard opens a confirmation dialog listing exactly the affected paths', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: CONFLICT_PREVIEW_WITH_FILES });

    // state=conflict already defaults the incoming-only row to "discard".
    dispatchClick(getApplyBtn());
    await flushMicrotasks();

    assert.equal(getOverlays().length, 2, 'the confirm dialog opens a second overlay on top of the import modal');
    const confirmOverlay = Array.from(getOverlays())[1];
    const confirmBody = confirmOverlay.querySelector('.modal-body');
    assert.ok(confirmBody.textContent.includes('scripts/new.sh'));
    // Only the incoming-only row defaults to discard; the other two rows default to keep.
    assert.ok(!confirmBody.textContent.includes('scripts/removed.sh'));
    assert.ok(!confirmBody.textContent.includes('scripts/changed.sh'));

    const { cancelBtn } = getConfirmDialogButtons();
    dispatchClick(cancelBtn);
    await flushMicrotasks();

    dispatchClick(getCancelBtn());
    await promise;
});

test('WP-015 AC2: cancelling the discard confirmation sends no request and preserves the modal\'s selection', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: CONFLICT_PREVIEW_WITH_FILES });

    dispatchClick(getApplyBtn());
    await flushMicrotasks();

    const { cancelBtn: confirmCancelBtn } = getConfirmDialogButtons();
    dispatchClick(confirmCancelBtn);
    await flushMicrotasks();

    assert.equal(applyImportCalls.length, 0);
    assert.equal(getOverlays().length, 1, 'only the import modal remains open');

    const [incomingOnly] = getFileFieldsets();
    assert.equal(incomingOnly.querySelector('input[value="discard"]').checked, true, 'selection is preserved');

    // The import modal itself must still be usable (Apply/Cancel re-enabled).
    assert.equal(getApplyBtn().disabled, false);
    assert.equal(getCancelBtn().disabled, false);

    dispatchClick(getCancelBtn());
    await promise;
});

test('WP-015 AC2: confirming the discard confirmation sends the request', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: CONFLICT_PREVIEW_WITH_FILES });

    dispatchClick(getApplyBtn());
    await flushMicrotasks();

    const { confirmBtn } = getConfirmDialogButtons();
    dispatchClick(confirmBtn);
    const result = await promise;

    assert.equal(applyImportCalls.length, 1);
    assert.deepEqual(result, { applied: true });
    assert.deepEqual(applyImportCalls[0].selections.files, [
        { path: 'scripts/new.sh', action: 'discard' },
        { path: 'scripts/removed.sh', action: 'keep' },
        { path: 'scripts/changed.sh', action: 'keep' },
    ]);
});

test('WP-015 AC3: a selection with no discard applies without any confirmation step', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: INCOMING_PREVIEW_WITH_FILES });

    // state=incoming defaults to add/delete/overwrite — no discard anywhere.
    dispatchClick(getApplyBtn());
    const result = await promise;

    assert.equal(getOverlays().length, 0);
    assert.equal(applyImportCalls.length, 1);
    assert.deepEqual(result, { applied: true });
    assert.deepEqual(applyImportCalls[0].selections.files, [
        { path: 'scripts/new.sh', action: 'add' },
        { path: 'scripts/removed.sh', action: 'delete' },
        { path: 'scripts/changed.sh', action: 'overwrite' },
    ]);
});

// ---------------------------------------------------------------------------
// WP-015 AC4 — payload shape, double-click, empty-fields-only-files
// ---------------------------------------------------------------------------

test('WP-015 AC4: the Apply request sends files alongside the existing fields', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: INCOMING_PREVIEW_WITH_FILES });

    dispatchClick(getApplyBtn());
    await promise;

    assert.equal(applyImportCalls.length, 1);
    assert.deepEqual(applyImportCalls[0].selections.fields, ['Name']);
    assert.equal(applyImportCalls[0].selections.files.length, 3);
});

test('WP-015 AC4: a rapid double-click on Apply sends exactly one request', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: INCOMING_PREVIEW_WITH_FILES });

    dispatchClick(getApplyBtn());
    dispatchClick(getApplyBtn());
    await promise;

    assert.equal(applyImportCalls.length, 1);
});

test('WP-015 AC4: a rapid double-click on Apply when the selection contains discard still sends exactly one request', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: CONFLICT_PREVIEW_WITH_FILES });

    dispatchClick(getApplyBtn());
    dispatchClick(getApplyBtn());
    await flushMicrotasks();

    const { confirmBtn } = getConfirmDialogButtons();
    dispatchClick(confirmBtn);
    await promise;

    assert.equal(applyImportCalls.length, 1);
});

test('WP-015 AC4: an empty fields array with only file diffs renders and applies correctly', async () => {
    const promise = showRepositoryInfoImportModal({
        repoId: 'repo-1',
        preview: { state: 'incoming', fields: [], files: FILE_DIFFS },
    });

    assert.equal(getFieldFieldsets().length, 0);
    assert.equal(getFileFieldsets().length, 3);

    dispatchClick(getApplyBtn());
    const result = await promise;

    assert.deepEqual(result, { applied: true });
    assert.deepEqual(applyImportCalls[0].selections.fields, []);
    assert.equal(applyImportCalls[0].selections.files.length, 3);
});

test('a preview with no files key at all (pre-Milestone-2 shape) renders no file rows', async () => {
    const promise = showRepositoryInfoImportModal({ repoId: 'repo-1', preview: INCOMING_PREVIEW });

    assert.equal(getFileFieldsets().length, 0);

    dispatchClick(getCancelBtn());
    await promise;
});
