/**
 * Unit tests for components/info-commit-dialog.js — WP-012.
 *
 * Acceptance Criteria verified (see WP-012 and the plan's step 15/AC-11,
 * AC-17c):
 *   AC1 — The message field is pre-filled with `defaultMessage`.
 *   AC2 — An empty (after trim) or over-500-character message sets
 *         `aria-invalid` on the field, shows an inline error, and disables
 *         Commit; a valid message re-enables it.
 *   AC3 — Commit calls `api.repositories.infoSync.commitPush(repoId, trimmed)`
 *         and resolves with the trimmed message on success.
 *   AC4 — Cancel/Escape/backdrop-click resolve with `null` without calling
 *         `commitPush()`.
 *   AC5 — While `commitPush()` is in flight, Commit/Cancel/the message field
 *         are disabled; a rejected call re-enables them and shows the error
 *         inline in a `role="alert"` region (including the write-access
 *         hint text verbatim), keeping the modal open.
 *   AC6 — Initial focus is the message field.
 *   AC7 — The pending-files list renders one item per path.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/components/info-commit-dialog.test.mjs
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
globalThis.Event         = window.Event;

globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => ({}),
});

const { api } = await import('../api.js');
const { showInfoCommitDialog } = await import('./info-commit-dialog.js');

// ---------------------------------------------------------------------------
// Fixtures / call trackers
// ---------------------------------------------------------------------------

let commitPushCalls;

/** A promise that never settles, standing in for an in-flight API call. */
function pending() {
    return new Promise(() => {});
}

beforeEach(() => {
    document.body.innerHTML = '<button id="outside-btn" type="button">Outside</button>';
    commitPushCalls = [];

    api.repositories.infoSync.commitPush = async (id, message) => {
        commitPushCalls.push({ id, message });
        return { committed: true, pushed: true };
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

function dispatchInput(target) {
    const event = new window.Event('input', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
}

function getMessageInput() {
    return document.getElementById('info-commit-message');
}

function getCommitBtn() {
    return Array.from(document.querySelectorAll('.modal-actions button'))
        .find((btn) => btn.textContent === 'Commit & Push');
}

function getCancelBtn() {
    return Array.from(document.querySelectorAll('.modal-actions button'))
        .find((btn) => btn.textContent === 'Cancel');
}

function setMessage(value) {
    const input = getMessageInput();
    input.value = value;
    dispatchInput(input);
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// AC1 — Pre-fill
// ---------------------------------------------------------------------------

test('AC1: the message field is pre-filled with defaultMessage', async () => {
    const promise = showInfoCommitDialog({
        repoId: 'repo-1',
        pendingFiles: [],
        defaultMessage: 'Paralizer: Update repository info for "repo-1"',
    });

    assert.equal(getMessageInput().value, 'Paralizer: Update repository info for "repo-1"');

    dispatchClick(getCancelBtn());
    await promise;
});

// ---------------------------------------------------------------------------
// AC2 — Inline validation
// ---------------------------------------------------------------------------

test('AC2: an empty (trimmed) message disables Commit and sets aria-invalid', async () => {
    const promise = showInfoCommitDialog({ repoId: 'repo-1', pendingFiles: [], defaultMessage: '' });

    setMessage('   ');

    assert.equal(getCommitBtn().disabled, true);
    assert.equal(getMessageInput().getAttribute('aria-invalid'), 'true');

    dispatchClick(getCancelBtn());
    await promise;
});

test('AC2: an over-500-character message disables Commit and sets aria-invalid', async () => {
    const promise = showInfoCommitDialog({ repoId: 'repo-1', pendingFiles: [], defaultMessage: '' });

    setMessage('x'.repeat(501));

    assert.equal(getCommitBtn().disabled, true);
    assert.equal(getMessageInput().getAttribute('aria-invalid'), 'true');

    dispatchClick(getCancelBtn());
    await promise;
});

test('AC2: a valid message enables Commit and clears aria-invalid', async () => {
    const promise = showInfoCommitDialog({ repoId: 'repo-1', pendingFiles: [], defaultMessage: '' });

    setMessage('   ');
    assert.equal(getCommitBtn().disabled, true);

    setMessage('Update workspace info');
    assert.equal(getCommitBtn().disabled, false);
    assert.equal(getMessageInput().hasAttribute('aria-invalid'), false);

    dispatchClick(getCancelBtn());
    await promise;
});

test('AC2: exactly 500 trimmed characters is valid', async () => {
    const promise = showInfoCommitDialog({ repoId: 'repo-1', pendingFiles: [], defaultMessage: '' });

    setMessage('x'.repeat(500));
    assert.equal(getCommitBtn().disabled, false);

    dispatchClick(getCancelBtn());
    await promise;
});

// ---------------------------------------------------------------------------
// AC3 — Commit success
// ---------------------------------------------------------------------------

test('AC3: Commit trims the message, calls commitPush(repoId, trimmed), and resolves with it', async () => {
    const promise = showInfoCommitDialog({ repoId: 'repo-1', pendingFiles: ['.workspace/info.json'], defaultMessage: '' });

    setMessage('  Update info  ');
    dispatchClick(getCommitBtn());

    const result = await promise;

    assert.equal(commitPushCalls.length, 1);
    assert.deepEqual(commitPushCalls[0], { id: 'repo-1', message: 'Update info' });
    assert.equal(result, 'Update info');
});

// ---------------------------------------------------------------------------
// AC4 — Cancel / Escape / backdrop dismissal
// ---------------------------------------------------------------------------

test('AC4: Cancel resolves with null and does not call commitPush()', async () => {
    const promise = showInfoCommitDialog({ repoId: 'repo-1', pendingFiles: [], defaultMessage: 'msg' });

    dispatchClick(getCancelBtn());
    const result = await promise;

    assert.equal(result, null);
    assert.equal(commitPushCalls.length, 0);
});

test('AC4: Escape resolves with null', async () => {
    const promise = showInfoCommitDialog({ repoId: 'repo-1', pendingFiles: [], defaultMessage: 'msg' });

    dispatchKeydown(document, 'Escape');
    const result = await promise;

    assert.equal(result, null);
});

test('AC4: backdrop click resolves with null', async () => {
    const promise = showInfoCommitDialog({ repoId: 'repo-1', pendingFiles: [], defaultMessage: 'msg' });

    dispatchClick(document.querySelector('.modal-overlay'));
    const result = await promise;

    assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// AC5 — Busy state and inline error
// ---------------------------------------------------------------------------

test('AC5: a rejected commitPush() shows the write-access hint inline and re-enables the controls', async () => {
    api.repositories.infoSync.commitPush = async () => {
        throw new Error('Failed to push changes: permission denied. The configured credential may not have write access.');
    };

    const promise = showInfoCommitDialog({ repoId: 'repo-1', pendingFiles: [], defaultMessage: 'msg' });

    dispatchClick(getCommitBtn());
    await wait(0);

    const errorEl = document.querySelector('.modal .error-message[role="alert"]');
    assert.equal(errorEl.hidden, false);
    assert.equal(
        errorEl.textContent,
        'Failed to push changes: permission denied. The configured credential may not have write access.',
    );
    assert.equal(getCommitBtn().disabled, false);
    assert.equal(getCancelBtn().disabled, false);
    assert.equal(getMessageInput().disabled, false);

    dispatchClick(getCancelBtn());
    await promise;
});

test('AC5: Commit/Cancel/the message field are disabled while commitPush() is in flight', async () => {
    api.repositories.infoSync.commitPush = pending;

    const promise = showInfoCommitDialog({ repoId: 'repo-1', pendingFiles: [], defaultMessage: 'msg' });

    dispatchClick(getCommitBtn());
    await wait(0);

    assert.equal(getCommitBtn().disabled, true);
    assert.equal(getCancelBtn().disabled, true);
    assert.equal(getMessageInput().disabled, true);

    promise.then(() => {});
});

// ---------------------------------------------------------------------------
// AC6 — Focus management
// ---------------------------------------------------------------------------

test('AC6: initial focus is the message field; focus returns to the opener on close', async () => {
    const opener = document.getElementById('outside-btn');
    opener.focus();

    const promise = showInfoCommitDialog({ repoId: 'repo-1', pendingFiles: [], defaultMessage: 'msg' });

    assert.equal(document.activeElement, getMessageInput());

    dispatchClick(getCancelBtn());
    await promise;

    assert.equal(document.activeElement, opener);
});

// ---------------------------------------------------------------------------
// AC7 — Pending files list
// ---------------------------------------------------------------------------

test('AC7: the pending-files list renders one item per path', async () => {
    const promise = showInfoCommitDialog({
        repoId: 'repo-1',
        pendingFiles: ['.workspace/info.json', '.workspace/README.md'],
        defaultMessage: 'msg',
    });

    const items = Array.from(document.querySelectorAll('.info-commit-pending-files li')).map((li) => li.textContent);
    assert.deepEqual(items, ['.workspace/info.json', '.workspace/README.md']);

    dispatchClick(getCancelBtn());
    await promise;
});

test('AC7: no pending-files list is rendered when there are none', async () => {
    const promise = showInfoCommitDialog({ repoId: 'repo-1', pendingFiles: [], defaultMessage: 'msg' });

    assert.equal(document.querySelector('.info-commit-pending-files'), null);

    dispatchClick(getCancelBtn());
    await promise;
});
