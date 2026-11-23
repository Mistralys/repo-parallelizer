/**
 * Unit tests for components/file-definition-editor.js — WP-013.
 *
 * Covers the callback-driven table and editor extracted from
 * `views/project-custom-files.js`. The project view's own regression suite
 * (`views/project-custom-files.test.mjs`) covers the extraction did not
 * change the project tab's observable behaviour; this suite covers the
 * shared component's own contract directly — including a configuration
 * (`showExecutable`, a table `onDelete` rejection) that view does not
 * exercise.
 *
 * Acceptance Criteria verified:
 *   AC1 — `buildFileDefinitionEditor()` shows the Executable checkbox only
 *          when `showExecutable` is true, and invokes `onSave`/`onDelete`/
 *          `onClose` callbacks rather than calling any API directly.
 *   AC2 — `buildFileDefinitionTable()` renders rows via the supplied
 *          `formatPath` and calls `onEdit`/`onDelete` rather than binding to
 *          a specific project/repository.
 *   AC3 — Neither this module nor `project-custom-files.js` uses `innerHTML`
 *          for user-supplied data.
 *
 * Run individually with:
 *   node --test gui/public/js/components/file-definition-editor.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// jsdom setup — install globals before the module under test is imported
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
const { window } = dom;

globalThis.document      = window.document;
globalThis.window        = window;
globalThis.HTMLElement   = window.HTMLElement;
globalThis.Event         = window.Event;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.MouseEvent    = window.MouseEvent;

const { buildFileDefinitionTable, buildFileDefinitionEditor } = await import('./file-definition-editor.js');

const tick = () => new Promise((r) => setTimeout(r, 0));

function file(overrides) {
    return {
        id: '1', directory: 'scripts', fileName: 'run.sh', label: 'Run',
        description: '', content: '#!/bin/sh\necho hi\n', listInAgents: false, executable: false,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// buildFileDefinitionTable()
// ---------------------------------------------------------------------------

test('table: renders rows via formatPath, with no status column when omitted', () => {
    const wrap = buildFileDefinitionTable({
        files: [file()],
        formatPath: (f) => `custom/${f.fileName}`,
        onEdit: () => {},
        onDelete: () => {},
    });
    document.body.appendChild(wrap);

    assert.match(wrap.querySelector('td.font-mono').textContent, /custom\/run\.sh/);
    const headers = [...wrap.querySelectorAll('th')].map((th) => th.textContent);
    assert.deepEqual(headers, ['Label', 'Path', 'Actions']);
    wrap.remove();
});

test('table: renders a statusColumn when supplied, with its own header and aria-label', () => {
    const wrap = buildFileDefinitionTable({
        files: [file({ listInAgents: true }), file({ id: '2', listInAgents: false })],
        formatPath: (f) => f.fileName,
        statusColumn: {
            header: 'In AGENTS.md',
            render: (f) => (f.listInAgents ? 'Listed' : '—'),
            ariaLabel: (f) => (f.listInAgents ? '' : 'Not listed'),
        },
        onEdit: () => {},
        onDelete: () => {},
    });
    document.body.appendChild(wrap);

    const headers = [...wrap.querySelectorAll('th')].map((th) => th.textContent);
    assert.deepEqual(headers, ['Label', 'Path', 'In AGENTS.md', 'Actions']);
    const rows = wrap.querySelectorAll('tbody tr');
    assert.match(rows[0].textContent, /Listed/);
    assert.equal(rows[1].querySelectorAll('td')[2].getAttribute('aria-label'), 'Not listed');
    wrap.remove();
});

test('table: Edit button calls onEdit with the file; accessible names use the label', () => {
    const edited = [];
    const wrap = buildFileDefinitionTable({
        files: [file({ label: 'Alpha' })],
        formatPath: (f) => f.fileName,
        onEdit: (f) => edited.push(f),
        onDelete: () => {},
    });
    document.body.appendChild(wrap);

    assert.ok(wrap.querySelector('button[aria-label="Edit Alpha"]'));
    assert.ok(wrap.querySelector('button[aria-label="Delete Alpha"]'));
    wrap.querySelector('button[aria-label="Edit Alpha"]').click();
    assert.equal(edited.length, 1);
    assert.equal(edited[0].label, 'Alpha');
    wrap.remove();
});

test('table: Delete button disables itself for a pending onDelete, and re-enables only on rejection', async () => {
    let resolveDelete;
    const pending = new Promise((r) => { resolveDelete = r; });
    const wrap = buildFileDefinitionTable({
        files: [file()],
        formatPath: (f) => f.fileName,
        onEdit: () => {},
        onDelete: () => pending,
    });
    document.body.appendChild(wrap);

    const delBtn = wrap.querySelector('button[aria-label="Delete Run"]');
    delBtn.click();
    await tick();
    assert.equal(delBtn.disabled, true);

    resolveDelete();
    await tick();
    assert.equal(delBtn.disabled, true, 'stays disabled on a resolved delete — caller is expected to remove/re-render the row');
    wrap.remove();
});

test('table: Delete button re-enables when onDelete rejects', async () => {
    const wrap = buildFileDefinitionTable({
        files: [file()],
        formatPath: (f) => f.fileName,
        onEdit: () => {},
        onDelete: () => Promise.reject(new Error('nope')),
    });
    document.body.appendChild(wrap);

    const delBtn = wrap.querySelector('button[aria-label="Delete Run"]');
    delBtn.click();
    await tick();
    assert.equal(delBtn.disabled, false);
    wrap.remove();
});

// ---------------------------------------------------------------------------
// buildFileDefinitionEditor()
// ---------------------------------------------------------------------------

test('editor: Executable checkbox is absent when showExecutable is false (default)', () => {
    const form = buildFileDefinitionEditor({
        file: null, onSave: async () => {}, onClose: () => {},
    });
    document.body.appendChild(form);
    assert.equal(form.querySelector('[name="executable"]'), null);
    form.remove();
});

test('editor: Executable checkbox appears when showExecutable is true, pre-filled from the file', () => {
    const form = buildFileDefinitionEditor({
        file: file({ executable: true }), showExecutable: true, onSave: async () => {}, onClose: () => {},
    });
    document.body.appendChild(form);
    const checkbox = form.querySelector('[name="executable"]');
    assert.ok(checkbox);
    assert.equal(checkbox.checked, true);
    assert.equal(checkbox.getAttribute('role'), 'switch');
    form.remove();
});

test('editor: onSave payload includes "executable" only when showExecutable is true', async () => {
    const calls = [];
    const form = buildFileDefinitionEditor({
        file: null, showExecutable: true,
        onSave: async (payload) => { calls.push(payload); },
        onClose: () => {},
    });
    document.body.appendChild(form);
    form.querySelector('[name="label"]').value = 'L';
    form.querySelector('[name="fileName"]').value = 'a.sh';
    form.querySelector('[name="executable"]').checked = true;
    form.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, true);

    calls.length = 0;
    const form2 = buildFileDefinitionEditor({
        file: null, onSave: async (payload) => { calls.push(payload); }, onClose: () => {},
    });
    document.body.appendChild(form2);
    form2.querySelector('[name="label"]').value = 'L';
    form2.querySelector('[name="fileName"]').value = 'a.sh';
    form2.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
    await tick();
    assert.equal(calls.length, 1);
    assert.equal('executable' in calls[0], false);

    form.remove();
    form2.remove();
});

test('editor: a rejected onSave shows the message inline (role=alert) and re-enables the Save button', async () => {
    const form = buildFileDefinitionEditor({
        file: null,
        onSave: async () => { throw new Error('Server says no.'); },
        onClose: () => {},
    });
    document.body.appendChild(form);
    form.querySelector('[name="label"]').value = 'L';
    form.querySelector('[name="fileName"]').value = 'a.sh';
    form.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
    await tick();

    const err = form.querySelector('.custom-file-form-error');
    assert.equal(err.hidden, false);
    assert.equal(err.getAttribute('role'), 'alert');
    assert.match(err.textContent, /Server says no\./);
    assert.equal(form.querySelector('[type="submit"]').disabled, false);
    form.remove();
});

test('editor: no Delete button when onDelete is omitted; present and wired when supplied (edit mode only)', async () => {
    const noDelete = buildFileDefinitionEditor({ file: file(), onSave: async () => {}, onClose: () => {} });
    document.body.appendChild(noDelete);
    assert.equal(noDelete.querySelector('button.btn-danger'), null);
    noDelete.remove();

    const deleted = [];
    const closed = [];
    const withDelete = buildFileDefinitionEditor({
        file: file(),
        onSave: async () => {},
        onDelete: async (f) => { deleted.push(f); },
        onClose: () => closed.push(true),
    });
    document.body.appendChild(withDelete);
    const delBtn = withDelete.querySelector('button.btn-danger');
    assert.ok(delBtn);
    delBtn.click();
    await tick();
    assert.equal(deleted.length, 1);
    assert.equal(closed.length, 1);
    withDelete.remove();
});

test('editor: a new (non-edit) file never shows a Delete button, even when onDelete is supplied', () => {
    const form = buildFileDefinitionEditor({
        file: null, onSave: async () => {}, onDelete: async () => {}, onClose: () => {},
    });
    document.body.appendChild(form);
    assert.equal(form.querySelector('button.btn-danger'), null);
    form.remove();
});

test('editor: live summary uses pathPrefixLabel and computeExecutableHint when supplied', () => {
    const form = buildFileDefinitionEditor({
        file: null,
        pathPrefixLabel: '<workspace>/',
        computeExecutableHint: (fileName) => fileName.endsWith('.sh'),
        onSave: async () => {}, onClose: () => {},
    });
    document.body.appendChild(form);
    const set = (n, v) => {
        const el = form.querySelector(`[name="${n}"]`);
        el.value = v;
        el.dispatchEvent(new window.Event('input', { bubbles: true }));
    };
    set('directory', 'scripts');
    set('fileName', 'run.sh');
    assert.match(form.querySelector('.custom-file-summary').textContent, /^Will be written to <workspace>\/scripts\/run\.sh and marked executable\.$/);
    form.remove();
});

test('editor: live summary omits the executable hint when computeExecutableHint is not supplied', () => {
    const form = buildFileDefinitionEditor({ file: null, onSave: async () => {}, onClose: () => {} });
    document.body.appendChild(form);
    const set = (n, v) => {
        const el = form.querySelector(`[name="${n}"]`);
        el.value = v;
        el.dispatchEvent(new window.Event('input', { bubbles: true }));
    };
    set('fileName', 'run.sh');
    assert.equal(form.querySelector('.custom-file-summary').textContent, 'Will be written to run.sh.');
    form.remove();
});

// ---------------------------------------------------------------------------
// No-innerHTML rule (AC3)
// ---------------------------------------------------------------------------

test('no innerHTML assignment is used anywhere in the component source', () => {
    const thisFile = fileURLToPath(import.meta.url);
    const srcPath  = path.join(path.dirname(thisFile), 'file-definition-editor.js');
    const source   = fs.readFileSync(srcPath, 'utf8');
    assert.ok(!/\.innerHTML\s*=/.test(source), 'file-definition-editor.js must not assign to .innerHTML');
});

test('no innerHTML assignment is used in project-custom-files.js', () => {
    const thisFile = fileURLToPath(import.meta.url);
    const srcPath  = path.join(path.dirname(thisFile), '..', 'views', 'project-custom-files.js');
    const source   = fs.readFileSync(srcPath, 'utf8');
    assert.ok(!/\.innerHTML\s*=/.test(source), 'project-custom-files.js must not assign to .innerHTML');
});
