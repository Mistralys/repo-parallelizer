/**
 * Unit tests for views/project-custom-files.js — the "Custom Files" tab.
 *
 * Covers: pure helpers, list/empty rendering, the add/edit form payload,
 * the Tab-key / Escape handling in the content textarea (no keyboard trap),
 * inline display of a server rejection, and the project-detail tab wiring.
 *
 * Run individually with:
 *   node --test gui/public/js/views/project-custom-files.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="toast-container"></div></body></html>', {
    url: 'http://localhost/',
});
const { window } = dom;

globalThis.document    = window.document;
globalThis.window      = window;
globalThis.location    = window.location;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Event       = window.Event;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.CSS = window.CSS ?? { escape: (s) => s.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '\\$&') };
globalThis.fetch = async () => ({
    status: 200, ok: true, statusText: 'OK',
    headers: { get: () => 'application/json' }, json: async () => ({}),
});

const { api } = await import('../api.js');
const {
    normaliseCustomFile, formatCustomFilePath, isExecutableHint, buildCustomFilesSection,
} = await import('./project-custom-files.js');

const calls = [];
let nextError = null;
api.projects.customFiles.create = async (pid, data) => {
    calls.push({ op: 'create', pid, data });
    if (nextError) throw new Error(nextError);
    return {};
};
api.projects.customFiles.update = async (pid, fid, data) => { calls.push({ op: 'update', pid, fid, data }); return {}; };

function mount(files) {
    const section = buildCustomFilesSection('proj-a', files, async () => { calls.push({ op: 'refresh' }); });
    document.body.appendChild(section);
    return section;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('normaliseCustomFile accepts PascalCase and camelCase', () => {
    const a = normaliseCustomFile({ Id: '1', Directory: 'd', FileName: 'f.sh', Label: 'L', Description: 'D', Content: 'c', ListInAgents: true });
    const b = normaliseCustomFile({ id: '1', directory: 'd', fileName: 'f.sh', label: 'L', description: 'D', content: 'c', listInAgents: true });
    assert.deepEqual(a, b);
    assert.equal(normaliseCustomFile({}).listInAgents, false);
});

test('formatCustomFilePath joins and tidies', () => {
    assert.equal(formatCustomFilePath('', 'a.md'), 'a.md');
    assert.equal(formatCustomFilePath('./docs\\x/', ' a.md '), 'docs/x/a.md');
    assert.equal(formatCustomFilePath('.', 'a.md'), 'a.md');
});

test('isExecutableHint: shell extension or shebang only', () => {
    assert.equal(isExecutableHint('a.SH', ''), true);
    assert.equal(isExecutableHint('tool', '#!/bin/sh'), true);
    assert.equal(isExecutableHint('a.bat', '@echo off'), false);
});

test('empty state is shown when there are no files', () => {
    const s = mount(undefined);
    assert.match(s.textContent, /No custom files yet/);
    assert.equal(s.querySelector('table'), null);
    s.remove();
});

test('list renders label, path, listed state and accessible action names', () => {
    const s = mount([
        { Id: '1', Directory: 'scripts', FileName: 'a.sh', Label: 'Alpha', Description: 'Desc', Content: '', ListInAgents: true },
        { Id: '2', Directory: '', FileName: 'b.md', Label: 'Beta', Description: '', Content: '', ListInAgents: false },
    ]);
    const rows = s.querySelectorAll('tbody tr');
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /scripts\/a\.sh/);
    assert.match(rows[0].textContent, /Listed/);
    assert.match(rows[1].textContent, /b\.md/);
    assert.ok(s.querySelector('button[aria-label="Edit Alpha"]'));
    assert.ok(s.querySelector('button[aria-label="Delete Beta"]'));
    s.remove();
});

test('add form: switch defaults to off, create sends the camelCase payload, then refreshes', async () => {
    calls.length = 0;
    const s = mount([]);
    s.querySelector('.custom-files-toolbar button').click();
    const form = s.querySelector('.custom-file-form');
    const sw = form.querySelector('[name="listInAgents"]');
    assert.equal(sw.checked, false);
    assert.equal(sw.getAttribute('role'), 'switch');

    const set = (n, v) => { const e = form.querySelector(`[name="${n}"]`); e.value = v; e.dispatchEvent(new window.Event('input', { bubbles: true })); };
    set('label', ' Start '); set('directory', 'scripts'); set('fileName', 'start.sh'); set('content', 'echo hi');
    assert.match(form.querySelector('.custom-file-summary').textContent, /scripts\/start\.sh and marked executable/);
    sw.checked = true;

    form.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
    await tick();
    assert.deepEqual(calls[0], {
        op: 'create', pid: 'proj-a',
        data: { label: 'Start', directory: 'scripts', fileName: 'start.sh', description: '', content: 'echo hi', listInAgents: true },
    });
    assert.equal(calls[1].op, 'refresh');
    s.remove();
});

test('required fields and path separators in the name block the request', async () => {
    calls.length = 0;
    const s = mount([]);
    s.querySelector('.custom-files-toolbar button').click();
    const form = s.querySelector('.custom-file-form');
    form.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
    await tick();
    assert.equal(calls.length, 0);

    form.querySelector('[name="label"]').value = 'x';
    form.querySelector('[name="fileName"]').value = 'a/b.sh';
    form.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
    await tick();
    assert.equal(calls.length, 0);
    assert.equal(form.querySelector('.custom-file-form-error').hidden, false);
    s.remove();
});

test('a server rejection is shown inline (role=alert) and the form stays open and re-enabled', async () => {
    calls.length = 0;
    nextError = 'Directory must not contain "." or ".." segments.';
    const s = mount([]);
    s.querySelector('.custom-files-toolbar button').click();
    const form = s.querySelector('.custom-file-form');
    form.querySelector('[name="label"]').value = 'x';
    form.querySelector('[name="fileName"]').value = 'a.sh';
    form.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
    await tick(); await tick();
    const err = form.querySelector('.custom-file-form-error');
    assert.equal(err.getAttribute('role'), 'alert');
    assert.equal(err.hidden, false);
    assert.match(err.textContent, /\.\./);
    assert.equal(form.querySelector('[type="submit"]').disabled, false);
    assert.ok(s.querySelector('.custom-file-form'));
    nextError = null;
    s.remove();
});

test('edit form is prefilled and saves via update with the file id', async () => {
    calls.length = 0;
    const s = mount([{ Id: 'abc', Directory: 'd', FileName: 'f.md', Label: 'L', Description: 'x', Content: 'body', ListInAgents: true }]);
    s.querySelector('button[aria-label="Edit L"]').click();
    const form = s.querySelector('.custom-file-form');
    assert.equal(form.querySelector('[name="content"]').value, 'body');
    assert.equal(form.querySelector('[name="listInAgents"]').checked, true);
    form.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
    await tick();
    assert.equal(calls[0].op, 'update');
    assert.equal(calls[0].fid, 'abc');
    s.remove();
});

test('content textarea: Tab inserts a tab, Escape then Tab is left to the browser', () => {
    const s = mount([]);
    s.querySelector('.custom-files-toolbar button').click();
    const ta = s.querySelector('.custom-file-content');
    ta.value = 'ab'; ta.selectionStart = ta.selectionEnd = 1;

    const tab1 = new window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
    ta.dispatchEvent(tab1);
    assert.equal(tab1.defaultPrevented, true);
    assert.equal(ta.value, 'a\tb');

    ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const tab2 = new window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
    ta.dispatchEvent(tab2);
    assert.equal(tab2.defaultPrevented, false);

    const shiftTab = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true, bubbles: true });
    ta.dispatchEvent(shiftTab);
    assert.equal(shiftTab.defaultPrevented, false);
    s.remove();
});

test('dirty indicator appears after an edit', () => {
    const s = mount([]);
    s.querySelector('.custom-files-toolbar button').click();
    const form = s.querySelector('.custom-file-form');
    const ind = form.querySelector('.unsaved-indicator');
    assert.equal(ind.hidden, true);
    const label = form.querySelector('[name="label"]');
    label.value = 'changed';
    label.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(ind.hidden, false);
    s.remove();
});
