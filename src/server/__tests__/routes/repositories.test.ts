import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../router.js';
import { registerRepositoryRoutes } from '../../routes/repositories.js';
import { NotFoundError } from '../../../errors.js';
import type { Repository } from '../../../models/repository/repository.types.js';
import type { AppConfig, GitCredentialEntry } from '../../../config/config.types.js';
import type { ErrorLogManager } from '../../../error-log/error-log.manager.js';
import { mockRequest, mockResponse, flushAsync, type MockResponse } from '../helpers/mock-http.js';
import { makeMockErrorLogManager } from '../helpers/mock-error-log-manager.js';

// ---------------------------------------------------------------------------
// Mock RepositoryManager
// ---------------------------------------------------------------------------

/**
 * Minimal implementation of the RepositoryManager interface used by the routes.
 * All methods are replaceable stubs.
 */
class MockRepositoryManager {
    private store: Repository[] = [];

    list(): Repository[] {
        return this.store;
    }

    getById(id: string): Repository | undefined {
        return this.store.find((r) => r.Id === id);
    }

    exists(id: string): boolean {
        return this.getById(id) !== undefined;
    }

    add(params: { url: string; name?: string; id?: string }): Repository {
        const id = params.id ?? 'inferred-id';
        const name = params.name ?? id;

        const duplicate = this.store.find((r) => r.Id === id);
        if (duplicate) {
            throw new Error(`A repository with ID "${id}" already exists.`);
        }

        const duplicateUrl = this.store.find((r) => r.Url === params.url);
        if (duplicateUrl) {
            throw new Error(`A repository with URL "${params.url}" already exists (ID: "${duplicateUrl.Id}").`);
        }

        const repo: Repository = { Id: id, Name: name, Url: params.url };
        this.store.push(repo);
        return repo;
    }

    update(id: string, params: { name: string; url?: string }): Repository {
        const index = this.store.findIndex((r) => r.Id === id);
        if (index === -1) {
            throw new NotFoundError(`Cannot update: repository with ID "${id}" does not exist.`);
        }

        let updated: Repository = { ...this.store[index], Name: params.name };
        if (params.url !== undefined) {
            const duplicateUrl = this.store.find((r) => r.Id !== id && r.Url === params.url);
            if (duplicateUrl) {
                throw new Error(`A repository with URL "${params.url}" already exists (ID: "${duplicateUrl.Id}").`);
            }
            updated = { ...updated, Url: params.url };
        }

        this.store[index] = updated;
        return this.store[index];
    }

    remove(id: string): void {
        const index = this.store.findIndex((r) => r.Id === id);
        if (index === -1) {
            throw new NotFoundError(`Cannot remove: repository with ID "${id}" does not exist.`);
        }
        this.store.splice(index, 1);
    }

    updateCredential(id: string, credentialId: string | null): Repository {
        const index = this.store.findIndex((r) => r.Id === id);
        if (index === -1) {
            throw new NotFoundError(`Cannot update credential: repository with ID "${id}" does not exist.`);
        }
        const existing = this.store[index];
        if (credentialId === null) {
            const { CredentialId: _removed, ...rest } = existing;
            this.store[index] = rest as Repository;
        } else {
            this.store[index] = { ...existing, CredentialId: credentialId };
        }
        return this.store[index];
    }

    // Test helper: seed the store directly
    seed(repos: Repository[]): void {
        this.store = [...repos];
    }
}

// ---------------------------------------------------------------------------
// Minimal AppConfig factory for tests
// ---------------------------------------------------------------------------

function makeAppConfig(credentials: GitCredentialEntry[] = []): AppConfig {
    return {
        projectsFolder: '/tmp/projects',
        storageFolder: '/tmp/storage',
        cloneDepth: 50,
        serverPort: 4200,
        gitPollingIntervalSeconds: 30,
        notesCardHeight: 200,
        notesColumns: 3,
        gitCredentials: credentials,
    };
}


/**
 * Convenience: builds a fresh Router + MockManager pair with routes registered.
 * Accepts an optional `AppConfig` for tests that exercise credential routes.
 */
function buildSut(appConfig?: AppConfig, errorLogManager?: ErrorLogManager): { router: Router; manager: MockRepositoryManager } {
    const router = new Router();
    const manager = new MockRepositoryManager();
    const config = appConfig ?? makeAppConfig();
    // Cast is safe: our mock satisfies the same duck-type interface used by the routes.
    registerRepositoryRoutes(router, manager as never, config, errorLogManager);
    return { router, manager };
}

// ---------------------------------------------------------------------------
// GET /api/repositories — list all
// ---------------------------------------------------------------------------

test('GET /api/repositories: returns 200 with an empty array when no repos exist', () => {
    const { router } = buildSut();
    const req = mockRequest('GET', '/api/repositories');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(JSON.parse(mock.body), []);
});

test('GET /api/repositories: returns 200 with all seeded repositories', () => {
    const { router, manager } = buildSut();
    const repos: Repository[] = [
        { Id: 'repo-a', Name: 'Repo A', Url: 'https://github.com/org/repo-a.git' },
        { Id: 'repo-b', Name: 'Repo B', Url: 'https://github.com/org/repo-b.git' },
    ];
    manager.seed(repos);

    const req = mockRequest('GET', '/api/repositories');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(JSON.parse(mock.body), repos);
});

// ---------------------------------------------------------------------------
// GET /api/repositories/:id — get one
// ---------------------------------------------------------------------------

test('GET /api/repositories/:id: returns 200 with the repository when found', () => {
    const { router, manager } = buildSut();
    const repo: Repository = { Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git' };
    manager.seed([repo]);

    const req = mockRequest('GET', '/api/repositories/my-repo');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.deepEqual(JSON.parse(mock.body), repo);
});

test('GET /api/repositories/:id: returns 404 with { error } when ID does not exist', () => {
    const { router } = buildSut();

    const req = mockRequest('GET', '/api/repositories/nonexistent');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string', 'body should have an error string');
});

// ---------------------------------------------------------------------------
// POST /api/repositories — create
// ---------------------------------------------------------------------------

test('POST /api/repositories: returns 201 with the created repository on valid input', async () => {
    const { router } = buildSut();

    const payload = { url: 'https://github.com/org/new-repo.git', name: 'New Repo', id: 'new-repo' };
    const req = mockRequest('POST', '/api/repositories', payload);
    const mock = mockResponse();

    router.handle(req, mock.res);

    // Wait for the async handler (parseJsonBody) to finish
    await new Promise<void>((resolve) => process.nextTick(resolve));
    // Give one extra tick for the handler to process after body resolves
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 201);
    const created = JSON.parse(mock.body) as Repository;
    assert.strictEqual(created.Id, 'new-repo');
    assert.strictEqual(created.Name, 'New Repo');
    assert.strictEqual(created.Url, 'https://github.com/org/new-repo.git');
});

test('POST /api/repositories: returns 400 when url field is missing', async () => {
    const { router } = buildSut();

    const payload = { name: 'No URL' };
    const req = mockRequest('POST', '/api/repositories', payload);
    const mock = mockResponse();

    router.handle(req, mock.res);

    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('POST /api/repositories: returns 400 when url is an empty string', async () => {
    const { router } = buildSut();

    const payload = { url: '   ' };
    const req = mockRequest('POST', '/api/repositories', payload);
    const mock = mockResponse();

    router.handle(req, mock.res);

    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('POST /api/repositories: returns 400 when body is a JSON array (not an object)', async () => {
    const { router } = buildSut();

    const req = mockRequest('POST', '/api/repositories', [1, 2, 3]);
    const mock = mockResponse();

    router.handle(req, mock.res);

    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('POST /api/repositories: returns 400 when manager.add throws (duplicate ID)', async () => {
    const { router, manager } = buildSut();
    manager.seed([{ Id: 'existing', Name: 'Existing', Url: 'https://github.com/org/existing.git' }]);

    const payload = { url: 'https://github.com/org/another.git', id: 'existing' };
    const req = mockRequest('POST', '/api/repositories', payload);
    const mock = mockResponse();

    router.handle(req, mock.res);

    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

// ---------------------------------------------------------------------------
// PUT /api/repositories/:id — update
// ---------------------------------------------------------------------------

test('PUT /api/repositories/:id: returns 200 with the updated repository on valid input', async () => {
    const { router, manager } = buildSut();
    manager.seed([{ Id: 'my-repo', Name: 'Old Name', Url: 'https://github.com/org/my-repo.git' }]);

    const payload = { name: 'New Name' };
    const req = mockRequest('PUT', '/api/repositories/my-repo', payload);
    const mock = mockResponse();

    router.handle(req, mock.res);

    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as Repository;
    assert.strictEqual(updated.Name, 'New Name');
    assert.strictEqual(updated.Id, 'my-repo');
});

test('PUT /api/repositories/:id: returns 404 when ID does not exist', async () => {
    const { router } = buildSut();

    const payload = { name: 'Ghost Name' };
    const req = mockRequest('PUT', '/api/repositories/ghost', payload);
    const mock = mockResponse();

    router.handle(req, mock.res);

    // The 404 is sent synchronously before body is read, so no extra ticks needed
    // but we still wait to be safe
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('PUT /api/repositories/:id: returns 400 when name field is missing', async () => {
    const { router, manager } = buildSut();
    manager.seed([{ Id: 'my-repo', Name: 'Current Name', Url: 'https://github.com/org/my-repo.git' }]);

    const payload = { unrelated: 'field' };
    const req = mockRequest('PUT', '/api/repositories/my-repo', payload);
    const mock = mockResponse();

    router.handle(req, mock.res);

    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/repositories/:id: returns 200 with both name and url persisted when url is provided', async () => {
    const { router, manager } = buildSut();
    manager.seed([{ Id: 'my-repo', Name: 'Old Name', Url: 'https://github.com/org/my-repo.git' }]);

    const payload = { name: 'New Name', url: 'https://gitlab.com/org/my-repo.git' };
    const req = mockRequest('PUT', '/api/repositories/my-repo', payload);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as Repository;
    assert.strictEqual(updated.Name, 'New Name');
    assert.strictEqual(updated.Url, 'https://gitlab.com/org/my-repo.git');
});

test('PUT /api/repositories/:id: returns 400 when url field is an empty string', async () => {
    const { router, manager } = buildSut();
    manager.seed([{ Id: 'my-repo', Name: 'Current Name', Url: 'https://github.com/org/my-repo.git' }]);

    const payload = { name: 'Current Name', url: '   ' };
    const req = mockRequest('PUT', '/api/repositories/my-repo', payload);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
});

test('PUT /api/repositories/:id: returns 400 with the manager\'s error message when url duplicates another repository\'s URL', async () => {
    const { router, manager } = buildSut();
    manager.seed([
        { Id: 'repo-a', Name: 'Repo A', Url: 'https://github.com/org/repo-a.git' },
        { Id: 'repo-b', Name: 'Repo B', Url: 'https://github.com/org/repo-b.git' },
    ]);

    const payload = { name: 'Repo B', url: 'https://github.com/org/repo-a.git' };
    const req = mockRequest('PUT', '/api/repositories/repo-b', payload);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.match(parsed.error, /already exists/);
});

test('PUT /api/repositories/:id: clears CredentialId and appends a clear-credential audit entry when a url edit changes the host', async () => {
    const credential: GitCredentialEntry = {
        id: 'cred-1',
        label: 'GitHub Personal',
        host: 'github.com',
        token: 'ghp_secret',
    };
    const errorLogManager = makeMockErrorLogManager();
    const { router, manager } = buildSut(makeAppConfig([credential]), errorLogManager);
    manager.seed([{
        Id: 'my-repo',
        Name: 'My Repo',
        Url: 'https://github.com/org/my-repo.git',
        CredentialId: 'cred-1',
    }]);

    const payload = { name: 'My Repo', url: 'https://gitlab.com/org/my-repo.git' };
    const req = mockRequest('PUT', '/api/repositories/my-repo', payload);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as Repository;
    assert.strictEqual(updated.CredentialId, undefined);

    assert.strictEqual(errorLogManager.appendedEntries.length, 1);
    const entry = errorLogManager.appendedEntries[0];
    assert.strictEqual(entry.Source, 'credential-audit');
    assert.strictEqual(entry.Severity, 'audit');
    assert.strictEqual(entry.Operation, 'clear-credential');
});

test('PUT /api/repositories/:id: leaves CredentialId untouched when a url edit keeps the same host', async () => {
    const credential: GitCredentialEntry = {
        id: 'cred-1',
        label: 'GitHub Personal',
        host: 'github.com',
        token: 'ghp_secret',
    };
    const errorLogManager = makeMockErrorLogManager();
    const { router, manager } = buildSut(makeAppConfig([credential]), errorLogManager);
    manager.seed([{
        Id: 'my-repo',
        Name: 'My Repo',
        Url: 'https://github.com/org/my-repo.git',
        CredentialId: 'cred-1',
    }]);

    const payload = { name: 'My Repo', url: 'https://github.com/org/my-repo-renamed.git' };
    const req = mockRequest('PUT', '/api/repositories/my-repo', payload);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as Repository;
    assert.strictEqual(updated.CredentialId, 'cred-1');
    assert.strictEqual(errorLogManager.appendedEntries.length, 0);
});

test('PUT /api/repositories/:id: leaves CredentialId untouched when a url edit resolves to an SSH URL (null host)', async () => {
    const credential: GitCredentialEntry = {
        id: 'cred-1',
        label: 'GitHub Personal',
        host: 'github.com',
        token: 'ghp_secret',
    };
    const errorLogManager = makeMockErrorLogManager();
    const { router, manager } = buildSut(makeAppConfig([credential]), errorLogManager);
    manager.seed([{
        Id: 'my-repo',
        Name: 'My Repo',
        Url: 'https://github.com/org/my-repo.git',
        CredentialId: 'cred-1',
    }]);

    const payload = { name: 'My Repo', url: 'git@github.com:org/my-repo.git' };
    const req = mockRequest('PUT', '/api/repositories/my-repo', payload);
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as Repository;
    assert.strictEqual(updated.CredentialId, 'cred-1');
    assert.strictEqual(errorLogManager.appendedEntries.length, 0);
});

// ---------------------------------------------------------------------------
// DELETE /api/repositories/:id — delete
// ---------------------------------------------------------------------------

test('DELETE /api/repositories/:id: returns 204 when the repository is deleted successfully', () => {
    const { router, manager } = buildSut();
    manager.seed([{ Id: 'repo-to-delete', Name: 'To Delete', Url: 'https://github.com/org/del.git' }]);

    const req = mockRequest('DELETE', '/api/repositories/repo-to-delete');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
});

test('DELETE /api/repositories/:id: returns 404 when ID does not exist', () => {
    const { router } = buildSut();

    const req = mockRequest('DELETE', '/api/repositories/does-not-exist');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('DELETE /api/repositories/:id: the deleted repository is no longer listed', () => {
    const { router, manager } = buildSut();
    manager.seed([
        { Id: 'keep', Name: 'Keep', Url: 'https://github.com/org/keep.git' },
        { Id: 'remove-me', Name: 'Remove Me', Url: 'https://github.com/org/remove.git' },
    ]);

    const req = mockRequest('DELETE', '/api/repositories/remove-me');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
    assert.deepEqual(manager.list().map((r) => r.Id), ['keep']);
});

// ---------------------------------------------------------------------------
// PUT /api/repositories/:id/credential — set or clear credential
// ---------------------------------------------------------------------------

test('PUT /api/repositories/:id/credential: sets CredentialId when credentialId is valid', async () => {
    const credential: GitCredentialEntry = {
        id: 'cred-1',
        label: 'GitHub Personal',
        host: 'github.com',
        token: 'ghp_secret',
    };
    const { router, manager } = buildSut(makeAppConfig([credential]));
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git' }]);

    const req = mockRequest('PUT', '/api/repositories/my-repo/credential', { credentialId: 'cred-1' });
    const mock = mockResponse();
    router.handle(req, mock.res);

    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as Repository;
    assert.strictEqual(updated.CredentialId, 'cred-1');
    assert.strictEqual(updated.Id, 'my-repo');
});

test('PUT /api/repositories/:id/credential: clears CredentialId when credentialId is null', async () => {
    const credential: GitCredentialEntry = {
        id: 'cred-1',
        label: 'GitHub Personal',
        host: 'github.com',
        token: 'ghp_secret',
    };
    const { router, manager } = buildSut(makeAppConfig([credential]));
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git', CredentialId: 'cred-1' }]);

    const req = mockRequest('PUT', '/api/repositories/my-repo/credential', { credentialId: null });
    const mock = mockResponse();
    router.handle(req, mock.res);

    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as Repository;
    assert.strictEqual(updated.CredentialId, undefined);
    assert.strictEqual(updated.Id, 'my-repo');
});

test('PUT /api/repositories/:id/credential: returns 400 when credentialId does not reference an existing credential', async () => {
    const { router, manager } = buildSut(makeAppConfig([]));
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git' }]);

    const req = mockRequest('PUT', '/api/repositories/my-repo/credential', { credentialId: 'nonexistent-cred' });
    const mock = mockResponse();
    router.handle(req, mock.res);

    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
    assert.ok(parsed.error.includes('nonexistent-cred'));
});

test('PUT /api/repositories/:id/credential: returns 404 when repository does not exist', async () => {
    const { router } = buildSut(makeAppConfig([]));

    const req = mockRequest('PUT', '/api/repositories/ghost/credential', { credentialId: null });
    const mock = mockResponse();
    router.handle(req, mock.res);

    await flushAsync();

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('PUT /api/repositories/:id/credential: returns 400 when credentialId is not a string or null', async () => {
    const { router, manager } = buildSut(makeAppConfig([]));
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git' }]);

    const req = mockRequest('PUT', '/api/repositories/my-repo/credential', { credentialId: 42 });
    const mock = mockResponse();
    router.handle(req, mock.res);

    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

// ---------------------------------------------------------------------------
// PUT /api/repositories/:id/credential — host/credential coherence guard (WP-008)
// ---------------------------------------------------------------------------

test('PUT /api/repositories/:id/credential: returns 400 when credential host does not match repository URL hostname', async () => {
    const credential: GitCredentialEntry = {
        id: 'gitlab-cred',
        label: 'GitLab',
        host: 'gitlab.com',
        token: 'glpat_secret',
    };
    const { router, manager } = buildSut(makeAppConfig([credential]));
    // Repo is on github.com but credential is for gitlab.com.
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git' }]);

    const req = mockRequest('PUT', '/api/repositories/my-repo/credential', { credentialId: 'gitlab-cred' });
    const mock = mockResponse();
    router.handle(req, mock.res);

    await flushAsync();

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
    assert.ok(parsed.error.includes('gitlab.com'), 'error must include credential host');
    assert.ok(parsed.error.includes('github.com'), 'error must include repository host');
});

test('PUT /api/repositories/:id/credential: returns 200 when credential host matches repository URL hostname', async () => {
    const credential: GitCredentialEntry = {
        id: 'github-cred',
        label: 'GitHub',
        host: 'github.com',
        token: 'ghp_secret',
    };
    const { router, manager } = buildSut(makeAppConfig([credential]));
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git' }]);

    const req = mockRequest('PUT', '/api/repositories/my-repo/credential', { credentialId: 'github-cred' });
    const mock = mockResponse();
    router.handle(req, mock.res);

    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as Repository;
    assert.strictEqual(updated.CredentialId, 'github-cred');
});

test('PUT /api/repositories/:id/credential: clearing (credentialId: null) skips host-coherence check', async () => {
    const credential: GitCredentialEntry = {
        id: 'gitlab-cred',
        label: 'GitLab',
        host: 'gitlab.com',
        token: 'glpat_secret',
    };
    const { router, manager } = buildSut(makeAppConfig([credential]));
    // Repo has a mismatched credential already; clearing should always be allowed.
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git', CredentialId: 'gitlab-cred' }]);

    const req = mockRequest('PUT', '/api/repositories/my-repo/credential', { credentialId: null });
    const mock = mockResponse();
    router.handle(req, mock.res);

    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as Repository;
    assert.strictEqual(updated.CredentialId, undefined);
});

test('PUT /api/repositories/:id/credential: returns 200 when credential host matches the repository host only case-insensitively', async () => {
    const credential: GitCredentialEntry = {
        id: 'github-cred',
        label: 'GitHub',
        host: 'GitHub.COM',
        token: 'ghp_secret',
    };
    const { router, manager } = buildSut(makeAppConfig([credential]));
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git' }]);

    const req = mockRequest('PUT', '/api/repositories/my-repo/credential', { credentialId: 'github-cred' });
    const mock = mockResponse();
    router.handle(req, mock.res);

    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    const updated = JSON.parse(mock.body) as Repository;
    assert.strictEqual(updated.CredentialId, 'github-cred');
});

// ---------------------------------------------------------------------------
// GET /api/repositories/:id/credential-options — list matching credentials
// ---------------------------------------------------------------------------

test('GET /api/repositories/:id/credential-options: returns only credentials matching the repository host, with tokens masked', () => {
    const githubCred: GitCredentialEntry = {
        id: 'cred-github',
        label: 'GitHub',
        host: 'github.com',
        token: 'ghp_secret',
    };
    const gitlabCred: GitCredentialEntry = {
        id: 'cred-gitlab',
        label: 'GitLab',
        host: 'gitlab.com',
        token: 'glpat_secret',
    };
    const { router, manager } = buildSut(makeAppConfig([githubCred, gitlabCred]));
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git' }]);

    const req = mockRequest('GET', '/api/repositories/my-repo/credential-options');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { credentials: GitCredentialEntry[]; autoSelected?: string };
    assert.strictEqual(body.credentials.length, 1);
    assert.strictEqual(body.credentials[0].id, 'cred-github');
    assert.strictEqual(body.credentials[0].token, '***', 'token must be masked');
});

test('GET /api/repositories/:id/credential-options: includes autoSelected when exactly one credential matches the host', () => {
    const cred: GitCredentialEntry = {
        id: 'cred-1',
        label: 'My Cred',
        host: 'github.com',
        token: 'secret',
    };
    const { router, manager } = buildSut(makeAppConfig([cred]));
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git' }]);

    const req = mockRequest('GET', '/api/repositories/my-repo/credential-options');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { credentials: GitCredentialEntry[]; autoSelected?: string };
    assert.strictEqual(body.autoSelected, 'cred-1');
});

test('GET /api/repositories/:id/credential-options: omits autoSelected when zero credentials match the host', () => {
    const cred: GitCredentialEntry = {
        id: 'cred-gitlab',
        label: 'GitLab',
        host: 'gitlab.com',
        token: 'secret',
    };
    const { router, manager } = buildSut(makeAppConfig([cred]));
    // Repo is on github.com — no matching credential
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git' }]);

    const req = mockRequest('GET', '/api/repositories/my-repo/credential-options');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { credentials: GitCredentialEntry[]; autoSelected?: string };
    assert.strictEqual(body.credentials.length, 0);
    assert.strictEqual(body.autoSelected, undefined);
});

test('GET /api/repositories/:id/credential-options: omits autoSelected when multiple credentials match the host', () => {
    const cred1: GitCredentialEntry = { id: 'cred-a', label: 'Account A', host: 'github.com', token: 'secret-a' };
    const cred2: GitCredentialEntry = { id: 'cred-b', label: 'Account B', host: 'github.com', token: 'secret-b' };
    const { router, manager } = buildSut(makeAppConfig([cred1, cred2]));
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git' }]);

    const req = mockRequest('GET', '/api/repositories/my-repo/credential-options');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { credentials: GitCredentialEntry[]; autoSelected?: string };
    assert.strictEqual(body.credentials.length, 2);
    assert.strictEqual(body.autoSelected, undefined, 'autoSelected must be absent when multiple credentials match');
});

test('GET /api/repositories/:id/credential-options: returns 404 when repository does not exist', () => {
    const { router } = buildSut(makeAppConfig([]));

    const req = mockRequest('GET', '/api/repositories/ghost/credential-options');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

// ---------------------------------------------------------------------------
// GET /api/repositories/credential-options?url= — list matching credentials for
// an arbitrary URL, without requiring an existing repository record (WP-002)
// ---------------------------------------------------------------------------

test('GET /api/repositories/credential-options: returns only credentials matching the URL host, with tokens masked', () => {
    const githubCred: GitCredentialEntry = {
        id: 'cred-github',
        label: 'GitHub',
        host: 'github.com',
        token: 'ghp_secret',
    };
    const gitlabCred: GitCredentialEntry = {
        id: 'cred-gitlab',
        label: 'GitLab',
        host: 'gitlab.com',
        token: 'glpat_secret',
    };
    const { router } = buildSut(makeAppConfig([githubCred, gitlabCred]));

    const req = mockRequest('GET', '/api/repositories/credential-options?url=' + encodeURIComponent('https://github.com/org/my-repo.git'));
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { credentials: GitCredentialEntry[]; autoSelected?: string };
    assert.strictEqual(body.credentials.length, 1);
    assert.strictEqual(body.credentials[0].id, 'cred-github');
    assert.strictEqual(body.credentials[0].token, '***', 'token must be masked');
});

test('GET /api/repositories/credential-options: matches the URL host case-insensitively against a stored credential host', () => {
    const cred: GitCredentialEntry = {
        id: 'cred-github',
        label: 'GitHub',
        host: 'GitHub.COM',
        token: 'ghp_secret',
    };
    const { router } = buildSut(makeAppConfig([cred]));

    const req = mockRequest('GET', '/api/repositories/credential-options?url=' + encodeURIComponent('https://github.com/org/my-repo.git'));
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { credentials: GitCredentialEntry[]; autoSelected?: string };
    assert.strictEqual(body.credentials.length, 1);
    assert.strictEqual(body.autoSelected, 'cred-github');
});

test('GET /api/repositories/credential-options: includes autoSelected when exactly one credential matches the host', () => {
    const cred: GitCredentialEntry = {
        id: 'cred-1',
        label: 'My Cred',
        host: 'github.com',
        token: 'secret',
    };
    const { router } = buildSut(makeAppConfig([cred]));

    const req = mockRequest('GET', '/api/repositories/credential-options?url=' + encodeURIComponent('https://github.com/org/my-repo.git'));
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { credentials: GitCredentialEntry[]; autoSelected?: string };
    assert.strictEqual(body.autoSelected, 'cred-1');
});

test('GET /api/repositories/credential-options: omits autoSelected when zero credentials match the host', () => {
    const cred: GitCredentialEntry = {
        id: 'cred-gitlab',
        label: 'GitLab',
        host: 'gitlab.com',
        token: 'secret',
    };
    const { router } = buildSut(makeAppConfig([cred]));

    const req = mockRequest('GET', '/api/repositories/credential-options?url=' + encodeURIComponent('https://github.com/org/my-repo.git'));
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { credentials: GitCredentialEntry[]; autoSelected?: string };
    assert.strictEqual(body.credentials.length, 0);
    assert.strictEqual(body.autoSelected, undefined);
});

test('GET /api/repositories/credential-options: omits autoSelected when multiple credentials match the host', () => {
    const cred1: GitCredentialEntry = { id: 'cred-a', label: 'Account A', host: 'github.com', token: 'secret-a' };
    const cred2: GitCredentialEntry = { id: 'cred-b', label: 'Account B', host: 'github.com', token: 'secret-b' };
    const { router } = buildSut(makeAppConfig([cred1, cred2]));

    const req = mockRequest('GET', '/api/repositories/credential-options?url=' + encodeURIComponent('https://github.com/org/my-repo.git'));
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { credentials: GitCredentialEntry[]; autoSelected?: string };
    assert.strictEqual(body.credentials.length, 2);
    assert.strictEqual(body.autoSelected, undefined, 'autoSelected must be absent when multiple credentials match');
});

test('GET /api/repositories/credential-options: returns 400 when url query parameter is missing', () => {
    const { router } = buildSut(makeAppConfig([]));

    const req = mockRequest('GET', '/api/repositories/credential-options');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 400);
    const parsed = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof parsed.error === 'string');
});

test('GET /api/repositories/credential-options: returns 400 when url query parameter is an empty string', () => {
    const { router } = buildSut(makeAppConfig([]));

    const req = mockRequest('GET', '/api/repositories/credential-options?url=%20%20');
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 400);
});

test('GET /api/repositories/credential-options: does not require an existing repository record (no 404 for an unregistered URL)', () => {
    const cred: GitCredentialEntry = {
        id: 'cred-1',
        label: 'My Cred',
        host: 'github.com',
        token: 'secret',
    };
    const { router } = buildSut(makeAppConfig([cred]));

    // No repository is seeded — the URL does not belong to any existing record.
    const req = mockRequest('GET', '/api/repositories/credential-options?url=' + encodeURIComponent('https://github.com/org/brand-new-repo.git'));
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { credentials: GitCredentialEntry[]; autoSelected?: string };
    assert.strictEqual(body.autoSelected, 'cred-1');
});

test('GET /api/repositories/credential-options: is not shadowed by GET /api/repositories/:id (registration-order regression)', () => {
    const { router, manager } = buildSut(makeAppConfig([]));
    // Seed a repository whose ID happens to equal the static route's last segment,
    // to prove the static route is matched first rather than falling through to /:id.
    manager.seed([{ Id: 'credential-options', Name: 'Decoy', Url: 'https://example.com/decoy.git' }]);

    const req = mockRequest('GET', '/api/repositories/credential-options?url=' + encodeURIComponent('https://github.com/org/repo.git'));
    const mock = mockResponse();
    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as { credentials: GitCredentialEntry[]; autoSelected?: string };
    // The by-ID handler would have returned the seeded "Decoy" repository object,
    // not a { credentials, autoSelected? } shape.
    assert.ok(Array.isArray(body.credentials), 'response must be the credential-options shape, not a Repository');
});

// ---------------------------------------------------------------------------
// Audit logging — credential assign / clear operations
// ---------------------------------------------------------------------------

test('PUT /api/repositories/:id/credential: audit log entry produced with Source credential-audit and operation assign-credential', async () => {
    const credential: GitCredentialEntry = {
        id: 'cred-1',
        label: 'GitHub Personal',
        host: 'github.com',
        token: 'ghp_secret',
    };
    const errorLogManager = makeMockErrorLogManager();
    const { router, manager } = buildSut(makeAppConfig([credential]), errorLogManager);
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git' }]);

    const req = mockRequest('PUT', '/api/repositories/my-repo/credential', { credentialId: 'cred-1' });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(errorLogManager.appendedEntries.length, 1);
    const entry = errorLogManager.appendedEntries[0];
    assert.strictEqual(entry.Source, 'credential-audit');
    assert.strictEqual(entry.Severity, 'audit');
    assert.strictEqual(entry.Operation, 'assign-credential');
});

test('PUT /api/repositories/:id/credential: audit log entry produced with operation clear-credential when credentialId is null', async () => {
    const credential: GitCredentialEntry = {
        id: 'cred-1',
        label: 'GitHub Personal',
        host: 'github.com',
        token: 'ghp_secret',
    };
    const errorLogManager = makeMockErrorLogManager();
    const { router, manager } = buildSut(makeAppConfig([credential]), errorLogManager);
    manager.seed([{ Id: 'my-repo', Name: 'My Repo', Url: 'https://github.com/org/my-repo.git', CredentialId: 'cred-1' }]);

    const req = mockRequest('PUT', '/api/repositories/my-repo/credential', { credentialId: null });
    const mock = mockResponse();
    router.handle(req, mock.res);
    await flushAsync();

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(errorLogManager.appendedEntries.length, 1);
    const entry = errorLogManager.appendedEntries[0];
    assert.strictEqual(entry.Source, 'credential-audit');
    assert.strictEqual(entry.Severity, 'audit');
    assert.strictEqual(entry.Operation, 'clear-credential');
});
