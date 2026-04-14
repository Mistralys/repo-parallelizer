import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import { ErrorLogManager } from '../error-log/error-log.manager.js';
import { DEFAULT_MAX_ERROR_LOG_ENTRIES } from '../error-log/error-log.types.js';
import { createTempDirTracker } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-error-log-test-');

function makeTestConfig(base: string): AppConfig {
    return {
        storageFolder: path.join(base, 'storage'),
        projectsFolder: path.join(base, 'projects'),
        cloneDepth: 50,
        serverPort: 4200,
        gitPollingIntervalSeconds: 30,
    };
}

function makeManager(base: string): ErrorLogManager {
    const config = makeTestConfig(base);
    fs.mkdirSync(config.storageFolder, { recursive: true });
    return new ErrorLogManager(config);
}

/** Minimal helper to build a valid append payload. */
function makePayload(overrides: Partial<Parameters<ErrorLogManager['append']>[0]> = {}) {
    return {
        Severity: 'error' as const,
        Source: 'TestSource',
        Operation: 'testOperation',
        Context: {},
        Message: 'Something went wrong',
        ...overrides,
    };
}

// ─── append — basic ──────────────────────────────────────────────────────────

test('append returns the created entry', () => {
    const mgr = makeManager(makeTempDir());
    const entry = mgr.append(makePayload());
    assert.strictEqual(entry.Severity, 'error');
    assert.strictEqual(entry.Source, 'TestSource');
    assert.strictEqual(entry.Message, 'Something went wrong');
});

test('append assigns Id starting at 1 when store is empty', () => {
    const mgr = makeManager(makeTempDir());
    const entry = mgr.append(makePayload());
    assert.strictEqual(entry.Id, 1);
});

test('append auto-increments Id', () => {
    const mgr = makeManager(makeTempDir());
    const e1 = mgr.append(makePayload());
    const e2 = mgr.append(makePayload());
    assert.strictEqual(e1.Id, 1);
    assert.strictEqual(e2.Id, 2);
});

test('append assigns an ISO 8601 Timestamp', () => {
    const mgr = makeManager(makeTempDir());
    const before = new Date().toISOString();
    const entry = mgr.append(makePayload());
    const after = new Date().toISOString();
    assert.ok(entry.Timestamp >= before, 'Timestamp should not be before the call');
    assert.ok(entry.Timestamp <= after, 'Timestamp should not be after the call');
    // Must parse as a valid date
    assert.ok(!isNaN(Date.parse(entry.Timestamp)), 'Timestamp must be a valid ISO 8601 string');
});

test('append persists the entry so subsequent reads include it', () => {
    const base = makeTempDir();
    const mgr = makeManager(base);
    mgr.append(makePayload({ Message: 'persisted entry' }));

    // Construct a second manager instance pointing to the same store
    const mgr2 = new ErrorLogManager(makeTestConfig(base));
    const { entries } = mgr2.list();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].Message, 'persisted entry');
});

// ─── append — FIFO eviction ───────────────────────────────────────────────────

test(`append trims store to DEFAULT_MAX_ERROR_LOG_ENTRIES (${DEFAULT_MAX_ERROR_LOG_ENTRIES}) by removing oldest entries`, () => {
    const mgr = makeManager(makeTempDir());

    // Add MAX + 5 entries
    const total = DEFAULT_MAX_ERROR_LOG_ENTRIES + 5;
    for (let i = 1; i <= total; i++) {
        mgr.append(makePayload({ Message: `entry ${i}` }));
    }

    const { entries } = mgr.list();
    assert.strictEqual(entries.length, DEFAULT_MAX_ERROR_LOG_ENTRIES);

    // Newest entries must be retained; oldest must be gone
    // list() returns newest-first, so entries[0] is the last appended
    assert.strictEqual(entries[0].Message, `entry ${total}`);
    // The oldest retained is entry 6 (entries 1–5 were evicted)
    assert.strictEqual(entries[entries.length - 1].Message, 'entry 6');
});

// ─── list — ordering ─────────────────────────────────────────────────────────

test('list returns entries in reverse chronological order (newest first)', () => {
    const mgr = makeManager(makeTempDir());
    mgr.append(makePayload({ Message: 'first' }));
    mgr.append(makePayload({ Message: 'second' }));
    mgr.append(makePayload({ Message: 'third' }));

    const { entries } = mgr.list();
    assert.strictEqual(entries[0].Message, 'third');
    assert.strictEqual(entries[1].Message, 'second');
    assert.strictEqual(entries[2].Message, 'first');
});

test('list returns empty array when store is empty', () => {
    const mgr = makeManager(makeTempDir());
    const result = mgr.list();
    assert.deepStrictEqual(result.entries, []);
    assert.strictEqual(result.total, 0);
});

// ─── list — severity filter ───────────────────────────────────────────────────

test('list filters by severity', () => {
    const mgr = makeManager(makeTempDir());
    mgr.append(makePayload({ Severity: 'error', Message: 'err1' }));
    mgr.append(makePayload({ Severity: 'warning', Message: 'warn1' }));
    mgr.append(makePayload({ Severity: 'error', Message: 'err2' }));

    const result = mgr.list({ severity: 'error' });
    assert.strictEqual(result.total, 2);
    assert.ok(result.entries.every((e) => e.Severity === 'error'));
});

test('list severity filter returns correct total', () => {
    const mgr = makeManager(makeTempDir());
    for (let i = 0; i < 3; i++) mgr.append(makePayload({ Severity: 'warning' }));
    for (let i = 0; i < 7; i++) mgr.append(makePayload({ Severity: 'error' }));

    const result = mgr.list({ severity: 'warning' });
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.entries.length, 3);
});

// ─── list — combined filter ───────────────────────────────────────────────────

test('list filters by combined severity and source', () => {
    const mgr = makeManager(makeTempDir());
    mgr.append(makePayload({ Severity: 'error',   Source: 'Alpha' }));
    mgr.append(makePayload({ Severity: 'warning', Source: 'Alpha' }));
    mgr.append(makePayload({ Severity: 'error',   Source: 'Beta'  }));
    mgr.append(makePayload({ Severity: 'error',   Source: 'Alpha' }));

    // Only entries with Severity='error' AND Source='Alpha' should be returned
    const result = mgr.list({ severity: 'error', source: 'Alpha' });
    assert.strictEqual(result.total, 2);
    assert.ok(result.entries.every((e) => e.Severity === 'error' && e.Source === 'Alpha'));
});

// ─── list — source filter ─────────────────────────────────────────────────────

test('list filters by source', () => {
    const mgr = makeManager(makeTempDir());
    mgr.append(makePayload({ Source: 'Alpha' }));
    mgr.append(makePayload({ Source: 'Beta' }));
    mgr.append(makePayload({ Source: 'Alpha' }));

    const result = mgr.list({ source: 'Alpha' });
    assert.strictEqual(result.total, 2);
    assert.ok(result.entries.every((e) => e.Source === 'Alpha'));
});

// ─── list — pagination ────────────────────────────────────────────────────────

test('list respects limit', () => {
    const mgr = makeManager(makeTempDir());
    for (let i = 0; i < 10; i++) mgr.append(makePayload());

    const result = mgr.list({ limit: 3 });
    assert.strictEqual(result.entries.length, 3);
    assert.strictEqual(result.total, 10);
});

test('list respects offset', () => {
    const mgr = makeManager(makeTempDir());
    for (let i = 1; i <= 5; i++) mgr.append(makePayload({ Message: `entry ${i}` }));

    // newest-first: [5, 4, 3, 2, 1]; offset=2 should give [3, 2, 1]
    const result = mgr.list({ offset: 2 });
    assert.strictEqual(result.entries.length, 3);
    assert.strictEqual(result.entries[0].Message, 'entry 3');
    assert.strictEqual(result.total, 5);
});

test('list respects limit and offset together', () => {
    const mgr = makeManager(makeTempDir());
    for (let i = 1; i <= 10; i++) mgr.append(makePayload({ Message: `entry ${i}` }));

    // newest-first: [10..1]; offset=3, limit=2 → [7, 6]
    const result = mgr.list({ offset: 3, limit: 2 });
    assert.strictEqual(result.entries.length, 2);
    assert.strictEqual(result.entries[0].Message, 'entry 7');
    assert.strictEqual(result.entries[1].Message, 'entry 6');
    assert.strictEqual(result.total, 10);
});

test('list total reflects filtered count, not paged count', () => {
    const mgr = makeManager(makeTempDir());
    for (let i = 0; i < 6; i++) mgr.append(makePayload({ Severity: 'error' }));
    for (let i = 0; i < 4; i++) mgr.append(makePayload({ Severity: 'warning' }));

    const result = mgr.list({ severity: 'error', limit: 2 });
    assert.strictEqual(result.entries.length, 2);
    assert.strictEqual(result.total, 6);
});

// ─── getById ─────────────────────────────────────────────────────────────────

test('getById returns the matching entry', () => {
    const mgr = makeManager(makeTempDir());
    const created = mgr.append(makePayload({ Message: 'find me' }));
    const found = mgr.getById(created.Id);
    assert.ok(found !== undefined);
    assert.strictEqual(found.Id, created.Id);
    assert.strictEqual(found.Message, 'find me');
});

test('getById returns undefined for a non-existent ID', () => {
    const mgr = makeManager(makeTempDir());
    assert.strictEqual(mgr.getById(9999), undefined);
});

// ─── clear ────────────────────────────────────────────────────────────────────

test('clear empties the entries array', () => {
    const mgr = makeManager(makeTempDir());
    mgr.append(makePayload());
    mgr.append(makePayload());
    mgr.clear();

    const { entries, total } = mgr.list();
    assert.strictEqual(entries.length, 0);
    assert.strictEqual(total, 0);
});

test('clear preserves SchemaVersion', () => {
    const base = makeTempDir();
    const config = makeTestConfig(base);
    fs.mkdirSync(config.storageFolder, { recursive: true });
    const mgr = new ErrorLogManager(config);
    mgr.append(makePayload());
    mgr.clear();

    // Read raw JSON to verify SchemaVersion survives clear()
    const raw = JSON.parse(fs.readFileSync(path.join(config.storageFolder, 'error-log.json'), 'utf8'));
    assert.strictEqual(raw.SchemaVersion, 1);
    assert.deepStrictEqual(raw.Entries, []);
});

// ─── graceful missing file ────────────────────────────────────────────────────

test('list returns empty result when error-log.json does not exist yet', () => {
    const mgr = makeManager(makeTempDir());
    // No append() call — file is never created
    const result = mgr.list();
    assert.deepStrictEqual(result.entries, []);
    assert.strictEqual(result.total, 0);
});

test('getById returns undefined when error-log.json does not exist yet', () => {
    const mgr = makeManager(makeTempDir());
    assert.strictEqual(mgr.getById(1), undefined);
});

// ─── context & optional fields ────────────────────────────────────────────────

test('append stores optional Details field', () => {
    const mgr = makeManager(makeTempDir());
    const entry = mgr.append(makePayload({ Details: 'stack trace here' }));
    assert.strictEqual(entry.Details, 'stack trace here');
});

test('append stores Context fields correctly', () => {
    const mgr = makeManager(makeTempDir());
    const entry = mgr.append(makePayload({
        Context: { ProjectId: 'proj-1', WorkspaceId: 'STABLE', RepositoryId: 'repo-a' },
    }));
    assert.strictEqual(entry.Context.ProjectId, 'proj-1');
    assert.strictEqual(entry.Context.WorkspaceId, 'STABLE');
    assert.strictEqual(entry.Context.RepositoryId, 'repo-a');
});

// ─── append — resilience (write failure) ──────────────────────────────────────

test('append does not throw when writeJsonFile fails', () => {
    const base = makeTempDir();
    const config = makeTestConfig(base);
    // Point storage to a path that will fail on write (no directory created).
    config.storageFolder = path.join(base, 'non-existent', 'deep', 'dir');
    const mgr = new ErrorLogManager(config);

    // Seed an initial store so that read() succeeds (manager falls back to
    // empty store when file is missing).
    // append() should not throw even though write will fail.
    assert.doesNotThrow(() => {
        mgr.append(makePayload());
    });
});

test('append writes to stderr when writeJsonFile fails', () => {
    const base = makeTempDir();
    const config = makeTestConfig(base);
    // Make storage dir read-only so that write fails.
    fs.mkdirSync(config.storageFolder, { recursive: true });
    // Write a valid initial file, then make it read-only.
    const filePath = path.join(config.storageFolder, 'error-log.json');
    fs.writeFileSync(filePath, JSON.stringify({ Entries: [], SchemaVersion: 1 }));
    fs.chmodSync(filePath, 0o444);

    const mgr = new ErrorLogManager(config);

    const chunks: Buffer[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: Uint8Array | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        return true;
    }) as typeof process.stderr.write;

    try {
        mgr.append(makePayload());
    } finally {
        process.stderr.write = originalWrite;
        // Restore write permission for cleanup.
        fs.chmodSync(filePath, 0o644);
    }

    const output = Buffer.concat(chunks).toString();
    assert.ok(output.includes('ERROR-LOG WRITE FAILED'), 'stderr should contain failure message');
});

// ─── append — configurable retention limit ────────────────────────────────────

test('append respects custom maxErrorLogEntries from config', () => {
    const base = makeTempDir();
    const config: AppConfig = {
        ...makeTestConfig(base),
        maxErrorLogEntries: 5,
    };
    fs.mkdirSync(config.storageFolder, { recursive: true });
    const mgr = new ErrorLogManager(config);

    for (let i = 1; i <= 7; i++) {
        mgr.append(makePayload({ Message: `entry ${i}` }));
    }

    const { entries } = mgr.list();
    assert.strictEqual(entries.length, 5, 'should retain only maxErrorLogEntries entries');
    // entries are newest-first; oldest retained is entry 3
    assert.strictEqual(entries[0].Message, 'entry 7');
    assert.strictEqual(entries[entries.length - 1].Message, 'entry 3');
});
