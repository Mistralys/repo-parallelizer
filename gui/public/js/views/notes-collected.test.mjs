/**
 * Unit tests for the Notes Collected View (WP-008).
 *
 * Covers all acceptance criteria:
 *   AC1 — Two-panel layout is rendered (.notes-view, .notes-sidebar, .notes-main).
 *   AC2 — Sidebar lists workspaces grouped by project (collapsible <details>).
 *   AC3 — Sidebar items with notes carry the .has-notes class.
 *   AC4 — Clicking a sidebar item for a workspace with a card scrolls to it.
 *   AC5 — Clicking a sidebar item without a card creates a new empty card.
 *   AC6 — Each card has a link to #/projects/:pid/workspaces/:wid.
 *   AC7 — Textarea auto-saves after the 1000 ms debounce with status indicator.
 *   AC8 — Saving empty removes the card and clears the sidebar .has-notes class.
 *   AC9 — On initial load only non-empty note cards are rendered.
 *
 * Run individually with:
 *   node --test 'gui/public/js/views/notes-collected.test.mjs'
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup — install globals before any module is loaded
// ---------------------------------------------------------------------------

const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="toast-container"></div><div id="app"></div></body></html>',
    { url: 'http://localhost/' },
);

const { window } = dom;

globalThis.document    = window.document;
globalThis.window      = window;
globalThis.location    = window.location;
globalThis.HTMLElement = window.HTMLElement;
globalThis.CSS         = window.CSS ?? { escape: (s) => s.replace(/["\\]/g, '\\$&') };
globalThis.Event       = window.Event;

// ---------------------------------------------------------------------------
// Timer stubs — allow fine-grained debounce control in tests
// ---------------------------------------------------------------------------

let _pendingDebounce       = null;
let _originalSetTimeout    = null;
let _originalClearTimeout  = null;

/**
 * Immediately execute the pending debounce callback and await the result.
 */
async function flushDebounce() {
    if (_pendingDebounce) {
        const fn = _pendingDebounce;
        _pendingDebounce = null;
        await fn();
    }
}

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
// Import dependencies and stub API
// ---------------------------------------------------------------------------

const { api } = await import('../api.js');

/** Calls recorded by api.workspaces.update spy. */
const updateCalls = [];
let updateShouldFail = false;

const defaultUpdateStub = async (projectId, wid, data) => {
    updateCalls.push({ projectId, wid, data });
    if (updateShouldFail) throw new Error('Storage error');
    return { WorkspaceID: wid };
};
api.workspaces.update = defaultUpdateStub;

/** Simulated notes response — two projects, three workspaces. */
let notesResponseStub = {
    Projects: [
        {
            ProjectId:   'proj-a',
            ProjectName: 'Project A',
            Workspaces: [
                { WorkspaceId: 'STABLE', Notes: '' },
                { WorkspaceId: 'DEV',    Notes: 'some notes' },
            ],
        },
        {
            ProjectId:   'proj-b',
            ProjectName: 'Project B',
            Workspaces: [
                { WorkspaceId: 'STABLE', Notes: '' },
            ],
        },
    ],
};
api.notes = { list: async () => notesResponseStub };

const { renderNotesCollected } = await import('./notes-collected.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const container = window.document.getElementById('app');

/**
 * Render the notes-collected view and await the async data fetch.
 */
async function render() {
    // Stub setTimeout so debounce can be flushed synchronously.
    _pendingDebounce     = null;
    _originalSetTimeout  = globalThis.setTimeout;
    _originalClearTimeout = globalThis.clearTimeout;

    let _timerId = 2000;
    globalThis.setTimeout = (fn, _delay) => {
        _pendingDebounce = fn;
        return ++_timerId;
    };
    globalThis.clearTimeout = (id) => {
        if (_timerId === id) _pendingDebounce = null;
    };

    // Stub scrollIntoView — not available in jsdom.
    const origScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = () => {};

    // Stub focus so it does not throw in jsdom.
    window.HTMLElement.prototype.focus = function () {};

    const result = renderNotesCollected(container, {});
    // Let the api.notes.list() promise resolve.
    await new Promise((resolve) => _originalSetTimeout(resolve, 0));
    await result;

    // Restore scrollIntoView if it existed.
    if (origScrollIntoView !== undefined) {
        window.HTMLElement.prototype.scrollIntoView = origScrollIntoView;
    }
}

function restoreTimers() {
    if (_originalSetTimeout)   globalThis.setTimeout   = _originalSetTimeout;
    if (_originalClearTimeout) globalThis.clearTimeout = _originalClearTimeout;
    _pendingDebounce = null;
}

function clearContainer() {
    while (container.firstChild) container.removeChild(container.firstChild);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
    clearContainer();
    updateCalls.length = 0;
    updateShouldFail   = false;
    api.workspaces.update = defaultUpdateStub;
    notesResponseStub = {
        Projects: [
            {
                ProjectId:   'proj-a',
                ProjectName: 'Project A',
                Workspaces: [
                    { WorkspaceId: 'STABLE', Notes: '' },
                    { WorkspaceId: 'DEV',    Notes: 'some notes' },
                ],
            },
            {
                ProjectId:   'proj-b',
                ProjectName: 'Project B',
                Workspaces: [
                    { WorkspaceId: 'STABLE', Notes: '' },
                ],
            },
        ],
    };
    api.notes.list = async () => notesResponseStub;
});

// ---- AC1: Two-panel layout ----

test('AC1: renders .notes-view wrapper with .notes-sidebar and .notes-main', async () => {
    await render();
    const view    = container.querySelector('.notes-view');
    const sidebar = container.querySelector('.notes-sidebar');
    const main    = container.querySelector('.notes-main');
    assert.ok(view,    '.notes-view should be rendered');
    assert.ok(sidebar, '.notes-sidebar should be rendered');
    assert.ok(main,    '.notes-main should be rendered');
    restoreTimers();
});

// ---- AC2: Sidebar grouped by project ----

test('AC2: sidebar has one collapsible group per project', async () => {
    await render();
    const groups = container.querySelectorAll('.notes-sidebar-group');
    assert.strictEqual(groups.length, 2);
    restoreTimers();
});

test('AC2: each group contains the correct workspace buttons', async () => {
    await render();
    const groups = container.querySelectorAll('.notes-sidebar-group');
    const firstGroupBtns = groups[0].querySelectorAll('.notes-sidebar-btn');
    assert.strictEqual(firstGroupBtns.length, 2, 'proj-a has 2 workspaces');
    const secondGroupBtns = groups[1].querySelectorAll('.notes-sidebar-btn');
    assert.strictEqual(secondGroupBtns.length, 1, 'proj-b has 1 workspace');
    restoreTimers();
});

test('AC2: groups are open by default', async () => {
    await render();
    const groups = container.querySelectorAll('details.notes-sidebar-group');
    for (const group of groups) {
        assert.strictEqual(group.open, true, 'groups should be open by default');
    }
    restoreTimers();
});

// ---- AC3: Visual distinction for workspaces with notes ----

test('AC3: sidebar item for workspace with notes has .has-notes class', async () => {
    await render();
    const items = container.querySelectorAll('.notes-sidebar-item');
    const devItem = Array.from(items).find(
        (li) => li.dataset.projectId === 'proj-a' && li.dataset.workspaceId === 'DEV',
    );
    assert.ok(devItem, 'DEV workspace item should exist in sidebar');
    assert.ok(devItem.classList.contains('has-notes'), 'DEV item should have .has-notes');
    restoreTimers();
});

test('AC3: sidebar item for workspace without notes does NOT have .has-notes class', async () => {
    await render();
    const items = container.querySelectorAll('.notes-sidebar-item');
    const stableItem = Array.from(items).find(
        (li) => li.dataset.projectId === 'proj-a' && li.dataset.workspaceId === 'STABLE',
    );
    assert.ok(stableItem, 'STABLE workspace item should exist in sidebar');
    assert.ok(!stableItem.classList.contains('has-notes'), 'STABLE item should NOT have .has-notes');
    restoreTimers();
});

// ---- AC4: Clicking sidebar item with existing card scrolls to it ----

test('AC4: clicking sidebar item for a workspace with a card does not create a duplicate card', async () => {
    await render();
    // DEV already has a card on initial load.
    const cardsBefore = container.querySelectorAll('.notes-card');
    const countBefore = cardsBefore.length;

    const devBtn = Array.from(container.querySelectorAll('.notes-sidebar-btn')).find(
        (btn) => btn.closest('.notes-sidebar-item').dataset.workspaceId === 'DEV',
    );
    devBtn.click();

    const cardsAfter = container.querySelectorAll('.notes-card');
    assert.strictEqual(cardsAfter.length, countBefore, 'no duplicate card should be created');
    restoreTimers();
});

// ---- AC5: Clicking sidebar item without a card creates one ----

test('AC5: clicking sidebar item for a workspace without a card creates a new card', async () => {
    await render();
    const stableBtn = Array.from(container.querySelectorAll('.notes-sidebar-btn')).find(
        (btn) => btn.closest('.notes-sidebar-item').dataset.projectId === 'proj-a'
            && btn.closest('.notes-sidebar-item').dataset.workspaceId === 'STABLE',
    );
    stableBtn.click();

    const stableCard = Array.from(container.querySelectorAll('.notes-card')).find(
        (c) => c.dataset.projectId === 'proj-a' && c.dataset.workspaceId === 'STABLE',
    );
    assert.ok(stableCard, 'a new card for STABLE should be created');
    restoreTimers();
});

test('AC5: new card textarea is empty and present', async () => {
    await render();
    const stableBtn = Array.from(container.querySelectorAll('.notes-sidebar-btn')).find(
        (btn) => btn.closest('.notes-sidebar-item').dataset.projectId === 'proj-a'
            && btn.closest('.notes-sidebar-item').dataset.workspaceId === 'STABLE',
    );
    stableBtn.click();

    const stableCard = Array.from(container.querySelectorAll('.notes-card')).find(
        (c) => c.dataset.projectId === 'proj-a' && c.dataset.workspaceId === 'STABLE',
    );
    const ta = stableCard.querySelector('.notes-card-textarea');
    assert.ok(ta, 'card should contain a textarea');
    assert.strictEqual(ta.value, '', 'new card textarea should be empty');
    restoreTimers();
});

// ---- AC6: Card header link to workspace detail ----

test('AC6: card header contains a link to the workspace detail view', async () => {
    await render();
    const devCard = Array.from(container.querySelectorAll('.notes-card')).find(
        (c) => c.dataset.projectId === 'proj-a' && c.dataset.workspaceId === 'DEV',
    );
    assert.ok(devCard, 'DEV card should be rendered');

    const link = devCard.querySelector('a.notes-card-ws-link');
    assert.ok(link, 'card should contain a .notes-card-ws-link anchor');
    assert.ok(
        link.href.includes('/projects/proj-a/workspaces/DEV'),
        'link href should point to workspace detail',
    );
    restoreTimers();
});

// ---- AC7: Auto-save with status indicator ----

test('AC7: typing triggers api.workspaces.update after the debounce', async () => {
    await render();
    const devCard = Array.from(container.querySelectorAll('.notes-card')).find(
        (c) => c.dataset.workspaceId === 'DEV',
    );
    const ta = devCard.querySelector('.notes-card-textarea');

    ta.value = 'updated notes';
    ta.dispatchEvent(new window.Event('input'));

    // Debounce has not fired yet.
    assert.strictEqual(updateCalls.length, 0);

    await flushDebounce();

    assert.strictEqual(updateCalls.length, 1);
    assert.strictEqual(updateCalls[0].projectId, 'proj-a');
    assert.strictEqual(updateCalls[0].wid, 'DEV');
    assert.deepStrictEqual(updateCalls[0].data, { notes: 'updated notes' });
    restoreTimers();
});

test('AC7: status indicator shows "Saving…" while save is in flight', async () => {
    let resolveUpdate;
    api.workspaces.update = async (_pid, _wid, _data) => {
        updateCalls.push({ data: _data });
        await new Promise((resolve) => { resolveUpdate = resolve; });
        return {};
    };

    await render();
    const devCard = Array.from(container.querySelectorAll('.notes-card')).find(
        (c) => c.dataset.workspaceId === 'DEV',
    );
    const ta       = devCard.querySelector('.notes-card-textarea');
    const statusEl = devCard.querySelector('.notes-card-status');

    ta.value = 'in flight';
    ta.dispatchEvent(new window.Event('input'));

    // Fire the debounce but do NOT await — let it block on the held update.
    const savedPending = _pendingDebounce;
    _pendingDebounce = null;
    savedPending(); // not awaited intentionally

    // One tick so the async handler reaches the first await (api call).
    await new Promise((resolve) => _originalSetTimeout(resolve, 0));

    assert.strictEqual(statusEl.hidden, false);
    assert.strictEqual(statusEl.textContent, 'Saving\u2026');

    resolveUpdate();
    await new Promise((resolve) => _originalSetTimeout(resolve, 0));
    restoreTimers();
});

test('AC7: status indicator shows "Saved" after a successful save', async () => {
    await render();
    const devCard = Array.from(container.querySelectorAll('.notes-card')).find(
        (c) => c.dataset.workspaceId === 'DEV',
    );
    const ta       = devCard.querySelector('.notes-card-textarea');
    const statusEl = devCard.querySelector('.notes-card-status');

    ta.value = 'final notes';
    ta.dispatchEvent(new window.Event('input'));
    await flushDebounce();

    assert.strictEqual(statusEl.hidden, false);
    assert.strictEqual(statusEl.textContent, 'Saved');
    restoreTimers();
});

test('AC7: status indicator shows "Save failed." when api call rejects', async () => {
    updateShouldFail = true;
    await render();
    const devCard = Array.from(container.querySelectorAll('.notes-card')).find(
        (c) => c.dataset.workspaceId === 'DEV',
    );
    const ta       = devCard.querySelector('.notes-card-textarea');
    const statusEl = devCard.querySelector('.notes-card-status');

    ta.value = 'will fail';
    ta.dispatchEvent(new window.Event('input'));
    await flushDebounce();

    assert.strictEqual(statusEl.textContent, 'Save failed.');
    restoreTimers();
});

// ---- AC8: Saving empty removes card and clears sidebar indicator ----

test('AC8: saving empty text removes the card from the main panel', async () => {
    await render();
    const devCard = Array.from(container.querySelectorAll('.notes-card')).find(
        (c) => c.dataset.workspaceId === 'DEV',
    );
    assert.ok(devCard, 'DEV card should be present before save');

    const ta = devCard.querySelector('.notes-card-textarea');
    ta.value = '';
    ta.dispatchEvent(new window.Event('input'));
    await flushDebounce();

    const cardAfter = Array.from(container.querySelectorAll('.notes-card')).find(
        (c) => c.dataset.workspaceId === 'DEV',
    );
    assert.strictEqual(cardAfter, undefined, 'DEV card should be removed after empty save');
    restoreTimers();
});

test('AC8: saving empty clears .has-notes on the sidebar item', async () => {
    await render();
    const devCard = Array.from(container.querySelectorAll('.notes-card')).find(
        (c) => c.dataset.workspaceId === 'DEV',
    );
    const ta = devCard.querySelector('.notes-card-textarea');
    ta.value = '';
    ta.dispatchEvent(new window.Event('input'));
    await flushDebounce();

    const devItem = Array.from(container.querySelectorAll('.notes-sidebar-item')).find(
        (li) => li.dataset.projectId === 'proj-a' && li.dataset.workspaceId === 'DEV',
    );
    assert.ok(devItem, 'DEV sidebar item should still exist');
    assert.ok(!devItem.classList.contains('has-notes'), '.has-notes should be removed from sidebar item');
    restoreTimers();
});

test('AC8: empty-state message appears when all cards are removed', async () => {
    // Only one workspace has notes.
    notesResponseStub = {
        Projects: [
            {
                ProjectId:   'single',
                ProjectName: 'Single',
                Workspaces: [{ WorkspaceId: 'WS-1', Notes: 'hello' }],
            },
        ],
    };
    await render();

    const card = container.querySelector('.notes-card');
    assert.ok(card, 'initial card should be present');

    const ta = card.querySelector('.notes-card-textarea');
    ta.value = '';
    ta.dispatchEvent(new window.Event('input'));
    await flushDebounce();

    const empty = container.querySelector('.notes-empty-state');
    assert.ok(empty, '.notes-empty-state should appear after last card is removed');
    restoreTimers();
});

// ---- AC9: Initial load only shows non-empty cards ----

test('AC9: on initial load, only non-empty notes produce cards', async () => {
    await render();
    const cards = container.querySelectorAll('.notes-card');
    // Only proj-a/DEV has notes ('some notes').
    assert.strictEqual(cards.length, 1, 'only one card should be rendered initially');
    assert.strictEqual(cards[0].dataset.projectId,   'proj-a');
    assert.strictEqual(cards[0].dataset.workspaceId, 'DEV');
    restoreTimers();
});

test('AC9: empty-state message shown when no workspaces have notes on load', async () => {
    notesResponseStub = {
        Projects: [
            {
                ProjectId:   'empty-proj',
                ProjectName: 'Empty Proj',
                Workspaces: [{ WorkspaceId: 'STABLE', Notes: '' }],
            },
        ],
    };
    await render();

    const cards = container.querySelectorAll('.notes-card');
    assert.strictEqual(cards.length, 0, 'no cards should render when all notes are empty');

    const empty = container.querySelector('.notes-empty-state');
    assert.ok(empty, '.notes-empty-state should be shown');
    restoreTimers();
});
