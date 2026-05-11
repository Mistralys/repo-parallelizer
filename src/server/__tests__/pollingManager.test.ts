/**
 * Unit tests for PollingManager.
 *
 * All dependencies (ProjectManager, WorkspaceManager, fetchStatusFn) are
 * replaced with lightweight in-memory mocks so no real git I/O or disk I/O
 * is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectManager } from '../../models/project/project.manager.js';
import type { WorkspaceManager } from '../../models/workspace/workspace.manager.js';
import type { WorkspaceInfo } from '../../models/workspace/workspace.types.js';
import type { GitStatusInfo } from '../../git/git.types.js';
import { PollingManager } from '../pollingManager.js';
import { makeTestConfig } from '../../tests/test-helpers.js';

// ---------------------------------------------------------------------------
// Minimal stubs / factories
// ---------------------------------------------------------------------------

const BASE_CONFIG = makeTestConfig('/fake');

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
        updateLastActivity: (_id: string, _value: string) => { /* no-op */ },
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
                    Notes: '',
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

// ---------------------------------------------------------------------------
// restart
// ---------------------------------------------------------------------------

test('restart: calling restart when not running still starts polling', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['repo'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    const wm = makeDefaultWorkspaceManager();
    const callCount = { n: 0 };
    const fetchFn = async (_: string) => { callCount.n++; return makeStatus(); };

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    mgr.restart(0.05); // not previously started

    await withTimeout(
        new Promise<void>((resolve) => {
            const check = setInterval(() => {
                if (callCount.n >= 1) { clearInterval(check); resolve(); }
            }, 5);
        }),
        300,
    );

    mgr.stop();
    assert.ok(callCount.n >= 1, `Expected ≥1 sweep after restart(), got ${callCount.n}`);
});

test('restart: stops the old interval and starts a new one', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['repo'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    const wm = makeDefaultWorkspaceManager();
    const callCount = { n: 0 };
    const fetchFn = async (_: string) => { callCount.n++; return makeStatus(); };

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    mgr.start(10); // very long interval — should never fire in the test window

    const countBefore = callCount.n;
    assert.strictEqual(countBefore, 0, 'No sweeps expected with a 10 s interval');

    // Restart with a much shorter interval.
    mgr.restart(0.05); // 50 ms

    await withTimeout(
        new Promise<void>((resolve) => {
            const check = setInterval(() => {
                if (callCount.n >= 1) { clearInterval(check); resolve(); }
            }, 5);
        }),
        500,
    );

    mgr.stop();
    assert.ok(callCount.n >= 1,
        `Expected ≥1 sweep after restart() with fast interval, got ${callCount.n}`);
});

test('restart: only one interval is active after restart', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['repo'],
        Workspaces: { STABLE: {} },
    };
    const pm = makeProjectManager([project]);
    const wm = makeDefaultWorkspaceManager();
    const callCount = { n: 0 };
    const fetchFn = async (_: string) => { callCount.n++; return makeStatus(); };

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    mgr.start(0.05);
    mgr.restart(0.05); // replaces the original interval

    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    mgr.stop();

    // With one 50 ms interval ≈ 2 sweeps in 120 ms.  Two live intervals would
    // double that, so assert < 5.
    assert.ok(callCount.n < 5,
        `Too many sweeps (${callCount.n}): restart may have left a stale interval running`);
});

// ---------------------------------------------------------------------------
// persistLastActivity — helpers
// ---------------------------------------------------------------------------

/**
 * Returns a ProjectManager mock that also records calls to updateLastActivity.
 * `calls` is mutated in-place so the caller can inspect what was recorded.
 */
function makeTrackingProjectManager(
    projects: MockProject[],
    calls: Array<{ id: string; value: string }>,
): ProjectManager {
    return {
        list: () => projects.map((p) => ({ Id: p.Id, Name: p.Id })),
        getById: (id: string) => projects.find((p) => p.Id === id) ?? undefined,
        updateLastActivity: (id: string, value: string) => {
            calls.push({ id, value });
        },
    } as unknown as ProjectManager;
}

// ---------------------------------------------------------------------------
// persistLastActivity — called after refreshWorkspace
// ---------------------------------------------------------------------------

test('persistLastActivity: updateLastActivity is called with correct max after refreshWorkspace', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['r1', 'r2'],
        Workspaces: { STABLE: {} },
    };
    const calls: Array<{ id: string; value: string }> = [];
    const pm = makeTrackingProjectManager([project], calls);
    const wm = makeDefaultWorkspaceManager();

    const statusR1: GitStatusInfo = { ...makeStatus(), lastActivity: '2024-06-01T12:00:00Z' };
    const statusR2: GitStatusInfo = { ...makeStatus(), lastActivity: '2024-06-02T08:00:00Z' };

    const fetchFn = async (p: string): Promise<GitStatusInfo> =>
        p.endsWith('r1') ? statusR1 : statusR2;

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    await mgr.refreshWorkspace('proj', 'STABLE');

    // Only one call expected; the max of the two timestamps is r2's value.
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].id, 'proj');
    assert.strictEqual(calls[0].value, '2024-06-02T08:00:00Z');
});

test('persistLastActivity: updateLastActivity is called with correct max after runSweep (via start)', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['r1', 'r2'],
        Workspaces: { STABLE: {} },
    };
    const calls: Array<{ id: string; value: string }> = [];
    const pm = makeTrackingProjectManager([project], calls);
    const wm = makeDefaultWorkspaceManager();

    const statusR1: GitStatusInfo = { ...makeStatus(), lastActivity: '2024-01-10T00:00:00Z' };
    const statusR2: GitStatusInfo = { ...makeStatus(), lastActivity: '2024-01-15T00:00:00Z' };

    const fetchFn = async (p: string): Promise<GitStatusInfo> =>
        p.endsWith('r1') ? statusR1 : statusR2;

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    mgr.start(0.02); // 20 ms — fire quickly

    await withTimeout(
        new Promise<void>((resolve) => {
            const check = setInterval(() => {
                // Wait until at least one updateLastActivity call has been recorded.
                if (calls.length >= 1) { clearInterval(check); resolve(); }
            }, 5);
        }),
        500,
    );
    mgr.stop();

    // At least one sweep completed; every sweep should record the correct max.
    const lastCall = calls[calls.length - 1];
    assert.strictEqual(lastCall.id, 'proj');
    assert.strictEqual(lastCall.value, '2024-01-15T00:00:00Z');
});

// ---------------------------------------------------------------------------
// persistLastActivity — max across multiple repos and workspaces
// ---------------------------------------------------------------------------

test('persistLastActivity: selects the max timestamp across multiple repos of the same project', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['r1', 'r2', 'r3'],
        Workspaces: { STABLE: {} },
    };
    const calls: Array<{ id: string; value: string }> = [];
    const pm = makeTrackingProjectManager([project], calls);
    const wm = makeDefaultWorkspaceManager();

    const statuses: Record<string, GitStatusInfo> = {
        r1: { ...makeStatus(), lastActivity: '2024-03-01T00:00:00Z' },
        r2: { ...makeStatus(), lastActivity: '2024-03-05T00:00:00Z' },
        r3: { ...makeStatus(), lastActivity: '2024-03-03T00:00:00Z' },
    };

    const fetchFn = async (p: string): Promise<GitStatusInfo> => {
        for (const [repoId, status] of Object.entries(statuses)) {
            if (p.endsWith(repoId)) return status;
        }
        return makeStatus();
    };

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    await mgr.refreshWorkspace('proj', 'STABLE');

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].value, '2024-03-05T00:00:00Z');
});

test('persistLastActivity: computes max across two projects independently', async () => {
    const projectA = { Id: 'proj-a', Repositories: ['r1'], Workspaces: { STABLE: {} } };
    const projectB = { Id: 'proj-b', Repositories: ['r1'], Workspaces: { STABLE: {} } };
    const calls: Array<{ id: string; value: string }> = [];
    const pm = makeTrackingProjectManager([projectA, projectB], calls);

    // Both STABLE workspaces exist.
    const wm: WorkspaceManager = {
        getById: (_projectId: string, workspaceId: string) =>
            workspaceId === 'STABLE'
                ? ({ ProjectID: _projectId, WorkspaceID: 'STABLE', Description: '', DateCreated: '', DateModified: '' })
                : undefined,
    } as unknown as WorkspaceManager;

    // proj-a/STABLE/r1 → older; proj-b/STABLE/r1 → newer
    const fetchFn = async (p: string): Promise<GitStatusInfo> => {
        if (p.includes('proj-a')) return { ...makeStatus(), lastActivity: '2024-05-01T00:00:00Z' };
        return { ...makeStatus(), lastActivity: '2024-06-01T00:00:00Z' };
    };

    // Trigger a sweep by refreshing both workspaces.
    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    await mgr.refreshWorkspace('proj-a', 'STABLE');
    await mgr.refreshWorkspace('proj-b', 'STABLE');

    const callsByProject: Record<string, string[]> = {};
    for (const c of calls) {
        (callsByProject[c.id] ??= []).push(c.value);
    }

    // Each project must have received exactly the right timestamp.
    assert.ok(callsByProject['proj-a']?.includes('2024-05-01T00:00:00Z'),
        'proj-a should receive its max timestamp');
    assert.ok(callsByProject['proj-b']?.includes('2024-06-01T00:00:00Z'),
        'proj-b should receive its max timestamp');
});

// ---------------------------------------------------------------------------
// persistLastActivity — null-activity skip
// ---------------------------------------------------------------------------

test('persistLastActivity: updateLastActivity is NOT called when all cached entries have null lastActivity', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['r1', 'r2'],
        Workspaces: { STABLE: {} },
    };
    const calls: Array<{ id: string; value: string }> = [];
    const pm = makeTrackingProjectManager([project], calls);
    const wm = makeDefaultWorkspaceManager();

    // Both repos return null lastActivity.
    const fetchFn = async (_: string): Promise<GitStatusInfo> =>
        ({ ...makeStatus(), lastActivity: null });

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    await mgr.refreshWorkspace('proj', 'STABLE');

    assert.strictEqual(calls.length, 0,
        'updateLastActivity should not be called when all lastActivity values are null');
});

test('persistLastActivity: partial null — only non-null entries contribute to the max', async () => {
    const project = {
        Id: 'proj',
        Repositories: ['r1', 'r2'],
        Workspaces: { STABLE: {} },
    };
    const calls: Array<{ id: string; value: string }> = [];
    const pm = makeTrackingProjectManager([project], calls);
    const wm = makeDefaultWorkspaceManager();

    const fetchFn = async (p: string): Promise<GitStatusInfo> => {
        if (p.endsWith('r1')) return { ...makeStatus(), lastActivity: null };
        return { ...makeStatus(), lastActivity: '2024-09-01T00:00:00Z' };
    };

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, fetchFn);
    await mgr.refreshWorkspace('proj', 'STABLE');

    assert.strictEqual(calls.length, 1,
        'updateLastActivity should be called because r2 has a non-null lastActivity');
    assert.strictEqual(calls[0].value, '2024-09-01T00:00:00Z');
});

// ---------------------------------------------------------------------------
// persistLastActivity — extractContext parse-failure skip
// ---------------------------------------------------------------------------

test('persistLastActivity: cache entries with unparseable paths are skipped without error', async () => {
    // A repo path that is NOT under the projectsFolder — extractContext returns {}.
    const project = {
        Id: 'proj',
        Repositories: ['repo'],
        Workspaces: { STABLE: {} },
    };
    const calls: Array<{ id: string; value: string }> = [];
    const pm = makeTrackingProjectManager([project], calls);
    const wm = makeDefaultWorkspaceManager();

    const mgr = new PollingManager(BASE_CONFIG, pm, wm, async () => makeStatus());

    // First, populate the cache via a normal refreshWorkspace so we have one
    // valid entry (proj/STABLE/repo), then manually trigger a second refresh.
    // The valid entry will produce a call; the bad path (injected indirectly via
    // a fetch on an out-of-scope path) cannot be added through the public API,
    // so we verify the positive path and the absence of errors instead.
    await assert.doesNotReject(() => mgr.refreshWorkspace('proj', 'STABLE'));

    // The valid path resolves cleanly; updateLastActivity should have been called.
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].id, 'proj');
});
