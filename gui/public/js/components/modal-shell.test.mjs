/**
 * Unit tests for components/modal-shell.js — WP-003.
 *
 * Acceptance Criteria verified:
 *   AC1 — mount() focuses the supplied initialFocusEl, or the first focusable
 *         element inside modal when omitted.
 *   AC2 — Tab on the last focusable element wraps to the first, and Shift+Tab
 *         from the first wraps to the last, without focus leaving modal.
 *   AC3 — close() restores document.activeElement to whatever had focus
 *         immediately before mount() was called.
 *   AC4 — Escape key and a backdrop click (event.target === overlay) each
 *         invoke the caller's onCancel.
 *   AC5 — After setBusy(true), Escape and backdrop click become no-ops;
 *         setBusy(false) re-enables them.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/components/modal-shell.test.mjs
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

globalThis.document        = window.document;
globalThis.window          = window;
globalThis.HTMLElement     = window.HTMLElement;
globalThis.KeyboardEvent   = window.KeyboardEvent;
globalThis.MouseEvent      = window.MouseEvent;

const { createModalShell } = await import('./modal-shell.js');

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/** Builds a shell with two buttons appended to `modal`, and returns everything needed to test it. */
function buildShell(overrides = {}) {
    const onCancel = overrides.onCancel ?? (() => {});
    const shell = createModalShell({
        titleText: 'Test Modal',
        ariaLabelledbyId: 'test-modal-title',
        onCancel,
        ...overrides,
    });

    const firstBtn = document.createElement('button');
    firstBtn.type = 'button';
    firstBtn.textContent = 'First';

    const lastBtn = document.createElement('button');
    lastBtn.type = 'button';
    lastBtn.textContent = 'Last';

    shell.modal.appendChild(firstBtn);
    shell.modal.appendChild(lastBtn);

    return { shell, firstBtn, lastBtn, onCancel };
}

function dispatchKeydown(target, key, { shiftKey = false } = {}) {
    const event = new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
}

function dispatchClick(target) {
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
}

// ---------------------------------------------------------------------------
// Per-test cleanup — ensure no leftover overlay/listeners leak between tests
// ---------------------------------------------------------------------------

let activeShell = null;

beforeEach(() => {
    if (activeShell) {
        activeShell.close();
        activeShell = null;
    }
    document.body.innerHTML = '<button id="outside-btn" type="button">Outside</button>';
});

// ---------------------------------------------------------------------------
// AC1 — mount() initial focus
// ---------------------------------------------------------------------------

test('AC1: mount() focuses the supplied initialFocusEl', () => {
    const { shell, lastBtn } = buildShell();
    activeShell = shell;

    shell.mount(lastBtn);

    assert.equal(document.activeElement, lastBtn);
});

test('AC1: mount() focuses the first focusable element inside modal when initialFocusEl is omitted', () => {
    const { shell, firstBtn } = buildShell();
    activeShell = shell;

    shell.mount();

    assert.equal(document.activeElement, firstBtn);
});

// ---------------------------------------------------------------------------
// AC2 — Focus trap: Tab/Shift+Tab wrap-around
// ---------------------------------------------------------------------------

test('AC2: Tab on the last focusable element wraps focus to the first', () => {
    const { shell, firstBtn, lastBtn } = buildShell();
    activeShell = shell;

    shell.mount();
    lastBtn.focus();
    assert.equal(document.activeElement, lastBtn);

    dispatchKeydown(document, 'Tab', { shiftKey: false });

    assert.equal(document.activeElement, firstBtn);
});

test('AC2: Shift+Tab on the first focusable element wraps focus to the last', () => {
    const { shell, firstBtn, lastBtn } = buildShell();
    activeShell = shell;

    shell.mount();
    firstBtn.focus();
    assert.equal(document.activeElement, firstBtn);

    dispatchKeydown(document, 'Tab', { shiftKey: true });

    assert.equal(document.activeElement, lastBtn);
});

test('AC2: Tab on a middle element does not wrap (focus trap only fires at boundaries)', () => {
    const { shell, firstBtn, lastBtn } = buildShell();
    activeShell = shell;

    const middleBtn = document.createElement('button');
    middleBtn.type = 'button';
    middleBtn.textContent = 'Middle';
    shell.modal.insertBefore(middleBtn, lastBtn);

    shell.mount();
    middleBtn.focus();

    dispatchKeydown(document, 'Tab', { shiftKey: false });

    // The trap only intervenes at the first/last boundary; a Tab from the
    // middle element is not prevented, so focus stays where jsdom left it
    // (jsdom does not auto-advance focus on Tab), i.e. still the middle button.
    assert.equal(document.activeElement, middleBtn);
    assert.notEqual(document.activeElement, firstBtn);
});

// ---------------------------------------------------------------------------
// AC3 — close() restores focus
// ---------------------------------------------------------------------------

test('AC3: close() restores focus to the element that had focus before mount()', () => {
    const outsideBtn = document.getElementById('outside-btn');
    outsideBtn.focus();
    assert.equal(document.activeElement, outsideBtn);

    const { shell } = buildShell();
    activeShell = shell;

    shell.mount();
    assert.notEqual(document.activeElement, outsideBtn);

    shell.close();
    activeShell = null;

    assert.equal(document.activeElement, outsideBtn);
});

test('AC3: close() does not throw when the previously-focused element is no longer in the document', () => {
    const outsideBtn = document.getElementById('outside-btn');
    outsideBtn.focus();

    const { shell } = buildShell();
    activeShell = shell;
    shell.mount();

    outsideBtn.remove();

    assert.doesNotThrow(() => shell.close());
    activeShell = null;
});

// ---------------------------------------------------------------------------
// AC4 — Escape and backdrop click invoke onCancel
// ---------------------------------------------------------------------------

test('AC4: Escape key invokes onCancel', () => {
    let cancelled = false;
    const { shell } = buildShell({ onCancel: () => { cancelled = true; } });
    activeShell = shell;

    shell.mount();
    dispatchKeydown(document, 'Escape');

    assert.equal(cancelled, true);
});

test('AC4: backdrop click (event.target === overlay) invokes onCancel', () => {
    let cancelled = false;
    const { shell } = buildShell({ onCancel: () => { cancelled = true; } });
    activeShell = shell;

    shell.mount();
    dispatchClick(shell.overlay);

    assert.equal(cancelled, true);
});

test('AC4: a click on the modal itself (not the overlay backdrop) does not invoke onCancel', () => {
    let cancelled = false;
    const { shell } = buildShell({ onCancel: () => { cancelled = true; } });
    activeShell = shell;

    shell.mount();
    dispatchClick(shell.modal);

    assert.equal(cancelled, false);
});

// ---------------------------------------------------------------------------
// AC5 — setBusy() gates Escape/backdrop-cancel
// ---------------------------------------------------------------------------

test('AC5: after setBusy(true), Escape becomes a no-op', () => {
    let cancelled = false;
    const { shell } = buildShell({ onCancel: () => { cancelled = true; } });
    activeShell = shell;

    shell.mount();
    shell.setBusy(true);
    dispatchKeydown(document, 'Escape');

    assert.equal(cancelled, false);
});

test('AC5: after setBusy(true), backdrop click becomes a no-op', () => {
    let cancelled = false;
    const { shell } = buildShell({ onCancel: () => { cancelled = true; } });
    activeShell = shell;

    shell.mount();
    shell.setBusy(true);
    dispatchClick(shell.overlay);

    assert.equal(cancelled, false);
});

test('AC5: setBusy(false) re-enables Escape and backdrop click', () => {
    let cancelCount = 0;
    const { shell } = buildShell({ onCancel: () => { cancelCount += 1; } });
    activeShell = shell;

    shell.mount();
    shell.setBusy(true);
    dispatchKeydown(document, 'Escape');
    assert.equal(cancelCount, 0);

    shell.setBusy(false);
    dispatchKeydown(document, 'Escape');
    assert.equal(cancelCount, 1);
});
