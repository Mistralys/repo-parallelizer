/**
 * Unit tests for applyFiltersAndSort() in dashboard.js.
 *
 * Tests the pure filter/sort logic directly with plain data arrays — no DOM
 * rendering or API calls involved.
 *
 * Run individually with:
 *   node --test 'gui/public/js/__tests__/dashboard.test.mjs'
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserGlobalsShim } from './test-setup.mjs';

before(installBrowserGlobalsShim);

// Dynamic import after shims are installed (top-level await is fine in ESM).
const { applyFiltersAndSort } = await import('../views/dashboard.js');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal project entry as expected by applyFiltersAndSort.
 *
 * @param {Partial<{Id: string, Name: string, Description: string,
 *   Repositories: Array, LastActivity: string|null}>} overrides
 * @returns {{ fullProject: object, wsCount: number }}
 */
function makeEntry(overrides = {}) {
    return {
        fullProject: {
            Id:          overrides.Id          ?? 'proj-a',
            Name:        overrides.Name        ?? 'Project A',
            Description: overrides.Description ?? '',
            Repositories: overrides.Repositories ?? [],
            LastActivity: overrides.LastActivity !== undefined
                ? overrides.LastActivity
                : null,
        },
        wsCount: overrides.wsCount ?? 0,
    };
}

// ---------------------------------------------------------------------------
// Search filter
// ---------------------------------------------------------------------------

test('search: matches project name case-insensitively', () => {
    const all = [makeEntry({ Name: 'Alpha Project' }), makeEntry({ Id: 'beta', Name: 'Beta Project' })];
    const result = applyFiltersAndSort({ search: 'alpha', repoId: '', sort: 'alpha' }, all);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].fullProject.Name, 'Alpha Project');
});

test('search: matches project ID case-insensitively', () => {
    const all = [makeEntry({ Id: 'alpha-project', Name: 'Alpha' }), makeEntry({ Id: 'beta-project', Name: 'Beta' })];
    const result = applyFiltersAndSort({ search: 'BETA', repoId: '', sort: 'alpha' }, all);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].fullProject.Id, 'beta-project');
});

test('search: matches project description case-insensitively', () => {
    const all = [
        makeEntry({ Id: 'a', Name: 'A', Description: 'Contains needle here' }),
        makeEntry({ Id: 'b', Name: 'B', Description: 'No match' }),
    ];
    const result = applyFiltersAndSort({ search: 'NEEDLE', repoId: '', sort: 'alpha' }, all);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].fullProject.Id, 'a');
});

test('search: empty string returns all projects', () => {
    const all = [makeEntry({ Id: 'a' }), makeEntry({ Id: 'b' }), makeEntry({ Id: 'c' })];
    const result = applyFiltersAndSort({ search: '', repoId: '', sort: 'alpha' }, all);
    assert.strictEqual(result.length, 3);
});

test('search: no match returns empty array', () => {
    const all = [makeEntry({ Name: 'Alpha' }), makeEntry({ Id: 'b', Name: 'Beta' })];
    const result = applyFiltersAndSort({ search: 'zzz', repoId: '', sort: 'alpha' }, all);
    assert.strictEqual(result.length, 0);
});

// ---------------------------------------------------------------------------
// Repository filter
// ---------------------------------------------------------------------------

test('repoId: filters to projects containing the given repo', () => {
    const all = [
        makeEntry({ Id: 'with-repo',    Repositories: [{ id: 'repo-x' }] }),
        makeEntry({ Id: 'without-repo', Repositories: [] }),
    ];
    const result = applyFiltersAndSort({ search: '', repoId: 'repo-x', sort: 'alpha' }, all);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].fullProject.Id, 'with-repo');
});

test('repoId: empty string returns all projects regardless of repos', () => {
    const all = [
        makeEntry({ Id: 'a', Repositories: [{ id: 'repo-x' }] }),
        makeEntry({ Id: 'b', Repositories: [] }),
    ];
    const result = applyFiltersAndSort({ search: '', repoId: '', sort: 'alpha' }, all);
    assert.strictEqual(result.length, 2);
});

// ---------------------------------------------------------------------------
// Sort: alphabetical
// ---------------------------------------------------------------------------

test('sort alpha: sorts ascending by name', () => {
    const all = [
        makeEntry({ Id: 'c', Name: 'Cherry' }),
        makeEntry({ Id: 'a', Name: 'Apple' }),
        makeEntry({ Id: 'b', Name: 'Banana' }),
    ];
    const result = applyFiltersAndSort({ search: '', repoId: '', sort: 'alpha' }, all);
    assert.deepStrictEqual(result.map((e) => e.fullProject.Name), ['Apple', 'Banana', 'Cherry']);
});

test('sort alpha: uses ID as tiebreaker when names are equal', () => {
    const all = [
        makeEntry({ Id: 'proj-z', Name: 'Same Name' }),
        makeEntry({ Id: 'proj-a', Name: 'Same Name' }),
    ];
    const result = applyFiltersAndSort({ search: '', repoId: '', sort: 'alpha' }, all);
    assert.strictEqual(result[0].fullProject.Id, 'proj-a');
    assert.strictEqual(result[1].fullProject.Id, 'proj-z');
});

// ---------------------------------------------------------------------------
// Sort: last activity
// ---------------------------------------------------------------------------

test('sort activity: sorts descending by LastActivity', () => {
    const all = [
        makeEntry({ Id: 'old',    LastActivity: '2024-01-01T00:00:00.000Z' }),
        makeEntry({ Id: 'newer',  LastActivity: '2024-06-01T00:00:00.000Z' }),
        makeEntry({ Id: 'newest', LastActivity: '2025-01-01T00:00:00.000Z' }),
    ];
    const result = applyFiltersAndSort({ search: '', repoId: '', sort: 'activity' }, all);
    assert.deepStrictEqual(result.map((e) => e.fullProject.Id), ['newest', 'newer', 'old']);
});

test('sort activity: null LastActivity sorts last', () => {
    const all = [
        makeEntry({ Id: 'no-activity', LastActivity: null }),
        makeEntry({ Id: 'has-activity', LastActivity: '2024-01-01T00:00:00.000Z' }),
    ];
    const result = applyFiltersAndSort({ search: '', repoId: '', sort: 'activity' }, all);
    assert.strictEqual(result[0].fullProject.Id, 'has-activity');
    assert.strictEqual(result[1].fullProject.Id, 'no-activity');
});

test('sort activity: two null entries use name as tiebreaker', () => {
    const all = [
        makeEntry({ Id: 'z', Name: 'Zulu', LastActivity: null }),
        makeEntry({ Id: 'a', Name: 'Alpha', LastActivity: null }),
    ];
    const result = applyFiltersAndSort({ search: '', repoId: '', sort: 'activity' }, all);
    assert.strictEqual(result[0].fullProject.Name, 'Alpha');
    assert.strictEqual(result[1].fullProject.Name, 'Zulu');
});

// ---------------------------------------------------------------------------
// Combined filter + sort
// ---------------------------------------------------------------------------

test('combined: search + sort alpha narrows and orders results', () => {
    const all = [
        makeEntry({ Id: 'cherry', Name: 'Cherry Service' }),
        makeEntry({ Id: 'apple-api', Name: 'Apple API' }),
        makeEntry({ Id: 'banana', Name: 'Banana CLI' }),
        makeEntry({ Id: 'apple-web', Name: 'Apple Web' }),
    ];
    const result = applyFiltersAndSort({ search: 'apple', repoId: '', sort: 'alpha' }, all);
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result.map((e) => e.fullProject.Id), ['apple-api', 'apple-web']);
});

test('combined: repoId + sort activity filters then sorts', () => {
    const all = [
        makeEntry({ Id: 'a', Repositories: [{ id: 'r1' }], LastActivity: '2024-03-01T00:00:00.000Z' }),
        makeEntry({ Id: 'b', Repositories: [{ id: 'r1' }], LastActivity: '2024-01-01T00:00:00.000Z' }),
        makeEntry({ Id: 'c', Repositories: [{ id: 'r2' }], LastActivity: '2025-01-01T00:00:00.000Z' }),
    ];
    const result = applyFiltersAndSort({ search: '', repoId: 'r1', sort: 'activity' }, all);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].fullProject.Id, 'a');
    assert.strictEqual(result[1].fullProject.Id, 'b');
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('empty allProjects returns empty array', () => {
    const result = applyFiltersAndSort({ search: '', repoId: '', sort: 'alpha' }, []);
    assert.strictEqual(result.length, 0);
});

test('does not mutate the input allProjects array', () => {
    const all = [
        makeEntry({ Id: 'b', Name: 'Banana' }),
        makeEntry({ Id: 'a', Name: 'Apple' }),
    ];
    const originalOrder = all.map((e) => e.fullProject.Id);
    applyFiltersAndSort({ search: '', repoId: '', sort: 'alpha' }, all);
    assert.deepStrictEqual(all.map((e) => e.fullProject.Id), originalOrder);
});
