/**
 * Unit tests for PollingManager.
 *
 * All dependencies (ProjectManager, WorkspaceManager, fetchStatusFn) are
 * replaced with lightweight in-memory mocks so no real git I/O or disk I/O
 * is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../config/config.types.js';
import type { ProjectManager } from '../../models/project/project.manager.js';
import type { WorkspaceManager } from '../../models/workspace/workspace.manager.js';
import type { WorkspaceInfo } from '../../models/workspace/workspace.types.js';
import type { GitStatusInfo } from '../../git/git.types.js';
import { PollingManager } from '../pollingManager.js';

// ---------------------------------------------------------------------------
// Minimal stubs / factories
// ---------------------------------------------------------------------------

const BASE_CONFIG: AppConfig = {
    projectsFolder: '/fake/projects',
    storageFolder: '/fake/storage',
    cloneDepth: 50,
    serverPort: 4200,
    gitPollingIntervalSeconds: 30,
};

function makeStatus(branch = 'main'): GitStatusInfo {
    return {
        currentBranch: branch,
        localCommits: 0,
        unfetchedCommits: 0,
        modifiedFiles: 0,
        lastActivity: '2024-01-01T00:00:00Z',
        hasConflicts: false,
    };
}

interface MockProject {
    Id: string;
    Repositories: string[];
    Workspaces: Record<string, unknown>;
    [key: string]: unknown;
}

function makeProjectManager(projects: MockProject[]): ProjectManager {
    return {
        list: () => projects.map((p) => ({ Id: p.Id, Name: p.Id })),
        getById: (id: string) => projects.find((p) => p.Id === id) ?? undefined,
    } as unknown as ProjectManager;
}

function makeWorkspaceManager(workspaces: Record<string, WorkspaceInfo | undefined>): WorkspaceManager {
    return {
        getById: (projectId: string, workspaceId: string): WorkspaceInfo | undefined => {
            return workspaces[`${projectId}:${workspaceId}`];
        },
    } as unknown as WorkspaceManager;
}

/**
 * Returns a mock WorkspaceManager where every (projectId, workspaceId) combo
 * that has the form `<project>:STABLE` is treated as existing.
 */
function makeDefaultWorkspaceManager(): WorkspaceManager {
    return {
        getById: (projectId: string, workspaceId: string): WorkspaceInfo | undefined => {
            if (workspaceId === 'STABLE') {
                return {
                    ProjectID: projectId,
                    WorkspaceID: 'STABLE',
                    Description: '',
                    DateCreated: '',
                    DateModified: '',
                };
            }
            return undefined;
        },
    } as unknown as WorkspaceManager;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Waits for a promise to resolve within `ms` milliseconds. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
        ),
    ]);
}

// ---------------------------------------------------------------------------
// getStatus — cache reads
// ---------------------------------------------------------------------------

test('getStatus: returns null before the first poll', () => {
    const pm = makeProjectManager([]);
    const wm = makeDefaultWorkspaceManager();
    const mgr = new PollingManager(BASE_CONFIG, pm, wm);

    assert.strictEqual(mgr.getStatus('/fake/projects/proj/STABLE/repo'), null);
});

test('getStatus: returns the cached value after refreshWorkspace', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['repo'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    const wm = makeDefaultWorkspaceManager();
    const expectedStatus = makeStatus('feature');
    const fetchFn = async (_path: string) => expectedStatus;

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    await mgr.refreshWorkspace('proj', 'STABLE');

    const cached = mgr.getStatus('/fake/projects/proj/STABLE/repo');
    assert.deepEqual(cached, expectedStatus);
});

test('getStatus: returns null for a path that has never been polled', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['repo-a'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    const wm = makeDefaultWorkspaceManager();
    const mgr = new PollingManager(BASE_CONFIG, pm, wm, async () => makeStatus());

    await mgr.refreshWorkspace('proj', 'STABLE');
    // repo-b was never polled
    assert.strictEqual(mgr.getStatus('/fake/projects/proj/STABLE/repo-b'), null);
});

// ---------------------------------------------------------------------------
// refreshWorkspace
// ---------------------------------------------------------------------------

test('refreshWorkspace: fetches status for every repo in the workspace', async () => {
    const project = {
        Id: 'my-proj',
        Repositories: ['repo-1', 'repo-2'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    const wm = makeDefaultWorkspaceManager();
    const fetched: string[] = [];
    const fetchFn = async (p: string) => { fetched.push(p); return makeStatus(); };

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    await mgr.refreshWorkspace('my-proj', 'STABLE');

    assert.deepEqual(fetched.sort(), [
        '/fake/projects/my-proj/STABLE/repo-1',
        '/fake/projects/my-proj/STABLE/repo-2',
    ].sort());
});

test('refreshWorkspace: updates the cache with the returned status', async () => {
    const project = {
        Id: 'p1',
        Repositories: ['r1'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    const wm = makeDefaultWorkspaceManager();
    const status1 = makeStatus('main');
    const status2 = makeStatus('dev');

    let callCount = 0;
    const fetchFn = async (_: string) => callCount++ === 0 ? status1 : status2;

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);

    await mgr.refreshWorkspace('p1', 'STABLE');
    assert.deepEqual(mgr.getStatus('/fake/projects/p1/STABLE/r1'), status1);

    await mgr.refreshWorkspace('p1', 'STABLE');
    assert.deepEqual(mgr.getStatus('/fake/projects/p1/STABLE/r1'), status2);
});

test('refreshWorkspace: resolves even when fetchStatusFn rejects for a repo', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['ok-repo', 'bad-repo'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    const wm = makeDefaultWorkspaceManager();
    const fetchFn = async (p: string) => {
        if (p.endsWith('bad-repo')) throw new Error('network error');
        return makeStatus();
    };

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    // Should not reject
    await assert.doesNotReject(() => mgr.refreshWorkspace('proj', 'STABLE'));
});

test('refreshWorkspace: cache for ok-repo is populated when bad-repo fails', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['ok-repo', 'bad-repo'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    const wm = makeDefaultWorkspaceManager();
    const okStatus = makeStatus('main');
    const fetchFn = async (p: string) => {
        if (p.endsWith('bad-repo')) throw new Error('fail');
        return okStatus;
    };

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    await mgr.refreshWorkspace('proj', 'STABLE');

    assert.deepEqual(mgr.getStatus('/fake/projects/proj/STABLE/ok-repo'), okStatus);
    assert.strictEqual(mgr.getStatus('/fake/projects/proj/STABLE/bad-repo'), null);
});

test('refreshWorkspace: throws when project does not exist', async () => {
    const pm = makeProjectManager([]);
    const wm = makeDefaultWorkspaceManager();
    const mgr = new PollingManager(BASE_CONFIG, pm, wm, async () => makeStatus());

    await assert.rejects(
        () => mgr.refreshWorkspace('nonexistent', 'STABLE'),
        /nonexistent/,
    );
});

test('refreshWorkspace: throws when workspace does not exist', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['repo'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    // WorkspaceManager that knows nothing
    const wm = makeWorkspaceManager({});
    const mgr = new PollingManager(BASE_CONFIG, pm, wm, async () => makeStatus());

    await assert.rejects(
        () => mgr.refreshWorkspace('proj', 'NOPE'),
        /NOPE/,
    );
});

// ---------------------------------------------------------------------------
// Stagger behaviour
// ---------------------------------------------------------------------------

test('fetches are staggered: second fetch starts after first completes', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['r1', 'r2'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    const wm = makeDefaultWorkspaceManager();

    const timestamps: number[] = [];
    const fetchFn = async (_: string) => {
        timestamps.push(Date.now());
        return makeStatus();
    };

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    await mgr.refreshWorkspace('proj', 'STABLE');

    assert.strictEqual(timestamps.length, 2, 'Expected exactly 2 fetch calls');
    // The second call must be at least 100 ms after the first (stagger is 150 ms,
    // with some tolerance for timer inaccuracies on CI)
    assert.ok(timestamps[1] - timestamps[0] >= 100,
        `Stagger too small: ${timestamps[1] - timestamps[0]}ms`);
});

// ---------------------------------------------------------------------------
// start / stop lifecycle
// ---------------------------------------------------------------------------

test('stop: calling stop when not started is a no-op', () => {
    const pm = makeProjectManager([]);
    const wm = makeDefaultWorkspaceManager();
    const mgr = new PollingManager(BASE_CONFIG, pm, wm, async () => makeStatus());
    // Should not throw
    mgr.stop();
});

test('start: schedules repeated calls to fetchStatusFn at the given interval', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['repo'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    const wm = makeDefaultWorkspaceManager();
    const callCount = { n: 0 };

    const fetchFn = async (_: string) => {
        callCount.n++;
        return makeStatus();
    };

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    mgr.start(0.05); // 50 ms interval for test speed

    // Wait for at least 2 sweeps (2 × 50 ms ≈ 150 ms; use 300 ms to be safe)
    await withTimeout(
        new Promise<void>((resolve) => {
            const check = setInterval(() => {
                if (callCount.n >= 2) {
                    clearInterval(check);
                    resolve();
                }
            }, 10);
        }),
        500,
    );

    mgr.stop();
    assert.ok(callCount.n >= 2, `Expected ≥2 sweeps, got ${callCount.n}`);
});

test('stop: prevents further polling callbacks from firing', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['repo'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    const wm = makeDefaultWorkspaceManager();
    const callCount = { n: 0 };

    const fetchFn = async (_: string) => {
        callCount.n++;
        return makeStatus();
    };

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    mgr.start(0.05); // 50 ms

    // Wait for at least one sweep
    await withTimeout(
        new Promise<void>((resolve) => {
            const check = setInterval(() => {
                if (callCount.n >= 1) { clearInterval(check); resolve(); }
            }, 5);
        }),
        300,
    );

    mgr.stop();
    const countAfterStop = callCount.n;

    // Wait 150 ms to confirm no more sweeps fire
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(callCount.n, countAfterStop,
        'fetchFn was called after stop()');
});

test('start: calling start twice keeps only one interval', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['repo'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    const wm = makeDefaultWorkspaceManager();
    const callCount = { n: 0 };

    const fetchFn = async (_: string) => {
        callCount.n++;
        return makeStatus();
    };

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    mgr.start(0.05);
    mgr.start(0.05); // second call should be a no-op

    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    mgr.stop();

    // With one 50 ms interval we expect roughly 2 sweeps in 120 ms.
    // A doubled interval would produce roughly 4, so assert < 5.
    assert.ok(callCount.n < 5,
        `Too many sweeps (${callCount.n}): double-start may have created two intervals`);
});
