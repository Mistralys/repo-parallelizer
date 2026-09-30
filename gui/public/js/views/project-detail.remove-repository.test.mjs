/**
 * Unit tests for views/project-detail.js — Remove-repository confirmation — WP-005.
 *
 * The Remove-repository confirmation dialog previously read "The repository
 * itself is not deleted", which said nothing about the fate of the repo's
 * cloned folders on disk. After routing the project-level unlink through
 * RepositoryOrchestrator (WP-003/WP-004), the action deletes those clone
 * folders — so the confirmation text must say so, while also stating that the
 * global repository record survives.
 *
 * Acceptance Criteria verified:
 *   AC1 — The confirmation states that the repository's cloned folders are
 *         deleted from disk.
 *   AC2 — The confirmation states that the global repository record is
 *         retained.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/views/project-detail.remove-repository.test.mjs
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
globalThis.MouseEvent  = window.MouseEvent;
globalThis.CSS = window.CSS ?? { escape: (s) => s.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '\\$&') };

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
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID   = 'proj-a';
const PROJECT_NAME = 'Project A';
const REPO_ID       = 'my-repo';
const REPO_NAME     = 'My Repo';

// ---------------------------------------------------------------------------
// Import API and set up mocks
// ---------------------------------------------------------------------------

const { api } = await import('../api.js');

let mockProjectDetail = {
    Id: PROJECT_ID,
    Name: PROJECT_NAME,
    Description: '',
    Repositories: [REPO_ID],
};
let mockWorkspacesList = [];
let mockAllRepos = [{ Id: REPO_ID, Name: REPO_NAME, Url: 'https://example.com/my-repo.git' }];

const removeRepositoryCalls = [];

api.projects.get             = async () => mockProjectDetail;
api.workspaces.list          = async () => mockWorkspacesList;
api.repositories.list        = async () => mockAllRepos;
api.projects.removeRepository = async (projectId, repoId) => {
    removeRepositoryCalls.push({ projectId, repoId });
    return {};
};

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { renderProjectDetail } = await import('./project-detail.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render the view into a fresh container and wait for async bootstrap.
 *
 * @returns {Promise<HTMLElement>}
 */
async function renderAndWait() {
    const container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);

    renderProjectDetail(container, { id: PROJECT_ID });

    // Flush all pending micro-tasks (Promise chains).
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    return container;
}

/** Clean up all rendered containers and any leftover confirm-dialog overlays after each test. */
function cleanupContainers() {
    document.body.querySelectorAll('#app').forEach((el) => el.remove());
    document.body.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
}

function dispatchClick(target) {
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
}

beforeEach(() => {
    removeRepositoryCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('AC1/AC2 — Remove-repository confirmation states clone-folder deletion and record retention', async () => {
    const container = await renderAndWait();
    try {
        const removeBtn = Array.from(container.querySelectorAll('button'))
            .find((btn) => btn.textContent === 'Remove');
        assert.ok(removeBtn, 'Remove button should be rendered for the repository row');

        dispatchClick(removeBtn);

        // The confirm dialog is rendered synchronously onto document.body.
        const bodyEl = document.body.querySelector('#confirm-dialog-body');
        assert.ok(bodyEl, 'Confirm dialog body should be rendered');

        assert.match(
            bodyEl.textContent,
            /deleted from disk/i,
            'Confirmation should state that the cloned folders are deleted from disk',
        );
        assert.match(
            bodyEl.textContent,
            /repository record.*retained/i,
            'Confirmation should state that the global repository record is retained',
        );

        // Cancel to avoid triggering the actual removal for this assertion-only test.
        const cancelBtn = Array.from(document.body.querySelectorAll('.modal-actions button'))
            .find((btn) => btn.textContent === 'Cancel');
        assert.ok(cancelBtn, 'Cancel button should exist');
        dispatchClick(cancelBtn);

        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.strictEqual(removeRepositoryCalls.length, 0, 'Cancelling should not call removeRepository');
    } finally {
        cleanupContainers();
    }
});

test('Confirming the dialog calls api.projects.removeRepository with the project and repo IDs', async () => {
    const container = await renderAndWait();
    try {
        const removeBtn = Array.from(container.querySelectorAll('button'))
            .find((btn) => btn.textContent === 'Remove');
        dispatchClick(removeBtn);

        const confirmBtn = Array.from(document.body.querySelectorAll('.modal-actions button'))
            .find((btn) => btn.textContent === 'Confirm');
        assert.ok(confirmBtn, 'Confirm button should exist');
        dispatchClick(confirmBtn);

        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.strictEqual(removeRepositoryCalls.length, 1, 'removeRepository should have been called once');
        assert.deepStrictEqual(removeRepositoryCalls[0], { projectId: PROJECT_ID, repoId: REPO_ID });
    } finally {
        cleanupContainers();
    }
});
