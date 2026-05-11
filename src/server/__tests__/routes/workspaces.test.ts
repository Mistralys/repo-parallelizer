import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../router.js';
import { registerWorkspaceRoutes } from '../../routes/workspaces.js';
import { NotFoundError } from '../../../errors.js';
import type { WorkspaceInfo } from '../../../models/workspace/workspace.types.js';
import { mockRequest, mockResponse, type MockResponse } from '../helpers/mock-http.js';

// ---------------------------------------------------------------------------
// Mock WorkspaceManager
// ---------------------------------------------------------------------------

interface StoredWorkspace {
    Description: string;
    DateCreated: string;
    DateModified: string;
    Notes: string;
}

interface StoredProject {
    workspaces: Record<string, StoredWorkspace>;
}

function makeWsInfo(projectId: string, wsId: string, description = ''): WorkspaceInfo {
    const now = new Date().toISOString();
    return { ProjectID: projectId, WorkspaceID: wsId, Description: description, DateCreated: now, DateModified: now, Notes: '' };
}

class MockWorkspaceManager {
    private projects: Record<string, StoredProject> = {};

    // Test helper: seed a project with a set of workspaces
    seedProject(projectId: string, workspaceIds: string[]): void {
        const now = new Date().toISOString();
        const workspaces: Record<string, StoredWorkspace> = {};
        for (const wsId of workspaceIds) {
            workspaces[wsId] = { Description: '', DateCreated: now, DateModified: now, Notes: '' };
        }
        this.projects[projectId] = { workspaces };
    }

    private requireProject(projectId: string, verb: string): StoredProject {
        const project = this.projects[projectId];
        if (!project) {
            throw new NotFoundError(`Cannot ${verb}: project with ID "${projectId}" does not exist.`);
        }
        return project;
    }

    list(projectId: string): WorkspaceInfo[] {
        const project = this.requireProject(projectId, 'list workspaces');
        return Object.entries(project.workspaces).map(([wsId, ws]) =>
            makeWsInfo(projectId, wsId, ws.Description),
        );
    }

    getById(projectId: string, workspaceId: string): WorkspaceInfo | undefined {
        const project = this.requireProject(projectId, 'get workspace');
        const ws = project.workspaces[workspaceId];
        if (!ws) return undefined;
        return makeWsInfo(projectId, workspaceId, ws.Description);
    }

    create(projectId: string, workspaceId: string, description?: string): WorkspaceInfo {
        const project = this.requireProject(projectId, 'create workspace');
        if (workspaceId in project.workspaces) {
            throw new Error(`A workspace with ID "${workspaceId}" already exists in project "${projectId}".`);
        }
        const now = new Date().toISOString();
        project.workspaces[workspaceId] = { Description: description ?? '', DateCreated: now, DateModified: now, Notes: '' };
        return makeWsInfo(projectId, workspaceId, description ?? '');
    }

    update(projectId: string, workspaceId: string, changes: { Description?: string; Notes?: string }): WorkspaceInfo {
        const project = this.requireProject(projectId, 'update workspace');
        const ws = project.workspaces[workspaceId];
        if (!ws) {
            throw new NotFoundError(`Cannot update: workspace "${workspaceId}" does not exist in project "${projectId}".`);
        }
        if (changes.Description !== undefined) ws.Description = changes.Description;
        if (changes.Notes !== undefined) ws.Notes = changes.Notes;
        ws.DateModified = new Date().toISOString();
        return { ...makeWsInfo(projectId, workspaceId, ws.Description), Notes: ws.Notes };
    }

    rename(projectId: string, oldId: string, newId: string): WorkspaceInfo {
        if (oldId === 'STABLE') {
            throw new Error(`Cannot rename the STABLE workspace: it is the default workspace for project "${projectId}" and cannot be renamed.`);
        }
        const project = this.requireProject(projectId, 'rename workspace');
        const ws = project.workspaces[oldId];
        if (!ws) {
            throw new NotFoundError(`Cannot rename: workspace "${oldId}" does not exist in project "${projectId}".`);
        }
        if (newId in project.workspaces) {
            throw new Error(`Cannot rename: a workspace with ID "${newId}" already exists in project "${projectId}".`);
        }
        ws.DateModified = new Date().toISOString();
        project.workspaces[newId] = ws;
        delete project.workspaces[oldId];
        return makeWsInfo(projectId, newId, ws.Description);
    }

    remove(projectId: string, workspaceId: string): void {
        if (workspaceId === 'STABLE') {
            throw new Error(`Cannot remove the STABLE workspace: it is the default workspace for project "${projectId}" and cannot be deleted.`);
        }
        const project = this.requireProject(projectId, 'remove workspace');
        if (!(workspaceId in project.workspaces)) {
            throw new NotFoundError(`Cannot remove: workspace "${workspaceId}" does not exist in project "${projectId}".`);
        }
        delete project.workspaces[workspaceId];
    }
}

function buildSut(): { router: Router; wm: MockWorkspaceManager } {
    const router = new Router();
    const wm = new MockWorkspaceManager();
    // The orchestrator, appConfig, projectManager, and errorLogManager are only
    // used by specific endpoints not exercised by this suite, so stubs suffice.
    const stubOrchestrator = {} as never;
    const stubConfig = { projectsFolder: '/tmp/nonexistent-test-projects' } as never;
    const stubProjectManager = {} as never;
    const stubErrorLogManager = {} as never;
    registerWorkspaceRoutes(router, wm as never, stubOrchestrator, stubConfig, stubProjectManager, stubErrorLogManager);
    return { router, wm };
}

async function flushAsync(): Promise<void> {
    await new Promise<void>((r) => process.nextTick(r));
    await new Promise<void>((r) => process.nextTick(r));
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id/workspaces — list all
// ---------------------------------------------------------------------------

test('GET /api/projects/:id/workspaces: returns 200 with array of workspaces', () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const result = JSON.parse(mock.body) as WorkspaceInfo[];
    assert.strictEqual(result.length, 2);
    assert.ok(result.some((w) => w.WorkspaceID === 'STABLE'));
    assert.ok(result.some((w) => w.WorkspaceID === 'DEV'));
});

test('GET /api/projects/:id/workspaces: returns 404 when project does not exist', () => {
    const { router } = buildSut();
    const req = mockRequest('GET', '/api/projects/ghost/workspaces');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

// ---------------------------------------------------------------------------
// POST /api/projects/:id/workspaces — create
// ---------------------------------------------------------------------------

test('POST /api/projects/:id/workspaces: returns 201 with created workspace on valid input', async () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE']);

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces', { workspaceId: 'DEV', description: 'Dev ws' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 201);
    const created = JSON.parse(mock.body) as WorkspaceInfo;
    assert.strictEqual(created.WorkspaceID, 'DEV');
    assert.strictEqual(created.Description, 'Dev ws');
    assert.strictEqual(created.ProjectID, 'proj-a');
});

test('POST /api/projects/:id/workspaces: returns 400 when workspaceId is missing', async () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE']);

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces', { description: 'missing id' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('POST /api/projects/:id/workspaces: returns 400 when body is not a JSON object', async () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE']);

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces', [1, 2]);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
});

test('POST /api/projects/:id/workspaces: returns 404 when project does not exist', async () => {
    const { router } = buildSut();
    const req = mockRequest('POST', '/api/projects/ghost/workspaces', { workspaceId: 'DEV' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
});

// ---------------------------------------------------------------------------
// GET /api/projects/:id/workspaces/:wid — get one
// ---------------------------------------------------------------------------

test('GET /api/projects/:id/workspaces/:wid: returns 200 with the workspace when found', () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/DEV');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const ws = JSON.parse(mock.body) as WorkspaceInfo;
    assert.strictEqual(ws.WorkspaceID, 'DEV');
    assert.strictEqual(ws.ProjectID, 'proj-a');
});

test('GET /api/projects/:id/workspaces/:wid: returns 404 when workspace not found', () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE']);

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/GHOST');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('GET /api/projects/:id/workspaces/:wid: returns 404 when project does not exist', () => {
    const { router } = buildSut();
    const req = mockRequest('GET', '/api/projects/ghost/workspaces/STABLE');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
});

// ---------------------------------------------------------------------------
// PUT /api/projects/:id/workspaces/:wid — update description and/or notes
// ---------------------------------------------------------------------------

test('PUT /api/projects/:id/workspaces/:wid: returns 200 and persists notes when only notes is provided', async () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('PUT', '/api/projects/proj-a/workspaces/DEV', { notes: 'my notes' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as WorkspaceInfo;
    assert.strictEqual(updated.Notes, 'my notes');
    assert.strictEqual(updated.WorkspaceID, 'DEV');
});

test('PUT /api/projects/:id/workspaces/:wid: returns 200 when only description is provided', async () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('PUT', '/api/projects/proj-a/workspaces/DEV', { description: 'desc only' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as WorkspaceInfo;
    assert.strictEqual(updated.Description, 'desc only');
    assert.strictEqual(updated.WorkspaceID, 'DEV');
});

test('PUT /api/projects/:id/workspaces/:wid: returns 200 and persists both fields when notes and description are provided', async () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('PUT', '/api/projects/proj-a/workspaces/DEV', { notes: 'both notes', description: 'both desc' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as WorkspaceInfo;
    assert.strictEqual(updated.Notes, 'both notes');
    assert.strictEqual(updated.Description, 'both desc');
});

test('PUT /api/projects/:id/workspaces/:wid: returns 400 when body is empty object', async () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('PUT', '/api/projects/proj-a/workspaces/DEV', {});
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

// ---------------------------------------------------------------------------
// PUT /api/projects/:id/workspaces/:wid/rename — rename
// ---------------------------------------------------------------------------

test('PUT /api/projects/:id/workspaces/:wid/rename: returns 200 with renamed workspace on valid input', async () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('PUT', '/api/projects/proj-a/workspaces/DEV/rename', { newId: 'QA' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const renamed = JSON.parse(mock.body) as WorkspaceInfo;
    assert.strictEqual(renamed.WorkspaceID, 'QA');
    assert.strictEqual(renamed.ProjectID, 'proj-a');
});

test('PUT /api/projects/:id/workspaces/:wid/rename: returns 404 when workspace does not exist', async () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE']);

    const req = mockRequest('PUT', '/api/projects/proj-a/workspaces/GHOST/rename', { newId: 'QA' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('PUT /api/projects/:id/workspaces/:wid/rename: returns 400 when newId is missing', async () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('PUT', '/api/projects/proj-a/workspaces/DEV/rename', { unrelated: 'field' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/projects/:id/workspaces/:wid/rename: returns 400 when attempting to rename STABLE', async () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE']);

    const req = mockRequest('PUT', '/api/projects/proj-a/workspaces/STABLE/rename', { newId: 'DEV' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    // rename() for STABLE throws without "does not exist" — maps to 400
    assert.strictEqual(mock.statusCode, 400);
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/:id/workspaces/:wid — delete
// ---------------------------------------------------------------------------

test('DELETE /api/projects/:id/workspaces/:wid: returns 204 when workspace is deleted', () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('DELETE', '/api/projects/proj-a/workspaces/DEV');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
    // Confirm workspace is gone
    assert.strictEqual(wm.getById('proj-a', 'DEV'), undefined);
});

test('DELETE /api/projects/:id/workspaces/:wid: returns 404 when workspace does not exist', () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE']);

    const req = mockRequest('DELETE', '/api/projects/proj-a/workspaces/GHOST');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('DELETE /api/projects/:id/workspaces/:wid: returns 404 when project does not exist', () => {
    const { router } = buildSut();
    const req = mockRequest('DELETE', '/api/projects/ghost/workspaces/DEV');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/:id/workspaces/STABLE — STABLE protection returns 400
// ---------------------------------------------------------------------------

test('DELETE /api/projects/:id/workspaces/STABLE: returns 400 (not 404) for STABLE protection', () => {
    const { router, wm } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('DELETE', '/api/projects/proj-a/workspaces/STABLE');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(parsed.error.includes('Cannot remove the STABLE workspace'));
});
