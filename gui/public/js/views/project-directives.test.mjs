/**
 * Unit tests for views/project-directives.js — the "Directives" tab (T-37),
 * including the project-detail tab wiring.
 *
 * Run individually with:
 *   node --test gui/public/js/views/project-directives.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="toast-container"></div></body></html>', {
    url: 'http://localhost/',
});
const { window } = dom;
globalThis.document = window.document;
globalThis.window = window;
globalThis.location = window.location;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Event = window.Event;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.fetch = async () => ({
    status: 200, ok: true, statusText: 'OK',
    headers: { get: () => 'application/json' }, json: async () => ({}),
});

const { api } = await import('../api.js');
const { buildProjectDirectivesSection } = await import('./project-directives.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

test('renders the list fetched through api.projects.directives.list', async () => {
    const calls = [];
    api.projects.directives.list = async (pid) => { calls.push({ op: 'list', pid }); return [{ Id: 'a1', Text: 'Rule one.' }]; };

    const section = buildProjectDirectivesSection('proj-a');
    document.body.replaceChildren(section);
    await flush();

    assert.deepEqual(calls, [{ op: 'list', pid: 'proj-a' }]);
    assert.equal(section.querySelectorAll('.directive-item').length, 1);
    assert.equal(section.querySelector('.directive-text').textContent, 'Rule one.');
});

test('saves a new directive through api.projects.directives.create', async () => {
    const calls = [];
    let list = [];
    api.projects.directives.list = async () => list;
    api.projects.directives.create = async (pid, text) => {
        calls.push({ op: 'create', pid, text });
        list = [{ Id: 'n1', Text: text }];
        return list[0];
    };

    const section = buildProjectDirectivesSection('proj-a');
    document.body.replaceChildren(section);
    await flush();

    section.querySelector('.directive-add-btn').click();
    section.querySelector('textarea').value = 'Release dependencies first.';
    section.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await flush();

    assert.deepEqual(calls, [{ op: 'create', pid: 'proj-a', text: 'Release dependencies first.' }]);
    assert.equal(section.querySelector('.directive-text').textContent, 'Release dependencies first.');
});

test('a failed load is reported inline', async () => {
    api.projects.directives.list = async () => { throw new Error('boom'); };
    const section = buildProjectDirectivesSection('proj-a');
    document.body.replaceChildren(section);
    await flush();
    assert.equal(section.querySelector('[role="alert"]').textContent, 'boom');
});

test('project-detail.js registers the Directives tab and delegates to the new module', () => {
    const src = fs.readFileSync(new URL('./project-detail.js', import.meta.url), 'utf8');
    assert.match(src, /\{ id: 'directives', label: 'Directives' \}/);
    assert.match(src, /buildProjectDirectivesSection\(normProject\.id\)/);
});
