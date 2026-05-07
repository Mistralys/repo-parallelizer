import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Router } from '../../router.js';
import { registerBranchRoutes } from '../../routes/branches.js';
import type { BranchesResponse } from '../../routes/branches.js';
import type { BranchInfo } from '../../../git/git.types.js';
import type { BranchSwitchResult } from '../../../orchestration/orchestration.types.js';
import type { WorkspaceInfo } from '../../../models/workspace/workspace.types.js';

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function mockRequest(method: string, url: string, bodyJson?: unknown): IncomingMessage {
    const req = new EventEmitter() as IncomingMessage;
    (req as unknown as { method: string }).method = method;
    (req as unknown as { url: string }).url = url;
    (req as unknown as { destroy(): void }).destroy = () => {
        req.emit('error', new Error('destroyed'));
    };
    process.nextTick(() => {
        if (bodyJson !== undefined) {
            req.emit('data', Buffer.from(JSON.stringify(bodyJson)));
        }
        req.emit('end');
    });
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
// Mock BranchOrchestrator
// ---------------------------------------------------------------------------

class MockBranchOrchestrator {
    private branchMap: Map<string, BranchInfo[]> = new Map();
    private switchResult: BranchSwitchResult = { results: {} };
    private throwOnGetBranches: Error | null = null;
    private throwOnSwitch: Error | null = null;

    setBranchMap(map: Map<string, BranchInfo[]>): void {
        this.branchMap = map;
    }

    setSwitchResult(result: BranchSwitchResult): void {
        this.switchResult = result;
    }

    setThrowOnGetBranches(err: Error): void {
        this.throwOnGetBranches = err;
    }

    setThrowOnSwitch(err: Error): void {
        this.throwOnSwitch = err;
    }

    async getAvailableBranches(_projectId: string, _workspaceId: string): Promise<Map<string, BranchInfo[]>> {
        if (this.throwOnGetBranches) throw this.throwOnGetBranches;
        return this.branchMap;
    }

    compileBranchSuggestions(branchMap: Map<string, BranchInfo[]>): string[] {
        const seen = new Map<string, string>();
        for (const branches of branchMap.values()) {
            for (const branch of branches) {
                const name = branch.isRemote
                    ? branch.name.slice(branch.name.indexOf('/') + 1)
                    : branch.name;
                const lower = name.toLowerCase();
                if (!seen.has(lower)) seen.set(lower, name);
            }
        }
        return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
    }

    async switchBranches(
        _projectId: string,
        _workspaceId: string,
        _assignments: Record<string, string>,
    ): Promise<BranchSwitchResult> {
        if (this.throwOnSwitch) throw this.throwOnSwitch;
        return this.switchResult;
    }
}

// ---------------------------------------------------------------------------
// Mock WorkspaceManager
// ---------------------------------------------------------------------------

class MockWorkspaceManager {
    private known: Array<{ projectId: string; workspaceId: string }> = [];
    private throwOnGet: Error | null = null;

    registerWorkspace(projectId: string, workspaceId: string): void {
        this.known.push({ projectId, workspaceId });
    }

    setThrowOnGet(err: Error): void {
        this.throwOnGet = err;
    }

    getById(projectId: string, workspaceId: string): WorkspaceInfo | undefined {
        if (this.throwOnGet) throw this.throwOnGet;
        const now = new Date().toISOString();
        const found = this.known.some((k) => k.projectId === projectId && k.workspaceId === workspaceId);
        if (!found) return undefined;
        return { ProjectID: projectId, WorkspaceID: workspaceId, Description: '', DateCreated: now, DateModified: now, Notes: '' };
    }
}

function buildSut(): {
    router: Router;
    orchestrator: MockBranchOrchestrator;
    wm: MockWorkspaceManager;
} {
    const router = new Router();
    const orchestrator = new MockBranchOrchestrator();
    const wm = new MockWorkspaceManager();
    registerBranchRoutes(router, orchestrator as never, wm as never);
    return { router, orchestrator, wm };
}

async function flushAsync(): Promise<void> {
    await new Promise<void>((r) => process.nextTick(r));
    await new Promise<void>((r) => process.nextTick(r));
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id/workspaces/:wid/branches
// ---------------------------------------------------------------------------

test('GET branches: returns 200 with branches and suggestions on valid project/workspace', async () => {
    const { router, orchestrator, wm } = buildSut();
    wm.registerWorkspace('proj-a', 'STABLE');

    const branchMap = new Map<string, BranchInfo[]>([
        ['repo-1', [
            { name: 'main', isCurrent: true, isRemote: false },
            { name: 'feature-x', isCurrent: false, isRemote: false },
        ]],
    ]);
    orchestrator.setBranchMap(branchMap);

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/STABLE/branches');
    const mock = mockResponse();
    router.handle(req, mock.res);

    // Wait for async handler
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    assert.strictEqual(mock.statusCode, 200);
    const payload = JSON.parse(mock.body) as BranchesResponse;
    assert.ok(typeof payload.branches === 'object');
    assert.ok(Array.isArray(payload.suggestions));
    assert.ok(payload.suggestions.includes('main'));
    assert.ok(payload.suggestions.includes('feature-x'));
    assert.ok(Array.isArray(payload.branches['repo-1']));
    assert.strictEqual(payload.branches['repo-1'].length, 2);
});

test('GET branches: returns 404 when workspace does not exist', async () => {
    const { router, wm } = buildSut();
    wm.registerWorkspace('proj-a', 'STABLE');

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/GHOST/branches');
    const mock = mockResponse();
    router.handle(req, mock.res);

    await new Promise<void>((r) => setImmediate(r));

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('GET branches: returns 404 when project does not exist', async () => {
    const { router } = buildSut();

    const req = mockRequest('GET', '/api/projects/ghost/workspaces/STABLE/branches');
    const mock = mockResponse();
    router.handle(req, mock.res);

    await new Promise<void>((r) => setImmediate(r));

    assert.strictEqual(mock.statusCode, 404);
});

test('GET branches: returns empty branches and suggestions when no repos are in the workspace', async () => {
    const { router, wm } = buildSut();
    wm.registerWorkspace('proj-a', 'STABLE');
    // orchestrator returns an empty map by default

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/STABLE/branches');
    const mock = mockResponse();
    router.handle(req, mock.res);

    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    assert.strictEqual(mock.statusCode, 200);
    const payload = JSON.parse(mock.body) as BranchesResponse;
    assert.deepEqual(payload.branches, {});
    assert.deepEqual(payload.suggestions, []);
});

// ---------------------------------------------------------------------------
// POST /api/projects/:id/workspaces/:wid/branches/switch
// ---------------------------------------------------------------------------

test('POST branches/switch: returns 200 with per-repo results on valid input', async () => {
    const { router, orchestrator, wm } = buildSut();
    wm.registerWorkspace('proj-a', 'STABLE');

    const switchResult: BranchSwitchResult = {
        results: {
            'repo-1': { success: true, conflict: false },
        },
    };
    orchestrator.setSwitchResult(switchResult);

    const payload = { assignments: { 'repo-1': 'feature-y' } };
    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/branches/switch', payload);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const result = JSON.parse(mock.body) as BranchSwitchResult;
    assert.strictEqual(result.results['repo-1'].success, true);
});

test('POST branches/switch: returns 400 when assignments field is missing', async () => {
    const { router, wm } = buildSut();
    wm.registerWorkspace('proj-a', 'STABLE');

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/branches/switch', { other: 'field' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('POST branches/switch: returns 400 when assignments is an array (not an object)', async () => {
    const { router, wm } = buildSut();
    wm.registerWorkspace('proj-a', 'STABLE');

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/branches/switch', { assignments: ['main'] });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
});

test('POST branches/switch: returns 400 when assignments is an empty object', async () => {
    const { router, wm } = buildSut();
    wm.registerWorkspace('proj-a', 'STABLE');

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/branches/switch', { assignments: {} });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
});

test('POST branches/switch: returns 400 when an assignment value is not a string', async () => {
    const { router, wm } = buildSut();
    wm.registerWorkspace('proj-a', 'STABLE');

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/branches/switch', {
        assignments: { 'repo-1': 42 },
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
});

test('POST branches/switch: returns 400 when body is not a JSON object', async () => {
    const { router, wm } = buildSut();
    wm.registerWorkspace('proj-a', 'STABLE');

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/STABLE/branches/switch', [1, 2, 3]);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
});

test('POST branches/switch: returns 404 when project does not exist', async () => {
    const { router } = buildSut();

    const req = mockRequest('POST', '/api/projects/ghost/workspaces/STABLE/branches/switch', {
        assignments: { 'repo-1': 'main' },
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('POST branches/switch: returns 404 when workspace does not exist in project', async () => {
    const { router, wm } = buildSut();
    wm.registerWorkspace('proj-a', 'STABLE');

    const req = mockRequest('POST', '/api/projects/proj-a/workspaces/GHOST/branches/switch', {
        assignments: { 'repo-1': 'main' },
    });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
});

// ---------------------------------------------------------------------------
// GET branches: generic Error from orchestrator → 500
// ---------------------------------------------------------------------------

test('GET branches: returns 500 when orchestrator.getAvailableBranches throws a generic Error', async () => {
    const { router, orchestrator, wm } = buildSut();
    wm.registerWorkspace('proj-a', 'STABLE');

    orchestrator.setThrowOnGetBranches(new Error('git subprocess crashed'));

    const req = mockRequest('GET', '/api/projects/proj-a/workspaces/STABLE/branches');
    const mock = mockResponse();
    router.handle(req, mock.res);

    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    assert.strictEqual(mock.statusCode, 500);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.strictEqual(parsed.error, 'Internal server error.');
});
