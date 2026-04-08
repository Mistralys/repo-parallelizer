import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Router } from '../../router.js';
import { registerRepositoryRoutes } from '../../routes/repositories.js';
import { NotFoundError } from '../../../errors.js';
import type { Repository } from '../../../models/repository/repository.types.js';

// ---------------------------------------------------------------------------
// Minimal mocks — reused from the router test convention
// ---------------------------------------------------------------------------

/**
 * Creates a minimal mock IncomingMessage for requests without a body.
 * Emits 'end' immediately so `parseJsonBody` resolves quickly if called.
 */
function mockRequest(method: string, url: string, bodyJson?: unknown): IncomingMessage {
    const req = new EventEmitter() as IncomingMessage;
    (req as unknown as { method: string }).method = method;
    (req as unknown as { url: string }).url = url;
    (req as unknown as { destroy(): void }).destroy = () => {
        req.emit('error', new Error('destroyed'));
    };

    // Emit body and end asynchronously so parseJsonBody has time to attach listeners
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

/**
 * Creates a mock ServerResponse that captures writeHead / end calls.
 */
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

    update(id: string, params: { name: string }): Repository {
        const index = this.store.findIndex((r) => r.Id === id);
        if (index === -1) {
            throw new NotFoundError(`Cannot update: repository with ID "${id}" does not exist.`);
        }
        this.store[index] = { ...this.store[index], Name: params.name };
        return this.store[index];
    }

    remove(id: string): void {
        const index = this.store.findIndex((r) => r.Id === id);
        if (index === -1) {
            throw new NotFoundError(`Cannot remove: repository with ID "${id}" does not exist.`);
        }
        this.store.splice(index, 1);
    }

    // Test helper: seed the store directly
    seed(repos: Repository[]): void {
        this.store = [...repos];
    }
}

/**
 * Convenience: builds a fresh Router + MockManager pair with routes registered.
 */
function buildSut(): { router: Router; manager: MockRepositoryManager } {
    const router = new Router();
    const manager = new MockRepositoryManager();
    // Cast is safe: our mock satisfies the same duck-type interface used by the routes.
    registerRepositoryRoutes(router, manager as never);
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
