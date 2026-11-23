/**
 * Unit tests for views/repository-info-sync-section.js — WP-013.
 *
 * Acceptance Criteria verified (plan AC-17, AC-17b, AC-17c; see also the
 * WP-013 spec and the plan's step 16 "GUI Interaction & Accessibility Spec"):
 *
 *   AC-17  — The section renders the toggle, status block, pending-files
 *            list, health alert and action buttons in the documented order;
 *            the button-enablement matrix matches step 16(b) for several
 *            representative states, including "all disabled while busy";
 *            the alert's Import… button and the action row's Import… button
 *            both open the same modal; a successful import notifies the
 *            caller while Refresh never does.
 *   AC-17b — A `conflict` state auto-opens the import modal exactly once per
 *            repository, and a cancelled auto-open does not reopen after a
 *            later re-render (e.g. triggered by Refresh).
 *   AC-17c — Flipping the toggle does not save until Save is pressed; a
 *            failed save reverts the toggle and shows an inline
 *            `role="alert"` error; disabling with pending changes shows
 *            `showConfirm()` and retries with `discardPendingChanges: true`
 *            on confirmation; a failed initial load shows an inline error
 *            with a Retry button; `cleanup()` stops the section from acting
 *            on a request that resolves after unmount.
 *   AC-18 (WP-016) — The Commit & Push toast names the short commit SHA and
 *            default branch when both are known, falls back to the generic
 *            text otherwise, and shows an additional info toast for a
 *            `filterFallback` result; cancelling the dialog shows no toast.
 *            The button matrix for `main-folder-unavailable`, `invalid-file`,
 *            `id-mismatch` and `unsupported-schema` matches the documented
 *            reasons.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/views/repository-info-sync-section.test.mjs
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
globalThis.HTMLElement = window.HTMLElement;
globalThis.Event       = window.Event;
globalThis.MouseEvent  = window.MouseEvent;

globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => ({}),
});

const { api } = await import('../api.js');
const { buildRepositoryInfoSyncSection } = await import('./repository-info-sync-section.js');

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** @returns {Object} A minimal, valid `InfoSyncStatus`, overridable per test. */
function makeStatus(overrides = {}) {
    return {
        enabled: true,
        mainFolder: {
            path: '/data/repositories/repo',
            exists: true,
            isGitRepository: true,
            remoteUrl: 'https://example.test/repo.git',
            remoteMatches: true,
            currentBranch: 'main',
            defaultBranch: 'main',
            ahead: 0,
            behind: 0,
            pendingChanges: [],
        },
        state: 'in-sync',
        pendingChanges: [],
        defaultCommitMessage: 'Update workspace info',
        health: { healthy: true, issues: [] },
        ...overrides,
    };
}

let nextRepoId = 0;
/** A fresh repo ID per test, so the module-level auto-open `Set` never bleeds across tests. */
function uniqueRepoId() {
    nextRepoId += 1;
    return `repo-${nextRepoId}`;
}

/** Waits one macrotask — enough for any pending microtask chain (awaited API mocks) to settle. */
function wait(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function dispatchClick(target) {
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function dispatchChange(target, checked) {
    target.checked = checked;
    target.dispatchEvent(new window.Event('change', { bubbles: true }));
}

/** @param {HTMLElement} root @param {string} text @returns {HTMLButtonElement|undefined} */
function findButton(root, text) {
    return Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text);
}

function findModalButton(text) {
    return Array.from(document.querySelectorAll('.modal-actions button')).find((b) => b.textContent === text);
}

beforeEach(() => {
    document.body.innerHTML = '<div id="toast-container"></div>';

    api.repositories.infoSync.status = async () => makeStatus();
    api.repositories.infoSync.saveSettings = async (_id, input) => makeStatus({ enabled: input.enabled });
    api.repositories.infoSync.refresh = async () => makeStatus();
    api.repositories.infoSync.recreateMainFolder = async () => makeStatus();
    api.repositories.infoSync.importPreview = async () => ({ state: 'incoming', fields: [] });
    api.repositories.infoSync.applyImport = async () => makeStatus({ state: 'in-sync' });
    api.repositories.infoSync.commitPush = async () => ({ committed: true, pushed: true });
    api.repositories.get = async () => ({ Id: 'repo', Name: 'Repo' });
});

// ---------------------------------------------------------------------------
// AC-17 — Rendering order and the state labels
// ---------------------------------------------------------------------------

test('AC-17: renders the toggle, status block, pending list, health alert and action row in order', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({
        state: 'write-required',
        pendingChanges: ['.workspace/info.json'],
        health: {
            healthy: false,
            issues: [{ type: 'info-sync-pending-changes', severity: 'warning', message: 'Pending changes', fixAction: 'commit-push' }],
        },
    });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    const body = element.querySelector('.repository-info-sync-body');
    const classes = Array.from(body.children).map((c) => c.className.split(' ')[0]);
    assert.deepEqual(classes, [
        'info-sync-toggle-row',
        'info-sync-status-block',
        'info-sync-pending-files',
        'health-alert',
        'info-sync-action-row',
    ]);

    const toggle = element.querySelector('input[role="switch"]');
    assert.ok(toggle, 'toggle switch is rendered');

    const pill = element.querySelector('.info-sync-state');
    assert.equal(pill.textContent, 'Will be written on next sync');
});

test('AC-17: the state pill uses the documented label for every state', async () => {
    const labels = {
        'in-sync': 'Up to date',
        'write-required': 'Will be written on next sync',
        'incoming': 'Import available',
        'conflict': 'Conflict',
        'disabled': 'Off',
        'main-folder-unavailable': 'Main folder unavailable',
        'invalid-file': 'Invalid info file',
        'id-mismatch': 'Id mismatch',
        'unsupported-schema': 'Unsupported file version',
    };

    for (const [state, label] of Object.entries(labels)) {
        const repoId = uniqueRepoId();
        api.repositories.infoSync.status = async () => makeStatus({ state });

        const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
        document.body.appendChild(element);
        await wait();

        assert.equal(element.querySelector('.info-sync-state').textContent, label, `state "${state}"`);
        element.remove();
    }
});

// ---------------------------------------------------------------------------
// AC-17: button-enablement matrix (representative states)
// ---------------------------------------------------------------------------

test('AC-17: "incoming" enables Refresh, makes Import… primary, and disables Commit & Push with a reason', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ state: 'incoming' });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    const refresh = findButton(element, 'Refresh');
    const importBtn = findButton(element, 'Import…');
    const commit = findButton(element, 'Commit & Push');

    assert.equal(refresh.hidden, false);
    assert.equal(refresh.disabled, false);
    assert.equal(importBtn.disabled, false);
    assert.ok(importBtn.classList.contains('btn-primary'));
    assert.equal(commit.disabled, true);
    assert.equal(commit.title, 'Resolve the import first.');
});

test('AC-17: "disabled" state hides Refresh, Import… and Commit & Push', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ enabled: false, state: 'disabled' });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    assert.equal(findButton(element, 'Refresh').hidden, true);
    assert.equal(findButton(element, 'Import…').hidden, true);
    assert.equal(findButton(element, 'Commit & Push').hidden, true);
});

test('AC-17: "in-sync" with pending changes enables Commit & Push', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ state: 'in-sync', pendingChanges: ['x'] });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    assert.equal(findButton(element, 'Commit & Push').disabled, false);
});

test('AC-17c: all action buttons are disabled while a request for the section is in flight', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ state: 'write-required', pendingChanges: ['x'] });
    let resolveRefresh;
    api.repositories.infoSync.refresh = () => new Promise((resolve) => { resolveRefresh = resolve; });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    dispatchClick(findButton(element, 'Refresh'));
    await wait();

    assert.equal(findButton(element, 'Refresh').disabled, true);
    const commit = findButton(element, 'Commit & Push');
    assert.equal(commit.disabled, true);
    assert.equal(commit.title, 'A request for this section is already in progress.');

    resolveRefresh(makeStatus({ state: 'write-required', pendingChanges: ['x'] }));
    await wait();
});

// ---------------------------------------------------------------------------
// AC-17c — Toggle/Save behaviour
// ---------------------------------------------------------------------------

test('AC-17c: flipping the toggle does not save until Save is pressed', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ enabled: false, state: 'disabled' });
    let saveCalls = 0;
    api.repositories.infoSync.saveSettings = async (_id, input) => {
        saveCalls += 1;
        return makeStatus({ enabled: input.enabled, state: input.enabled ? 'write-required' : 'disabled' });
    };

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    dispatchChange(element.querySelector('input[role="switch"]'), true);
    assert.equal(saveCalls, 0);

    const saveBtn = findButton(element, 'Save');
    assert.equal(saveBtn.disabled, false);
    dispatchClick(saveBtn);
    await wait();

    assert.equal(saveCalls, 1);
});

test('AC-17c: a failed save reverts the toggle and shows an inline role="alert" error', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ enabled: false, state: 'disabled' });
    api.repositories.infoSync.saveSettings = async () => { throw new Error('Clone failed.'); };

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    dispatchChange(element.querySelector('input[role="switch"]'), true);
    dispatchClick(findButton(element, 'Save'));
    await wait();

    const alert = element.querySelector('[role="alert"]');
    assert.equal(alert.textContent, 'Clone failed.');
    assert.equal(element.querySelector('input[role="switch"]').checked, false);
});

test('AC-17c: disabling with pending changes shows showConfirm() and retries with discardPendingChanges: true', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({
        enabled: true, state: 'write-required', pendingChanges: ['.workspace/info.json'],
    });
    const saveCalls = [];
    api.repositories.infoSync.saveSettings = async (_id, input) => {
        saveCalls.push(input);
        return makeStatus({ enabled: input.enabled, state: 'disabled', pendingChanges: [] });
    };

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    dispatchChange(element.querySelector('input[role="switch"]'), false);
    dispatchClick(findButton(element, 'Save'));
    await wait();

    const confirmBtn = findModalButton('Confirm');
    assert.ok(confirmBtn, 'the confirm dialog is open before any saveSettings call');
    assert.equal(saveCalls.length, 0);
    assert.ok(document.querySelector('.modal-body').textContent.includes('.workspace/info.json'));

    dispatchClick(confirmBtn);
    await wait();

    assert.equal(saveCalls.length, 1);
    assert.deepEqual(saveCalls[0], { enabled: false, discardPendingChanges: true });
});

// ---------------------------------------------------------------------------
// AC-17 — Post-action refresh (import notifies the caller, Refresh never does)
// ---------------------------------------------------------------------------

test('AC-17: a successful import calls onRepositoryChanged with the refreshed repository and re-fetches status', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ state: 'incoming' });
    api.repositories.infoSync.importPreview = async () => ({
        state: 'incoming', fields: [{ field: 'Name', current: 'Old', incoming: 'New' }],
    });
    const updatedRepo = { Id: repoId, Name: 'New', Description: '' };
    api.repositories.get = async () => updatedRepo;

    let changedWith = null;
    const { element } = buildRepositoryInfoSyncSection(
        { id: repoId, name: 'Repo' },
        { onRepositoryChanged: (r) => { changedWith = r; } },
    );
    document.body.appendChild(element);
    await wait();

    dispatchClick(findButton(element, 'Import…'));
    await wait();
    await wait();

    assert.equal(document.querySelectorAll('.modal-overlay').length, 1);
    dispatchClick(findModalButton('Apply'));
    await wait();
    await wait();

    assert.deepEqual(changedWith, updatedRepo);
    assert.equal(document.querySelectorAll('.modal-overlay').length, 0);
});

test('AC-17: Refresh re-fetches only the section status and never calls onRepositoryChanged', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ state: 'in-sync' });
    api.repositories.infoSync.refresh = async () => makeStatus({ state: 'in-sync' });

    let changedCalls = 0;
    const { element } = buildRepositoryInfoSyncSection(
        { id: repoId, name: 'Repo' },
        { onRepositoryChanged: () => { changedCalls += 1; } },
    );
    document.body.appendChild(element);
    await wait();

    dispatchClick(findButton(element, 'Refresh'));
    await wait();

    assert.equal(changedCalls, 0);
});

// ---------------------------------------------------------------------------
// AC-17b — Conflict auto-open
// ---------------------------------------------------------------------------

test('AC-17b: a "conflict" state auto-opens the import modal exactly once per repository', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ state: 'conflict' });
    api.repositories.infoSync.importPreview = async () => ({
        state: 'conflict', fields: [{ field: 'Name', current: 'A', incoming: 'B' }],
    });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();
    await wait();

    assert.equal(document.querySelectorAll('.modal-overlay').length, 1);

    dispatchClick(findModalButton('Cancel'));
    await wait();

    assert.equal(document.querySelectorAll('.modal-overlay').length, 0);
});

test('AC-17b: the alert\'s Import… button still opens the dialog manually after a cancelled auto-open', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({
        state: 'conflict',
        health: { healthy: false, issues: [{ type: 'info-sync-conflict', severity: 'warning', message: 'Conflict', fixAction: 'import' }] },
    });
    api.repositories.infoSync.importPreview = async () => ({
        state: 'conflict', fields: [{ field: 'Name', current: 'A', incoming: 'B' }],
    });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();
    await wait();

    // Dismiss the auto-opened modal.
    dispatchClick(findModalButton('Cancel'));
    await wait();
    assert.equal(document.querySelectorAll('.modal-overlay').length, 0);

    // The health alert's own Import… button (distinct from the action row's)
    // still opens it on demand.
    const alertImportBtn = element.querySelector('.health-alert button');
    assert.ok(alertImportBtn);
    dispatchClick(alertImportBtn);
    await wait();
    await wait();

    assert.equal(document.querySelectorAll('.modal-overlay').length, 1);
});

test('AC-17b: a later re-render (Refresh) in the same conflict state does not reopen the modal', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ state: 'conflict' });
    api.repositories.infoSync.importPreview = async () => ({
        state: 'conflict', fields: [{ field: 'Name', current: 'A', incoming: 'B' }],
    });
    api.repositories.infoSync.refresh = async () => makeStatus({ state: 'conflict' });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();
    await wait();

    dispatchClick(findModalButton('Cancel'));
    await wait();

    dispatchClick(findButton(element, 'Refresh'));
    await wait();

    assert.equal(document.querySelectorAll('.modal-overlay').length, 0);
});

// ---------------------------------------------------------------------------
// AC-17c — Loading/error feedback and cleanup
// ---------------------------------------------------------------------------

test('AC-17c: a failed initial load shows an inline error with a Retry button that reloads', async () => {
    const repoId = uniqueRepoId();
    let calls = 0;
    api.repositories.infoSync.status = async () => {
        calls += 1;
        if (calls === 1) throw new Error('Network down.');
        return makeStatus({ state: 'in-sync' });
    };

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    const alert = element.querySelector('[role="alert"]');
    assert.equal(alert.textContent, 'Network down.');

    dispatchClick(findButton(element, 'Retry'));
    await wait();

    assert.ok(element.querySelector('.info-sync-toggle-row'));
});

test('cleanup() stops the section from acting on a status fetch that resolves after unmount', async () => {
    const repoId = uniqueRepoId();
    let resolveStatus;
    api.repositories.infoSync.status = () => new Promise((resolve) => { resolveStatus = resolve; });

    const { element, cleanup } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    cleanup();
    resolveStatus(makeStatus({ state: 'in-sync' }));
    await wait();

    assert.equal(element.querySelector('.info-sync-toggle-row'), null);
    assert.ok(element.querySelector('.repository-info-sync-body').textContent.includes('Loading'));
});

// ---------------------------------------------------------------------------
// AC-18 (WP-016) — Commit & Push toast naming the SHA/branch, filterFallback
// ---------------------------------------------------------------------------

function toastTexts() {
    return Array.from(document.querySelectorAll('#toast-container .toast-message')).map((el) => el.textContent);
}

async function openCommitDialogAndSubmit(element) {
    dispatchClick(findButton(element, 'Commit & Push'));
    await wait();
    const messageInput = document.getElementById('info-commit-message');
    messageInput.value = 'Update workspace info';
    messageInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    dispatchClick(findModalButton('Commit & Push'));
    await wait();
}

test('AC-18: the commit toast names the short SHA and default branch when both are known', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ state: 'write-required', pendingChanges: ['x'] });
    api.repositories.infoSync.commitPush = async () => ({ committed: true, pushed: true, commitSha: 'abcdef1234567' });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    await openCommitDialogAndSubmit(element);

    assert.ok(toastTexts().includes('Pushed abcdef1 to main.'));
});

test('AC-18: the commit toast falls back to the generic text without a commitSha', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ state: 'write-required', pendingChanges: ['x'] });
    api.repositories.infoSync.commitPush = async () => ({ committed: true, pushed: true });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    await openCommitDialogAndSubmit(element);

    assert.ok(toastTexts().includes('Committed and pushed.'));
});

test('AC-18: a filterFallback result shows an additional info toast', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ state: 'write-required', pendingChanges: ['x'] });
    api.repositories.infoSync.commitPush = async () => ({ committed: true, pushed: true, commitSha: 'abcdef1234567', filterFallback: true });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    await openCommitDialogAndSubmit(element);

    const texts = toastTexts();
    assert.ok(texts.includes('Pushed abcdef1 to main.'));
    assert.ok(texts.some((t) => t.includes('partial-clone filtering')));
});

test('AC-18: cancelling the commit dialog shows no toast and does not re-fetch status', async () => {
    const repoId = uniqueRepoId();
    let statusCalls = 0;
    api.repositories.infoSync.status = async () => { statusCalls += 1; return makeStatus({ state: 'write-required', pendingChanges: ['x'] }); };

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();
    const callsBeforeOpen = statusCalls;

    dispatchClick(findButton(element, 'Commit & Push'));
    await wait();
    dispatchClick(findModalButton('Cancel'));
    await wait();

    assert.equal(toastTexts().length, 0);
    assert.equal(statusCalls, callsBeforeOpen);
});

// ---------------------------------------------------------------------------
// AC-10 (WP-006) — Shared partial-clone fallback notice for Enable, Refresh
// and Recreate (Commit & Push's own filterFallback toast is covered above).
// ---------------------------------------------------------------------------

test('AC-10: Enable shows the clone fallback toast when saveSettings() reports filterFallback', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ enabled: false, state: 'disabled' });
    api.repositories.infoSync.saveSettings = async (_id, input) => makeStatus({ enabled: input.enabled, filterFallback: true });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    dispatchChange(element.querySelector('input[role="switch"]'), true);
    dispatchClick(findButton(element, 'Save'));
    await wait();

    const texts = toastTexts();
    assert.ok(texts.includes('Sync enabled'));
    assert.ok(texts.some((t) => t.includes('partial-clone filtering') && t.includes('full clone')));
});

test('AC-10: Disable never shows the fallback toast, even when saveSettings() reports filterFallback', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ enabled: true, state: 'in-sync' });
    api.repositories.infoSync.saveSettings = async (_id, input) => makeStatus({ enabled: input.enabled, filterFallback: true });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    dispatchChange(element.querySelector('input[role="switch"]'), false);
    dispatchClick(findButton(element, 'Save'));
    await wait();

    const texts = toastTexts();
    assert.ok(texts.includes('Sync disabled'));
    assert.ok(!texts.some((t) => t.includes('partial-clone filtering')));
});

test('AC-10: Refresh shows the fetch fallback toast when refresh() reports filterFallback', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ state: 'in-sync' });
    api.repositories.infoSync.refresh = async () => makeStatus({ filterFallback: true });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    dispatchClick(findButton(element, 'Refresh'));
    await wait();

    assert.ok(toastTexts().some((t) => t.includes('partial-clone filtering') && t.includes('full fetch')));
});

test('AC-10: Refresh shows no fallback toast when filterFallback is absent', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ state: 'in-sync' });
    api.repositories.infoSync.refresh = async () => makeStatus();

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    dispatchClick(findButton(element, 'Refresh'));
    await wait();

    assert.ok(!toastTexts().some((t) => t.includes('partial-clone filtering')));
});

test('AC-10: Recreate shows the clone fallback toast when recreateMainFolder() reports filterFallback', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({
        state: 'in-sync',
        health: {
            healthy: false,
            issues: [{
                type: 'main-folder-missing',
                severity: 'warning',
                message: 'The managed main folder does not exist.',
                fixAction: 'recreate-main-folder',
            }],
        },
    });
    api.repositories.infoSync.recreateMainFolder = async () => makeStatus({ filterFallback: true });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    dispatchClick(findButton(element, 'Recreate main folder'));
    await wait();

    const texts = toastTexts();
    assert.ok(texts.includes('Main folder recreated.'));
    assert.ok(texts.some((t) => t.includes('partial-clone filtering') && t.includes('full clone')));
});

// ---------------------------------------------------------------------------
// AC-18 (WP-016) — Button matrix for the remaining documented states
// ---------------------------------------------------------------------------

test('AC-18: "main-folder-unavailable" disables Import… and Commit & Push with the documented reason, hides Refresh', async () => {
    const repoId = uniqueRepoId();
    api.repositories.infoSync.status = async () => makeStatus({ state: 'main-folder-unavailable' });

    const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
    document.body.appendChild(element);
    await wait();

    assert.equal(findButton(element, 'Refresh').hidden, true);
    const importBtn = findButton(element, 'Import…');
    const commitBtn = findButton(element, 'Commit & Push');
    assert.equal(importBtn.disabled, true);
    assert.equal(importBtn.title, 'The main folder is unavailable — recreate it first.');
    assert.equal(commitBtn.disabled, true);
    assert.equal(commitBtn.title, 'The main folder is unavailable — recreate it first.');
});

for (const state of ['invalid-file', 'id-mismatch', 'unsupported-schema']) {
    test(`AC-18: "${state}" enables Refresh, disables Import… and Commit & Push with the documented reasons`, async () => {
        const repoId = uniqueRepoId();
        api.repositories.infoSync.status = async () => makeStatus({ state });

        const { element } = buildRepositoryInfoSyncSection({ id: repoId, name: 'Repo' });
        document.body.appendChild(element);
        await wait();

        assert.equal(findButton(element, 'Refresh').hidden, false);
        assert.equal(findButton(element, 'Refresh').disabled, false);

        const importBtn = findButton(element, 'Import…');
        assert.equal(importBtn.disabled, true);
        assert.equal(importBtn.title, 'No import available.');

        const commitBtn = findButton(element, 'Commit & Push');
        assert.equal(commitBtn.disabled, true);
        assert.equal(commitBtn.title, 'Resolve the info file issue first.');
    });
}
