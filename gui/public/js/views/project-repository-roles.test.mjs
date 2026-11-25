/**
 * Unit tests for views/project-repository-roles.js (T-38): the inline
 * click-to-edit "Role / relations" cell.
 *
 * Run individually with:
 *   node --test gui/public/js/views/project-repository-roles.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="toast-container"></div></body></html>', {
    url: 'http://localhost/',
});
const { window } = dom;

globalThis.document      = window.document;
globalThis.window        = window;
globalThis.location      = window.location;
globalThis.HTMLElement   = window.HTMLElement;
globalThis.Event         = window.Event;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.fetch = async () => ({
    status: 200, ok: true, statusText: 'OK',
    headers: { get: () => 'application/json' }, json: async () => ({}),
});

const { api } = await import('../api.js');
const { buildRepositoryRoleCell, ROLE_PLACEHOLDER } = await import('./project-repository-roles.js');

const calls = [];
let nextError = null;
api.projects.setRepositoryRole = async (pid, rid, role) => {
    calls.push({ pid, rid, role });
    if (nextError) throw new Error(nextError);
    return { role };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

function mount(role) {
    const cell = buildRepositoryRoleCell('proj', 'repo-a', role);
    document.body.appendChild(cell);
    return cell;
}

function startEdit(cell) {
    cell.querySelector('.repo-role-display').click();
    return cell.querySelector('input.repo-role-input');
}

beforeEach(() => {
    calls.length = 0;
    nextError = null;
    document.body.innerHTML = '<div id="toast-container"></div>';
});

test('shows the role, or a placeholder when there is none', () => {
    assert.equal(mount('Backend API').querySelector('.repo-role-display').textContent, 'Backend API');
    const empty = mount('').querySelector('.repo-role-display');
    assert.equal(empty.textContent, ROLE_PLACEHOLDER);
    assert.ok(empty.classList.contains('repo-role-display--empty'));
});

test('click opens an input prefilled with the role', () => {
    const input = startEdit(mount('Backend API'));
    assert.ok(input);
    assert.equal(input.value, 'Backend API');
});

test('Enter saves the trimmed text and shows the stored role', async () => {
    const cell = mount('');
    const input = startEdit(cell);
    input.value = '  Web frontend  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    assert.deepEqual(calls, [{ pid: 'proj', rid: 'repo-a', role: 'Web frontend' }]);
    assert.equal(cell.querySelector('.repo-role-display').textContent, 'Web frontend');
});

test('blur saves, and Enter followed by blur saves only once', async () => {
    const cell = mount('');
    const input = startEdit(cell);
    input.value = 'Library';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    input.dispatchEvent(new window.Event('blur'));
    await tick();
    assert.equal(calls.length, 1);

    const cell2 = mount('');
    const input2 = startEdit(cell2);
    input2.value = 'Docs';
    input2.dispatchEvent(new window.Event('blur'));
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].role, 'Docs');
});

test('empty text clears the role and restores the placeholder', async () => {
    const cell = mount('Backend API');
    const input = startEdit(cell);
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    assert.deepEqual(calls, [{ pid: 'proj', rid: 'repo-a', role: '' }]);
    assert.equal(cell.querySelector('.repo-role-display').textContent, ROLE_PLACEHOLDER);
});

test('unchanged text makes no request', async () => {
    const cell = mount('Backend API');
    const input = startEdit(cell);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    assert.equal(calls.length, 0);
    assert.ok(cell.querySelector('.repo-role-display'));
});

test('Escape cancels without saving', async () => {
    const cell = mount('Backend API');
    const input = startEdit(cell);
    input.value = 'Changed';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    input.dispatchEvent(new window.Event('blur'));
    await tick();
    assert.equal(calls.length, 0);
    assert.equal(cell.querySelector('.repo-role-display').textContent, 'Backend API');
});

test('a failed save keeps the editor open and can be retried', async () => {
    nextError = 'boom';
    const cell = mount('');
    const input = startEdit(cell);
    input.value = 'X';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    assert.equal(cell.querySelector('input.repo-role-input'), input);
    assert.equal(input.disabled, false);

    nextError = null;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(cell.querySelector('.repo-role-display').textContent, 'X');
});
