/**
 * Tests for the two launch route handlers added in WP-002:
 *   POST /api/projects/:id/workspaces/:wid/launch/vscode
 *   POST /api/projects/:id/workspaces/:wid/launch/github-desktop/:rid
 *
 * `launchApplication` is injected via the optional 7th parameter of
 * `registerWorkspaceRoutes`, so no real child processes are spawned.
 * File-system checks (fs.existsSync) rely on real temporary directories
 * created and torn down per test, following the same pattern as
 * workspaces-health.test.ts.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Router } from '../../router.js';
import { registerWorkspaceRoutes } from '../../routes/workspaces.js';
import { NotFoundError } from '../../../errors.js';
import type { WorkspaceInfo } from '../../../models/workspace/workspace.types.js';
import type { ProjectData } from '../../../models/project/project.types.js';
import { mockRequest, mockResponse, flushAsync, type MockResponse } from '../helpers/mock-http.js';

// ---------------------------------------------------------------------------
// Temp-directory lifecycle (same approach as workspaces-health.test.ts)
// ---------------------------------------------------------------------------

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

function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-launch-test-'));
    allTempDirs.push(dir);
    return dir;
}

// ---------------------------------------------------------------------------
// Mock WorkspaceManager
// ---------------------------------------------------------------------------

function makeWsInfo(projectId: string, wsId: string): WorkspaceInfo {
    const now = new Date().toISOString();
    return { ProjectID: projectId, WorkspaceID: wsId, Description: '', DateCreated: now, DateModified: now, Notes: '' };
}

class MockWorkspaceManager {
    private projects: Record<string, Set<string>> = {};

    seedProject(projectId: string, workspaceIds: string[]): void {
        this.projects[projectId] = new Set(workspaceIds);
    }

    getById(projectId: string, workspaceId: string): WorkspaceInfo | undefined {
        const ws = this.projects[projectId];
        if (!ws) {
            throw new NotFoundError(`Cannot get workspace: project with ID "${projectId}" does not exist.`);
        }
        if (!ws.has(workspaceId)) return undefined;
        return makeWsInfo(projectId, workspaceId);
    }
}

// ---------------------------------------------------------------------------
// Mock ProjectManager
// ---------------------------------------------------------------------------

class MockProjectManager {
    private projects: Record<string, ProjectData> = {};

    seedProject(id: string, repositories: string[]): void {
        const now = new Date().toISOString();
        this.projects[id] = {
            Id: id,
            Name: id,
            Description: '',
            Repositories: repositories,
            Workspaces: {},
            SchemaVersion: 1,
            DateCreated: now,
            DateModified: now,
        };
    }

    getById(id: string): ProjectData | undefined {
        return this.projects[id];
    }
}

// ---------------------------------------------------------------------------
// Mock ErrorLogManager
// ---------------------------------------------------------------------------

interface CapturedLogEntry {
    Severity: string;
    Source: string;
    Operation: string;
    Context: Record<string, unknown>;
    Message: string;
}

class MockErrorLogManager {
    readonly entries: CapturedLogEntry[] = [];

    append(entry: Omit<CapturedLogEntry, 'Id' | 'Timestamp'>): CapturedLogEntry {
        this.entries.push(entry as CapturedLogEntry);
        return entry as CapturedLogEntry;
    }
}

// ---------------------------------------------------------------------------
// Stub launch function
// ---------------------------------------------------------------------------

interface LaunchCall {
    command: string;
    args: string[];
}

function makeLaunchStub(shouldReject = false, error = new Error('launch failed')): {
    fn: (command: string, args: string[]) => Promise<void>;
    calls: LaunchCall[];
} {
    const calls: LaunchCall[] = [];
    const fn = async (command: string, args: string[]): Promise<void> => {
        calls.push({ command, args });
        if (shouldReject) {
            throw error;
        }
    };
    return { fn, calls };
}

// ---------------------------------------------------------------------------
// Test fixture builder
// ---------------------------------------------------------------------------

interface SutFixture {
    router: Router;
    wm: MockWorkspaceManager;
    pm: MockProjectManager;
    elm: MockErrorLogManager;
    projectsFolder: string;
}

function buildSut(
    projectsFolder: string,
    launchFn?: (command: string, args: string[]) => Promise<void>,
): SutFixture {
    const router = new Router();
    const wm = new MockWorkspaceManager();
    const pm = new MockProjectManager();
    const elm = new MockErrorLogManager();
    const stubOrchestrator = {} as never;
    const stubConfig = { projectsFolder } as never;
    registerWorkspaceRoutes(
        router,
        wm as never,
        stubOrchestrator,
        stubConfig,
        pm as never,
        elm as never,
        launchFn,
    );
    return { router, wm, pm, elm, projectsFolder };
}

// ===========================================================================
// POST /api/projects/:id/workspaces/:wid/launch/vscode
// ===========================================================================

// ---------------------------------------------------------------------------
// 404: workspace does not exist
// ---------------------------------------------------------------------------

test('POST /launch/vscode: returns 404 when workspace does not exist', async () => {
    const projectsFolder = makeTempDir();
    const stub = makeLaunchStub();
    const { router, wm } = buildSut(projectsFolder, stub.fn);
    wm.seedProject('proj-a', ['STABLE']);

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/GHOST/launch/vscode');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('POST /launch/vscode: returns 404 when project does not exist', async () => {
    const projectsFolder = makeTempDir();
    const stub = makeLaunchStub();
    const { router } = buildSut(projectsFolder, stub.fn);

    const req = mockRequest('POST', '/api/projects/ghost/workspaces/STABLE/launch/vscode');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
});

// ---------------------------------------------------------------------------
// 400: .code-workspace file missing from disk
// ---------------------------------------------------------------------------

test('POST /launch/vscode: returns 400 with correct message when .code-workspace file is missing', async () => {
    const projectsFolder = makeTempDir();
    const stub = makeLaunchStub();
    const { router, wm } = buildSut(projectsFolder, stub.fn);
    wm.seedProject('proj-a', ['STABLE']);
    // The workspace file path is NOT created on disk — so existsSync returns false.

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/launch/vscode');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.strictEqual(parsed.error, 'Workspace file does not exist. Run setup first.');
});

// ---------------------------------------------------------------------------
// 200: file exists and launch succeeds
// ---------------------------------------------------------------------------

test('POST /launch/vscode: returns 200 { success: true } when file exists and launch succeeds', async () => {
    const projectsFolder = makeTempDir();
    const stub = makeLaunchStub();
    const { router, wm } = buildSut(projectsFolder, stub.fn);
    wm.seedProject('proj-a', ['STABLE']);

    // Create the expected .code-workspace file path on disk so existsSync returns true.
    // Path format: {projectsFolder}/{projectId}/{projectId}-{workspaceId}.code-workspace
    const projDir = path.join(projectsFolder, 'proj-a');
    fs.mkdirSync(projDir, { recursive: true });
    const wsFilePath = path.join(projDir, 'proj-a-STABLE.code-workspace');
    fs.writeFileSync(wsFilePath, '{}');

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/launch/vscode');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const parsed = JSON.parse(mock.body) as { success: boolean };
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(stub.calls.length, 1);
    assert.strictEqual(stub.calls[0]!.command, 'code');
    assert.deepStrictEqual(stub.calls[0]!.args, [wsFilePath]);
});

// ---------------------------------------------------------------------------
// 500: launch fails — returns error + logs to ErrorLogManager
// ---------------------------------------------------------------------------

test('POST /launch/vscode: returns 500 and logs error when launch throws', async () => {
    const projectsFolder = makeTempDir();
    const stub = makeLaunchStub(true, new Error('code: command not found'));
    const { router, wm, elm } = buildSut(projectsFolder, stub.fn);
    wm.seedProject('proj-a', ['STABLE']);

    // Create the workspace file so we get past the 400 guard.
    const projDir = path.join(projectsFolder, 'proj-a');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'proj-a-STABLE.code-workspace'), '{}');

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/launch/vscode');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 500);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');

    // Verify error log entry
    assert.strictEqual(elm.entries.length, 1);
    const entry = elm.entries[0]!;
    assert.strictEqual(entry.Source, 'app-launcher');
    assert.strictEqual(entry.Operation, 'launch-vscode');
    assert.strictEqual(entry.Severity, 'error');
    assert.strictEqual(entry.Context['ProjectId'], 'proj-a');
    assert.strictEqual(entry.Context['WorkspaceId'], 'STABLE');
    assert.ok(typeof entry.Message === 'string' && entry.Message.length > 0);
});

// ===========================================================================
// POST /api/projects/:id/workspaces/:wid/launch/github-desktop/:rid
// ===========================================================================

// ---------------------------------------------------------------------------
// 404: workspace does not exist
// ---------------------------------------------------------------------------

test('POST /launch/github-desktop/:rid: returns 404 when workspace does not exist', async () => {
    const projectsFolder = makeTempDir();
    const stub = makeLaunchStub();
    const { router, wm } = buildSut(projectsFolder, stub.fn);
    wm.seedProject('proj-a', ['STABLE']);

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/GHOST/launch/github-desktop/repo-1');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
});

test('POST /launch/github-desktop/:rid: returns 404 when project does not exist', async () => {
    const projectsFolder = makeTempDir();
    const stub = makeLaunchStub();
    const { router } = buildSut(projectsFolder, stub.fn);

    const req = mockRequest('POST', '/api/projects/ghost/workspaces/STABLE/launch/github-desktop/repo-1');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
});

// ---------------------------------------------------------------------------
// 404: project not found via ProjectManager (wm passes but pm doesn't)
// ---------------------------------------------------------------------------

test('POST /launch/github-desktop/:rid: returns 404 when project not found in ProjectManager', async () => {
    const projectsFolder = makeTempDir();
    const stub = makeLaunchStub();
    const { router, wm } = buildSut(projectsFolder, stub.fn);
    // Workspace exists in wm but no project data in pm
    wm.seedProject('proj-a', ['STABLE']);

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/launch/github-desktop/repo-1');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(parsed.error.includes('proj-a'));
});

// ---------------------------------------------------------------------------
// 404: repository not in project's Repositories list
// ---------------------------------------------------------------------------

test('POST /launch/github-desktop/:rid: returns 404 when repository not in project', async () => {
    const projectsFolder = makeTempDir();
    const stub = makeLaunchStub();
    const { router, wm, pm } = buildSut(projectsFolder, stub.fn);
    wm.seedProject('proj-a', ['STABLE']);
    pm.seedProject('proj-a', ['repo-1', 'repo-2']);

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/launch/github-desktop/repo-999');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(parsed.error.includes('repo-999'));
});

// ---------------------------------------------------------------------------
// 400: repository directory missing from disk
// ---------------------------------------------------------------------------

test('POST /launch/github-desktop/:rid: returns 400 with correct message when repo directory is missing', async () => {
    const projectsFolder = makeTempDir();
    const stub = makeLaunchStub();
    const { router, wm, pm } = buildSut(projectsFolder, stub.fn);
    wm.seedProject('proj-a', ['STABLE']);
    pm.seedProject('proj-a', ['repo-1']);
    // Repo directory is NOT created on disk — so existsSync returns false.

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/launch/github-desktop/repo-1');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.strictEqual(parsed.error, 'Repository directory does not exist. Run setup first.');
});

// ---------------------------------------------------------------------------
// 200: directory exists and launch succeeds
// ---------------------------------------------------------------------------

test('POST /launch/github-desktop/:rid: returns 200 { success: true } when dir exists and launch succeeds', async () => {
    const projectsFolder = makeTempDir();
    const stub = makeLaunchStub();
    const { router, wm, pm } = buildSut(projectsFolder, stub.fn);
    wm.seedProject('proj-a', ['STABLE']);
    pm.seedProject('proj-a', ['repo-1']);

    // Create the expected repository directory on disk.
    // Path format: {projectsFolder}/{projectId}/{workspaceId}/{repoId}
    const repoDir = path.join(projectsFolder, 'proj-a', 'STABLE', 'repo-1');
    fs.mkdirSync(repoDir, { recursive: true });

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/launch/github-desktop/repo-1');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const parsed = JSON.parse(mock.body) as { success: boolean };
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(stub.calls.length, 1);
    assert.strictEqual(stub.calls[0]!.command, 'github');
    assert.deepStrictEqual(stub.calls[0]!.args, [repoDir]);
});

// ---------------------------------------------------------------------------
// 500: launch fails — returns error + logs to ErrorLogManager
// ---------------------------------------------------------------------------

test('POST /launch/github-desktop/:rid: returns 500 and logs error when launch throws', async () => {
    const projectsFolder = makeTempDir();
    const stub = makeLaunchStub(true, new Error('github: command not found'));
    const { router, wm, pm, elm } = buildSut(projectsFolder, stub.fn);
    wm.seedProject('proj-a', ['STABLE']);
    pm.seedProject('proj-a', ['repo-1']);

    // Create the repo directory so we get past the 400 guard.
    const repoDir = path.join(projectsFolder, 'proj-a', 'STABLE', 'repo-1');
    fs.mkdirSync(repoDir, { recursive: true });

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/launch/github-desktop/repo-1');
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 500);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');

    // Verify error log entry
    assert.strictEqual(elm.entries.length, 1);
    const entry = elm.entries[0]!;
    assert.strictEqual(entry.Source, 'app-launcher');
    assert.strictEqual(entry.Operation, 'launch-github-desktop');
    assert.strictEqual(entry.Severity, 'error');
    assert.strictEqual(entry.Context['ProjectId'], 'proj-a');
    assert.strictEqual(entry.Context['WorkspaceId'], 'STABLE');
    assert.strictEqual(entry.Context['RepositoryId'], 'repo-1');
    assert.ok(typeof entry.Message === 'string' && entry.Message.length > 0);
});
