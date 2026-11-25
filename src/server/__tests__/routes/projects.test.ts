import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../router.js';
import { registerProjectRoutes } from '../../routes/projects.js';
import { NotFoundError } from '../../../errors.js';
import type { ProjectData, ProjectIndexEntry } from '../../../models/project/project.types.js';
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
}

// ---------------------------------------------------------------------------
// Fake RepositoryOrchestrator
// ---------------------------------------------------------------------------

/**
 * Records every call to `removeRepositoryFromProject()` and, unless configured
 * to simulate a path-guard rejection via `shouldThrowPathGuard`, mirrors the
 * real `RepositoryOrchestrator` method's externally-observable side effects
 * against the injected fakes: mutating the project's repository list via
 * `pm.removeRepository()`, unconditionally appending the `unlink-repository`
 * audit entry, then best-effort regenerating the artefact set (a throwing
 * choke-point here logs a `Severity: 'warning'` entry instead of propagating).
 *
 * This lets the route-level tests assert delegation (call arguments) while
 * still exercising the route's own 404-before-call and 500-after-throw
 * branches without duplicating the orchestrator's own unit tests.
 */
class FakeRepositoryOrchestrator {
    calls: { method: string; args: unknown[] }[] = [];
    shouldThrowPathGuard = false;

    constructor(
        private readonly pm: MockProjectManager,
        private readonly artifacts: MockWorkspaceArtifacts,
        private readonly errorLog: ReturnType<typeof makeMockErrorLogManager>,
    ) {}

    removeRepositoryFromProject(projectId: string, repositoryId: string): void {
        this.calls.push({ method: 'removeRepositoryFromProject', args: [projectId, repositoryId] });

        if (this.shouldThrowPathGuard) {
            throw new Error(
                `Security check failed: clone path is not under projectsFolder "${projectId}".`,
            );
        }

        this.pm.removeRepository(projectId, repositoryId);

        this.errorLog.append({
            Severity: 'audit',
            Source: 'repository-audit',
            Operation: 'unlink-repository',
            Context: { ProjectId: projectId, RepositoryId: repositoryId },
            Message: `Repository "${repositoryId}" was unlinked from project "${projectId}" and its clone folders removed.`,
        });

        try {
            this.artifacts.regenerateProject(projectId);
        } catch (err) {
            this.errorLog.append({
                Severity: 'warning',
                Source: 'workspace-index',
                Operation: 'unlink-repository',
                Context: { ProjectId: projectId, RepositoryId: repositoryId },
                Message: `Failed to regenerate workspace artefacts for project "${projectId}" after ` +
                    `unlinking repository "${repositoryId}": ${err instanceof Error ? err.message : String(err)}`,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Mock ProjectManager
// ---------------------------------------------------------------------------

function makeProject(id: string, name: string, repoIds: string[] = [], workspaceIds: string[] = ['STABLE']): ProjectData {
    const now = new Date().toISOString();
    const workspaces: ProjectData['Workspaces'] = {};
    for (const workspaceId of workspaceIds) {
        workspaces[workspaceId] = { Description: `${workspaceId} workspace`, DateCreated: now, DateModified: now };
    }
    return {
        Id: id,
        Name: name,
        Description: '',
        DateCreated: now,
        DateModified: now,
        Repositories: [...repoIds],
        Workspaces: workspaces,
        SchemaVersion: 1,
    };
}

class MockProjectManager {
    private store: ProjectData[] = [];

    list(): ProjectIndexEntry[] {
        return this.store.map((p) => ({ Id: p.Id, Name: p.Name }));
    }

    getById(id: string): ProjectData | undefined {
        return this.store.find((p) => p.Id === id);
    }

    create(name: string, repositoryIds: string[], description?: string, id?: string): ProjectData {
        const resolvedId = id ?? name.toLowerCase().replace(/\s+/g, '-');

        const duplicate = this.store.find((p) => p.Id === resolvedId);
        if (duplicate) {
            throw new Error(`A project with ID "${resolvedId}" already exists.`);
        }

        const project = makeProject(resolvedId, name, repositoryIds);
        if (description !== undefined) project.Description = description;
        this.store.push(project);
        return project;
    }

    update(id: string, changes: { Name?: string; Description?: string }): ProjectData {
        const project = this.store.find((p) => p.Id === id);
        if (!project) {
            throw new NotFoundError(`Cannot update: project with ID "${id}" does not exist.`);
        }
        if (changes.Name !== undefined) project.Name = changes.Name;
        if (changes.Description !== undefined) project.Description = changes.Description;
        project.DateModified = new Date().toISOString();
        return project;
    }

    rename(oldId: string, newId: string): ProjectData {
        const project = this.store.find((p) => p.Id === oldId);
        if (!project) {
            throw new NotFoundError(`Cannot rename: project with ID "${oldId}" does not exist.`);
        }
        const conflict = this.store.find((p) => p.Id === newId);
        if (conflict) {
            throw new Error(`Cannot rename: a project with ID "${newId}" already exists.`);
        }
        project.Id = newId;
        project.DateModified = new Date().toISOString();
        return project;
    }

    remove(id: string): void {
        const index = this.store.findIndex((p) => p.Id === id);
        if (index === -1) {
            throw new NotFoundError(`Cannot remove: project with ID "${id}" does not exist.`);
        }
        this.store.splice(index, 1);
    }

    addRepository(projectId: string, repositoryId: string): ProjectData {
        const project = this.store.find((p) => p.Id === projectId);
        if (!project) {
            throw new NotFoundError(`Cannot addRepository: project with ID "${projectId}" does not exist.`);
        }
        if (project.Repositories.includes(repositoryId)) {
            throw new Error(`Repository "${repositoryId}" is already listed in project "${projectId}".`);
        }
        project.Repositories.push(repositoryId);
        project.DateModified = new Date().toISOString();
        return project;
    }

    removeRepository(projectId: string, repositoryId: string): ProjectData {
        const project = this.store.find((p) => p.Id === projectId);
        if (!project) {
            throw new NotFoundError(`Cannot removeRepository: project with ID "${projectId}" does not exist.`);
        }
        const idx = project.Repositories.indexOf(repositoryId);
        if (idx === -1) {
            throw new Error(`Repository "${repositoryId}" is not listed in project "${projectId}".`);
        }
        project.Repositories.splice(idx, 1);
        project.DateModified = new Date().toISOString();
        return project;
    }

    // Test helper
    seed(projects: ProjectData[]): void {
        this.store = projects.map((p) => ({ ...p, Repositories: [...p.Repositories] }));
    }
}

function buildSut(): {
    router: Router;
    pm: MockProjectManager;
    artifacts: MockWorkspaceArtifacts;
    errorLog: ReturnType<typeof makeMockErrorLogManager>;
    repositoryOrchestrator: FakeRepositoryOrchestrator;
} {
    const router = new Router();
    const pm = new MockProjectManager();
    const artifacts = new MockWorkspaceArtifacts();
    const errorLog = makeMockErrorLogManager();
    const repositoryOrchestrator = new FakeRepositoryOrchestrator(pm, artifacts, errorLog);
    registerProjectRoutes(router, pm as never, artifacts as never, repositoryOrchestrator as never, errorLog);
    return { router, pm, artifacts, errorLog, repositoryOrchestrator };
}

/** Waits two process ticks so async route handlers can resolve. */
async function flushAsync(): Promise<void> {
    await new Promise<void>((r) => process.nextTick(r));
    await new Promise<void>((r) => process.nextTick(r));
}

// ---------------------------------------------------------------------------
// GET /api/projects — list all
// ---------------------------------------------------------------------------

test('GET /api/projects: returns 200 with an empty array when no projects exist', () => {
    const { router } = buildSut();
    const req = mockRequest('GET', '/api/projects');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(JSON.parse(mock.body), []);
});

test('GET /api/projects: returns 200 with index entries for all projects', () => {
    const { router, pm } = buildSut();
    pm.seed([makeProject('proj-a', 'Project A'), makeProject('proj-b', 'Project B')]);

    const req = mockRequest('GET', '/api/projects');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const result = JSON.parse(mock.body) as ProjectIndexEntry[];
    assert.strictEqual(result.length, 2);
    assert.ok(result.some((p) => p.Id === 'proj-a'));
    assert.ok(result.some((p) => p.Id === 'proj-b'));
});

// ---------------------------------------------------------------------------
// GET /api/projects/:id — get one
// ---------------------------------------------------------------------------

test('GET /api/projects/:id: returns 200 with full project data when found', () => {
    const { router, pm } = buildSut();
    const project = makeProject('my-proj', 'My Project');
    pm.seed([project]);

    const req = mockRequest('GET', '/api/projects/my-proj');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const parsed = JSON.parse(mock.body) as ProjectData;
    assert.strictEqual(parsed.Id, 'my-proj');
    assert.strictEqual(parsed.Name, 'My Project');
});

test('GET /api/projects/:id: returns 404 with { error } when project does not exist', () => {
    const { router } = buildSut();
    const req = mockRequest('GET', '/api/projects/ghost');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

// ---------------------------------------------------------------------------
// POST /api/projects — create
// ---------------------------------------------------------------------------

test('POST /api/projects: returns 201 with the created project on valid input', async () => {
    const { router } = buildSut();
    const payload = { name: 'New Project', repositoryIds: [], id: 'new-project' };
    const req = mockRequest('POST', '/api/projects', payload);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 201);
    const created = JSON.parse(mock.body) as ProjectData;
    assert.strictEqual(created.Id, 'new-project');
    assert.strictEqual(created.Name, 'New Project');
});

test('POST /api/projects: returns 400 when name is missing', async () => {
    const { router } = buildSut();
    const req = mockRequest('POST', '/api/projects', { repositoryIds: [] });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('POST /api/projects: returns 400 when name is empty string', async () => {
    const { router } = buildSut();
    const req = mockRequest('POST', '/api/projects', { name: '  ' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
});

test('POST /api/projects: returns 400 when repositoryIds is not an array', async () => {
    const { router } = buildSut();
    const req = mockRequest('POST', '/api/projects', { name: 'Proj', repositoryIds: 'not-array' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
});

test('POST /api/projects: returns 400 when body is not a JSON object', async () => {
    const { router } = buildSut();
    const req = mockRequest('POST', '/api/projects', [1, 2, 3]);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
});

// ---------------------------------------------------------------------------
// PUT /api/projects/:id — update
// ---------------------------------------------------------------------------

test('PUT /api/projects/:id: returns 200 with updated project on valid name change', async () => {
    const { router, pm } = buildSut();
    pm.seed([makeProject('my-proj', 'Old Name')]);

    const req = mockRequest('PUT', '/api/projects/my-proj', { name: 'New Name' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as ProjectData;
    assert.strictEqual(updated.Name, 'New Name');
});

test('PUT /api/projects/:id: regenerates the artefact set for every workspace on success', async () => {
    const { router, pm, artifacts } = buildSut();
    pm.seed([makeProject('my-proj', 'Old Name')]);

    const req = mockRequest('PUT', '/api/projects/my-proj', { name: 'New Name' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(
        artifacts.calls.map((c) => c.method),
        ['regenerateProject'],
    );
    assert.deepEqual(artifacts.calls[0].args, ['my-proj']);
});

test('PUT /api/projects/:id: a throwing choke-point does not change the 200 response, but logs a warning', async () => {
    const { router, pm, artifacts, errorLog } = buildSut();
    pm.seed([makeProject('my-proj', 'Old Name')]);
    artifacts.shouldThrow = true;

    const req = mockRequest('PUT', '/api/projects/my-proj', { name: 'New Name' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as ProjectData;
    assert.strictEqual(updated.Name, 'New Name');
    assert.strictEqual(errorLog.appendedEntries.length, 1);
    assert.strictEqual(errorLog.appendedEntries[0].Severity, 'warning');
    assert.strictEqual(errorLog.appendedEntries[0].Source, 'workspace-index');
});

test('PUT /api/projects/:id: returns 404 when project does not exist', async () => {
    const { router } = buildSut();
    const req = mockRequest('PUT', '/api/projects/ghost', { name: 'Ghost' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
});

test('PUT /api/projects/:id: returns 400 when no updatable fields are provided', async () => {
    const { router, pm } = buildSut();
    pm.seed([makeProject('my-proj', 'My Proj')]);

    const req = mockRequest('PUT', '/api/projects/my-proj', { unrelated: 'field' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
});

// ---------------------------------------------------------------------------
// PUT /api/projects/:id/rename — rename (change project ID)
// ---------------------------------------------------------------------------

test('PUT /api/projects/:id/rename: returns 200 with the renamed project on valid input', async () => {
    const { router, pm } = buildSut();
    pm.seed([makeProject('old-id', 'My Project')]);

    const req = mockRequest('PUT', '/api/projects/old-id/rename', { newId: 'new-id' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const renamed = JSON.parse(mock.body) as ProjectData;
    assert.strictEqual(renamed.Id, 'new-id');
});

test('PUT /api/projects/:id/rename: returns 404 when project ID does not exist', async () => {
    const { router } = buildSut();
    const req = mockRequest('PUT', '/api/projects/ghost/rename', { newId: 'new-id' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('PUT /api/projects/:id/rename: returns 400 when newId is missing', async () => {
    const { router, pm } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project')]);

    const req = mockRequest('PUT', '/api/projects/my-proj/rename', { unrelated: 'field' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/projects/:id/rename: regenerates artefacts under the new ID and removes them under the old ID', async () => {
    const { router, pm, artifacts } = buildSut();
    pm.seed([makeProject('old-id', 'My Project')]);

    const req = mockRequest('PUT', '/api/projects/old-id/rename', { newId: 'new-id' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(
        artifacts.calls.map((c) => c.method),
        ['regenerateWorkspace', 'removeWorkspace'],
    );
    assert.deepEqual(artifacts.calls[0].args, ['new-id', 'STABLE']);
    assert.deepEqual(artifacts.calls[1].args, ['old-id', 'STABLE']);
});

test('PUT /api/projects/:id/rename: AC-20 — a throwing choke-point does not change the 200 response, but logs a warning', async () => {
    const { router, pm, artifacts, errorLog } = buildSut();
    pm.seed([makeProject('old-id', 'My Project')]);
    artifacts.shouldThrow = true;

    const req = mockRequest('PUT', '/api/projects/old-id/rename', { newId: 'new-id' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const renamed = JSON.parse(mock.body) as ProjectData;
    assert.strictEqual(renamed.Id, 'new-id');
    assert.strictEqual(errorLog.appendedEntries.length, 1);
    assert.strictEqual(errorLog.appendedEntries[0].Severity, 'warning');
    assert.strictEqual(errorLog.appendedEntries[0].Source, 'workspace-index');
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/:id — delete
// ---------------------------------------------------------------------------

test('DELETE /api/projects/:id: returns 204 when project is deleted successfully', () => {
    const { router, pm } = buildSut();
    pm.seed([makeProject('to-delete', 'To Delete')]);

    const req = mockRequest('DELETE', '/api/projects/to-delete');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
});

test('DELETE /api/projects/:id: returns 404 when project does not exist', () => {
    const { router } = buildSut();
    const req = mockRequest('DELETE', '/api/projects/ghost');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('DELETE /api/projects/:id: removes the artefact set for every workspace of the deleted project', () => {
    const { router, pm, artifacts } = buildSut();
    pm.seed([makeProject('to-delete', 'To Delete', [], ['STABLE', 'DEV'])]);

    const req = mockRequest('DELETE', '/api/projects/to-delete');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
    assert.deepEqual(artifacts.calls, [
        { method: 'removeWorkspace', args: ['to-delete', 'STABLE'] },
        { method: 'removeWorkspace', args: ['to-delete', 'DEV'] },
    ]);
});

test('DELETE /api/projects/:id: AC-20 — a throwing choke-point does not change the 204 response, but logs a warning', () => {
    const { router, pm, artifacts, errorLog } = buildSut();
    pm.seed([makeProject('to-delete', 'To Delete')]);
    artifacts.shouldThrow = true;

    const req = mockRequest('DELETE', '/api/projects/to-delete');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
    assert.strictEqual(errorLog.appendedEntries.length, 1);
    assert.strictEqual(errorLog.appendedEntries[0].Severity, 'warning');
    assert.strictEqual(errorLog.appendedEntries[0].Source, 'workspace-index');
});

// ---------------------------------------------------------------------------
// POST /api/projects/:id/repositories — link a repo
// ---------------------------------------------------------------------------

test('POST /api/projects/:id/repositories: returns 200 when repo is successfully linked', async () => {
    const { router, pm } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project')]);

    const req = mockRequest('POST', '/api/projects/my-proj/repositories', { repositoryId: 'repo-a' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as ProjectData;
    assert.ok(updated.Repositories.includes('repo-a'));
});

test('POST /api/projects/:id/repositories: returns 404 when project does not exist', async () => {
    const { router } = buildSut();
    const req = mockRequest('POST', '/api/projects/ghost/repositories', { repositoryId: 'repo-a' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('POST /api/projects/:id/repositories: returns 400 when repositoryId is missing', async () => {
    const { router, pm } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project')]);

    const req = mockRequest('POST', '/api/projects/my-proj/repositories', { unrelated: 'field' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
});

test('POST /api/projects/:id/repositories: regenerates the project\'s artefact set', async () => {
    const { router, pm, artifacts } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project')]);

    const req = mockRequest('POST', '/api/projects/my-proj/repositories', { repositoryId: 'repo-a' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(artifacts.calls, [{ method: 'regenerateProject', args: ['my-proj'] }]);
});

test('POST /api/projects/:id/repositories: AC-20 — a throwing choke-point does not change the 200 response, but logs a warning', async () => {
    const { router, pm, artifacts, errorLog } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project')]);
    artifacts.shouldThrow = true;

    const req = mockRequest('POST', '/api/projects/my-proj/repositories', { repositoryId: 'repo-a' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as ProjectData;
    assert.ok(updated.Repositories.includes('repo-a'));
    assert.strictEqual(errorLog.appendedEntries.length, 1);
    assert.strictEqual(errorLog.appendedEntries[0].Severity, 'warning');
    assert.strictEqual(errorLog.appendedEntries[0].Source, 'workspace-index');
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/:id/repositories/:repoId — unlink a repo
// ---------------------------------------------------------------------------

test('DELETE /api/projects/:id/repositories/:repoId: returns 204 on success and delegates to the orchestrator', () => {
    const { router, pm, repositoryOrchestrator } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project', ['repo-a', 'repo-b'])]);

    const req = mockRequest('DELETE', '/api/projects/my-proj/repositories/repo-a');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
    assert.deepEqual(pm.getById('my-proj')?.Repositories, ['repo-b']);
    assert.deepEqual(repositoryOrchestrator.calls, [
        { method: 'removeRepositoryFromProject', args: ['my-proj', 'repo-a'] },
    ]);
});

test('DELETE /api/projects/:id/repositories/:repoId: emits an unlink-repository audit entry on success', () => {
    const { router, pm, errorLog } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project', ['repo-a', 'repo-b'])]);

    const req = mockRequest('DELETE', '/api/projects/my-proj/repositories/repo-a');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
    const auditEntry = errorLog.appendedEntries.find((e) => e.Operation === 'unlink-repository' && e.Severity === 'audit');
    assert.ok(auditEntry, 'expected an audit-severity unlink-repository entry');
    assert.deepEqual(auditEntry?.Context, { ProjectId: 'my-proj', RepositoryId: 'repo-a' });
});

test('DELETE /api/projects/:id/repositories/:repoId: unlinks from every workspace of a multi-workspace project', () => {
    const { router, pm, repositoryOrchestrator } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project', ['repo-a', 'repo-b'], ['STABLE', 'DEV'])]);

    const req = mockRequest('DELETE', '/api/projects/my-proj/repositories/repo-a');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
    assert.deepEqual(pm.getById('my-proj')?.Repositories, ['repo-b']);
    assert.deepEqual(repositoryOrchestrator.calls, [
        { method: 'removeRepositoryFromProject', args: ['my-proj', 'repo-a'] },
    ]);
});

test('DELETE /api/projects/:id/repositories/:repoId: returns 404 when project does not exist and does not call the orchestrator', () => {
    const { router, repositoryOrchestrator } = buildSut();
    const req = mockRequest('DELETE', '/api/projects/ghost/repositories/repo-a');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
    assert.deepEqual(repositoryOrchestrator.calls, []);
});

test('DELETE /api/projects/:id/repositories/:repoId: returns 404 when repo is not linked and does not call the orchestrator', () => {
    const { router, pm, repositoryOrchestrator } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project', ['repo-b'])]);

    const req = mockRequest('DELETE', '/api/projects/my-proj/repositories/repo-a');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    assert.deepEqual(repositoryOrchestrator.calls, []);
    assert.deepEqual(pm.getById('my-proj')?.Repositories, ['repo-b']);
});

test('DELETE /api/projects/:id/repositories/:repoId: returns 500 when the orchestrator rejects the clone path', () => {
    const { router, pm, repositoryOrchestrator } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project', ['repo-a', 'repo-b'])]);
    repositoryOrchestrator.shouldThrowPathGuard = true;

    const req = mockRequest('DELETE', '/api/projects/my-proj/repositories/repo-a');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 500);
    // No filesystem/data mutation performed by the (fake) orchestrator when it throws.
    assert.deepEqual(pm.getById('my-proj')?.Repositories, ['repo-a', 'repo-b']);
});

test('DELETE /api/projects/:id/repositories/:repoId: regenerates the project\'s artefact set', () => {
    const { router, pm, artifacts } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project', ['repo-a', 'repo-b'])]);

    const req = mockRequest('DELETE', '/api/projects/my-proj/repositories/repo-a');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
    assert.deepEqual(artifacts.calls, [{ method: 'regenerateProject', args: ['my-proj'] }]);
});

test('DELETE /api/projects/:id/repositories/:repoId: returns 204 when artefact regeneration fails after the mutation succeeded, and logs a warning', () => {
    const { router, pm, artifacts, errorLog } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project', ['repo-a', 'repo-b'])]);
    artifacts.shouldThrow = true;

    const req = mockRequest('DELETE', '/api/projects/my-proj/repositories/repo-a');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
    assert.deepEqual(pm.getById('my-proj')?.Repositories, ['repo-b']);
    const warningEntry = errorLog.appendedEntries.find((e) => e.Severity === 'warning');
    assert.ok(warningEntry, 'expected a warning entry for the failed regeneration');
    assert.strictEqual(warningEntry?.Source, 'workspace-index');
    assert.strictEqual(warningEntry?.Operation, 'unlink-repository');
});

// ---------------------------------------------------------------------------
// Directives and repository role — T-29, T-31
// ---------------------------------------------------------------------------

/** Patches directive/role methods and the index refresh onto the shared mocks, recording every call. */
function buildDirectiveSut(): ReturnType<typeof buildSut> & {
    managerCalls: { method: string; args: unknown[] }[];
    refreshCalls: string[];
    refresh: { shouldThrow: boolean; failed: { workspaceId: string; error: string }[] };
} {
    const sut = buildSut();
    const managerCalls: { method: string; args: unknown[] }[] = [];
    const refreshCalls: string[] = [];
    const refresh = { shouldThrow: false, failed: [] as { workspaceId: string; error: string }[] };
    const pm = sut.pm as unknown as Record<string, unknown>;
    const stored = (id: string, text: string) => ({ Id: id, Text: text, DateModified: '2026-01-01T00:00:00.000Z' });
    const guard = (projectId: string): void => {
        if (sut.pm.getById(projectId) === undefined) throw new NotFoundError(`project "${projectId}" does not exist`);
    };
    pm['listDirectives'] = (projectId: string, scope: unknown) => { managerCalls.push({ method: 'listDirectives', args: [projectId, scope] }); guard(projectId); return [stored('d1', 'One')]; };
    pm['addDirective'] = (projectId: string, scope: unknown, input: { Text: string }) => {
        managerCalls.push({ method: 'addDirective', args: [projectId, scope, input] });
        guard(projectId);
        if (input.Text.trim() === '') throw new Error('Directive must not be empty.');
        return stored('d2', input.Text);
    };
    pm['updateDirective'] = (projectId: string, scope: unknown, id: string, input: { Text: string }) => {
        managerCalls.push({ method: 'updateDirective', args: [projectId, scope, id, input] });
        guard(projectId);
        if (id !== 'd1') throw new NotFoundError(`Directive "${id}" does not exist`);
        return stored(id, input.Text);
    };
    pm['removeDirective'] = (projectId: string, scope: unknown, id: string) => {
        managerCalls.push({ method: 'removeDirective', args: [projectId, scope, id] });
        guard(projectId);
        if (id !== 'd1') throw new NotFoundError(`Directive "${id}" does not exist`);
        return stored(id, 'One');
    };
    pm['setRepositoryRole'] = (projectId: string, repoId: string, text: string) => {
        managerCalls.push({ method: 'setRepositoryRole', args: [projectId, repoId, text] });
        guard(projectId);
        if (repoId !== 'repo-a') throw new NotFoundError(`Repository "${repoId}" is not listed`);
        if (text.length > 100) throw new Error('Role is too long.');
        return text.trim();
    };
    (sut.artifacts as unknown as Record<string, unknown>)['refreshProjectIndexes'] = (projectId: string) => {
        refreshCalls.push(projectId);
        if (refresh.shouldThrow) throw new Error('Simulated refresh failure.');
        return { refreshed: [], failed: refresh.failed };
    };
    return { ...sut, managerCalls, refreshCalls, refresh };
}

async function send(router: Router, method: string, url: string, body?: unknown): Promise<MockResponse> {
    const mock = mockResponse();
    router.handle(mockRequest(method, url, body), mock.res);
    await flushAsync();
    return mock;
}

test('T-29: project directive endpoints succeed, use project scope and refresh the indexes', async () => {
    const { router, pm, managerCalls, refreshCalls } = buildDirectiveSut();
    pm.seed([makeProject('p', 'P')]);

    assert.strictEqual((await send(router, 'GET', '/api/projects/p/directives')).statusCode, 200);

    const created = await send(router, 'POST', '/api/projects/p/directives', { text: 'Be nice.' });
    assert.strictEqual(created.statusCode, 201);
    assert.strictEqual((JSON.parse(created.body) as { Text: string }).Text, 'Be nice.');

    assert.strictEqual((await send(router, 'PUT', '/api/projects/p/directives/d1', { text: 'Changed.' })).statusCode, 200);
    assert.strictEqual((await send(router, 'DELETE', '/api/projects/p/directives/d1')).statusCode, 204);

    for (const call of managerCalls) {
        assert.deepEqual(call.args[1], { kind: 'project' });
    }
    assert.deepEqual(refreshCalls, ['p', 'p', 'p']);
});

test('T-29: project directive endpoints return 400 on validation errors and 404 on unknown project/directive', async () => {
    const { router, pm, refreshCalls } = buildDirectiveSut();
    pm.seed([makeProject('p', 'P')]);

    assert.strictEqual((await send(router, 'POST', '/api/projects/p/directives', { text: '  ' })).statusCode, 400);
    assert.strictEqual((await send(router, 'POST', '/api/projects/p/directives', {})).statusCode, 400);
    assert.strictEqual((await send(router, 'POST', '/api/projects/nope/directives', { text: 'x' })).statusCode, 404);
    assert.strictEqual((await send(router, 'GET', '/api/projects/nope/directives')).statusCode, 404);
    assert.strictEqual((await send(router, 'PUT', '/api/projects/p/directives/zzz', { text: 'x' })).statusCode, 404);
    assert.strictEqual((await send(router, 'DELETE', '/api/projects/p/directives/zzz')).statusCode, 404);
    assert.deepEqual(refreshCalls, []);
});

test('T-29: a refresh failure is tolerated and logged as a warning', async () => {
    const { router, pm, refresh, errorLog } = buildDirectiveSut();
    pm.seed([makeProject('p', 'P')]);

    refresh.shouldThrow = true;
    assert.strictEqual((await send(router, 'POST', '/api/projects/p/directives', { text: 'x' })).statusCode, 201);
    assert.strictEqual(errorLog.appendedEntries.length, 1);
    assert.strictEqual(errorLog.appendedEntries[0].Severity, 'warning');

    refresh.shouldThrow = false;
    refresh.failed = [{ workspaceId: 'STABLE', error: 'disk full' }];
    assert.strictEqual((await send(router, 'DELETE', '/api/projects/p/directives/d1')).statusCode, 204);
    assert.strictEqual(errorLog.appendedEntries.length, 2);
});

test('T-31: the role endpoint sets and clears a role and refreshes the indexes', async () => {
    const { router, pm, managerCalls, refreshCalls } = buildDirectiveSut();
    pm.seed([makeProject('p', 'P', ['repo-a'])]);

    const set = await send(router, 'PUT', '/api/projects/p/repositories/repo-a/role', { role: 'Core' });
    assert.strictEqual(set.statusCode, 200);
    assert.deepEqual(JSON.parse(set.body), { role: 'Core' });

    const cleared = await send(router, 'PUT', '/api/projects/p/repositories/repo-a/role', { role: '' });
    assert.strictEqual(cleared.statusCode, 200);
    assert.deepEqual(JSON.parse(cleared.body), { role: '' });

    assert.deepEqual(managerCalls.map((c) => c.args), [['p', 'repo-a', 'Core'], ['p', 'repo-a', '']]);
    assert.deepEqual(refreshCalls, ['p', 'p']);
});

test('T-31: the role endpoint returns 400 / 404 on errors and tolerates a refresh failure', async () => {
    const { router, pm, refresh, errorLog } = buildDirectiveSut();
    pm.seed([makeProject('p', 'P', ['repo-a'])]);

    assert.strictEqual((await send(router, 'PUT', '/api/projects/p/repositories/repo-a/role', {})).statusCode, 400);
    assert.strictEqual((await send(router, 'PUT', '/api/projects/p/repositories/repo-a/role', { role: 'x'.repeat(200) })).statusCode, 400);
    assert.strictEqual((await send(router, 'PUT', '/api/projects/nope/repositories/repo-a/role', { role: 'x' })).statusCode, 404);
    assert.strictEqual((await send(router, 'PUT', '/api/projects/p/repositories/other/role', { role: 'x' })).statusCode, 404);

    refresh.shouldThrow = true;
    assert.strictEqual((await send(router, 'PUT', '/api/projects/p/repositories/repo-a/role', { role: 'x' })).statusCode, 200);
    assert.strictEqual(errorLog.appendedEntries.length, 1);
});

test('GET /api/projects/:id exposes Directives and RepositoryRoles', () => {
    const { router, pm } = buildSut();
    const project = makeProject('p', 'P', ['repo-a']);
    project.Directives = [{ Id: 'd1', Text: 'One', DateModified: '2026-01-01T00:00:00.000Z' }];
    project.RepositoryRoles = { 'repo-a': 'Core' };
    pm.seed([project]);

    const mock = mockResponse();
    router.handle(mockRequest('GET', '/api/projects/p'), mock.res);

    const body = JSON.parse(mock.body) as ProjectData;
    assert.deepEqual(body.RepositoryRoles, { 'repo-a': 'Core' });
    assert.strictEqual(body.Directives?.[0].Text, 'One');
});
