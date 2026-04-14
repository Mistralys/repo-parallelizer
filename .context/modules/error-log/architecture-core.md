# Error Log - Architecture
_SOURCE: Error log types and manager implementation_
# Error log types and manager implementation
```
// Structure of documents
└── src/
    └── error-log/
        └── error-log.manager.ts
        └── error-log.types.ts

```
###  Path: `/src/error-log/error-log.manager.ts`

```ts
import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import { readJsonFile, writeJsonFile, FileNotFoundError } from '../storage/json-storage.js';
import type { ErrorLogEntry, ErrorLogStore, ErrorLogListOptions, ErrorLogListResult } from './error-log.types.js';
import { DEFAULT_MAX_ERROR_LOG_ENTRIES } from './error-log.types.js';

const ERROR_LOG_FILE = 'error-log.json';
const SCHEMA_VERSION = 1;

const DEFAULT_STORE: ErrorLogStore = { Entries: [], SchemaVersion: SCHEMA_VERSION };

/**
 * Provides append, query, and clear operations over the persisted error log.
 *
 * Every public method is stateless — it re-reads the store from disk on each
 * call so that concurrent writes from other processes are always reflected.
 *
 * The log is stored at `{storageFolder}/error-log.json`.
 */
export class ErrorLogManager {
    constructor(private readonly config: AppConfig) {}

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private filePath(): string {
        return path.join(this.config.storageFolder, ERROR_LOG_FILE);
    }

    private read(): ErrorLogStore {
        try {
            return readJsonFile<ErrorLogStore>(this.filePath());
        } catch (err) {
            if (err instanceof FileNotFoundError) {
                // Return a fresh store; the file will be created on the next write.
                return { ...DEFAULT_STORE, Entries: [] };
            }
            throw err;
        }
    }

    private write(store: ErrorLogStore): void {
        writeJsonFile(this.filePath(), store);
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Appends a new entry to the error log.
     *
     * - Assigns a unique auto-incremented ID (max existing ID + 1, or 1).
     * - Assigns the current UTC time as an ISO 8601 timestamp.
     * - Trims the store to at most `AppConfig.maxErrorLogEntries` entries
     *   (default: {@link DEFAULT_MAX_ERROR_LOG_ENTRIES}) by removing the oldest
     *   entries (those at the front of the array).
     *
     * @param entry - All fields of {@link ErrorLogEntry} except `Id` and `Timestamp`.
     * @returns The fully constructed entry as persisted.
     */
    append(entry: Omit<ErrorLogEntry, 'Id' | 'Timestamp'>): ErrorLogEntry {
        const store = this.read();

        const maxId = store.Entries.reduce((max, e) => Math.max(max, e.Id), 0);
        const newEntry: ErrorLogEntry = {
            ...entry,
            Id: maxId + 1,
            Timestamp: new Date().toISOString(),
        };

        store.Entries.push(newEntry);

        // Trim from the front (oldest) when over the limit.
        const limit = this.config.maxErrorLogEntries ?? DEFAULT_MAX_ERROR_LOG_ENTRIES;
        if (store.Entries.length > limit) {
            store.Entries.splice(0, store.Entries.length - limit);
        }

        try {
            this.write(store);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(
                `[${new Date().toISOString()}] ERROR-LOG WRITE FAILED: ${msg}\n`
            );
        }

        return newEntry;
    }

    /**
     * Returns entries in reverse chronological order (newest first), with
     * optional severity / source filtering and limit / offset pagination.
     *
     * **Boundary behaviour for `limit` and `offset`:**
     * - `limit: 0` or a negative `limit` returns an empty `entries` array; `total` is unaffected.
     * - `offset` at or beyond the filtered count returns an empty `entries` array; `total` is unaffected.
     * - A negative `offset` is treated as `0` via `Array.prototype.slice` semantics.
     *
     * @param options - Optional filtering and pagination options.
     * @returns An object containing the paged entries and the total filtered count (before pagination).
     */
    list(options?: ErrorLogListOptions): ErrorLogListResult {
        const store = this.read();

        // Reverse chronological order: entries were appended chronologically, so
        // reversing gives newest-first.
        let filtered = [...store.Entries].reverse();

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

    /**
     * Returns the entry with the given ID, or `undefined` if not found.
     *
     * @param id - Numeric entry ID.
     */
    getById(id: number): ErrorLogEntry | undefined {
        return this.read().Entries.find((e) => e.Id === id);
    }

    /**
     * Returns the distinct `Source` values present in the store, sorted
     * alphabetically. Useful for populating filter dropdowns without
     * hard-coding the source list.
     *
     * @returns A sorted array of unique source strings.
     */
    sources(): string[] {
        const store = this.read();
        const seen = new Set<string>();
        for (const entry of store.Entries) {
            if (entry.Source) {
                seen.add(entry.Source);
            }
        }
        return [...seen].sort();
    }

    /**
     * Removes all entries from the store while preserving `SchemaVersion`.
     */
    clear(): void {
        const store = this.read();
        store.Entries = [];
        this.write(store);
    }
}

```
###  Path: `/src/error-log/error-log.types.ts`

```ts
import type { BaseStore } from '../storage/storage.types.js';

/**
 * Severity level of an error log entry.
 */
export type ErrorSeverity = 'error' | 'warning';

/**
 * Optional context identifiers attached to an error log entry.
 * All fields use PascalCase to match the project's persisted-data convention.
 */
export interface ErrorLogContext {
    /** ID of the project this entry is associated with, if any. */
    ProjectId?: string;

    /** ID of the workspace this entry is associated with, if any. */
    WorkspaceId?: string;

    /** ID of the repository this entry is associated with, if any. */
    RepositoryId?: string;
}

/**
 * A single entry in the error log.
 */
export interface ErrorLogEntry {
    /** Auto-incremented unique numeric identifier. */
    Id: number;

    /** ISO 8601 timestamp when the entry was created. */
    Timestamp: string;

    /** Severity level of the entry. */
    Severity: ErrorSeverity;

    /** The subsystem or component that produced the entry (e.g. "GitManager"). */
    Source: string;

    /** The operation that was being performed when the error occurred. */
    Operation: string;

    /** Optional contextual identifiers (project, workspace, repository). */
    Context: ErrorLogContext;

    /** Human-readable error message. */
    Message: string;

    /** Additional structured detail (stack trace, raw error output, etc.). */
    Details?: string;
}

/**
 * Top-level shape of the error-log.json storage file.
 */
export interface ErrorLogStore extends BaseStore {
    Entries: ErrorLogEntry[];
}

/**
 * Maximum number of entries retained in the error log.
 * When this limit is exceeded the oldest entries (at the front of the array)
 * are removed to keep the store within bounds.
 *
 * Used as the default when `AppConfig.maxErrorLogEntries` is not set.
 */
export const DEFAULT_MAX_ERROR_LOG_ENTRIES = 500;

/**
 * Options accepted by {@link ErrorLogManager.list}.
 */
export interface ErrorLogListOptions {
    /** Filter by severity. When omitted all severities are returned. */
    severity?: ErrorSeverity;

    /** Filter by source string (exact match). When omitted all sources are returned. */
    source?: string;

    /**
     * Maximum number of entries to return. When omitted all matching entries are returned.
     *
     * **Boundary behaviour:** `0` returns an empty `entries` array (but `total` still
     * reflects the full filtered count). Negative values are treated as `0` via
     * `Array.prototype.slice` semantics and also return an empty array.
     */
    limit?: number;

    /**
     * Zero-based offset into the filtered result set. Defaults to `0`.
     *
     * **Boundary behaviour:** An offset greater than or equal to the filtered count
     * returns an empty `entries` array (but `total` still reflects the full filtered
     * count). Negative values are treated as `0` via `Array.prototype.slice` semantics.
     */
    offset?: number;
}

/**
 * Return value of {@link ErrorLogManager.list}.
 */
export interface ErrorLogListResult {
    /** The page of entries requested (after filtering and pagination). */
    entries: ErrorLogEntry[];

    /** Total number of entries that match the filter criteria (before pagination). */
    total: number;
}

```
---
**File Statistics**
- **Size**: 9.5 KB
- **Lines**: 300
File: `modules/error-log/architecture-core.md`
