/**
 * Shared ErrorLogManager stub for server-layer unit tests.
 *
 * `makeMockErrorLogManager()` returns a minimal in-memory implementation of
 * `ErrorLogManager` that records every `append()` call in `appendedEntries`.
 * This allows tests to assert on which entries were logged without requiring
 * the real `ErrorLogManager` infrastructure.
 *
 * The stub is intentionally kept identical across all consuming test files so
 * that changes to the `ErrorLogManager` interface only need to be reflected in
 * one place.
 *
 * **Exports**
 * - `makeMockErrorLogManager()` — returns an `ErrorLogManager` stub extended with
 *   an `appendedEntries` array so tests can assert on which entries were logged.
 *
 * **Consumers**
 * - `src/server/__tests__/routes/config.test.ts`
 * - `src/server/__tests__/routes/repositories.test.ts`
 */
import type { ErrorLogManager } from '../../../error-log/error-log.manager.js';
import type { ErrorLogEntry } from '../../../error-log/error-log.types.js';

/**
 * Creates a minimal ErrorLogManager stub that records appended entries.
 *
 * The returned object satisfies the `ErrorLogManager` interface and extends it
 * with an `appendedEntries` array so tests can inspect recorded calls.
 */
export function makeMockErrorLogManager(): ErrorLogManager & { appendedEntries: Omit<ErrorLogEntry, 'Id' | 'Timestamp'>[]; } {
    const stub = {
        appendedEntries: [] as Omit<ErrorLogEntry, 'Id' | 'Timestamp'>[],
        append(entry: Omit<ErrorLogEntry, 'Id' | 'Timestamp'>): ErrorLogEntry {
            stub.appendedEntries.push(entry);
            return { ...entry, Id: stub.appendedEntries.length, Timestamp: new Date().toISOString() };
        },
    };
    return stub as unknown as ErrorLogManager & { appendedEntries: Omit<ErrorLogEntry, 'Id' | 'Timestamp'>[]; };
}
