import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../router.js';
import { registerNotesRoutes } from '../../routes/notes.js';
import type { ProjectIndexEntry } from '../../../models/project/project.types.js';
import type { WorkspaceInfo } from '../../../models/workspace/workspace.types.js';
import { mockRequest, mockResponse, type MockResponse } from '../helpers/mock-http.js';

// ---------------------------------------------------------------------------
// Mock managers
// ---------------------------------------------------------------------------

function makeWorkspaceInfo(projectId: string, workspaceId: string, notes = ''): WorkspaceInfo {
    const now = new Date().toISOString();
    return {
        ProjectID: projectId,
        WorkspaceID: workspaceId,
        Description: '',
        DateCreated: now,
        DateModified: now,
        Notes: notes,
    };
}

class MockProjectManager {
    private entries: ProjectIndexEntry[] = [];

    addProject(id: string, name: string): void {
        this.entries.push({ Id: id, Name: name });
    }

    list(): ProjectIndexEntry[] {
        return [...this.entries];
    }
}

class MockWorkspaceManager {
    private workspaces: Record<string, WorkspaceInfo[]> = {};

    addWorkspace(projectId: string, ws: WorkspaceInfo): void {
        if (!this.workspaces[projectId]) {
            this.workspaces[projectId] = [];
        }
        this.workspaces[projectId].push(ws);
    }

    list(projectId: string): WorkspaceInfo[] {
        return this.workspaces[projectId] ?? [];
    }
}

function setup() {
    const router = new Router();
    const projectManager = new MockProjectManager();
    const workspaceManager = new MockWorkspaceManager();
    registerNotesRoutes(
        router,
        projectManager as unknown as Parameters<typeof registerNotesRoutes>[1],
        workspaceManager as unknown as Parameters<typeof registerNotesRoutes>[2],
    );
    return { router, projectManager, workspaceManager };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('GET /api/notes returns 200', async () => {
    const { router } = setup();
    const mock = mockResponse();
    await router.handle(mockRequest('GET', '/api/notes'), mock.res);
    assert.strictEqual(mock.statusCode, 200);
});

test('GET /api/notes returns { Projects: [] } when no projects exist', async () => {
    const { router } = setup();
    const mock = mockResponse();
    await router.handle(mockRequest('GET', '/api/notes'), mock.res);
    const body = JSON.parse(mock.body) as { Projects: unknown[] };
    assert.deepStrictEqual(body, { Projects: [] });
});

test('GET /api/notes includes all projects', async () => {
    const { router, projectManager, workspaceManager } = setup();
    projectManager.addProject('proj-a', 'Project A');
    projectManager.addProject('proj-b', 'Project B');
    workspaceManager.addWorkspace('proj-a', makeWorkspaceInfo('proj-a', 'STABLE'));
    workspaceManager.addWorkspace('proj-b', makeWorkspaceInfo('proj-b', 'STABLE'));

    const mock = mockResponse();
    await router.handle(mockRequest('GET', '/api/notes'), mock.res);
    const body = JSON.parse(mock.body) as { Projects: Array<{ ProjectId: string }> };

    assert.strictEqual(body.Projects.length, 2);
    assert.ok(body.Projects.some((p) => p.ProjectId === 'proj-a'));
    assert.ok(body.Projects.some((p) => p.ProjectId === 'proj-b'));
});

test('GET /api/notes response shape includes ProjectId, ProjectName, Workspaces', async () => {
    const { router, projectManager, workspaceManager } = setup();
    projectManager.addProject('my-project', 'My Project');
    workspaceManager.addWorkspace('my-project', makeWorkspaceInfo('my-project', 'STABLE', ''));
    workspaceManager.addWorkspace('my-project', makeWorkspaceInfo('my-project', 'DEV', 'dev notes'));

    const mock = mockResponse();
    await router.handle(mockRequest('GET', '/api/notes'), mock.res);
    const body = JSON.parse(mock.body) as {
        Projects: Array<{
            ProjectId: string;
            ProjectName: string;
            Workspaces: Array<{ WorkspaceId: string; Notes: string }>;
        }>;
    };

    assert.strictEqual(body.Projects.length, 1);
    const project = body.Projects[0];
    assert.strictEqual(project.ProjectId, 'my-project');
    assert.strictEqual(project.ProjectName, 'My Project');
    assert.strictEqual(project.Workspaces.length, 2);
});

test('GET /api/notes - workspaces without notes have Notes: ""', async () => {
    const { router, projectManager, workspaceManager } = setup();
    projectManager.addProject('proj-a', 'Project A');
    workspaceManager.addWorkspace('proj-a', makeWorkspaceInfo('proj-a', 'STABLE', ''));

    const mock = mockResponse();
    await router.handle(mockRequest('GET', '/api/notes'), mock.res);
    const body = JSON.parse(mock.body) as {
        Projects: Array<{
            Workspaces: Array<{ WorkspaceId: string; Notes: string }>;
        }>;
    };

    const stable = body.Projects[0].Workspaces.find((w) => w.WorkspaceId === 'STABLE');
    assert.strictEqual(stable?.Notes, '');
});

test('GET /api/notes - workspaces with notes have the correct Notes value', async () => {
    const { router, projectManager, workspaceManager } = setup();
    projectManager.addProject('proj-a', 'Project A');
    workspaceManager.addWorkspace('proj-a', makeWorkspaceInfo('proj-a', 'DEV', 'dev notes'));

    const mock = mockResponse();
    await router.handle(mockRequest('GET', '/api/notes'), mock.res);
    const body = JSON.parse(mock.body) as {
        Projects: Array<{
            Workspaces: Array<{ WorkspaceId: string; Notes: string }>;
        }>;
    };

    const dev = body.Projects[0].Workspaces.find((w) => w.WorkspaceId === 'DEV');
    assert.strictEqual(dev?.Notes, 'dev notes');
});

test('GET /api/notes includes all workspaces for each project', async () => {
    const { router, projectManager, workspaceManager } = setup();
    projectManager.addProject('proj-a', 'Project A');
    workspaceManager.addWorkspace('proj-a', makeWorkspaceInfo('proj-a', 'STABLE'));
    workspaceManager.addWorkspace('proj-a', makeWorkspaceInfo('proj-a', 'DEV'));
    workspaceManager.addWorkspace('proj-a', makeWorkspaceInfo('proj-a', 'QA'));

    const mock = mockResponse();
    await router.handle(mockRequest('GET', '/api/notes'), mock.res);
    const body = JSON.parse(mock.body) as {
        Projects: Array<{ Workspaces: Array<{ WorkspaceId: string }> }>;
    };

    const wsIds = body.Projects[0].Workspaces.map((w) => w.WorkspaceId);
    assert.deepStrictEqual(wsIds.sort(), ['DEV', 'QA', 'STABLE']);
});

test('GET /api/notes returns 500 when projectManager.list() throws', async () => {
    const router = new Router();
    const brokenProjectManager = {
        list(): never {
            throw new Error('storage failure');
        },
    };
    const workspaceManager = new MockWorkspaceManager();
    registerNotesRoutes(
        router,
        brokenProjectManager as unknown as Parameters<typeof registerNotesRoutes>[1],
        workspaceManager as unknown as Parameters<typeof registerNotesRoutes>[2],
    );

    const mock = mockResponse();
    await router.handle(mockRequest('GET', '/api/notes'), mock.res);
    assert.strictEqual(mock.statusCode, 500);
    const body = JSON.parse(mock.body) as { error: string };
    assert.strictEqual(body.error, 'Internal server error.');
});
