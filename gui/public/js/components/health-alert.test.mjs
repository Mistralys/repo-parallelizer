/**
 * Unit tests for components/health-alert.js — WP-011.
 *
 * Acceptance Criteria verified:
 *   AC1 — `buildHealthAlert()` renders the title and one row per issue; the
 *          registry maps a `fixAction` to a button that calls `onClick(issue)`;
 *          `none`/unknown actions render message-only; a healthy report
 *          returns `null`.
 *   AC2 — The component uses no `innerHTML` assignment.
 *   AC3 — (covered indirectly here; verified end-to-end for workspace-detail.js
 *          by workspace-detail.index-health.test.mjs and
 *          workspace-detail.credential-error.test.mjs, which pass unchanged.)
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/components/health-alert.test.mjs
 */

import { test, beforeEach } from 'node:test';
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

globalThis.document    = window.document;
globalThis.window      = window;
globalThis.HTMLElement = window.HTMLElement;

const { buildHealthAlert } = await import('./health-alert.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEALTHY_REPORT = { healthy: true, issues: [] };

function makeIssue(overrides = {}) {
    return {
        type:      'some-issue',
        severity:  'warning',
        message:   'Something needs attention.',
        fixAction: 'none',
        ...overrides,
    };
}

beforeEach(() => {
    // No shared mutable state between tests beyond the DOM, which each test
    // builds fresh via buildHealthAlert().
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('returns null when report is null', () => {
    assert.strictEqual(buildHealthAlert(null), null);
});

test('returns null when report.healthy is true', () => {
    assert.strictEqual(buildHealthAlert(HEALTHY_REPORT), null);
});

test('returns null when issues is missing or empty', () => {
    assert.strictEqual(buildHealthAlert({ healthy: false }), null);
    assert.strictEqual(buildHealthAlert({ healthy: false, issues: [] }), null);
});

test('renders the default title and one .health-alert-issue row per issue', () => {
    const report = {
        healthy: false,
        issues: [makeIssue({ message: 'First issue.' }), makeIssue({ message: 'Second issue.' })],
    };

    const section = buildHealthAlert(report);
    assert.ok(section, 'should return an element for an unhealthy report');
    assert.strictEqual(section.className, 'health-alert');

    const title = section.querySelector('.health-alert-title');
    assert.ok(title);
    assert.strictEqual(title.textContent, 'Workspace health issues detected');

    const rows = section.querySelectorAll('.health-alert-issue');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].querySelector('.health-alert-issue__message').textContent, 'First issue.');
    assert.strictEqual(rows[1].querySelector('.health-alert-issue__message').textContent, 'Second issue.');
});

test('accepts a custom title via options', () => {
    const report = { healthy: false, issues: [makeIssue()] };
    const section = buildHealthAlert(report, { title: 'Custom Title' });
    assert.strictEqual(section.querySelector('.health-alert-title').textContent, 'Custom Title');
});

test('an issue whose fixAction is "none" renders message-only (no button)', () => {
    const report = { healthy: false, issues: [makeIssue({ fixAction: 'none' })] };
    const section = buildHealthAlert(report, { actions: { 'some-other-action': { label: 'X', onClick: () => {} } } });

    const row = section.querySelector('.health-alert-issue');
    assert.strictEqual(row.querySelector('.health-alert-issue__action'), null);
    assert.strictEqual(row.querySelector('button'), null);
});

test('an issue whose fixAction has no registry entry renders message-only (no button)', () => {
    const report = { healthy: false, issues: [makeIssue({ fixAction: 'totally-unknown-action' })] };
    const section = buildHealthAlert(report, { actions: { 'some-other-action': { label: 'X', onClick: () => {} } } });

    const row = section.querySelector('.health-alert-issue');
    assert.strictEqual(row.querySelector('.health-alert-issue__action'), null);
});

test('an issue whose fixAction matches a registry entry renders a button with the configured label', () => {
    const report = { healthy: false, issues: [makeIssue({ fixAction: 'do-the-thing' })] };
    const onClick = () => {};
    const section = buildHealthAlert(report, { actions: { 'do-the-thing': { label: 'Do The Thing', onClick } } });

    const actionWrap = section.querySelector('.health-alert-issue__action');
    assert.ok(actionWrap, 'action wrapper should be present');

    const btn = actionWrap.querySelector('button');
    assert.ok(btn);
    assert.strictEqual(btn.type, 'button');
    assert.strictEqual(btn.className, 'btn btn-secondary btn-sm');
    assert.strictEqual(btn.textContent, 'Do The Thing');
});

test('clicking the button calls onClick(issue) with the full issue object', async () => {
    const issue = makeIssue({ fixAction: 'do-the-thing', repositoryId: 'repo-a' });
    const calls = [];
    const section = buildHealthAlert(
        { healthy: false, issues: [issue] },
        { actions: { 'do-the-thing': { label: 'Do The Thing', onClick: (i) => { calls.push(i); } } } },
    );

    const btn = section.querySelector('button');
    btn.dispatchEvent(new window.Event('click'));
    // Flush the microtask queue so the async click handler completes.
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0], issue);
});

test('button shows loadingLabel while onClick is pending, then restores label', async () => {
    let resolveClick;
    const pending = new Promise((resolve) => { resolveClick = resolve; });

    const section = buildHealthAlert(
        { healthy: false, issues: [makeIssue({ fixAction: 'slow-action' })] },
        { actions: { 'slow-action': { label: 'Go', loadingLabel: 'Going…', onClick: () => pending } } },
    );

    const btn = section.querySelector('button');
    assert.strictEqual(btn.textContent, 'Go');

    btn.dispatchEvent(new window.Event('click'));
    await Promise.resolve();

    assert.strictEqual(btn.disabled, true);
    assert.strictEqual(btn.textContent, 'Going…');

    resolveClick();
    await pending;
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(btn.disabled, false);
    assert.strictEqual(btn.textContent, 'Go');
});

test('button falls back to label as the loading text when loadingLabel is omitted', async () => {
    let resolveClick;
    const pending = new Promise((resolve) => { resolveClick = resolve; });

    const section = buildHealthAlert(
        { healthy: false, issues: [makeIssue({ fixAction: 'slow-action' })] },
        { actions: { 'slow-action': { label: 'Go', onClick: () => pending } } },
    );

    const btn = section.querySelector('button');
    btn.dispatchEvent(new window.Event('click'));
    await Promise.resolve();

    assert.strictEqual(btn.textContent, 'Go');

    resolveClick();
    await pending;
});

test('no innerHTML assignment is used anywhere in the component source', () => {
    const thisFile = fileURLToPath(import.meta.url);
    const srcPath  = path.join(path.dirname(thisFile), 'health-alert.js');
    const source   = fs.readFileSync(srcPath, 'utf8');
    assert.ok(!/\.innerHTML\s*=/.test(source), 'health-alert.js must not assign to .innerHTML');
});
