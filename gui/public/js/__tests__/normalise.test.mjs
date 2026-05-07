/**
 * Unit tests for normaliseWorkspace() and normaliseNotesResponse() in normalise.js.
 *
 * Run individually with:
 *   node --test 'gui/public/js/__tests__/normalise.test.mjs'
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normaliseWorkspace, normaliseNotesResponse } = await import('../utils/normalise.js');

// ─── normaliseWorkspace — notes field ────────────────────────────────────────

test('normaliseWorkspace: Notes field is returned as notes', () => {
    const result = normaliseWorkspace({ WorkspaceID: 'DEV', Notes: 'text' });
    assert.strictEqual(result.notes, 'text');
});

test('normaliseWorkspace: lowercase notes field is accepted', () => {
    const result = normaliseWorkspace({ WorkspaceID: 'DEV', notes: 'from lower' });
    assert.strictEqual(result.notes, 'from lower');
});

test('normaliseWorkspace: Notes takes precedence over notes', () => {
    const result = normaliseWorkspace({ WorkspaceID: 'DEV', Notes: 'upper', notes: 'lower' });
    assert.strictEqual(result.notes, 'upper');
});

test('normaliseWorkspace: missing Notes defaults to empty string', () => {
    const result = normaliseWorkspace({ WorkspaceID: 'STABLE' });
    assert.strictEqual(result.notes, '');
});

test('normaliseWorkspace: null Notes defaults to empty string', () => {
    const result = normaliseWorkspace({ WorkspaceID: 'STABLE', Notes: null });
    assert.strictEqual(result.notes, '');
});

test('normaliseWorkspace: existing fields still work with Notes present', () => {
    const result = normaliseWorkspace({
        WorkspaceID: 'DEV',
        Description: 'desc',
        DateCreated: '2026-01-01T00:00:00Z',
        Notes: 'hello',
    });
    assert.strictEqual(result.id, 'DEV');
    assert.strictEqual(result.description, 'desc');
    assert.strictEqual(result.notes, 'hello');
});

// ─── normaliseNotesResponse ───────────────────────────────────────────────────

test('normaliseNotesResponse: returns { projects: [] } for empty Projects array', () => {
    const result = normaliseNotesResponse({ Projects: [] });
    assert.deepStrictEqual(result, { projects: [] });
});

test('normaliseNotesResponse: returns { projects: [] } for missing Projects key', () => {
    const result = normaliseNotesResponse({});
    assert.deepStrictEqual(result, { projects: [] });
});

test('normaliseNotesResponse: returns { projects: [] } for null input', () => {
    const result = normaliseNotesResponse(null);
    assert.deepStrictEqual(result, { projects: [] });
});

test('normaliseNotesResponse: maps ProjectId to projectId', () => {
    const result = normaliseNotesResponse({
        Projects: [{ ProjectId: 'my-proj', ProjectName: 'My Proj', Workspaces: [] }],
    });
    assert.strictEqual(result.projects[0].projectId, 'my-proj');
});

test('normaliseNotesResponse: maps ProjectName to projectName', () => {
    const result = normaliseNotesResponse({
        Projects: [{ ProjectId: 'p', ProjectName: 'The Name', Workspaces: [] }],
    });
    assert.strictEqual(result.projects[0].projectName, 'The Name');
});

test('normaliseNotesResponse: maps WorkspaceId to workspaceId', () => {
    const result = normaliseNotesResponse({
        Projects: [{
            ProjectId: 'p', ProjectName: 'P',
            Workspaces: [{ WorkspaceId: 'STABLE', Notes: '' }],
        }],
    });
    assert.strictEqual(result.projects[0].workspaces[0].workspaceId, 'STABLE');
});

test('normaliseNotesResponse: maps Notes to notes', () => {
    const result = normaliseNotesResponse({
        Projects: [{
            ProjectId: 'p', ProjectName: 'P',
            Workspaces: [{ WorkspaceId: 'DEV', Notes: 'some notes' }],
        }],
    });
    assert.strictEqual(result.projects[0].workspaces[0].notes, 'some notes');
});

test('normaliseNotesResponse: empty Notes becomes empty string', () => {
    const result = normaliseNotesResponse({
        Projects: [{
            ProjectId: 'p', ProjectName: 'P',
            Workspaces: [{ WorkspaceId: 'STABLE', Notes: '' }],
        }],
    });
    assert.strictEqual(result.projects[0].workspaces[0].notes, '');
});

test('normaliseNotesResponse: includes all projects', () => {
    const result = normaliseNotesResponse({
        Projects: [
            { ProjectId: 'a', ProjectName: 'A', Workspaces: [] },
            { ProjectId: 'b', ProjectName: 'B', Workspaces: [] },
        ],
    });
    assert.strictEqual(result.projects.length, 2);
});

test('normaliseNotesResponse: includes all workspaces for a project', () => {
    const result = normaliseNotesResponse({
        Projects: [{
            ProjectId: 'p', ProjectName: 'P',
            Workspaces: [
                { WorkspaceId: 'STABLE', Notes: '' },
                { WorkspaceId: 'DEV',    Notes: 'dev' },
            ],
        }],
    });
    assert.strictEqual(result.projects[0].workspaces.length, 2);
});
