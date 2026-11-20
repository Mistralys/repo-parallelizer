import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../router.js';
import { registerRepositoryInfoSyncRoutes } from '../../routes/repository-info-sync.js';
import { NotFoundError } from '../../../errors.js';
import {
    PendingChangesError,
    SyncPreconditionError,
    RemoteOperationError,
    type RepositoryInfoSyncStatus,
    type CommitPushResult,
} from '../../../orchestration/repository-info-sync.js';
import { MainFolderPreconditionError, MainFolderGitError } from '../../../orchestration/repository-main-folder.js';
import type { RepositoryInfoImportField, RepositoryInfoFieldDiff, RepositoryInfoSyncState } from '../../../orchestration/repository-info.js';
import { MAX_INFO_COMMIT_MESSAGE_LENGTH } from '../../../config/config.constants.js';
import { mockRequest, mockResponse, flushAsync, type MockResponse } from '../helpers/mock-http.js';

// ---------------------------------------------------------------------------
// Mock RepositoryInfoSyncOrchestrator
// ---------------------------------------------------------------------------

const DEFAULT_STATUS: RepositoryInfoSyncStatus = {
    enabled: true,
    mainFolder: null,
    state: 'in-sync',
    pendingChanges: [],
    defaultCommitMessage: 'Update .workspace for "repo-1" via Paralizer',
    health: { healthy: true, issues: [] },
};

const DEFAULT_IMPORT_PREVIEW: { state: RepositoryInfoSyncState; fields: RepositoryInfoFieldDiff[] } = {
    state: 'incoming',
    fields: [{ field: 'Name', current: 'Old Name', incoming: 'New Name' }],
};

const DEFAULT_COMMIT_RESULT: CommitPushResult = {
    committed: true,
    pushed: true,
    commitSha: 'abc123',
};

/**
 * Records every call made to each method so tests can assert on arguments,
 * and lets a test configure a per-method error to throw (mirroring the
 * `MockBranchOrchestrator` / `MockRepositoryOrchestrator` pattern used by the
 * sibling route test suites).
 */
class MockInfoSyncOrchestrator {
    calls: { method: string; args: unknown[] }[] = [];
    errors: Partial<Record<string, Error>> = {};

    private record(method: string, args: unknown[]): void {
        this.calls.push({ method, args });
        const err = this.errors[method];
        if (err) throw err;
    }

    async getStatus(repositoryId: string): Promise<RepositoryInfoSyncStatus> {
        this.record('getStatus', [repositoryId]);
        return DEFAULT_STATUS;
    }

    async saveSettings(
        repositoryId: string,
        input: { enabled: boolean; discardPendingChanges?: boolean },
    ): Promise<RepositoryInfoSyncStatus> {
        this.record('saveSettings', [repositoryId, input]);
        return DEFAULT_STATUS;
    }

    async refresh(repositoryId: string): Promise<RepositoryInfoSyncStatus> {
        this.record('refresh', [repositoryId]);
        return DEFAULT_STATUS;
    }

    async recreateManagedClone(
        repositoryId: string,
        options: { discardPendingChanges?: boolean },
    ): Promise<RepositoryInfoSyncStatus> {
        this.record('recreateManagedClone', [repositoryId, options]);
        return DEFAULT_STATUS;
    }

    async getImportPreview(
        repositoryId: string,
    ): Promise<{ state: RepositoryInfoSyncState; fields: RepositoryInfoFieldDiff[] }> {
        this.record('getImportPreview', [repositoryId]);
        return DEFAULT_IMPORT_PREVIEW;
    }

    async applyImport(
        repositoryId: string,
        fields: RepositoryInfoImportField[],
    ): Promise<RepositoryInfoSyncStatus> {
        this.record('applyImport', [repositoryId, fields]);
        return DEFAULT_STATUS;
    }

    async commitAndPush(
        repositoryId: string,
        options: { message?: string },
    ): Promise<CommitPushResult> {
        this.record('commitAndPush', [repositoryId, options]);
        return DEFAULT_COMMIT_RESULT;
    }
}

// ---------------------------------------------------------------------------
// Mock WorkspaceArtifactsOrchestrator
// ---------------------------------------------------------------------------

class MockWorkspaceArtifacts {
    calls: { method: string; args: unknown[] }[] = [];
    shouldThrow = false;

    regenerateForRepository(repositoryId: string): void {
        this.calls.push({ method: 'regenerateForRepository', args: [repositoryId] });
        if (this.shouldThrow) {
            throw new Error('Simulated regenerateForRepository failure.');
        }
    }
}

// ---------------------------------------------------------------------------
// Mock ErrorLogManager
// ---------------------------------------------------------------------------

class MockErrorLogManager {
    appendedEntries: unknown[] = [];

    append(entry: unknown): void {
        this.appendedEntries.push(entry);
    }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function setup(): {
    router: Router;
    infoSync: MockInfoSyncOrchestrator;
    workspaceArtifacts: MockWorkspaceArtifacts;
    errorLogManager: MockErrorLogManager;
} {
    const router = new Router();
    const infoSync = new MockInfoSyncOrchestrator();
    const workspaceArtifacts = new MockWorkspaceArtifacts();
    const errorLogManager = new MockErrorLogManager();

    registerRepositoryInfoSyncRoutes(
        router,
        {} as never,
        infoSync as never,
        workspaceArtifacts as never,
        errorLogManager as never,
    );

    return { router, infoSync, workspaceArtifacts, errorLogManager };
}

async function dispatch(
    router: Router,
    method: string,
    url: string,
    body?: unknown,
): Promise<MockResponse> {
    const req = mockRequest(method, url, body);
    const res = mockResponse();
    router.handle(req, res.res);
    await flushAsync();
    return res;
}

// ---------------------------------------------------------------------------
// GET /api/repositories/:id/info-sync
// ---------------------------------------------------------------------------

test('GET /info-sync returns the documented status shape', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'GET', '/api/repositories/repo-1/info-sync');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), DEFAULT_STATUS);
    assert.deepEqual(infoSync.calls[0], { method: 'getStatus', args: ['repo-1'] });
});

test('GET /info-sync returns 404 for an unknown repository', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['getStatus'] = new NotFoundError('Repository with ID "missing" does not exist.');

    const res = await dispatch(router, 'GET', '/api/repositories/missing/info-sync');

    assert.equal(res.statusCode, 404);
    assert.match(JSON.parse(res.body).error, /does not exist/);
});

// ---------------------------------------------------------------------------
// PUT /api/repositories/:id/info-sync
// ---------------------------------------------------------------------------

test('PUT /info-sync saves settings and returns the status shape', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/info-sync', { enabled: true });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), DEFAULT_STATUS);
    assert.deepEqual(infoSync.calls[0], { method: 'saveSettings', args: ['repo-1', { enabled: true }] });
});

test('PUT /info-sync forwards discardPendingChanges when provided', async () => {
    const { router, infoSync } = setup();
    await dispatch(router, 'PUT', '/api/repositories/repo-1/info-sync', {
        enabled: false,
        discardPendingChanges: true,
    });

    assert.deepEqual(infoSync.calls[0], {
        method: 'saveSettings',
        args: ['repo-1', { enabled: false, discardPendingChanges: true }],
    });
});

test('PUT /info-sync rejects a missing enabled field with 400', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/info-sync', {});

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /enabled/);
    assert.equal(infoSync.calls.length, 0);
});

test('PUT /info-sync rejects a non-boolean enabled field with 400', async () => {
    const { router } = setup();
    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/info-sync', { enabled: 'yes' });

    assert.equal(res.statusCode, 400);
});

test('PUT /info-sync rejects a non-boolean discardPendingChanges with 400', async () => {
    const { router } = setup();
    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/info-sync', {
        enabled: true,
        discardPendingChanges: 'yes',
    });

    assert.equal(res.statusCode, 400);
});

test('PUT /info-sync rejects a non-object body with 400', async () => {
    const { router } = setup();
    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/info-sync', [1, 2, 3]);

    assert.equal(res.statusCode, 400);
});

test('PUT /info-sync maps PendingChangesError to 409', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['saveSettings'] = new PendingChangesError('Cannot disable: pending changes exist.');

    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/info-sync', {
        enabled: false,
    });

    assert.equal(res.statusCode, 409);
    assert.match(JSON.parse(res.body).error, /pending changes/);
});

test('PUT /info-sync maps SyncPreconditionError (e.g. empty remote) to 409', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['saveSettings'] = new SyncPreconditionError('The remote has no commits.');

    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/info-sync', { enabled: true });

    assert.equal(res.statusCode, 409);
});

test('PUT /info-sync maps MainFolderPreconditionError to 409', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['saveSettings'] = new MainFolderPreconditionError('No resolvable default branch.');

    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/info-sync', { enabled: true });

    assert.equal(res.statusCode, 409);
});

test('PUT /info-sync maps RemoteOperationError to 502 with a token-free message', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['saveSettings'] = new RemoteOperationError('Failed to clone: authentication failed.');

    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/info-sync', { enabled: true });

    assert.equal(res.statusCode, 502);
    const message = JSON.parse(res.body).error as string;
    assert.doesNotMatch(message, /https?:\/\/[^/]*:[^/]*@/);
});

test('PUT /info-sync maps MainFolderGitError to 502', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['saveSettings'] = new MainFolderGitError('git clone failed.');

    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/info-sync', { enabled: true });

    assert.equal(res.statusCode, 502);
});

test('PUT /info-sync maps an unexpected error to 500', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['saveSettings'] = new Error('Something unrelated broke.');

    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/info-sync', { enabled: true });

    assert.equal(res.statusCode, 500);
});

test('PUT /info-sync returns 404 for an unknown repository', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['saveSettings'] = new NotFoundError('Repository with ID "missing" does not exist.');

    const res = await dispatch(router, 'PUT', '/api/repositories/missing/info-sync', { enabled: true });

    assert.equal(res.statusCode, 404);
});

// ---------------------------------------------------------------------------
// POST /api/repositories/:id/info-sync/refresh
// ---------------------------------------------------------------------------

test('POST /info-sync/refresh returns the status shape', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/refresh');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), DEFAULT_STATUS);
    assert.deepEqual(infoSync.calls[0], { method: 'refresh', args: ['repo-1'] });
});

test('POST /info-sync/refresh returns 404 for an unknown repository', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['refresh'] = new NotFoundError('Repository with ID "missing" does not exist.');

    const res = await dispatch(router, 'POST', '/api/repositories/missing/info-sync/refresh');

    assert.equal(res.statusCode, 404);
});

test('POST /info-sync/refresh maps SyncPreconditionError to 409', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['refresh'] = new SyncPreconditionError('Info sync is not enabled.');

    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/refresh');

    assert.equal(res.statusCode, 409);
});

test('POST /info-sync/refresh maps RemoteOperationError to 502', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['refresh'] = new RemoteOperationError('Failed to fetch.');

    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/refresh');

    assert.equal(res.statusCode, 502);
});

// ---------------------------------------------------------------------------
// POST /api/repositories/:id/info-sync/recreate-main-folder
// ---------------------------------------------------------------------------

test('POST /info-sync/recreate-main-folder returns the status shape with an empty body', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/recreate-main-folder', {});

    assert.equal(res.statusCode, 200);
    assert.deepEqual(infoSync.calls[0], { method: 'recreateManagedClone', args: ['repo-1', {}] });
});

test('POST /info-sync/recreate-main-folder forwards discardPendingChanges', async () => {
    const { router, infoSync } = setup();
    await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/recreate-main-folder', {
        discardPendingChanges: true,
    });

    assert.deepEqual(infoSync.calls[0], {
        method: 'recreateManagedClone',
        args: ['repo-1', { discardPendingChanges: true }],
    });
});

test('POST /info-sync/recreate-main-folder rejects a non-boolean discardPendingChanges with 400', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/recreate-main-folder', {
        discardPendingChanges: 'true',
    });

    assert.equal(res.statusCode, 400);
    assert.equal(infoSync.calls.length, 0);
});

test('POST /info-sync/recreate-main-folder maps PendingChangesError to 409', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['recreateManagedClone'] = new PendingChangesError('Pending changes exist.');

    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/recreate-main-folder', {});

    assert.equal(res.statusCode, 409);
});

test('POST /info-sync/recreate-main-folder returns 404 for an unknown repository', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['recreateManagedClone'] = new NotFoundError('Repository with ID "missing" does not exist.');

    const res = await dispatch(router, 'POST', '/api/repositories/missing/info-sync/recreate-main-folder', {});

    assert.equal(res.statusCode, 404);
});

// ---------------------------------------------------------------------------
// GET /api/repositories/:id/info-sync/import
// ---------------------------------------------------------------------------

test('GET /info-sync/import returns the preview shape', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'GET', '/api/repositories/repo-1/info-sync/import');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), DEFAULT_IMPORT_PREVIEW);
    assert.deepEqual(infoSync.calls[0], { method: 'getImportPreview', args: ['repo-1'] });
});

test('GET /info-sync/import returns 404 for an unknown repository', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['getImportPreview'] = new NotFoundError('Repository with ID "missing" does not exist.');

    const res = await dispatch(router, 'GET', '/api/repositories/missing/info-sync/import');

    assert.equal(res.statusCode, 404);
});

test('GET /info-sync/import maps SyncPreconditionError (wrong state) to 409', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['getImportPreview'] = new SyncPreconditionError(
        'Info sync state must be "incoming" or "conflict".',
    );

    const res = await dispatch(router, 'GET', '/api/repositories/repo-1/info-sync/import');

    assert.equal(res.statusCode, 409);
});

// ---------------------------------------------------------------------------
// POST /api/repositories/:id/info-sync/import
// ---------------------------------------------------------------------------

test('POST /info-sync/import applies the selected fields and returns the status shape', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/import', {
        fields: ['Name'],
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), DEFAULT_STATUS);
    assert.deepEqual(infoSync.calls[0], { method: 'applyImport', args: ['repo-1', ['Name']] });
});

test('POST /info-sync/import accepts an empty fields array (keep all local values)', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/import', { fields: [] });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(infoSync.calls[0], { method: 'applyImport', args: ['repo-1', []] });
});

test('POST /info-sync/import rejects a missing fields array with 400', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/import', {});

    assert.equal(res.statusCode, 400);
    assert.equal(infoSync.calls.length, 0);
});

test('POST /info-sync/import rejects fields: ["Url"] with 400', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/import', {
        fields: ['Url'],
    });

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /Url/);
    assert.equal(infoSync.calls.length, 0);
});

test('POST /info-sync/import rejects an unknown field value with 400', async () => {
    const { router } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/import', {
        fields: ['NotAField'],
    });

    assert.equal(res.statusCode, 400);
});

test('POST /info-sync/import triggers regenerateForRepository on success', async () => {
    const { router, workspaceArtifacts } = setup();
    await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/import', { fields: ['Description'] });

    assert.deepEqual(workspaceArtifacts.calls[0], {
        method: 'regenerateForRepository',
        args: ['repo-1'],
    });
});

test('POST /info-sync/import still returns 200 and logs a warning when regenerateForRepository throws', async () => {
    const { router, workspaceArtifacts, errorLogManager } = setup();
    workspaceArtifacts.shouldThrow = true;

    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/import', { fields: [] });

    assert.equal(res.statusCode, 200);
    assert.equal(errorLogManager.appendedEntries.length, 1);
});

test('POST /info-sync/import returns 404 for an unknown repository', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['applyImport'] = new NotFoundError('Repository with ID "missing" does not exist.');

    const res = await dispatch(router, 'POST', '/api/repositories/missing/info-sync/import', { fields: [] });

    assert.equal(res.statusCode, 404);
});

// ---------------------------------------------------------------------------
// POST /api/repositories/:id/info-sync/commit-push
// ---------------------------------------------------------------------------

test('POST /info-sync/commit-push returns the commit/push result shape with no message', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/commit-push', {});

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), DEFAULT_COMMIT_RESULT);
    assert.deepEqual(infoSync.calls[0], { method: 'commitAndPush', args: ['repo-1', {}] });
});

test('POST /info-sync/commit-push forwards a trimmed message', async () => {
    const { router, infoSync } = setup();
    await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/commit-push', {
        message: '  Custom message  ',
    });

    assert.deepEqual(infoSync.calls[0], {
        method: 'commitAndPush',
        args: ['repo-1', { message: 'Custom message' }],
    });
});

test('POST /info-sync/commit-push rejects an empty (whitespace-only) message with 400', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/commit-push', {
        message: '   ',
    });

    assert.equal(res.statusCode, 400);
    assert.equal(infoSync.calls.length, 0);
});

test('POST /info-sync/commit-push rejects a message over the max length with 400', async () => {
    const { router, infoSync } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/commit-push', {
        message: 'a'.repeat(MAX_INFO_COMMIT_MESSAGE_LENGTH + 1),
    });

    assert.equal(res.statusCode, 400);
    assert.equal(infoSync.calls.length, 0);
});

test('POST /info-sync/commit-push rejects a non-string message with 400', async () => {
    const { router } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/commit-push', {
        message: 42,
    });

    assert.equal(res.statusCode, 400);
});

test('POST /info-sync/commit-push maps SyncPreconditionError to 409 (e.g. nothing pending)', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['commitAndPush'] = new SyncPreconditionError('There are no pending changes to commit.');

    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/commit-push', {});

    assert.equal(res.statusCode, 409);
});

test('POST /info-sync/commit-push maps RemoteOperationError to 502 with a token-free message', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['commitAndPush'] = new RemoteOperationError(
        'Failed to push changes: permission denied. The configured credential may not have write access.',
    );

    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/info-sync/commit-push', {});

    assert.equal(res.statusCode, 502);
    const message = JSON.parse(res.body).error as string;
    assert.doesNotMatch(message, /https?:\/\/[^/]*:[^/]*@/);
});

test('POST /info-sync/commit-push returns 404 for an unknown repository', async () => {
    const { router, infoSync } = setup();
    infoSync.errors['commitAndPush'] = new NotFoundError('Repository with ID "missing" does not exist.');

    const res = await dispatch(router, 'POST', '/api/repositories/missing/info-sync/commit-push', {});

    assert.equal(res.statusCode, 404);
});
