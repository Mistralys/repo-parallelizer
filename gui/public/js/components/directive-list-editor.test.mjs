/**
 * Unit tests for components/directive-list-editor.js (T-36): add, edit,
 * delete, inline server errors, delete confirmation and the length counter.
 *
 * Run individually with:
 *   node --test gui/public/js/components/directive-list-editor.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="toast-container"></div></body></html>', {
    url: 'http://localhost/',
});
const { window } = dom;
globalThis.document = window.document;
globalThis.window = window;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Event = window.Event;
globalThis.KeyboardEvent = window.KeyboardEvent;

const { buildDirectiveListEditor } = await import('./directive-list-editor.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

function mount(initial, overrides = {}) {
    const calls = [];
    let current = initial;
    const editor = buildDirectiveListEditor({
        directives: initial,
        maxLength: 1000,
        maxCount: 3,
        scopeLabel: 'project',
        onCreate: async (text) => {
            calls.push({ op: 'create', text });
            if (overrides.error) throw new Error(overrides.error);
            current = [...current, { Id: 'new1', Text: text }];
        },
        onUpdate: async (id, text) => {
            calls.push({ op: 'update', id, text });
            if (overrides.error) throw new Error(overrides.error);
            current = current.map((d) => (d.Id === id ? { Id: id, Text: text } : d));
        },
        onDelete: async (id) => {
            calls.push({ op: 'delete', id });
            current = current.filter((d) => d.Id !== id);
        },
        reload: async () => { calls.push({ op: 'reload' }); return current; },
    });
    document.body.replaceChildren(editor);
    return { editor, calls };
}

test('renders the empty state and the directives', () => {
    const empty = mount([]);
    assert.match(empty.editor.textContent, /No project directives yet/);

    const { editor } = mount([{ Id: 'a1', Text: 'First.' }, { Id: 'b2', Text: 'Second.' }]);
    const items = editor.querySelectorAll('.directive-item');
    assert.equal(items.length, 2);
    assert.equal(items[0].querySelector('.directive-text').textContent, 'First.');
});

test('add: submits the text, reloads and re-renders the list', async () => {
    const { editor, calls } = mount([]);
    editor.querySelector('.directive-add-btn').click();
    const textarea = editor.querySelector('textarea');
    textarea.value = 'Never push.';
    textarea.dispatchEvent(new window.Event('input'));
    assert.equal(editor.querySelector('.directive-counter').textContent, '11 / 1000');

    editor.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await flush();

    assert.deepEqual(calls, [{ op: 'create', text: 'Never push.' }, { op: 'reload' }]);
    assert.equal(editor.querySelectorAll('.directive-item').length, 1);
    assert.equal(editor.querySelector('form'), null);
});

test('add: empty text is rejected inline without calling the API', async () => {
    const { editor, calls } = mount([]);
    editor.querySelector('.directive-add-btn').click();
    editor.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await flush();

    assert.deepEqual(calls, []);
    assert.match(editor.querySelector('.directive-form-error').textContent, /required/);
});

test('edit: pre-fills the text and saves through onUpdate', async () => {
    const { editor, calls } = mount([{ Id: 'a1', Text: 'Old.' }]);
    editor.querySelector('.directive-edit-btn').click();
    const textarea = editor.querySelector('textarea');
    assert.equal(textarea.value, 'Old.');
    textarea.value = 'New.';
    editor.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await flush();

    assert.deepEqual(calls, [{ op: 'update', id: 'a1', text: 'New.' }, { op: 'reload' }]);
    assert.equal(editor.querySelector('.directive-text').textContent, 'New.');
});

test('a server error is shown inline and the form stays open', async () => {
    const { editor } = mount([], { error: 'Directive already exists.' });
    editor.querySelector('.directive-add-btn').click();
    editor.querySelector('textarea').value = 'Dup.';
    editor.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await flush();

    assert.equal(editor.querySelector('.directive-form-error').textContent, 'Directive already exists.');
    assert.ok(editor.querySelector('form'));
    assert.equal(editor.querySelector('button[type="submit"]').disabled, false);
});

test('delete asks for confirmation; confirming deletes, cancelling does not', async () => {
    const { editor, calls } = mount([{ Id: 'a1', Text: 'Gone soon.' }]);

    editor.querySelector('.directive-delete-btn').click();
    await flush();
    const dialogs = document.querySelectorAll('.modal-body');
    assert.equal(dialogs.length, 1, 'a confirmation dialog is shown');
    assert.match(dialogs[0].textContent, /Gone soon/);
    assert.deepEqual(calls, []);

    // Cancel: nothing deleted, button usable again.
    [...document.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === 'Cancel').click();
    await flush();
    assert.deepEqual(calls, []);
    assert.equal(editor.querySelector('.directive-delete-btn').disabled, false);

    // Confirm: deleted and list reloaded.
    editor.querySelector('.directive-delete-btn').click();
    await flush();
    [...document.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === 'Confirm').click();
    await flush();
    assert.deepEqual(calls, [{ op: 'delete', id: 'a1' }, { op: 'reload' }]);
    assert.equal(editor.querySelectorAll('.directive-item').length, 0);
});

test('the add button is disabled at the maximum count', () => {
    const { editor } = mount([{ Id: '1', Text: 'a' }, { Id: '2', Text: 'b' }, { Id: '3', Text: 'c' }]);
    assert.equal(editor.querySelector('.directive-add-btn').disabled, true);
});
