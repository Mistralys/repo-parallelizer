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
