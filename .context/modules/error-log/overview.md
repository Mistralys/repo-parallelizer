# Error Log - Overview
```
// Structure of documents
└── src/
    └── error-log/
        └── README.md

```
###  Path: `/src/error-log/README.md`

```md
# Error Log Module

Persistent, bounded error log for recording runtime faults and warnings to a JSON file on disk.

## Key Concepts

- **Stateless manager**: `ErrorLogManager` re-reads `error-log.json` from disk on every public method call — no in-memory cache. Concurrent writes from other processes are always reflected.
- **FIFO eviction**: The store is capped at `AppConfig.maxErrorLogEntries` (default: `DEFAULT_MAX_ERROR_LOG_ENTRIES` = 500). When the limit is exceeded, the oldest entries (at the front of the array) are removed so the file stays within bounds.
- **Auto-increment IDs**: `append()` assigns `Id = maxExistingId + 1` (or `1` for the first entry). IDs are unique but not guaranteed to be contiguous after eviction.
- **ISO 8601 timestamps**: `append()` stamps each entry with `new Date().toISOString()` (UTC).
- **Graceful cold start**: If `error-log.json` does not exist yet, `read()` catches `FileNotFoundError` and returns a fresh empty store — consistent with the `FileNotFoundError` handling pattern in `json-storage.ts`.

## Public API

| Method | Description |
|---|---|
| `append(entry)` | Append a new entry; returns the fully constructed `ErrorLogEntry` (with `Id` and `Timestamp` filled in). Trims oldest entries when over the cap (`AppConfig.maxErrorLogEntries`, default 500). |
| `list(options?)` | Return entries newest-first with optional `severity` / `source` filtering and `limit` / `offset` pagination. Returns `{ entries, total }` where `total` is the post-filter, pre-pagination count. See boundary behaviour note below. |
| `getById(id)` | Return the entry with the given numeric ID, or `undefined` if not found. |
| `sources()` | Return a sorted array of distinct `Source` values currently in the store. Useful for populating filter dropdowns dynamically. |
| `clear()` | Empty the `Entries` array while preserving `SchemaVersion` on the store. |

### `list()` boundary behaviour

| Scenario | `entries` result | `total` result |
|---|---|---|
| `limit: 0` | Empty array | Full filtered count |
| Negative `limit` | Empty array (treated as `0` by `slice`) | Full filtered count |
| `offset` ≥ filtered count | Empty array | Full filtered count |
| Negative `offset` | Same as `offset: 0` (treated as `0` by `slice`) | Full filtered count |

`total` always reflects the number of entries that match the filter criteria, regardless of pagination parameters.

## Persistence

The log is stored at `{storageFolder}/error-log.json` as defined by `AppConfig.storageFolder`. The file is created on first `append()` or `clear()` call if it does not already exist.

## No Barrel Index

There is no `index.ts` barrel for this module. Downstream consumers must import directly from the source files:

```typescript
import type { ErrorLogEntry, ErrorSeverity } from './error-log/error-log.types.js';
import { ErrorLogManager } from './error-log/error-log.manager.js';
```

If future work packages add more exports to this module, a barrel index should be introduced at that point.

## Integration Points

- **Dependencies**: `config` (`AppConfig` for storage paths), `storage` (`readJsonFile`, `writeJsonFile`, `FileNotFoundError`).
- **Consumed by**: Server route handlers (`src/server/routes/error-log.ts`) and orchestration layer.

## REST API

`ErrorLogManager` is surfaced over HTTP via `registerErrorLogRoutes()` in `src/server/routes/error-log.ts`. The four endpoints are:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/error-log` | List entries (newest first) with optional `severity`, `source`, `limit`, `offset` query params. |
| `GET` | `/api/error-log/sources` | Return sorted distinct `Source` values in the store (`{ sources: string[] }`). |
| `GET` | `/api/error-log/:id` | Get a single entry by numeric ID. Returns 400 for non-positive-integer IDs. |
| `DELETE` | `/api/error-log` | Clear all entries. No auth guard — localhost-only scope assumed. |

See `docs/agents/project-manifest/rest-api.md` for full parameter documentation, response shapes, and security notes.

```
---
**File Statistics**
- **Size**: 4.21 KB
- **Lines**: 84
File: `modules/error-log/overview.md`
