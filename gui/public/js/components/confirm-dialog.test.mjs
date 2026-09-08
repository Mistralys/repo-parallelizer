/**
 * Unit tests for components/confirm-dialog.js — WP-006.
 *
 * The first dedicated regression suite for `showConfirm()`. Previously it was
 * only exercised indirectly (and partially) via `settings.test.mjs`'s
 * monkey-patch workarounds, which could not drive the dialog itself.
 *
 * Acceptance Criteria verified:
 *   AC1 — showConfirm() resolves when Confirm is clicked, and rejects with
 *         Error('User cancelled') on Cancel, Escape, and backdrop-click.
 *   AC2 — In each dismissal path, focus is restored to the element that had
 *         focus before the dialog opened.
 *   AC3 — On open, the Confirm button (not the Cancel button or the dialog
 *         itself) receives initial focus, matching pre-refactor behavior.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/components/confirm-dialog.test.mjs
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

const { showConfirm } = await import('./confirm-dialog.js');

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

function getConfirmBtn() {
    return Array.from(document.querySelectorAll('.modal-actions button'))
        .find((btn) => btn.textContent === 'Confirm');
}

function getCancelBtn() {
    return Array.from(document.querySelectorAll('.modal-actions button'))
        .find((btn) => btn.textContent === 'Cancel');
}

function getOverlay() {
    return document.querySelector('.modal-overlay');
}

// ---------------------------------------------------------------------------
// Per-test cleanup
// ---------------------------------------------------------------------------

beforeEach(() => {
    document.body.innerHTML = '<button id="outside-btn" type="button">Outside</button>';
});

// ---------------------------------------------------------------------------
// AC3 — initial focus
// ---------------------------------------------------------------------------

test('AC3: on open, the Confirm button receives initial focus', () => {
    showConfirm('Title', 'Message').catch(() => {});

    const confirmBtn = getConfirmBtn();
    assert.ok(confirmBtn, 'Confirm button should exist');
    assert.equal(document.activeElement, confirmBtn);
    assert.notEqual(document.activeElement, getCancelBtn());
});

// ---------------------------------------------------------------------------
// AC1 / AC2 — Confirm
// ---------------------------------------------------------------------------

test('AC1: showConfirm() resolves when Confirm is clicked', async () => {
    const outsideBtn = document.getElementById('outside-btn');
    outsideBtn.focus();

    const promise = showConfirm('Title', 'Message');
    dispatchClick(getConfirmBtn());

    await assert.doesNotReject(promise);
});

test('AC2: clicking Confirm restores focus to the pre-open element', async () => {
    const outsideBtn = document.getElementById('outside-btn');
    outsideBtn.focus();

    const promise = showConfirm('Title', 'Message');
    dispatchClick(getConfirmBtn());
    await promise;

    assert.equal(document.activeElement, outsideBtn);
    assert.equal(getOverlay(), null, 'overlay should be removed from the DOM');
});

// ---------------------------------------------------------------------------
// AC1 / AC2 — Cancel button
// ---------------------------------------------------------------------------

test('AC1: showConfirm() rejects with Error("User cancelled") when Cancel is clicked', async () => {
    const promise = showConfirm('Title', 'Message');
    dispatchClick(getCancelBtn());

    await assert.rejects(promise, (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'User cancelled');
        return true;
    });
});

test('AC2: clicking Cancel restores focus to the pre-open element', async () => {
    const outsideBtn = document.getElementById('outside-btn');
    outsideBtn.focus();

    const promise = showConfirm('Title', 'Message');
    dispatchClick(getCancelBtn());
    await promise.catch(() => {});

    assert.equal(document.activeElement, outsideBtn);
});

// ---------------------------------------------------------------------------
// AC1 / AC2 — Escape key
// ---------------------------------------------------------------------------

test('AC1: showConfirm() rejects with Error("User cancelled") on Escape', async () => {
    const promise = showConfirm('Title', 'Message');
    dispatchKeydown(document, 'Escape');

    await assert.rejects(promise, (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'User cancelled');
        return true;
    });
});

test('AC2: pressing Escape restores focus to the pre-open element', async () => {
    const outsideBtn = document.getElementById('outside-btn');
    outsideBtn.focus();

    const promise = showConfirm('Title', 'Message');
    dispatchKeydown(document, 'Escape');
    await promise.catch(() => {});

    assert.equal(document.activeElement, outsideBtn);
});

// ---------------------------------------------------------------------------
// AC1 / AC2 — Backdrop click
// ---------------------------------------------------------------------------

test('AC1: showConfirm() rejects with Error("User cancelled") on backdrop click', async () => {
    const promise = showConfirm('Title', 'Message');
    dispatchClick(getOverlay());

    await assert.rejects(promise, (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'User cancelled');
        return true;
    });
});

test('AC2: backdrop click restores focus to the pre-open element', async () => {
    const outsideBtn = document.getElementById('outside-btn');
    outsideBtn.focus();

    const promise = showConfirm('Title', 'Message');
    dispatchClick(getOverlay());
    await promise.catch(() => {});

    assert.equal(document.activeElement, outsideBtn);
});

test('a click on the modal itself (not the backdrop) does not dismiss the dialog', async () => {
    const promise = showConfirm('Title', 'Message');
    let rejected = false;
    promise.catch(() => { rejected = true; });

    dispatchClick(document.querySelector('.modal'));

    assert.equal(rejected, false);
    assert.ok(getOverlay(), 'overlay should still be in the DOM');

    // Clean up the still-open dialog for subsequent tests.
    dispatchClick(getCancelBtn());
    await promise.catch(() => {});
});
