import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../router.js';
import { registerProjectRoutes } from '../../routes/projects.js';
import { NotFoundError } from '../../../errors.js';
import type { ProjectData, ProjectIndexEntry } from '../../../models/project/project.types.js';
import { mockRequest, mockResponse, type MockResponse } from '../helpers/mock-http.js';

// ---------------------------------------------------------------------------
// Mock ProjectManager
// ---------------------------------------------------------------------------

function makeProject(id: string, name: string, repoIds: string[] = []): ProjectData {
    const now = new Date().toISOString();
    return {
        Id: id,
        Name: name,
        Description: '',
        DateCreated: now,
        DateModified: now,
        Repositories: [...repoIds],
        Workspaces: { STABLE: { Description: 'Stable workspace', DateCreated: now, DateModified: now } },
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

function buildSut(): { router: Router; pm: MockProjectManager } {
    const router = new Router();
    const pm = new MockProjectManager();
    registerProjectRoutes(router, pm as never);
    return { router, pm };
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

// ---------------------------------------------------------------------------
// DELETE /api/projects/:id/repositories/:repoId — unlink a repo
// ---------------------------------------------------------------------------

test('DELETE /api/projects/:id/repositories/:repoId: returns 204 on success', () => {
    const { router, pm } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project', ['repo-a', 'repo-b'])]);

    const req = mockRequest('DELETE', '/api/projects/my-proj/repositories/repo-a');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
    assert.deepEqual(pm.getById('my-proj')?.Repositories, ['repo-b']);
});

test('DELETE /api/projects/:id/repositories/:repoId: returns 404 when project does not exist', () => {
    const { router } = buildSut();
    const req = mockRequest('DELETE', '/api/projects/ghost/repositories/repo-a');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('DELETE /api/projects/:id/repositories/:repoId: returns 404 when repo is not linked', () => {
    const { router, pm } = buildSut();
    pm.seed([makeProject('my-proj', 'My Project', ['repo-b'])]);

    const req = mockRequest('DELETE', '/api/projects/my-proj/repositories/repo-a');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
});
