/**
 * Unit tests for components/repo-status-cells.js — WP-001.
 *
 * Acceptance Criteria verified:
 *   AC1  — repo-status-cells.js exports buildRepoStatusCells, makeBranchTrigger,
 *           and updateRepoStatusCells as named ES module exports.
 *   AC2  — buildRepoStatusCells returns { branchCell, badgeCell, actionsCell },
 *           each being an HTMLTableCellElement (<td>).
 *   AC3  — Each returned cell carries the correct CSS class.
 *   AC4  — The badge wrapper <div> inside badgeCell retains data-repo-id.
 *   AC5  — makeBranchTrigger returns a <button class="branch-switch-trigger">
 *           with the correct textContent and aria-label.
 *   AC6  — updateRepoStatusCells locates branch and badge cells by CSS class,
 *           not by hardcoded cell index.
 *   AC7  — When isStable is false and onBranchCellClick is provided, the branch
 *           cell contains a clickable trigger button; when isStable is true it
 *           renders plain text.
 *   AC8  — The "Git GUI" button calls api.workspaces.launch.githubDesktop(projectId, wid, repoId).
 *   AC9  — The "Browse" button is only rendered when webserverUrl is truthy,
 *           and opens the correct URL.
 *   AC10 — No innerHTML assignments — all text set via textContent.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/components/repo-status-cells.test.mjs
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
// CSS.escape shim (jsdom may not expose the CSS global)
globalThis.CSS = window.CSS ?? { escape: (s) => s.replace(/["\\]/g, '\\$&') };

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
// Import module under test and patch api
// ---------------------------------------------------------------------------

const { api } = await import('../api.js');

/** Calls recorded by the launch.githubDesktop spy. */
const ghDesktopCalls = [];
let ghDesktopShouldFail  = false;
let ghDesktopFailMessage = 'GitHub Desktop not found';

api.workspaces.launch.githubDesktop = async (projectId, wid, repoId) => {
    ghDesktopCalls.push({ projectId, wid, repoId });
    if (ghDesktopShouldFail) {
        throw new Error(ghDesktopFailMessage);
    }
    return { success: true };
};

/** URLs opened by window.open spy. */
const openedUrls = [];
globalThis.window.open = (url, target) => {
    openedUrls.push({ url, target });
};

const {
    buildRepoStatusCells,
    makeBranchTrigger,
    updateRepoStatusCells,
} = await import('./repo-status-cells.js');

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

const DEFAULT_OPTS = {
    repoId:     'my-repo',
    repoName:   'My Repo',
    statusInfo: { currentBranch: 'main', localCommits: 0, unfetchedCommits: 0, modifiedFiles: 0, lastActivity: null, hasConflicts: false },
    projectId:  'my-project',
    wid:        'DEV',
};

/** Build cells from opts merged over DEFAULT_OPTS. */
function buildCells(overrides = {}) {
    return buildRepoStatusCells({ ...DEFAULT_OPTS, ...overrides });
}

/**
 * Build a minimal <tr> that contains the three shared cells.
 * An optional first column (name cell) is added when nameFirst = true, which
 * means the shared cells are NOT at index 0/1/2 — used to verify that
 * updateRepoStatusCells does not rely on hardcoded indices.
 */
function buildRow(overrides = {}, { nameFirst = false } = {}) {
    const tr = document.createElement('tr');
    tr.dataset.repoId   = overrides.repoId   ?? DEFAULT_OPTS.repoId;
    tr.dataset.repoName = overrides.repoName  ?? DEFAULT_OPTS.repoName;

    if (nameFirst) {
        const nameCell = document.createElement('td');
        nameCell.className   = 'repo-name-cell';
        nameCell.textContent = overrides.repoName ?? DEFAULT_OPTS.repoName;
        tr.appendChild(nameCell);
    }

    const { branchCell, badgeCell, actionsCell } = buildCells(overrides);
    tr.appendChild(branchCell);
    tr.appendChild(badgeCell);
    tr.appendChild(actionsCell);

    return tr;
}

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
    ghDesktopCalls.length = 0;
    ghDesktopShouldFail   = false;
    ghDesktopFailMessage  = 'GitHub Desktop not found';
    openedUrls.length     = 0;
    document.getElementById('toast-container').innerHTML = '';
});

// ---------------------------------------------------------------------------
// AC1 — Named exports
// ---------------------------------------------------------------------------

test('AC1: module exports buildRepoStatusCells, makeBranchTrigger, and updateRepoStatusCells', () => {
    assert.equal(typeof buildRepoStatusCells,   'function', 'buildRepoStatusCells should be a function');
    assert.equal(typeof makeBranchTrigger,       'function', 'makeBranchTrigger should be a function');
    assert.equal(typeof updateRepoStatusCells,   'function', 'updateRepoStatusCells should be a function');
});

// ---------------------------------------------------------------------------
// AC2 — buildRepoStatusCells returns { branchCell, badgeCell, actionsCell } <td>s
// ---------------------------------------------------------------------------

test('AC2: buildRepoStatusCells returns an object with branchCell, badgeCell, and actionsCell, each a <td>', () => {
    const result = buildCells();

    assert.ok('branchCell'  in result, 'result should have branchCell');
    assert.ok('badgeCell'   in result, 'result should have badgeCell');
    assert.ok('actionsCell' in result, 'result should have actionsCell');

    assert.equal(result.branchCell.tagName,  'TD', 'branchCell should be a <td>');
    assert.equal(result.badgeCell.tagName,   'TD', 'badgeCell should be a <td>');
    assert.equal(result.actionsCell.tagName, 'TD', 'actionsCell should be a <td>');
});

// ---------------------------------------------------------------------------
// AC3 — Each cell carries the correct CSS class
// ---------------------------------------------------------------------------

test('AC3: branchCell has class repo-branch-cell, badgeCell has repo-badge-cell, actionsCell has repo-actions-cell', () => {
    const { branchCell, badgeCell, actionsCell } = buildCells();

    assert.ok(branchCell.classList.contains('repo-branch-cell'),   'branchCell missing class repo-branch-cell');
    assert.ok(badgeCell.classList.contains('repo-badge-cell'),     'badgeCell missing class repo-badge-cell');
    assert.ok(actionsCell.classList.contains('repo-actions-cell'), 'actionsCell missing class repo-actions-cell');
});

// ---------------------------------------------------------------------------
// AC4 — Badge wrapper <div> retains data-repo-id
// ---------------------------------------------------------------------------

test('AC4: badgeCell contains a <div> with data-repo-id equal to repoId', () => {
    const { badgeCell } = buildCells({ repoId: 'alpha-repo' });

    const wrapper = badgeCell.querySelector('div[data-repo-id]');
    assert.ok(wrapper, 'expected a <div data-repo-id> inside badgeCell');
    assert.equal(wrapper.dataset.repoId, 'alpha-repo', 'data-repo-id should match repoId');
});

// ---------------------------------------------------------------------------
// AC5 — makeBranchTrigger
// ---------------------------------------------------------------------------

test('AC5: makeBranchTrigger returns a <button class="branch-switch-trigger"> with correct textContent and aria-label', () => {
    const btn = makeBranchTrigger('feature/my-branch', 'Switch branch for my-repo');

    assert.equal(btn.tagName,       'BUTTON',               'should be a <button>');
    assert.ok(btn.classList.contains('branch-switch-trigger'), 'missing class branch-switch-trigger');
    assert.equal(btn.textContent,   'feature/my-branch',    'textContent should be the branch name');
    assert.equal(btn.getAttribute('aria-label'), 'Switch branch for my-repo', 'aria-label mismatch');
});

// ---------------------------------------------------------------------------
// AC6 — updateRepoStatusCells uses CSS class selector, not hardcoded index
// ---------------------------------------------------------------------------

test('AC6: updateRepoStatusCells locates cells by class, not by index — works when a name cell is prepended', () => {
    // Build a row where the name cell is at index 0, so shared cells are at
    // index 1/2/3 — a hardcoded cells[1] approach would pick the name cell.
    const statusInfo = { currentBranch: 'develop', localCommits: 0, unfetchedCommits: 0, modifiedFiles: 0, lastActivity: null, hasConflicts: false };
    const tr = buildRow({ statusInfo }, { nameFirst: true });

    const newStatus = { currentBranch: 'hotfix', localCommits: 1, unfetchedCommits: 0, modifiedFiles: 0, lastActivity: null, hasConflicts: false };
    updateRepoStatusCells(tr, DEFAULT_OPTS.repoId, newStatus, false, null);

    const branchCell = tr.querySelector('.repo-branch-cell');
    assert.ok(branchCell, 'repo-branch-cell should be present after update');
    assert.equal(branchCell.textContent.trim(), 'hotfix', 'branch cell text should reflect the new branch');
});

test('AC6: updateRepoStatusCells updates the badge wrapper contents in-place', () => {
    const tr = buildRow();

    const newStatus = { currentBranch: 'main', localCommits: 3, unfetchedCommits: 0, modifiedFiles: 0, lastActivity: null, hasConflicts: false };
    updateRepoStatusCells(tr, DEFAULT_OPTS.repoId, newStatus, false, null);

    const badgeWrapper = tr.querySelector(`div[data-repo-id="${CSS.escape(DEFAULT_OPTS.repoId)}"]`);
    assert.ok(badgeWrapper, 'badge wrapper should still be present after update');
    assert.ok(badgeWrapper.firstChild, 'badge wrapper should have child content after update');
});

// ---------------------------------------------------------------------------
// AC7 — isStable flag governs branch cell rendering
// ---------------------------------------------------------------------------

test('AC7: when isStable is false and onBranchCellClick provided, branch cell has a trigger button', () => {
    const clicks = [];
    const { branchCell } = buildCells({
        isStable:          false,
        onBranchCellClick: (el, id, branch) => clicks.push({ el, id, branch }),
    });

    const btn = branchCell.querySelector('button.branch-switch-trigger');
    assert.ok(btn, 'expected a .branch-switch-trigger button in the branch cell');
    assert.equal(btn.textContent, 'main', 'trigger button should show the branch name');

    btn.click();
    assert.equal(clicks.length, 1, 'click handler should have been called once');
    assert.equal(clicks[0].id, DEFAULT_OPTS.repoId);
    assert.equal(clicks[0].branch, 'main');
});

test('AC7: when isStable is true, branch cell renders plain text (no trigger button)', () => {
    const { branchCell } = buildCells({
        isStable:          true,
        onBranchCellClick: () => { assert.fail('handler should not be wired for STABLE'); },
    });

    const btn = branchCell.querySelector('button');
    assert.equal(btn, null, 'no <button> should exist in the branch cell for a STABLE workspace');
    assert.equal(branchCell.textContent.trim(), 'main', 'plain text should be the branch name');
});

test('AC7: when onBranchCellClick is not provided, branch cell renders plain text even if isStable is false', () => {
    const { branchCell } = buildCells({ isStable: false, onBranchCellClick: undefined });

    const btn = branchCell.querySelector('button');
    assert.equal(btn, null, 'no trigger button expected when onBranchCellClick is absent');
    assert.equal(branchCell.textContent.trim(), 'main');
});

test('AC7: when statusInfo has no currentBranch, branch cell shows em-dash', () => {
    const { branchCell } = buildCells({ statusInfo: null, isStable: false, onBranchCellClick: () => {} });

    const btn = branchCell.querySelector('button');
    assert.equal(btn, null, 'no trigger when branch is null');
    assert.equal(branchCell.textContent.trim(), '—');
});

// ---------------------------------------------------------------------------
// AC8 — Git GUI button calls api.workspaces.launch.githubDesktop
// ---------------------------------------------------------------------------

test('AC8: clicking the "Git GUI" button calls api.workspaces.launch.githubDesktop with projectId, wid, repoId', async () => {
    const { actionsCell } = buildCells({ repoId: 'beta-repo', projectId: 'proj-x', wid: 'FEAT' });

    const btn = actionsCell.querySelector('button.btn');
    assert.ok(btn, 'expected a button inside actionsCell');
    assert.equal(btn.textContent.trim(), 'Git GUI');

    btn.click();

    // Drain microtask queue for the async click handler.
    for (let i = 0; i < 5; i++) {
        await new Promise((r) => Promise.resolve().then(r));
    }

    assert.equal(ghDesktopCalls.length, 1, 'expected exactly 1 launch.githubDesktop call');
    assert.equal(ghDesktopCalls[0].projectId, 'proj-x');
    assert.equal(ghDesktopCalls[0].wid,       'FEAT');
    assert.equal(ghDesktopCalls[0].repoId,    'beta-repo');
});

test('AC8: after launch.githubDesktop resolves, the "Git GUI" button is re-enabled', async () => {
    const { actionsCell } = buildCells();

    const btn = [...actionsCell.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Git GUI');
    assert.ok(btn);

    btn.click();
    for (let i = 0; i < 10; i++) {
        await new Promise((r) => Promise.resolve().then(r));
    }

    assert.equal(btn.disabled,           false,    'button should be re-enabled');
    assert.equal(btn.textContent.trim(), 'Git GUI', 'label should be restored');
});

test('AC8: when launch.githubDesktop fails and onError is provided, the callback is invoked with the error message', async () => {
    ghDesktopShouldFail  = true;
    ghDesktopFailMessage = 'GitHub Desktop not found';

    const errors = [];
    const { actionsCell } = buildCells({ onError: (msg) => errors.push(msg) });

    const btn = [...actionsCell.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Git GUI');
    assert.ok(btn);

    btn.click();
    for (let i = 0; i < 10; i++) {
        await new Promise((r) => Promise.resolve().then(r));
    }

    assert.equal(errors.length, 1, 'onError should have been called exactly once');
    assert.equal(errors[0], 'GitHub Desktop not found', 'error message should be forwarded');
    assert.equal(btn.disabled,           false,    'button should be re-enabled after error');
    assert.equal(btn.textContent.trim(), 'Git GUI', 'label should be restored after error');
});

test('AC8: when launch.githubDesktop fails and onError is NOT provided, no uncaught exception is thrown', async () => {
    ghDesktopShouldFail  = true;
    ghDesktopFailMessage = 'GitHub Desktop not found';

    // No onError provided — error should be silently swallowed.
    const { actionsCell } = buildCells();

    const btn = [...actionsCell.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Git GUI');
    assert.ok(btn);

    btn.click();
    for (let i = 0; i < 10; i++) {
        await new Promise((r) => Promise.resolve().then(r));
    }

    // If we reach here without an unhandled rejection the test passes.
    assert.equal(btn.disabled,           false,    'button should be re-enabled');
    assert.equal(btn.textContent.trim(), 'Git GUI', 'label should be restored');
});

// ---------------------------------------------------------------------------
// AC9 — Browse button conditionally rendered
// ---------------------------------------------------------------------------

test('AC9: no Browse button when webserverUrl is falsy', () => {
    const { actionsCell } = buildCells({ webserverUrl: null });

    const buttons = [...actionsCell.querySelectorAll('button')];
    const browseBtn = buttons.find((b) => b.textContent.trim() === 'Browse');
    assert.equal(browseBtn, undefined, 'Browse button should not exist when webserverUrl is null');
});

test('AC9: Browse button is present when webserverUrl is truthy', () => {
    const { actionsCell } = buildCells({ webserverUrl: 'http://localhost:8080' });

    const browseBtn = [...actionsCell.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Browse');
    assert.ok(browseBtn, 'expected a Browse button when webserverUrl is set');
});

test('AC9: clicking Browse opens the correct URL pattern', () => {
    const { actionsCell } = buildCells({
        repoId:       'gamma-repo',
        projectId:    'proj-y',
        wid:          'QA',
        webserverUrl: 'http://web.local',
    });

    const browseBtn = [...actionsCell.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Browse');
    assert.ok(browseBtn);
    browseBtn.click();

    assert.equal(openedUrls.length, 1, 'window.open should have been called once');
    const expectedUrl = `http://web.local/${encodeURIComponent('proj-y')}/${encodeURIComponent('QA')}/${encodeURIComponent('gamma-repo')}/`;
    assert.equal(openedUrls[0].url,    expectedUrl, `URL mismatch: ${openedUrls[0].url}`);
    assert.equal(openedUrls[0].target, '_blank');
});

test('AC9: Browse button appears before Git GUI button in the DOM', () => {
    const { actionsCell } = buildCells({ webserverUrl: 'http://localhost' });

    const buttons = [...actionsCell.querySelectorAll('button')];
    const browseIdx  = buttons.findIndex((b) => b.textContent.trim() === 'Browse');
    const gitGuiIdx  = buttons.findIndex((b) => b.textContent.trim() === 'Git GUI');

    assert.ok(browseIdx !== -1, 'Browse button must exist');
    assert.ok(gitGuiIdx !== -1, 'Git GUI button must exist');
    assert.ok(browseIdx < gitGuiIdx, 'Browse should appear before Git GUI');
});

// ---------------------------------------------------------------------------
// AC10 — No innerHTML assignments (all text via textContent)
// ---------------------------------------------------------------------------

test('AC10: makeBranchTrigger sets text via textContent, not innerHTML', () => {
    // Confirm the value is set without HTML entity encoding side-effects
    // by supplying a string that would look different if processed as HTML.
    const dangerous = '<b>branch</b>';
    const btn = makeBranchTrigger(dangerous, 'aria');

    // textContent should return the raw string, not the parsed text content
    // that innerHTML would produce.
    assert.equal(btn.textContent, dangerous, 'textContent must equal the raw string');
    assert.equal(btn.innerHTML,   dangerous.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        'innerHTML should be the HTML-escaped version of the raw string');
});

test('AC10: branch cell plain-text mode sets textContent, not innerHTML', () => {
    const raw = '<i>main</i>';
    const { branchCell } = buildCells({
        statusInfo: { currentBranch: raw, localCommits: 0, unfetchedCommits: 0, modifiedFiles: 0, lastActivity: null, hasConflicts: false },
        isStable:   true,
    });

    // If textContent was used, the raw string is stored literally; innerHTML
    // would produce the encoded equivalent.
    assert.equal(branchCell.textContent, raw, 'branch cell textContent must be the raw string');
});
