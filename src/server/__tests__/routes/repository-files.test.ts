import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../router.js';
import { registerRepositoryFileRoutes } from '../../routes/repository-files.js';
import { NotFoundError } from '../../../errors.js';
import { SyncPreconditionError } from '../../../orchestration/repository-info-sync.js';
import type { RepositoryFile, RepositoryFileInput } from '../../../models/repository/repository-file.js';
import { mockRequest, mockResponse, flushAsync, type MockResponse } from '../helpers/mock-http.js';

// ---------------------------------------------------------------------------
// Mock RepositoryFileManager
// ---------------------------------------------------------------------------

function buildFile(id: string, input: RepositoryFileInput): RepositoryFile {
    return {
        Id: id,
        Directory: input.Directory,
        FileName: input.FileName,
        Label: input.Label,
        Description: input.Description,
        Content: input.Content,
        Executable: input.Executable ?? false,
        ListInAgents: input.ListInAgents,
        DateModified: '2024-01-01T00:00:00.000Z',
    };
}

const DEFAULT_LIST: RepositoryFile[] = [
    buildFile('file-1', {
        Directory: '',
        FileName: 'run.sh',
        Label: 'Run script',
        Description: '',
        Content: '#!/bin/sh\n',
        Executable: true,
        ListInAgents: true,
    }),
];

/**
 * Records every call made to each method so tests can assert on arguments,
 * and lets a test configure a per-method error to throw (mirroring the
 * `MockInfoSyncOrchestrator` pattern used by the sibling route test suite).
 */
class MockFileManager {
    calls: { method: string; args: unknown[] }[] = [];
    errors: Partial<Record<string, Error>> = {};

    private record(method: string, args: unknown[]): void {
        this.calls.push({ method, args });
        const err = this.errors[method];
        if (err) throw err;
    }

    list(repoId: string): RepositoryFile[] {
        this.record('list', [repoId]);
        return DEFAULT_LIST;
    }

    add(repoId: string, input: RepositoryFileInput): RepositoryFile {
        this.record('add', [repoId, input]);
        return buildFile('file-new', input);
    }

    update(repoId: string, fileId: string, input: RepositoryFileInput): { previous: RepositoryFile; updated: RepositoryFile } {
        this.record('update', [repoId, fileId, input]);
        return { previous: DEFAULT_LIST[0], updated: buildFile(fileId, input) };
    }

    remove(repoId: string, fileId: string): RepositoryFile {
        this.record('remove', [repoId, fileId]);
        return DEFAULT_LIST[0];
    }
}

// ---------------------------------------------------------------------------
// Mock RepositoryInfoSyncOrchestrator (only the two methods this route uses)
// ---------------------------------------------------------------------------

class MockInfoSync {
    calls: { method: string; args: unknown[] }[] = [];
    syncEnabled = true;

    assertSyncEnabled(repositoryId: string): void {
        this.calls.push({ method: 'assertSyncEnabled', args: [repositoryId] });
        if (!this.syncEnabled) {
            throw new SyncPreconditionError(`Info sync is not enabled for repository "${repositoryId}".`);
        }
    }

    async runLocked<T>(repositoryId: string, fn: () => Promise<T>): Promise<T> {
        this.calls.push({ method: 'runLocked', args: [repositoryId] });
        return fn();
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
    fileManager: MockFileManager;
    infoSync: MockInfoSync;
    workspaceArtifacts: MockWorkspaceArtifacts;
    errorLogManager: MockErrorLogManager;
} {
    const router = new Router();
    const fileManager = new MockFileManager();
    const infoSync = new MockInfoSync();
    const workspaceArtifacts = new MockWorkspaceArtifacts();
    const errorLogManager = new MockErrorLogManager();

    registerRepositoryFileRoutes(
        router,
        {} as never,
        fileManager as never,
        infoSync as never,
        workspaceArtifacts as never,
        errorLogManager as never,
    );

    return { router, fileManager, infoSync, workspaceArtifacts, errorLogManager };
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

const VALID_BODY = {
    fileName: 'run.sh',
    label: 'Run script',
    content: '#!/bin/sh\n',
    executable: true,
    listInAgents: true,
};

// ---------------------------------------------------------------------------
// GET /api/repositories/:id/files
// ---------------------------------------------------------------------------

test('GET /files returns the repository file list', async () => {
    const { router, fileManager } = setup();
    const res = await dispatch(router, 'GET', '/api/repositories/repo-1/files');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), DEFAULT_LIST);
    assert.deepEqual(fileManager.calls[0], { method: 'list', args: ['repo-1'] });
});

test('GET /files returns 404 for an unknown repository', async () => {
    const { router, fileManager } = setup();
    fileManager.errors['list'] = new NotFoundError('Repository with ID "missing" does not exist.');

    const res = await dispatch(router, 'GET', '/api/repositories/missing/files');

    assert.equal(res.statusCode, 404);
});

test('GET /files works even when sync is disabled (list/show are always allowed)', async () => {
    const { router, infoSync } = setup();
    infoSync.syncEnabled = false;

    const res = await dispatch(router, 'GET', '/api/repositories/repo-1/files');

    assert.equal(res.statusCode, 200);
});

// ---------------------------------------------------------------------------
// POST /api/repositories/:id/files
// ---------------------------------------------------------------------------

test('POST /files adds a file, locks, and regenerates', async () => {
    const { router, fileManager, infoSync, workspaceArtifacts } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/files', VALID_BODY);

    assert.equal(res.statusCode, 201);
    assert.deepEqual(JSON.parse(res.body), buildFile('file-new', {
        Directory: '',
        FileName: 'run.sh',
        Label: 'Run script',
        Description: '',
        Content: '#!/bin/sh\n',
        Executable: true,
        ListInAgents: true,
    }));
    assert.deepEqual(infoSync.calls[0], { method: 'assertSyncEnabled', args: ['repo-1'] });
    assert.deepEqual(infoSync.calls[1], { method: 'runLocked', args: ['repo-1'] });
    assert.equal(fileManager.calls[0].method, 'add');
    assert.deepEqual(workspaceArtifacts.calls[0], { method: 'regenerateForRepository', args: ['repo-1'] });
});

test('POST /files rejects a missing required field with 400', async () => {
    const { router, fileManager } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/files', { label: 'x', content: 'y' });

    assert.equal(res.statusCode, 400);
    assert.equal(fileManager.calls.length, 0);
});

test('POST /files rejects a non-object body with 400', async () => {
    const { router } = setup();
    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/files', 'not-an-object');

    assert.equal(res.statusCode, 400);
});

test('POST /files returns 404 for an unknown repository', async () => {
    const { router, infoSync } = setup();
    infoSync.assertSyncEnabled = () => {
        throw new NotFoundError('Repository with ID "missing" does not exist.');
    };

    const res = await dispatch(router, 'POST', '/api/repositories/missing/files', VALID_BODY);

    assert.equal(res.statusCode, 404);
});

test('POST /files returns 409 and writes nothing when sync is disabled', async () => {
    const { router, fileManager, infoSync, workspaceArtifacts } = setup();
    infoSync.syncEnabled = false;

    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/files', VALID_BODY);

    assert.equal(res.statusCode, 409);
    assert.equal(fileManager.calls.length, 0);
    assert.equal(workspaceArtifacts.calls.length, 0);
});

test('POST /files maps a RepositoryFileManager validation failure to 400', async () => {
    const { router, fileManager } = setup();
    fileManager.errors['add'] = new Error('File name is required.');

    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/files', VALID_BODY);

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /File name is required/);
});

test('POST /files still returns 201 and logs a warning when regenerateForRepository throws', async () => {
    const { router, workspaceArtifacts, errorLogManager } = setup();
    workspaceArtifacts.shouldThrow = true;

    const res = await dispatch(router, 'POST', '/api/repositories/repo-1/files', VALID_BODY);

    assert.equal(res.statusCode, 201);
    assert.equal(errorLogManager.appendedEntries.length, 1);
});

// ---------------------------------------------------------------------------
// PUT /api/repositories/:id/files/:fileId
// ---------------------------------------------------------------------------

test('PUT /files/:fileId updates a file, locks, and regenerates', async () => {
    const { router, fileManager, infoSync, workspaceArtifacts } = setup();
    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/files/file-1', VALID_BODY);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(infoSync.calls[0], { method: 'assertSyncEnabled', args: ['repo-1'] });
    assert.deepEqual(infoSync.calls[1], { method: 'runLocked', args: ['repo-1'] });
    assert.equal(fileManager.calls[0].method, 'update');
    assert.deepEqual(fileManager.calls[0].args, ['repo-1', 'file-1', {
        Directory: '',
        FileName: 'run.sh',
        Label: 'Run script',
        Description: '',
        Content: '#!/bin/sh\n',
        Executable: true,
        ListInAgents: true,
    }]);
    assert.deepEqual(workspaceArtifacts.calls[0], { method: 'regenerateForRepository', args: ['repo-1'] });
});

test('PUT /files/:fileId rejects an invalid body with 400', async () => {
    const { router } = setup();
    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/files/file-1', { label: 'x' });

    assert.equal(res.statusCode, 400);
});

test('PUT /files/:fileId returns 404 for an unknown file', async () => {
    const { router, fileManager } = setup();
    fileManager.errors['update'] = new NotFoundError('Cannot update file: file "missing" does not exist in repository "repo-1".');

    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/files/missing', VALID_BODY);

    assert.equal(res.statusCode, 404);
});

test('PUT /files/:fileId returns 409 when sync is disabled', async () => {
    const { router, infoSync } = setup();
    infoSync.syncEnabled = false;

    const res = await dispatch(router, 'PUT', '/api/repositories/repo-1/files/file-1', VALID_BODY);

    assert.equal(res.statusCode, 409);
});

// ---------------------------------------------------------------------------
// DELETE /api/repositories/:id/files/:fileId
// ---------------------------------------------------------------------------

test('DELETE /files/:fileId removes a file, locks, and regenerates', async () => {
    const { router, fileManager, infoSync, workspaceArtifacts } = setup();
    const res = await dispatch(router, 'DELETE', '/api/repositories/repo-1/files/file-1');

    assert.equal(res.statusCode, 204);
    assert.deepEqual(infoSync.calls[0], { method: 'assertSyncEnabled', args: ['repo-1'] });
    assert.deepEqual(infoSync.calls[1], { method: 'runLocked', args: ['repo-1'] });
    assert.deepEqual(fileManager.calls[0], { method: 'remove', args: ['repo-1', 'file-1'] });
    assert.deepEqual(workspaceArtifacts.calls[0], { method: 'regenerateForRepository', args: ['repo-1'] });
});

test('DELETE /files/:fileId returns 404 for an unknown file', async () => {
    const { router, fileManager } = setup();
    fileManager.errors['remove'] = new NotFoundError('Cannot remove file: file "missing" does not exist in repository "repo-1".');

    const res = await dispatch(router, 'DELETE', '/api/repositories/repo-1/files/missing');

    assert.equal(res.statusCode, 404);
});

test('DELETE /files/:fileId returns 409 and writes nothing when sync is disabled', async () => {
    const { router, fileManager, infoSync, workspaceArtifacts } = setup();
    infoSync.syncEnabled = false;

    const res = await dispatch(router, 'DELETE', '/api/repositories/repo-1/files/file-1');

    assert.equal(res.statusCode, 409);
    assert.equal(fileManager.calls.length, 0);
    assert.equal(workspaceArtifacts.calls.length, 0);
});
