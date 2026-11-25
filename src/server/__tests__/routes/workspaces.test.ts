import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Router } from '../../router.js';
import { registerWorkspaceRoutes } from '../../routes/workspaces.js';
import { NotFoundError } from '../../../errors.js';
import type { WorkspaceInfo } from '../../../models/workspace/workspace.types.js';
import { mockRequest, mockResponse, type MockResponse } from '../helpers/mock-http.js';
import { makeMockErrorLogManager } from '../helpers/mock-error-log-manager.js';

// ---------------------------------------------------------------------------
// Mock WorkspaceArtifactsOrchestrator
// ---------------------------------------------------------------------------

/**
 * Records every call made to the artefact choke-point so tests can assert on
 * which method was invoked with which arguments, and can optionally be
 * configured (`shouldThrow`) to exercise the AC-20 contract-preservation path
 * — a failure inside the choke-point must not affect the handler's own
 * response, beyond appending a `Severity: 'warning'` entry to the error log.
 */
class MockWorkspaceArtifacts {
    calls: { method: string; args: unknown[] }[] = [];
    shouldThrow = false;

    private record(method: string, args: unknown[]): void {
        this.calls.push({ method, args });
        if (this.shouldThrow) {
            throw new Error(`Simulated ${method} failure.`);
        }
    }

    regenerateWorkspace(projectId: string, workspaceId: string): void {
        this.record('regenerateWorkspace', [projectId, workspaceId]);
    }

    removeWorkspace(projectId: string, workspaceId: string): void {
        this.record('removeWorkspace', [projectId, workspaceId]);
    }

    regenerateProject(projectId: string): void {
        this.record('regenerateProject', [projectId]);
    }

    // Sibling refresh is tracked separately from `calls` / `shouldThrow` so
    // the AC-20 assertions on the per-workspace choke-point stay unaffected.
    refreshCalls: string[] = [];
    refreshShouldThrow = false;
    refreshResult: { refreshed: string[]; failed: { workspaceId: string; error: string }[] } = { refreshed: [], failed: [] };
    onRefresh: ((projectId: string) => void) | undefined;

    refreshProjectIndexes(projectId: string): { refreshed: string[]; failed: { workspaceId: string; error: string }[] } {
        this.refreshCalls.push(projectId);
        this.onRefresh?.(projectId);
        if (this.refreshShouldThrow) {
            throw new Error('Simulated refreshProjectIndexes failure.');
        }
        return this.refreshResult;
    }
}

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

function buildSut(overrides?: {
    projectManager?: unknown;
    appConfig?: unknown;
}): {
    router: Router;
    wm: MockWorkspaceManager;
    artifacts: MockWorkspaceArtifacts;
    errorLog: ReturnType<typeof makeMockErrorLogManager>;
} {
    const router = new Router();
    const wm = new MockWorkspaceManager();
    // The orchestrator is only used by an endpoint not exercised by this
    // suite, so a stub suffices. `artifacts` and `errorLog` back the
    // DELETE/rename/regenerate handlers' choke-point calls and must be
    // working implementations (not `{} as never`) since those handlers now
    // consult them unconditionally. `projectManager`/`appConfig` default to
    // stubs but can be overridden for tests (e.g. regenerate-workspace-file)
    // that need a real project lookup and an on-disk projects folder.
    const stubOrchestrator = {} as never;
    const stubConfig = overrides?.appConfig ?? ({ projectsFolder: '/tmp/nonexistent-test-projects' } as never);
    const stubProjectManager = overrides?.projectManager ?? ({} as never);
    const artifacts = new MockWorkspaceArtifacts();
    const errorLog = makeMockErrorLogManager();
    registerWorkspaceRoutes(router, wm as never, stubOrchestrator, stubConfig as never, stubProjectManager as never, errorLog, artifacts as never);
    return { router, wm, artifacts, errorLog };
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

test('PUT /api/projects/:id/workspaces/:wid: regenerates this workspace\'s artefact set on success', async () => {
    const { router, wm, artifacts } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('PUT', '/api/projects/proj-a/workspaces/DEV', { notes: 'my notes' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(
        artifacts.calls.map((c) => c.method),
        ['regenerateWorkspace'],
    );
    assert.deepEqual(artifacts.calls[0].args, ['proj-a', 'DEV']);
});

test('PUT /api/projects/:id/workspaces/:wid: a throwing choke-point does not change the 200 response, but logs a warning', async () => {
    const { router, wm, artifacts, errorLog } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);
    artifacts.shouldThrow = true;

    const req = mockRequest('PUT', '/api/projects/proj-a/workspaces/DEV', { notes: 'my notes' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as WorkspaceInfo;
    assert.strictEqual(updated.Notes, 'my notes');
    assert.strictEqual(errorLog.appendedEntries.length, 1);
    assert.strictEqual(errorLog.appendedEntries[0].Severity, 'warning');
    assert.strictEqual(errorLog.appendedEntries[0].Source, 'workspace-index');
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

test('PUT /api/projects/:id/workspaces/:wid/rename: regenerates artefacts under the new ID and removes them under the old ID', async () => {
    const { router, wm, artifacts } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('PUT', '/api/projects/proj-a/workspaces/DEV/rename', { newId: 'QA' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(
        artifacts.calls.map((c) => c.method),
        ['regenerateWorkspace', 'removeWorkspace'],
    );
    assert.deepEqual(artifacts.calls[0].args, ['proj-a', 'QA']);
    assert.deepEqual(artifacts.calls[1].args, ['proj-a', 'DEV']);
});

test('PUT /api/projects/:id/workspaces/:wid/rename: AC-20 — a throwing choke-point does not change the 200 response, but logs a warning', async () => {
    const { router, wm, artifacts, errorLog } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);
    artifacts.shouldThrow = true;

    const req = mockRequest('PUT', '/api/projects/proj-a/workspaces/DEV/rename', { newId: 'QA' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const renamed = JSON.parse(mock.body) as WorkspaceInfo;
    assert.strictEqual(renamed.WorkspaceID, 'QA');
    assert.strictEqual(errorLog.appendedEntries.length, 1);
    assert.strictEqual(errorLog.appendedEntries[0].Severity, 'warning');
    assert.strictEqual(errorLog.appendedEntries[0].Source, 'workspace-index');
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

test('DELETE /api/projects/:id/workspaces/:wid: removes the workspace artefact set', () => {
    const { router, wm, artifacts } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('DELETE', '/api/projects/proj-a/workspaces/DEV');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
    assert.deepEqual(artifacts.calls, [{ method: 'removeWorkspace', args: ['proj-a', 'DEV'] }]);
});

test('DELETE /api/projects/:id/workspaces/:wid: AC-20 — a throwing choke-point does not change the 204 response, but logs a warning', () => {
    const { router, wm, artifacts, errorLog } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);
    artifacts.shouldThrow = true;

    const req = mockRequest('DELETE', '/api/projects/proj-a/workspaces/DEV');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
    assert.strictEqual(wm.getById('proj-a', 'DEV'), undefined);
    assert.strictEqual(errorLog.appendedEntries.length, 1);
    assert.strictEqual(errorLog.appendedEntries[0].Severity, 'warning');
    assert.strictEqual(errorLog.appendedEntries[0].Source, 'workspace-index');
});

test('DELETE /api/projects/:id/workspaces/STABLE: a throwing choke-point is never reached — STABLE rejection short-circuits first', () => {
    const { router, wm, artifacts, errorLog } = buildSut();
    wm.seedProject('proj-a', ['STABLE']);
    artifacts.shouldThrow = true;

    const req = mockRequest('DELETE', '/api/projects/proj-a/workspaces/STABLE');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 400);
    assert.deepEqual(artifacts.calls, []);
    assert.strictEqual(errorLog.appendedEntries.length, 0);
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

// ---------------------------------------------------------------------------
// POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file — widened
// to regenerate the full artefact set via the choke-point (see also the
// fs-backed guard/response-shape coverage in workspaces-health.test.ts).
// ---------------------------------------------------------------------------

/** Minimal stand-in for ProjectManager, sufficient for this route's guards. */
function makeStubProjectManager(project: { Id: string; Repositories: string[] } | undefined) {
    return { getById: (_id: string) => project };
}

test('POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file: returns 404 when project does not exist', () => {
    const { router } = buildSut({ projectManager: makeStubProjectManager(undefined) });

    const req = mockRequest('POST', '/api/projects/ghost/workspaces/DEV/regenerate-workspace-file');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
});

test('POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file: calls the choke-point and returns { success: true } once the workspace folder exists', () => {
    const projectsFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-regen-test-'));
    const wsFolder = path.join(projectsFolder, 'proj-a', 'DEV');
    fs.mkdirSync(wsFolder, { recursive: true });

    const { router, wm, artifacts } = buildSut({
        projectManager: makeStubProjectManager({ Id: 'proj-a', Repositories: [] }),
        appConfig: { projectsFolder },
    });
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/DEV/regenerate-workspace-file');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(JSON.parse(mock.body), { success: true });
    assert.deepEqual(artifacts.calls, [{ method: 'regenerateWorkspace', args: ['proj-a', 'DEV'] }]);

    fs.rmSync(projectsFolder, { recursive: true, force: true });
});

test('POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file: returns 400 when the workspace folder does not exist on disk', () => {
    const projectsFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-regen-test-'));

    const { router, wm } = buildSut({
        projectManager: makeStubProjectManager({ Id: 'proj-a', Repositories: [] }),
        appConfig: { projectsFolder },
    });
    wm.seedProject('proj-a', ['STABLE', 'DEV']);

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/DEV/regenerate-workspace-file');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 400);

    fs.rmSync(projectsFolder, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// WP-008 — sibling refresh on create / rename / delete (T-17)
// ---------------------------------------------------------------------------

test('T-17: POST create refreshes the project indexes once', async () => {
    const { router, wm, artifacts } = buildSut();
    wm.seedProject('proj-a', ['STABLE']);

    const mock = mockResponse();
    router.handle(mockRequest('POST', '/api/projects/proj-a/workspaces', { workspaceId: 'DEV' }), mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 201);
    assert.deepEqual(artifacts.refreshCalls, ['proj-a']);
});

test('T-17: PUT rename refreshes once, after the rename, listing the new ID and not the old', async () => {
    const { router, wm, artifacts } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);
    let listed: string[] = [];
    artifacts.onRefresh = (pid) => { listed = wm.list(pid).map((w) => w.WorkspaceID); };

    const mock = mockResponse();
    router.handle(mockRequest('PUT', '/api/projects/proj-a/workspaces/DEV/rename', { newId: 'QA' }), mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(artifacts.refreshCalls, ['proj-a']);
    assert.ok(listed.includes('QA'));
    assert.ok(!listed.includes('DEV'));
});

test('T-17: PUT rename still refreshes when the artefact block throws', async () => {
    const { router, wm, artifacts } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV']);
    artifacts.shouldThrow = true;

    const mock = mockResponse();
    router.handle(mockRequest('PUT', '/api/projects/proj-a/workspaces/DEV/rename', { newId: 'QA' }), mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(artifacts.refreshCalls, ['proj-a']);
});

test('T-17: DELETE refreshes once, also when the artefact block throws', () => {
    const { router, wm, artifacts } = buildSut();
    wm.seedProject('proj-a', ['STABLE', 'DEV', 'QA']);
    artifacts.shouldThrow = true;

    const mock = mockResponse();
    router.handle(mockRequest('DELETE', '/api/projects/proj-a/workspaces/DEV'), mock.res);

    assert.strictEqual(mock.statusCode, 204);
    assert.deepEqual(artifacts.refreshCalls, ['proj-a']);
});

test('T-17: DELETE of an unknown workspace (404) and of STABLE (400) does not refresh', () => {
    const { router, wm, artifacts } = buildSut();
    wm.seedProject('proj-a', ['STABLE']);

    const m1 = mockResponse();
    router.handle(mockRequest('DELETE', '/api/projects/proj-a/workspaces/GHOST'), m1.res);
    const m2 = mockResponse();
    router.handle(mockRequest('DELETE', '/api/projects/proj-a/workspaces/STABLE'), m2.res);

    assert.strictEqual(m1.statusCode, 404);
    assert.strictEqual(m2.statusCode, 400);
    assert.deepEqual(artifacts.refreshCalls, []);
});

test('T-17: a thrown refresh error is logged as a warning and leaves create/rename/delete responses unchanged', async () => {
    const { router, wm, artifacts, errorLog } = buildSut();
    wm.seedProject('proj-a', ['STABLE']);
    artifacts.refreshShouldThrow = true;

    const created = mockResponse();
    router.handle(mockRequest('POST', '/api/projects/proj-a/workspaces', { workspaceId: 'DEV' }), created.res);
    await flushAsync();
    const renamed = mockResponse();
    router.handle(mockRequest('PUT', '/api/projects/proj-a/workspaces/DEV/rename', { newId: 'QA' }), renamed.res);
    await flushAsync();
    const deleted = mockResponse();
    router.handle(mockRequest('DELETE', '/api/projects/proj-a/workspaces/QA'), deleted.res);

    assert.strictEqual(created.statusCode, 201);
    assert.strictEqual((JSON.parse(created.body) as WorkspaceInfo).WorkspaceID, 'DEV');
    assert.strictEqual(renamed.statusCode, 200);
    assert.strictEqual((JSON.parse(renamed.body) as WorkspaceInfo).WorkspaceID, 'QA');
    assert.strictEqual(deleted.statusCode, 204);
    assert.strictEqual(errorLog.appendedEntries.length, 3);
    for (const entry of errorLog.appendedEntries) {
        assert.strictEqual(entry.Severity, 'warning');
        assert.strictEqual(entry.Operation, 'refresh-siblings');
    }
});

test('T-17: each failed entry of the refresh result is logged as a warning without changing the response', async () => {
    const { router, wm, artifacts, errorLog } = buildSut();
    wm.seedProject('proj-a', ['STABLE']);
    artifacts.refreshResult = {
        refreshed: [],
        failed: [{ workspaceId: 'STABLE', error: 'boom' }, { workspaceId: 'QA', error: 'bang' }],
    };

    const mock = mockResponse();
    router.handle(mockRequest('POST', '/api/projects/proj-a/workspaces', { workspaceId: 'DEV' }), mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 201);
    assert.strictEqual(errorLog.appendedEntries.length, 2);
    assert.ok(errorLog.appendedEntries[0].Message.includes('boom'));
    assert.strictEqual(errorLog.appendedEntries[0].Operation, 'refresh-siblings');
});

// ---------------------------------------------------------------------------
// Workspace directives — T-30
// ---------------------------------------------------------------------------

function buildDirectiveSut() {
    const calls: { method: string; args: unknown[] }[] = [];
    const stored = (id: string, text: string) => ({ Id: id, Text: text, DateModified: '2026-01-01T00:00:00.000Z' });
    const guard = (projectId: string, scope: { workspaceId: string }): void => {
        if (projectId !== 'proj-a') throw new NotFoundError(`project "${projectId}" does not exist`);
        if (scope.workspaceId !== 'DEV') throw new NotFoundError(`workspace "${scope.workspaceId}" does not exist`);
    };
    const projectManager = {
        listDirectives(projectId: string, scope: { workspaceId: string }) { calls.push({ method: 'list', args: [projectId, scope] }); guard(projectId, scope); return [stored('d1', 'One')]; },
        addDirective(projectId: string, scope: { workspaceId: string }, input: { Text: string }) {
            calls.push({ method: 'add', args: [projectId, scope, input] });
            guard(projectId, scope);
            if (input.Text.trim() === '') throw new Error('Directive must not be empty.');
            return stored('d2', input.Text);
        },
        updateDirective(projectId: string, scope: { workspaceId: string }, id: string, input: { Text: string }) {
            calls.push({ method: 'update', args: [projectId, scope, id, input] });
            guard(projectId, scope);
            if (id !== 'd1') throw new NotFoundError(`Directive "${id}" does not exist`);
            return stored(id, input.Text);
        },
        removeDirective(projectId: string, scope: { workspaceId: string }, id: string) {
            calls.push({ method: 'remove', args: [projectId, scope, id] });
            guard(projectId, scope);
            if (id !== 'd1') throw new NotFoundError(`Directive "${id}" does not exist`);
            return stored(id, 'One');
        },
    };
    return { ...buildSut({ projectManager }), calls };
}

async function sendWs(router: Router, method: string, url: string, body?: unknown): Promise<MockResponse> {
    const mock = mockResponse();
    router.handle(mockRequest(method, url, body), mock.res);
    await flushAsync();
    return mock;
}

test('T-30: workspace directive endpoints use workspace scope with the route wid and regenerate that workspace', async () => {
    const { router, artifacts, calls } = buildDirectiveSut();
    const base = '/api/projects/proj-a/workspaces/DEV/directives';

    assert.strictEqual((await sendWs(router, 'GET', base)).statusCode, 200);
    assert.strictEqual((await sendWs(router, 'POST', base, { text: 'Rule.' })).statusCode, 201);
    assert.strictEqual((await sendWs(router, 'PUT', `${base}/d1`, { text: 'Changed.' })).statusCode, 200);
    assert.strictEqual((await sendWs(router, 'DELETE', `${base}/d1`)).statusCode, 204);

    for (const call of calls) {
        assert.deepEqual(call.args[1], { kind: 'workspace', workspaceId: 'DEV' });
    }
    assert.deepEqual(artifacts.calls, [
        { method: 'regenerateWorkspace', args: ['proj-a', 'DEV'] },
        { method: 'regenerateWorkspace', args: ['proj-a', 'DEV'] },
        { method: 'regenerateWorkspace', args: ['proj-a', 'DEV'] },
    ]);
});

test('T-30: workspace directive endpoints return 404 for unknown workspace/directive and 400 for bad input', async () => {
    const { router, artifacts } = buildDirectiveSut();

    assert.strictEqual((await sendWs(router, 'GET', '/api/projects/proj-a/workspaces/NOPE/directives')).statusCode, 404);
    assert.strictEqual((await sendWs(router, 'POST', '/api/projects/proj-a/workspaces/NOPE/directives', { text: 'x' })).statusCode, 404);
    assert.strictEqual((await sendWs(router, 'PUT', '/api/projects/proj-a/workspaces/DEV/directives/zzz', { text: 'x' })).statusCode, 404);
    assert.strictEqual((await sendWs(router, 'DELETE', '/api/projects/proj-a/workspaces/DEV/directives/zzz')).statusCode, 404);
    assert.strictEqual((await sendWs(router, 'POST', '/api/projects/proj-a/workspaces/DEV/directives', {})).statusCode, 400);
    assert.strictEqual((await sendWs(router, 'POST', '/api/projects/proj-a/workspaces/DEV/directives', { text: ' ' })).statusCode, 400);
    assert.deepEqual(artifacts.calls, []);
});

test('T-30: a throwing regeneration does not change the response, but logs a warning', async () => {
    const { router, artifacts, errorLog } = buildDirectiveSut();
    artifacts.shouldThrow = true;

    const mock = await sendWs(router, 'POST', '/api/projects/proj-a/workspaces/DEV/directives', { text: 'Rule.' });

    assert.strictEqual(mock.statusCode, 201);
    assert.strictEqual(errorLog.appendedEntries.length, 1);
    assert.strictEqual(errorLog.appendedEntries[0].Severity, 'warning');
});
