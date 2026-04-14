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
