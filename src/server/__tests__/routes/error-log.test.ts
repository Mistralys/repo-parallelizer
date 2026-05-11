import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../router.js';
import { registerErrorLogRoutes } from '../../routes/error-log.js';
import type { ErrorLogEntry, ErrorLogListOptions, ErrorLogListResult } from '../../../error-log/error-log.types.js';
import { mockRequest, mockResponse, type MockResponse } from '../helpers/mock-http.js';

// ---------------------------------------------------------------------------
// Mock ErrorLogManager
// ---------------------------------------------------------------------------

class MockErrorLogManager {
    private store: ErrorLogEntry[] = [];
    /** Records the options passed to the most recent list() call for assertion. */
    lastListOptions: ErrorLogListOptions | undefined = undefined;

    list(options?: ErrorLogListOptions): ErrorLogListResult {
        this.lastListOptions = options;
        let filtered = [...this.store].reverse();
        if (options?.severity !== undefined) {
            filtered = filtered.filter((e) => e.Severity === options.severity);
        }
        if (options?.source !== undefined) {
            filtered = filtered.filter((e) => e.Source === options.source);
        }
        const total = filtered.length;
        const offset = options?.offset ?? 0;
        filtered = filtered.slice(offset);
        if (options?.limit !== undefined) {
            filtered = filtered.slice(0, options.limit);
        }
        return { entries: filtered, total };
    }

    getById(id: number): ErrorLogEntry | undefined {
        return this.store.find((e) => e.Id === id);
    }

    clear(): void {
        this.store = [];
    }

    // Test helper: seed the store directly
    seed(entries: ErrorLogEntry[]): void {
        this.store = [...entries];
    }
}

/**
 * Convenience: builds a fresh Router + MockManager pair with routes registered.
 */
function buildSut(): { router: Router; manager: MockErrorLogManager } {
    const router = new Router();
    const manager = new MockErrorLogManager();
    registerErrorLogRoutes(router, manager as never);
    return { router, manager };
}

/** Convenience: creates a minimal valid ErrorLogEntry. */
function makeEntry(id: number, overrides: Partial<ErrorLogEntry> = {}): ErrorLogEntry {
    return {
        Id: id,
        Timestamp: new Date().toISOString(),
        Severity: 'error',
        Source: 'test',
        Operation: '/some/op',
        Context: {},
        Message: `Error ${id}`,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// GET /api/error-log — list entries
// ---------------------------------------------------------------------------

test('GET /api/error-log: returns 200 with { entries: [], total: 0 } when store is empty', () => {
    const { router } = buildSut();
    const req = mockRequest('GET', '/api/error-log');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as ErrorLogListResult;
    assert.deepEqual(body, { entries: [], total: 0 });
});

test('GET /api/error-log: returns 200 with all entries and total count', () => {
    const { router, manager } = buildSut();
    const entries = [makeEntry(1), makeEntry(2)];
    manager.seed(entries);

    const req = mockRequest('GET', '/api/error-log');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as ErrorLogListResult;
    assert.strictEqual(body.total, 2);
    assert.strictEqual(body.entries.length, 2);
    // Newest-first: entry 2 comes before entry 1
    assert.strictEqual(body.entries[0].Id, 2);
    assert.strictEqual(body.entries[1].Id, 1);
});

// ---------------------------------------------------------------------------
// GET /api/error-log?severity=...&source=...&limit=...&offset=...
// ---------------------------------------------------------------------------

test('GET /api/error-log?severity=error&source=clone&limit=10&offset=0: passes filters to manager.list()', () => {
    const { router, manager } = buildSut();

    const req = mockRequest('GET', '/api/error-log?severity=error&source=clone&limit=10&offset=0');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.ok(manager.lastListOptions !== undefined, 'list() should have been called');
    assert.strictEqual(manager.lastListOptions?.severity, 'error');
    assert.strictEqual(manager.lastListOptions?.source, 'clone');
    assert.strictEqual(manager.lastListOptions?.limit, 10);
    assert.strictEqual(manager.lastListOptions?.offset, 0);
});

test('GET /api/error-log: defaults limit to 100 when not specified', () => {
    const { router, manager } = buildSut();

    const req = mockRequest('GET', '/api/error-log');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    assert.strictEqual(manager.lastListOptions?.limit, 100);
});

test('GET /api/error-log: ignores unknown severity values (treats as no filter)', () => {
    const { router, manager } = buildSut();

    const req = mockRequest('GET', '/api/error-log?severity=critical');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    // 'critical' is not a valid ErrorSeverity so severity should be undefined
    assert.strictEqual(manager.lastListOptions?.severity, undefined);
});

// ---------------------------------------------------------------------------
// GET /api/error-log/:id — get single entry
// ---------------------------------------------------------------------------

test('GET /api/error-log/:id: returns 200 with the entry when found', () => {
    const { router, manager } = buildSut();
    const entry = makeEntry(42);
    manager.seed([entry]);

    const req = mockRequest('GET', '/api/error-log/42');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 200);
    const body = JSON.parse(mock.body) as ErrorLogEntry;
    assert.strictEqual(body.Id, 42);
});

test('GET /api/error-log/:id: returns 404 when entry does not exist', () => {
    const { router } = buildSut();

    const req = mockRequest('GET', '/api/error-log/999');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 404);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof body.error === 'string', 'body should have an error string');
});

test('GET /api/error-log/:id: returns 400 for non-numeric ID', () => {
    const { router } = buildSut();

    const req = mockRequest('GET', '/api/error-log/abc');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 400);
    const body = JSON.parse(mock.body) as { error: string };
    assert.ok(typeof body.error === 'string', 'body should have an error string');
});

test('GET /api/error-log/:id: returns 400 for an ID with mixed alphanumeric characters', () => {
    const { router } = buildSut();

    const req = mockRequest('GET', '/api/error-log/12abc');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 400);
});

test('GET /api/error-log/:id: returns 400 for a float ID', () => {
    const { router } = buildSut();

    const req = mockRequest('GET', '/api/error-log/1.5');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 400);
});

// ---------------------------------------------------------------------------
// DELETE /api/error-log — clear all entries
// ---------------------------------------------------------------------------

test('DELETE /api/error-log: returns 204 with no body', () => {
    const { router, manager } = buildSut();
    manager.seed([makeEntry(1), makeEntry(2)]);

    const req = mockRequest('DELETE', '/api/error-log');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);
    assert.strictEqual(mock.body, '');
});

test('DELETE /api/error-log: actually clears the store', () => {
    const { router, manager } = buildSut();
    manager.seed([makeEntry(1), makeEntry(2)]);

    const req = mockRequest('DELETE', '/api/error-log');
    const mock = mockResponse();

    router.handle(req, mock.res);

    assert.strictEqual(mock.statusCode, 204);

    // Confirm the store is empty after deletion
    const req2 = mockRequest('GET', '/api/error-log');
    const mock2 = mockResponse();
    router.handle(req2, mock2.res);

    assert.strictEqual(mock2.statusCode, 200);
    const body = JSON.parse(mock2.body) as ErrorLogListResult;
    assert.deepEqual(body, { entries: [], total: 0 });
});
