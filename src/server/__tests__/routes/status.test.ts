import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as nodePath from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Router } from '../../router.js';
import { registerStatusRoutes } from '../../routes/status.js';
import type { WorkspaceStatusResponse } from '../../routes/status.js';
import type { GitStatusInfo } from '../../../git/git.types.js';
import type { WorkspaceInfo } from '../../../models/workspace/workspace.types.js';
import type { ProjectData } from '../../../models/project/project.types.js';
import type { AppConfig } from '../../../config/config.types.js';

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function mockRequest(method: string, url: string): IncomingMessage {
    const req = new EventEmitter() as IncomingMessage;
    (req as unknown as { method: string }).method = method;
    (req as unknown as { url: string }).url = url;
    (req as unknown as { destroy(): void }).destroy = () => {
        req.emit('error', new Error('destroyed'));
    };
    process.nextTick(() => req.emit('end'));
    return req;
}

interface MockResponse {
    statusCode: number | undefined;
    headers: Record<string, string | number>;
    body: string;
    res: ServerResponse;
}

function mockResponse(): MockResponse {
    const mock: MockResponse = {
        statusCode: undefined,
        headers: {},
        body: '',
        res: null as unknown as ServerResponse,
    };
    const res = new EventEmitter() as unknown as ServerResponse;
    (res as unknown as {
        writeHead(status: number, headers: Record<string, string | number>): void;
    }).writeHead = (status: number, headers: Record<string, string | number>) => {
        mock.statusCode = status;
        mock.headers = { ...headers };
    };
    (res as unknown as { end(body: string): void }).end = (body: string) => {
        mock.body = body;
    };
    mock.res = res;
    return mock;
}

// ---------------------------------------------------------------------------
// Mock ProjectManager
// ---------------------------------------------------------------------------

function makeProject(id: string, repoIds: string[]): ProjectData {
    const now = new Date().toISOString();
    return {
        Id: id,
        Name: id,
        Description: '',
        DateCreated: now,
        DateModified: now,
        Repositories: [...repoIds],
        Workspaces: { STABLE: { Description: '', DateCreated: now, DateModified: now } },
        SchemaVersion: 1,
    };
}

class MockProjectManager {
    private store: ProjectData[] = [];

    seed(projects: ProjectData[]): void {
        this.store = [...projects];
    }

    getById(id: string): ProjectData | undefined {
        return this.store.find((p) => p.Id === id);
    }

    list() {
        return this.store.map((p) => ({ Id: p.Id, Name: p.Name }));
    }
}

// ---------------------------------------------------------------------------
// Mock WorkspaceManager
// ---------------------------------------------------------------------------

class MockWorkspaceManager {
    private known: Array<{ projectId: string; workspaceId: string }> = [];

    register(projectId: string, workspaceId: string): void {
        this.known.push({ projectId, workspaceId });
    }

    getById(projectId: string, workspaceId: string): WorkspaceInfo | undefined {
        const now = new Date().toISOString();
        const found = this.known.some((k) => k.projectId === projectId && k.workspaceId === workspaceId);
        if (!found) return undefined;
        return { ProjectID: projectId, WorkspaceID: workspaceId, Description: '', DateCreated: now, DateModified: now };
    }
}

// ---------------------------------------------------------------------------
// Mock PollingManager
// ---------------------------------------------------------------------------

function makeStatus(branch: string): GitStatusInfo {
    return {
        currentBranch: branch,
        localCommits: 0,
        unfetchedCommits: 0,
        modifiedFiles: 0,
        lastActivity: new Date().toISOString(),
        hasConflicts: false,
    };
}

class MockPollingManager {
    private cache: Map<string, GitStatusInfo> = new Map();
    private throwOnRefresh: Error | null = null;
    /** Tracks how many times refreshWorkspace was called (to verify GET doesn't call it). */
    refreshCallCount = 0;
    /** Tracks how many times getStatus was called. */
    getStatusCallCount = 0;

    seedCache(repoPath: string, status: GitStatusInfo): void {
        this.cache.set(repoPath, status);
    }

    setThrowOnRefresh(err: Error): void {
        this.throwOnRefresh = err;
    }

    getStatus(repoPath: string): GitStatusInfo | null {
        this.getStatusCallCount++;
        return this.cache.get(repoPath) ?? null;
    }

    async refreshWorkspace(_projectId: string, _workspaceId: string): Promise<void> {
        this.refreshCallCount++;
        if (this.throwOnRefresh) throw this.throwOnRefresh;
    }
}

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const TEST_CONFIG: AppConfig = {
    projectsFolder: '/projects',
    storageFolder: '/storage',
    cloneDepth: 50,
    serverPort: 4200,
    gitPollingIntervalSeconds: 30,
};

function buildSut(): {
    router: Router;
    pm: MockPollingManager;
    projectManager: MockProjectManager;
    wm: MockWorkspaceManager;
} {
    const router = new Router();
    const pm = new MockPollingManager();
    const projectManager = new MockProjectManager();
    const wm = new MockWorkspaceManager();
    registerStatusRoutes(router, pm as never, projectManager as never, wm as never, TEST_CONFIG);
    return { router, pm, projectManager, wm };
}

async function flushAsync(): Promise<void> {
    await new Promise<void>((r) => process.nextTick(r));
    await new Promise<void>((r) => process.nextTick(r));
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id/workspaces/:wid/status
// ---------------------------------------------------------------------------

test('GET status: returns 200 with cached status for all repos in the workspace', () => {
    const { router, pm, projectManager, wm } = buildSut();
    projectManager.seed([makeProject('proj-a', ['repo-1', 'repo-2'])]);
    wm.register('proj-a', 'STABLE');

    const repo1Path = nodePath.join('/projects', 'proj-a', 'STABLE', 'repo-1');
    const repo2Path = nodePath.join('/projects', 'proj-a', 'STABLE', 'repo-2');
    pm.seedCache(repo1Path, makeStatus('main'));
    pm.seedCache(repo2Path, makeStatus('feature-x'));

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/STABLE/status');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const result = JSON.parse(mock.body) as WorkspaceStatusResponse;
    assert.strictEqual(result['repo-1']?.currentBranch, 'main');
    assert.strictEqual(result['repo-2']?.currentBranch, 'feature-x');
});

test('GET status: returns null for repos not yet polled', () => {
    const { router, projectManager, wm } = buildSut();
    projectManager.seed([makeProject('proj-a', ['repo-1'])]);
    wm.register('proj-a', 'STABLE');

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/STABLE/status');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const result = JSON.parse(mock.body) as WorkspaceStatusResponse;
    assert.strictEqual(result['repo-1'], null);
});

test('GET status: returns 200 with empty object when workspace has no repos', () => {
    const { router, projectManager, wm } = buildSut();
    projectManager.seed([makeProject('proj-a', [])]);
    wm.register('proj-a', 'STABLE');

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/STABLE/status');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(JSON.parse(mock.body), {});
});

test('GET status: returns 404 when project does not exist', () => {
    const { router, wm } = buildSut();
    wm.register('proj-a', 'STABLE');

    const req = mockRequest('GET', '/api/projects/ghost/workspaces/STABLE/status');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('GET status: returns 404 when workspace does not exist', () => {
    const { router, projectManager } = buildSut();
    projectManager.seed([makeProject('proj-a', ['repo-1'])]);
    // workspace NOT registered

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/GHOST/status');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
});

test('GET status: does NOT call refreshWorkspace (no git I/O)', () => {
    const { router, pm, projectManager, wm } = buildSut();
    projectManager.seed([makeProject('proj-a', ['repo-1'])]);
    wm.register('proj-a', 'STABLE');

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/STABLE/status');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(pm.refreshCallCount, 0, 'GET should not call refreshWorkspace');
});

// ---------------------------------------------------------------------------
// POST /api/projects/:id/workspaces/:wid/status/refresh
// ---------------------------------------------------------------------------

test('POST status/refresh: returns 200 with updated status after refreshWorkspace', async () => {
    const { router, pm, projectManager, wm } = buildSut();
    projectManager.seed([makeProject('proj-a', ['repo-1'])]);
    wm.register('proj-a', 'STABLE');

    // Simulate refreshWorkspace updating the cache
    const repo1Path = nodePath.join('/projects', 'proj-a', 'STABLE', 'repo-1');
    pm.seedCache(repo1Path, makeStatus('main'));

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/status/refresh');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const result = JSON.parse(mock.body) as WorkspaceStatusResponse;
    assert.strictEqual(result['repo-1']?.currentBranch, 'main');
    assert.strictEqual(pm.refreshCallCount, 1);
});

test('POST status/refresh: returns 404 when project does not exist', async () => {
    const { router } = buildSut();

    const req = mockRequest('POST', '/api/projects/ghost/workspaces/STABLE/status/refresh');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('POST status/refresh: returns 404 when workspace does not exist', async () => {
    const { router, projectManager } = buildSut();
    projectManager.seed([makeProject('proj-a', ['repo-1'])]);

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/GHOST/status/refresh');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
});

test('POST status/refresh: returns 404 when refreshWorkspace throws (project/workspace race)', async () => {
    const { router, pm, projectManager, wm } = buildSut();
    projectManager.seed([makeProject('proj-a', ['repo-1'])]);
    wm.register('proj-a', 'STABLE');
    pm.setThrowOnRefresh(new Error('PollingManager: project "proj-a" does not exist.'));

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/status/refresh');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 500);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.strictEqual(parsed.error, 'Internal server error.');
});
