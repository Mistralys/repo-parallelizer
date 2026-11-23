/**
 * Unit tests for views/repository-files-section.js — WP-014.
 *
 * Acceptance Criteria verified:
 *   AC-1 — The section renders the git-only intro text verbatim, and while
 *          sync is disabled the list is read-only with a visible enable
 *          hint and no mutation controls are actionable.
 *   AC-2 — A save (add/update/delete) calls the WP-012 API client, then
 *          asks the caller (via `onChanged`) to refresh the info-sync
 *          section's status.
 *   AC-3 — This suite covers: the intro text, the read-only-while-disabled
 *          state, CRUD calls, delete confirmation, the `sh` hint, the
 *          status-refresh callback, and cleanup.
 *   AC-4 — The Executable checkbox is pre-checked from the heuristic
 *          default when a new file is created.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/views/repository-files-section.test.mjs
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
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.MouseEvent  = window.MouseEvent;

globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => ({}),
});

const { api } = await import('../api.js');
const { buildRepositoryFilesSection, normaliseRepositoryFile } = await import('./repository-files-section.js');

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const REPO = { id: 'my-repo', name: 'My Repo' };

function rawFile(overrides = {}) {
    return {
        Id: 'file-1', Directory: 'scripts', FileName: 'run.sh', Label: 'Run',
        Description: '', Content: '#!/bin/sh\necho hi\n', ListInAgents: false, Executable: true,
        ...overrides,
    };
}

const tick = async (n = 3) => {
    for (let i = 0; i < n; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

let listCalls, createCalls, updateCalls, removeCalls;

beforeEach(() => {
    listCalls = [];
    createCalls = [];
    updateCalls = [];
    removeCalls = [];
    api.repositories.files.list   = async (id) => { listCalls.push(id); return [rawFile()]; };
    api.repositories.files.create = async (id, data) => { createCalls.push({ id, data }); return rawFile({ Id: 'new-id', ...toRaw(data) }); };
    api.repositories.files.update = async (id, fileId, data) => { updateCalls.push({ id, fileId, data }); return rawFile({ Id: fileId, ...toRaw(data) }); };
    api.repositories.files.remove = async (id, fileId) => { removeCalls.push({ id, fileId }); };
});

/** Minimal camelCase→PascalCase bridge, just enough for the mocks above. */
function toRaw(data) {
    return {
        Directory: data.directory, FileName: data.fileName, Label: data.label,
        Description: data.description, Content: data.content,
        ListInAgents: data.listInAgents, Executable: data.executable,
    };
}

async function mount(status = { enabled: true }, options = {}) {
    const { element, cleanup } = buildRepositoryFilesSection(REPO, status, options);
    document.body.appendChild(element);
    await tick();
    return { element, cleanup };
}

// ---------------------------------------------------------------------------
// normaliseRepositoryFile()
// ---------------------------------------------------------------------------

test('normaliseRepositoryFile: maps PascalCase fields, including the explicit Executable flag', () => {
    const f = normaliseRepositoryFile(rawFile({ Executable: true }));
    assert.deepEqual(f, {
        id: 'file-1', directory: 'scripts', fileName: 'run.sh', label: 'Run',
        description: '', content: '#!/bin/sh\necho hi\n', listInAgents: false, executable: true,
    });
});

// ---------------------------------------------------------------------------
// Intro text (AC-1)
// ---------------------------------------------------------------------------

test('intro text states the git-only contract verbatim', async () => {
    const { element, cleanup } = await mount();
    try {
        const intro = element.querySelector('.repository-files-intro');
        assert.ok(intro);
        assert.equal(
            intro.textContent,
            'Files are written to the repository\'s .workspace/files/ folder and reach workspaces ' +
            'only after Commit & Push and a pull. Paralizer never copies them into workspaces.',
        );
    } finally {
        cleanup();
        element.remove();
    }
});

// ---------------------------------------------------------------------------
// Read-only while disabled (AC-1)
// ---------------------------------------------------------------------------

test('read-only while sync is disabled: shows the enable hint and disables every mutation control', async () => {
    const { element, cleanup } = await mount({ enabled: false });
    try {
        const hint = element.querySelector('.repository-files-enable-hint');
        assert.ok(hint, 'an enable hint should be visible');
        assert.match(hint.textContent, /Enable workspace info sync/);

        const addBtn = [...element.querySelectorAll('button')].find((b) => b.textContent === '+ Add File');
        assert.ok(addBtn.disabled, 'Add File button should be disabled while sync is disabled');

        const editBtn = element.querySelector('button[aria-label="Edit Run"]');
        const delBtn = element.querySelector('button[aria-label="Delete Run"]');
        assert.ok(editBtn.disabled, 'Edit button should be disabled while sync is disabled');
        assert.ok(delBtn.disabled, 'Delete button should be disabled while sync is disabled');

        // The list itself stays visible (read-only, not hidden).
        assert.ok(element.querySelector('table.custom-files-table'));
    } finally {
        cleanup();
        element.remove();
    }
});

test('enabled: Add File and the table row actions are actionable', async () => {
    const { element, cleanup } = await mount({ enabled: true });
    try {
        const addBtn = [...element.querySelectorAll('button')].find((b) => b.textContent === '+ Add File');
        assert.equal(addBtn.disabled, false);

        const editBtn = element.querySelector('button[aria-label="Edit Run"]');
        assert.equal(editBtn.disabled, false);
    } finally {
        cleanup();
        element.remove();
    }
});

test('a null/missing status is treated the same as disabled (safer default)', async () => {
    const { element, cleanup } = await mount(null);
    try {
        assert.ok(element.querySelector('.repository-files-enable-hint'));
    } finally {
        cleanup();
        element.remove();
    }
});

// ---------------------------------------------------------------------------
// The "Run with sh ..." hint (plan step 8)
// ---------------------------------------------------------------------------

test('the table shows the "sh .workspace/files/<path>" hint for executable files, an em dash otherwise', async () => {
    api.repositories.files.list = async () => [
        rawFile({ Id: 'a', Label: 'Executable', Executable: true, Directory: 'scripts', FileName: 'run.sh' }),
        rawFile({ Id: 'b', Label: 'Plain', Executable: false, Directory: '', FileName: 'notes.txt' }),
    ];
    const { element, cleanup } = await mount({ enabled: true });
    try {
        const headers = [...element.querySelectorAll('th')].map((th) => th.textContent);
        assert.ok(headers.includes('Run with'));

        const rows = [...element.querySelectorAll('tbody tr')];
        assert.match(rows[0].textContent, /sh \.workspace\/files\/scripts\/run\.sh/);
        assert.match(rows[1].textContent, /—/);
    } finally {
        cleanup();
        element.remove();
    }
});

// ---------------------------------------------------------------------------
// CRUD calls + status-refresh callback (AC-2)
// ---------------------------------------------------------------------------

test('add: calls api.repositories.files.create and then onChanged', async () => {
    let changedCalls = 0;
    const { element, cleanup } = await mount({ enabled: true }, { onChanged: () => { changedCalls += 1; } });
    try {
        const addBtn = [...element.querySelectorAll('button')].find((b) => b.textContent === '+ Add File');
        addBtn.click();

        const form = element.querySelector('form.custom-file-form');
        assert.ok(form);
        form.querySelector('[name="label"]').value = 'Install deps';
        form.querySelector('[name="fileName"]').value = 'vendor-install.sh';
        form.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
        await tick();

        assert.equal(createCalls.length, 1);
        assert.equal(createCalls[0].id, 'my-repo');
        assert.equal(createCalls[0].data.label, 'Install deps');
        assert.equal(changedCalls, 1, 'onChanged should fire once after a successful add');
    } finally {
        cleanup();
        element.remove();
    }
});

test('edit: calls api.repositories.files.update with the file id and then onChanged', async () => {
    let changedCalls = 0;
    const { element, cleanup } = await mount({ enabled: true }, { onChanged: () => { changedCalls += 1; } });
    try {
        element.querySelector('button[aria-label="Edit Run"]').click();
        const form = element.querySelector('form.custom-file-form');
        assert.ok(form);
        form.querySelector('[name="label"]').value = 'Run (updated)';
        form.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
        await tick();

        assert.equal(updateCalls.length, 1);
        assert.equal(updateCalls[0].id, 'my-repo');
        assert.equal(updateCalls[0].fileId, 'file-1');
        assert.equal(updateCalls[0].data.label, 'Run (updated)');
        assert.equal(changedCalls, 1);
    } finally {
        cleanup();
        element.remove();
    }
});

test('delete: shows a confirmation, then calls api.repositories.files.remove and onChanged', async () => {
    let changedCalls = 0;
    const { element, cleanup } = await mount({ enabled: true }, { onChanged: () => { changedCalls += 1; } });
    try {
        element.querySelector('button[aria-label="Delete Run"]').click();
        await tick();

        // showConfirm renders a modal onto document.body with a Confirm button.
        const confirmBtn = [...document.querySelectorAll('.modal-actions button')]
            .find((b) => b.textContent === 'Confirm' || b.textContent === 'Delete');
        assert.ok(confirmBtn, 'a confirmation dialog should be shown');
        confirmBtn.click();
        await tick();

        assert.equal(removeCalls.length, 1);
        assert.equal(removeCalls[0].id, 'my-repo');
        assert.equal(removeCalls[0].fileId, 'file-1');
        assert.equal(changedCalls, 1);
    } finally {
        cleanup();
        element.remove();
        document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
    }
});

test('a cancelled delete confirmation never calls remove() nor onChanged', async () => {
    let changedCalls = 0;
    const { element, cleanup } = await mount({ enabled: true }, { onChanged: () => { changedCalls += 1; } });
    try {
        element.querySelector('button[aria-label="Delete Run"]').click();
        await tick();

        const cancelBtn = [...document.querySelectorAll('.modal-actions button')]
            .find((b) => b.textContent === 'Cancel');
        assert.ok(cancelBtn);
        cancelBtn.click();
        await tick();

        assert.equal(removeCalls.length, 0);
        assert.equal(changedCalls, 0);
    } finally {
        cleanup();
        element.remove();
        document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
    }
});

// ---------------------------------------------------------------------------
// Executable checkbox pre-checked from the heuristic (AC-4)
// ---------------------------------------------------------------------------

test('new file: the Executable checkbox auto-tracks the heuristic until manually toggled', async () => {
    const { element, cleanup } = await mount({ enabled: true });
    try {
        const addBtn = [...element.querySelectorAll('button')].find((b) => b.textContent === '+ Add File');
        addBtn.click();

        const form = element.querySelector('form.custom-file-form');
        const executable = form.querySelector('[name="executable"]');
        const fileName = form.querySelector('[name="fileName"]');
        assert.ok(executable, 'the Executable checkbox should be rendered (showExecutable: true)');
        assert.equal(executable.checked, false, 'starts unchecked for an empty file name');

        fileName.value = 'install.sh';
        fileName.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(executable.checked, true, 'auto-checks once the file name matches the heuristic');

        fileName.value = 'install.txt';
        fileName.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(executable.checked, false, 'keeps tracking the heuristic while untouched by the user');

        // Manual override sticks even when the heuristic would disagree.
        executable.checked = true;
        executable.dispatchEvent(new window.Event('change', { bubbles: true }));
        fileName.value = 'install.md';
        fileName.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(executable.checked, true, 'a manual toggle stops the heuristic from overriding the checkbox');
    } finally {
        cleanup();
        element.remove();
    }
});

test('editing an existing file keeps (and does not auto-track) its saved Executable flag', async () => {
    const { element, cleanup } = await mount({ enabled: true });
    try {
        element.querySelector('button[aria-label="Edit Run"]').click();
        const form = element.querySelector('form.custom-file-form');
        const executable = form.querySelector('[name="executable"]');
        assert.equal(executable.checked, true, 'reflects the saved Executable: true');

        const fileName = form.querySelector('[name="fileName"]');
        fileName.value = 'run.txt';
        fileName.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(executable.checked, true, 'editing a file never auto-tracks the heuristic');
    } finally {
        cleanup();
        element.remove();
    }
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test('cleanup() prevents a late-resolving load from touching the DOM after unmount', async () => {
    let resolveList;
    api.repositories.files.list = () => new Promise((resolve) => { resolveList = resolve; });

    const { element, cleanup } = buildRepositoryFilesSection(REPO, { enabled: true }, {});
    document.body.appendChild(element);
    await tick();

    cleanup();
    resolveList([rawFile()]);
    await tick();

    // Still shows the loading placeholder — the resolved load was discarded.
    assert.match(element.textContent, /Loading repository files/);
    element.remove();
});

test('no innerHTML assignment is used anywhere in the module source', async () => {
    const { fileURLToPath } = await import('node:url');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const thisFile = fileURLToPath(import.meta.url);
    const srcPath = path.join(path.dirname(thisFile), 'repository-files-section.js');
    const source = fs.readFileSync(srcPath, 'utf8');
    assert.ok(!/\.innerHTML\s*=/.test(source), 'repository-files-section.js must not assign to .innerHTML');
});
