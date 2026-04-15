/**
 * Integration tests for:
 *   GET  /api/projects/:id/workspaces/:wid/health
 *   POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file
 *
 * These tests exercise the full request pipeline through the Router and route
 * handlers using lightweight mock managers.  The health and regenerate routes
 * both perform real `fs` operations, so a temporary directory is created on
 * disk for every on-disk scenario and cleaned up after each test.
 *
 * @see src/server/routes/workspaces.ts — route handler implementations
 * @see src/orchestration/workspace-health.ts — WorkspaceHealthReport type and checkWorkspaceHealth()
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Router } from '../../router.js';
import { registerWorkspaceRoutes } from '../../routes/workspaces.js';
import { NotFoundError } from '../../../errors.js';
import type { WorkspaceInfo } from '../../../models/workspace/workspace.types.js';
import type { ProjectData } from '../../../models/project/project.types.js';
import type { WorkspaceHealthReport } from '../../../orchestration/workspace-health.js';

// ---------------------------------------------------------------------------
// Temp-directory lifecycle
// ---------------------------------------------------------------------------

// Track every directory created during this test module so they are always
// removed — both in the normal flow (after()) and on crash (process.on('exit')).
const allTempDirs: string[] = [];

process.on('exit', () => {
    for (const dir of allTempDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

after(() => {
    for (const dir of allTempDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    allTempDirs.length = 0;
});

/**
 * Creates a unique temporary directory, registers it for cleanup, and
 * returns its absolute path.
 */
function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-health-test-'));
    allTempDirs.push(dir);
    return dir;
}

// ---------------------------------------------------------------------------
// Minimal HTTP primitives
// ---------------------------------------------------------------------------

function mockRequest(method: string, url: string): IncomingMessage {
    const req = new EventEmitter() as IncomingMessage;
    (req as unknown as { method: string }).method = method;
    (req as unknown as { url: string }).url = url;
    (req as unknown as { destroy(): void }).destroy = () => {
        req.emit('error', new Error('destroyed'));
    };
    // Emit 'end' asynchronously so the request looks like a real stream; the
    // handlers under test do not consume a body, so this never blocks a test.
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
// Mock WorkspaceManager
// ---------------------------------------------------------------------------

class MockWorkspaceManager {
    private readonly data = new Map<string, Map<string, WorkspaceInfo>>();

    /**
     * Seeds a workspace entry so the mock returns it from `getById`.
     */
    seed(projectId: string, workspaceId: string): void {
        const now = new Date().toISOString();
        if (!this.data.has(projectId)) {
            this.data.set(projectId, new Map());
        }
        this.data.get(projectId)!.set(workspaceId, {
            ProjectID: projectId,
            WorkspaceID: workspaceId,
            Description: '',
            DateCreated: now,
            DateModified: now,
        });
    }

    getById(projectId: string, workspaceId: string): WorkspaceInfo | undefined {
        const project = this.data.get(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot get workspace: project "${projectId}" does not exist.`);
        }
        return project.get(workspaceId);
    }
}

// ---------------------------------------------------------------------------
// Mock ProjectManager
// ---------------------------------------------------------------------------

class MockProjectManager {
    private readonly data = new Map<string, ProjectData>();

    /**
     * Seeds a project entry so the mock returns it from `getById`.
     */
    seed(project: ProjectData): void {
        this.data.set(project.Id, project);
    }

    getById(id: string): ProjectData | undefined {
        return this.data.get(id);
    }
}

// ---------------------------------------------------------------------------
// Test builder
// ---------------------------------------------------------------------------

function buildSut(projectsFolder: string): {
    router: Router;
    wm: MockWorkspaceManager;
    pm: MockProjectManager;
} {
    const router = new Router();
    const wm = new MockWorkspaceManager();
    const pm = new MockProjectManager();
    const stubOrchestrator = {} as never;
    const appConfig = { projectsFolder } as never;
    registerWorkspaceRoutes(router, wm as never, stubOrchestrator, appConfig, pm as never);
    return { router, wm, pm };
}

function makeProject(id: string, repositories: string[] = []): ProjectData {
    const now = new Date().toISOString();
    return {
        Id: id,
        Name: id,
        Description: '',
        DateCreated: now,
        DateModified: now,
        Repositories: repositories,
        Workspaces: {},
        SchemaVersion: 1,
    };
}

// ===========================================================================
// GET /api/projects/:id/workspaces/:wid/health
// ===========================================================================

test('GET /health: returns 404 when project does not exist', () => {
    const projectsFolder = makeTempDir();
    const { router } = buildSut(projectsFolder);

    const req = mockRequest('GET', '/api/projects/ghost/workspaces/STABLE/health');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
});

test('GET /health: returns 404 when workspace does not exist in project', () => {
    const projectsFolder = makeTempDir();
    const { router, wm, pm } = buildSut(projectsFolder);
    pm.seed(makeProject('proj-a', ['repo-x']));
    wm.seed('proj-a', 'STABLE');  // seed STABLE but not GHOST

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/GHOST/health');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
});

test('GET /health: returns 200 { healthy: true, issues: [] } for an uninitialized workspace', () => {
    // When the workspace folder has not been created (workspace was never set up),
    // the endpoint should not flag any health issues.
    const projectsFolder = makeTempDir();
    const { router, wm, pm } = buildSut(projectsFolder);
    pm.seed(makeProject('proj-a', ['repo-x', 'repo-y']));
    wm.seed('proj-a', 'STABLE');
    // Workspace folder is intentionally left absent on disk.

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/STABLE/health');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const report = JSON.parse(mock.body) as WorkspaceHealthReport;
    assert.strictEqual(report.healthy, true);
    assert.deepStrictEqual(report.issues, []);
});

test('GET /health: returns 200 healthy report when workspace file and all repos are present', () => {
    const projectsFolder = makeTempDir();
    const { router, wm, pm } = buildSut(projectsFolder);
    pm.seed(makeProject('proj-a', ['repo-x', 'repo-y']));
    wm.seed('proj-a', 'DEV');

    // Create workspace folder on disk.
    const wsFolder = path.join(projectsFolder, 'proj-a', 'DEV');
    fs.mkdirSync(wsFolder, { recursive: true });

    // Each repository has a .git directory (simulates a successful clone).
    fs.mkdirSync(path.join(wsFolder, 'repo-x', '.git'), { recursive: true });
    fs.mkdirSync(path.join(wsFolder, 'repo-y', '.git'), { recursive: true });

    // VS Code .code-workspace file exists.
    const wsFilePath = path.join(projectsFolder, 'proj-a', 'proj-a-DEV.code-workspace');
    fs.writeFileSync(wsFilePath, JSON.stringify({ folders: [], settings: {} }));

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/DEV/health');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const report = JSON.parse(mock.body) as WorkspaceHealthReport;
    assert.strictEqual(report.healthy, true);
    assert.deepStrictEqual(report.issues, []);
});

test('GET /health: returns 200 with issues when workspace file is missing and repos are not cloned', () => {
    const projectsFolder = makeTempDir();
    const { router, wm, pm } = buildSut(projectsFolder);
    pm.seed(makeProject('proj-a', ['repo-x', 'repo-y']));
    wm.seed('proj-a', 'DEV');

    // Create the workspace folder but omit the .code-workspace file and .git directories.
    const wsFolder = path.join(projectsFolder, 'proj-a', 'DEV');
    fs.mkdirSync(wsFolder, { recursive: true });

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/DEV/health');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const report = JSON.parse(mock.body) as WorkspaceHealthReport;

    // Workspace is unhealthy: missing workspace file (1) + two uncloned repos (2).
    assert.strictEqual(report.healthy, false);
    assert.strictEqual(report.issues.length, 3);

    assert.ok(
        report.issues.some((i) => i.type === 'workspace-file-missing'),
        'Expected a workspace-file-missing issue',
    );
    assert.ok(
        report.issues.some((i) => i.type === 'repository-not-cloned' && i.repositoryId === 'repo-x'),
        'Expected a repository-not-cloned issue for repo-x',
    );
    assert.ok(
        report.issues.some((i) => i.type === 'repository-not-cloned' && i.repositoryId === 'repo-y'),
        'Expected a repository-not-cloned issue for repo-y',
    );
});

test('GET /health: returns 200 with only missing-workspace-file issue when repos are cloned but file is absent', () => {
    const projectsFolder = makeTempDir();
    const { router, wm, pm } = buildSut(projectsFolder);
    pm.seed(makeProject('proj-a', ['repo-x']));
    wm.seed('proj-a', 'DEV');

    const wsFolder = path.join(projectsFolder, 'proj-a', 'DEV');
    fs.mkdirSync(wsFolder, { recursive: true });
    fs.mkdirSync(path.join(wsFolder, 'repo-x', '.git'), { recursive: true });
    // No .code-workspace file.

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/DEV/health');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const report = JSON.parse(mock.body) as WorkspaceHealthReport;
    assert.strictEqual(report.healthy, false);
    assert.strictEqual(report.issues.length, 1);
    assert.strictEqual(report.issues[0]?.type, 'workspace-file-missing');
});

// ===========================================================================
// POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file
// ===========================================================================

test('POST /regenerate-workspace-file: returns 404 when project does not exist', () => {
    const projectsFolder = makeTempDir();
    const { router } = buildSut(projectsFolder);

    const req = mockRequest('POST', '/api/projects/ghost/workspaces/STABLE/regenerate-workspace-file');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
});

test('POST /regenerate-workspace-file: returns 404 when workspace does not exist in project', () => {
    const projectsFolder = makeTempDir();
    const { router, wm, pm } = buildSut(projectsFolder);
    pm.seed(makeProject('proj-a', ['repo-x']));
    wm.seed('proj-a', 'STABLE');  // seed STABLE but not GHOST

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/GHOST/regenerate-workspace-file');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
});

test('POST /regenerate-workspace-file: returns 400 when workspace folder does not exist on disk', () => {
    const projectsFolder = makeTempDir();
    const { router, wm, pm } = buildSut(projectsFolder);
    pm.seed(makeProject('proj-a', ['repo-x']));
    wm.seed('proj-a', 'STABLE');
    // Workspace folder is intentionally left absent on disk.

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/regenerate-workspace-file');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
});

test('POST /regenerate-workspace-file: returns 200 and writes .code-workspace file to disk', () => {
    const projectsFolder = makeTempDir();
    const { router, wm, pm } = buildSut(projectsFolder);
    pm.seed(makeProject('proj-a', ['repo-x', 'repo-y']));
    wm.seed('proj-a', 'DEV');

    // Create the workspace folder so the 400 guard is satisfied.
    const wsFolder = path.join(projectsFolder, 'proj-a', 'DEV');
    fs.mkdirSync(wsFolder, { recursive: true });

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/DEV/regenerate-workspace-file');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { success: boolean };
    assert.strictEqual(body.success, true);

    // Verify the .code-workspace file was written with the expected structure.
    const wsFilePath = path.join(projectsFolder, 'proj-a', 'proj-a-DEV.code-workspace');
    assert.ok(fs.existsSync(wsFilePath), '.code-workspace file must exist after regeneration');

    const wsFile = JSON.parse(fs.readFileSync(wsFilePath, 'utf8')) as {
        folders: Array<{ path: string; name: string }>;
    };
    assert.strictEqual(wsFile.folders.length, 2, 'workspace file must contain one entry per repository');
    assert.ok(
        wsFile.folders.some((f) => f.name === 'repo-x (DEV)'),
        'Expected folder entry for repo-x with workspace label',
    );
    assert.ok(
        wsFile.folders.some((f) => f.name === 'repo-y (DEV)'),
        'Expected folder entry for repo-y with workspace label',
    );
    // Verify each folder path points to the correct on-disk location.
    assert.ok(
        wsFile.folders.some((f) => f.path === path.join(wsFolder, 'repo-x')),
        'repo-x folder path must be inside the workspace directory',
    );
    assert.ok(
        wsFile.folders.some((f) => f.path === path.join(wsFolder, 'repo-y')),
        'repo-y folder path must be inside the workspace directory',
    );
});

test('POST /regenerate-workspace-file: preserves existing .code-workspace settings section', () => {
    const projectsFolder = makeTempDir();
    const { router, wm, pm } = buildSut(projectsFolder);
    pm.seed(makeProject('proj-a', ['repo-x']));
    wm.seed('proj-a', 'DEV');

    const wsFolder = path.join(projectsFolder, 'proj-a', 'DEV');
    fs.mkdirSync(wsFolder, { recursive: true });

    // Pre-write a .code-workspace file with custom settings that must survive regeneration.
    const wsFilePath = path.join(projectsFolder, 'proj-a', 'proj-a-DEV.code-workspace');
    const existingContent = {
        folders: [{ path: '/old/path', name: 'old-repo (DEV)' }],
        settings: { 'editor.fontSize': 14 },
        extensions: { recommendations: ['dbaeumer.vscode-eslint'] },
    };
    fs.writeFileSync(wsFilePath, JSON.stringify(existingContent));

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/DEV/regenerate-workspace-file');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);

    const wsFile = JSON.parse(fs.readFileSync(wsFilePath, 'utf8')) as {
        folders: Array<{ path: string; name: string }>;
        settings: Record<string, unknown>;
        extensions: { recommendations: string[] };
    };

    // Folders must be replaced with the current repository list.
    assert.strictEqual(wsFile.folders.length, 1);
    assert.strictEqual(wsFile.folders[0]?.name, 'repo-x (DEV)');

    // Pre-existing settings and extensions must be preserved verbatim.
    assert.deepStrictEqual(wsFile.settings, { 'editor.fontSize': 14 });
    assert.deepStrictEqual(wsFile.extensions, { recommendations: ['dbaeumer.vscode-eslint'] });
});
