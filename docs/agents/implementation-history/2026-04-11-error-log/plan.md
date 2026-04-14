# Plan

## Summary

Add a centralized error logging system that captures all operational errors (git failures, storage I/O errors, route handler 500s, validation failures) and exposes them through a REST API and a GUI log viewer. The error log provides persistent visibility into failures that are currently silently swallowed or only transiently surfaced via API responses / toast notifications.

## Architectural Context

### Current Error Handling (No Logging)

The codebase has **zero error logging infrastructure**. Errors are handled in one of three ways:

1. **Collected per-repo in orchestrator results** — `WorkspaceOrchestrator.createWorkspace()`, `RepositoryOrchestrator.addRepositoryToProject()`, and `BranchOrchestrator.switchBranches()` return structured results with `success: boolean, error?: string`. These are surfaced in API responses and shown as transient toast notifications in the GUI — then lost.

2. **Silently swallowed** — `PollingManager.fetchWithStagger()` catches all errors with empty catch blocks. `BranchOrchestrator.getAvailableBranches()` swallows fetch failures. `fetchAndGetStatus()` in `src/git/git-status.ts` uses `.catch(() => undefined)`.

3. **Sent as HTTP error responses** — Route handlers catch errors and call `sendError(res, statusCode, message)`. The server `Router` in `src/server/router.ts` swallows unhandled rejections with `.catch(() => {})`.

### Key Files and Modules

| Module | Path | Relevance |
|--------|------|-----------|
| Storage primitives | `src/storage/json-storage.ts` | `readJsonFile`, `writeJsonFile` — will be used by ErrorLogManager |
| Storage types | `src/storage/storage.types.ts` | `BaseStore` interface — new store type extends this |
| Server startup | `src/server/index.ts` | Manager/orchestrator instantiation and route registration |
| Workspace orchestrator | `src/orchestration/workspace-orchestrator.ts` | Clone failure error surface |
| Repository orchestrator | `src/orchestration/repository-orchestrator.ts` | Clone failure error surface |
| Branch orchestrator | `src/orchestration/branch-orchestrator.ts` | Branch switch failure error surface |
| Polling manager | `src/server/pollingManager.ts` | Swallowed fetch errors — needs logging |
| Request utilities | `src/server/requestUtils.ts` | `sendError()` helper |
| Server router | `src/server/router.ts` | Swallowed handler rejections |
| GUI app bootstrap | `gui/public/js/app.js` | Route registration |
| GUI API client | `gui/public/js/api.js` | Needs new `errorLog` namespace |
| GUI index HTML | `gui/public/index.html` | Needs nav link |
| Config types | `src/config/config.types.ts` | No changes needed — log settings use storage defaults |

### Patterns to Follow

- **Storage:** JSON file via `readJsonFile<T>` / `writeJsonFile<T>`, extending `BaseStore`.
- **Manager:** Stateless re-read-from-disk pattern (consistent with `RepositoryManager`, `ProjectManager`, `WorkspaceManager`).
- **Dependency injection:** Managers and orchestrators receive dependencies via constructor parameters — no service locator.
- **REST routes:** Separate `registerXxxRoutes()` function in `src/server/routes/`, using `sendJson()` / `sendError()` helpers.
- **GUI view:** Vanilla JS module in `gui/public/js/views/`, registered in `app.js`. PascalCase keys normalised to camelCase via a normaliser function.
- **Import extensions:** All relative imports use `.js` extension (Node16 ESM).
- **Key casing:** Storage JSON uses PascalCase (`Id`, `Name`, `Timestamp`). Frontend normalises to camelCase.

## Approach / Architecture

### New Module: `src/error-log/`

A new `error-log` module at the same level as `models/`, `git/`, and `orchestration/`. It contains:

- **`error-log.types.ts`** — `ErrorLogEntry`, `ErrorLogStore`, `ErrorSeverity`, `ErrorLogContext` types.
- **`error-log.manager.ts`** — `ErrorLogManager` class with `append()`, `list()`, `getById()`, `clear()`, and `cleanup()` (FIFO eviction).

The manager follows the stateless re-read-from-disk pattern: every public method reads the JSON file, mutates, and writes back. This ensures concurrent processes always see consistent data.

### Storage

A single file `{storageFolder}/error-log.json` stores all entries. The file is seeded by `initializeStorage()` alongside the existing seed files.

### Entry Structure

Each error log entry captures:
- **Id** — Auto-incrementing integer (simple, sortable, no UUID dependency).
- **Timestamp** — ISO 8601 string.
- **Severity** — `"error"` or `"warning"`.
- **Source** — Categorical origin: `"clone"`, `"branch-switch"`, `"fetch"`, `"polling"`, `"storage"`, `"route-handler"`.
- **Operation** — Human-readable operation name (e.g. `"workspace-setup"`, `"add-repository"`, `"status-refresh"`).
- **Context** — Optional project/workspace/repository IDs for scoping.
- **Message** — Summary of what went wrong.
- **Details** — Full error output (git stderr, stack trace, etc.). Optional.

### FIFO Eviction

The log is capped at **500 entries** (hardcoded constant). When `append()` would exceed the cap, the oldest entries are removed. This prevents unbounded growth on disk.

### Polling Deduplication

To prevent flooding from persistently unreachable repos, the `PollingManager` deduplicates errors: if the same repo path produced a polling error in the previous sweep, a new entry is not appended. Only the first occurrence and state transitions (ok → error, error → ok) are logged. The deduplication state is held in-memory in the `PollingManager` (not persisted), keyed by repo path.

### Integration Points

The `ErrorLogManager` is injected into:

1. **`WorkspaceOrchestrator`** — logs clone failures per-repo (after `stripEmbeddedCredentials`).
2. **`RepositoryOrchestrator`** — logs clone failures per-workspace (after `stripEmbeddedCredentials`).
3. **`BranchOrchestrator`** — logs branch switch failures per-repo.
4. **`PollingManager`** — logs fetch failures (with deduplication).
5. **`Router` (server)** — logs unhandled handler rejections (currently silently swallowed).
6. **Route handlers** — log 500-level errors before sending the response.

Orchestrators call `errorLogManager.append(...)` alongside the existing error-collection logic. The existing return values and API response shapes are unchanged — logging is additive only.

### REST API

Three new endpoints under `/api/error-log`:

| Method | Path | Success | Query Params | Description |
|--------|------|---------|-------|-------------|
| `GET` | `/api/error-log` | 200 | `severity`, `source`, `limit`, `offset` | List entries (newest first). |
| `GET` | `/api/error-log/:id` | 200 / 404 | — | Get a single entry by ID. |
| `DELETE` | `/api/error-log` | 204 | — | Clear all entries. |

`GET /api/error-log` response shape:

```json
{
    "entries": [
        {
            "Id": 42,
            "Timestamp": "2026-04-11T10:30:00.000Z",
            "Severity": "error",
            "Source": "clone",
            "Operation": "workspace-setup",
            "Context": {
                "ProjectId": "my-project",
                "WorkspaceId": "STABLE",
                "RepositoryId": "my-repo"
            },
            "Message": "Clone failed: authentication required",
            "Details": "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
        }
    ],
    "total": 42
}
```

### GUI View

A new **Error Log** view at `#/error-log`:

- **Table** with columns: Timestamp (relative + absolute tooltip), Severity (badge), Source, Context (project/repo), Message.
- **Expandable rows** — clicking a row reveals the full `Details` field in a `<pre>` block.
- **Filters** — dropdown for severity (`all` / `error` / `warning`) and source (`all` / per-source).
- **Clear All** button with confirmation dialog.
- **Badge in nav** — the nav link shows a count badge when there are unread errors (count fetched on app init, stored in memory).
- **No auto-refresh** — the user refreshes manually or navigates back to the view. This avoids polling overhead.

## Rationale

- **Centralized JSON file** rather than per-project logs — errors can cross project boundaries (polling, global repository operations), and a single file is simpler to manage and query.
- **Stateless manager** (re-read from disk) — consistent with all other managers in the codebase. No in-memory cache means multiple processes see the same log.
- **FIFO eviction** — prevents unbounded disk growth without requiring manual maintenance. 500 entries is generous for reviewing recent failures while staying under ~500 KB on disk.
- **Polling deduplication in-memory** — simpler than persisting dedup state; dedup resets on server restart which is acceptable (at worst, one duplicate entry per repo on restart).
- **Additive integration** — logging is added alongside existing error-collection logic. No existing return values, API response shapes, or test expectations change.
- **No new dependencies** — uses existing `readJsonFile`/`writeJsonFile` primitives and `crypto.randomUUID` from Node.js stdlib.

## Detailed Steps

### Step 1: Error Log Types

Create `src/error-log/error-log.types.ts`:
- Define `ErrorSeverity` type: `'error' | 'warning'`.
- Define `ErrorLogContext` interface: `{ ProjectId?: string; WorkspaceId?: string; RepositoryId?: string }`.
- Define `ErrorLogEntry` interface: `{ Id: number; Timestamp: string; Severity: ErrorSeverity; Source: string; Operation: string; Context: ErrorLogContext; Message: string; Details?: string }`.
- Define `ErrorLogStore` interface extending `BaseStore`: `{ Entries: ErrorLogEntry[]; }`.
- Define `MAX_ERROR_LOG_ENTRIES` constant: `500`.

### Step 2: Error Log Manager

Create `src/error-log/error-log.manager.ts`:
- `ErrorLogManager` class with constructor accepting `config: AppConfig`.
- Private method `filePath()` returns `path.join(config.storageFolder, 'error-log.json')`.
- Private method `read()` reads and returns `ErrorLogStore` using `readJsonFile`.
- Private method `write(store)` writes `ErrorLogStore` using `writeJsonFile`.
- Public method `append(entry: Omit<ErrorLogEntry, 'Id' | 'Timestamp'>): ErrorLogEntry` — reads store, assigns next ID (max existing + 1, or 1), assigns ISO timestamp, appends entry, trims to `MAX_ERROR_LOG_ENTRIES` (remove from front), writes, returns the new entry.
- Public method `list(options?: { severity?: string; source?: string; limit?: number; offset?: number }): { entries: ErrorLogEntry[]; total: number }` — reads store, filters, slices (newest first = reverse order), returns paginated result with total count.
- Public method `getById(id: number): ErrorLogEntry | undefined` — reads store, finds by ID.
- Public method `clear(): void` — writes empty store (preserving `SchemaVersion`).

### Step 3: Storage Initialization

Update `src/storage/json-storage.ts`:
- Import `ErrorLogStore` type.
- In `initializeStorage()`, add seed logic for `error-log.json` (same pattern as `repositories.json`): create the file with `{ Entries: [], SchemaVersion: 1 }` if it does not exist.

### Step 4: REST API Routes

Create `src/server/routes/error-log.ts`:
- `registerErrorLogRoutes(router: Router, errorLogManager: ErrorLogManager): void`.
- `GET /api/error-log` — parse query params (`severity`, `source`, `limit`, `offset`), call `errorLogManager.list()`, return with `sendJson`.
- `GET /api/error-log/:id` — parse numeric ID, call `errorLogManager.getById()`, return 404 if not found.
- `DELETE /api/error-log` — call `errorLogManager.clear()`, return 204.

### Step 5: Server Wiring

Update `src/server/index.ts`:
- Import `ErrorLogManager` and `registerErrorLogRoutes`.
- Instantiate `ErrorLogManager` in `startServer()`.
- Pass `errorLogManager` to orchestrators and polling manager constructors.
- Call `registerErrorLogRoutes(router, errorLogManager)`.

### Step 6: Orchestrator Integration — WorkspaceOrchestrator

Update `src/orchestration/workspace-orchestrator.ts`:
- Add `ErrorLogManager` as optional constructor parameter (optional to avoid breaking existing tests that don't inject it).
- In `createWorkspace()`, after each failed clone result (where `gitResult.exitCode !== 0`), call `errorLogManager.append()` with severity `'error'`, source `'clone'`, operation `'workspace-setup'`, context `{ ProjectId, WorkspaceId, RepositoryId }`, message from sanitised stderr.

### Step 7: Orchestrator Integration — RepositoryOrchestrator

Update `src/orchestration/repository-orchestrator.ts`:
- Add `ErrorLogManager` as optional constructor parameter.
- In `addRepositoryToProject()`, after each failed clone, call `errorLogManager.append()` with source `'clone'`, operation `'add-repository'`.

### Step 8: Orchestrator Integration — BranchOrchestrator

Update `src/orchestration/branch-orchestrator.ts`:
- Add `ErrorLogManager` as optional constructor parameter.
- In `switchBranches()`, after each failed branch switch, call `errorLogManager.append()` with source `'branch-switch'`, operation `'branch-switch'`.

### Step 9: Polling Manager Integration

Update `src/server/pollingManager.ts`:
- Add `ErrorLogManager` as optional constructor parameter.
- Add private `failedPaths: Set<string>` field for deduplication.
- In `fetchWithStagger()`, on catch: if `repoPath` is not in `failedPaths`, call `errorLogManager.append()` with severity `'warning'`, source `'polling'`, operation `'status-poll'`, and add to `failedPaths`. On success: if `repoPath` was in `failedPaths`, remove it (state transition to healthy).
- Extract project/workspace/repo IDs from the repo path (reverse-engineer from path segments) for context.

### Step 10: Server Router Error Logging

Update `src/server/router.ts`:
- Add an optional `ErrorLogManager` reference (set via a public setter or constructor).
- In `handle()`, replace `.catch(() => {})` with `.catch((err) => { errorLogManager?.append(...) })` — log unhandled handler rejections with source `'route-handler'`, operation from the request URL, message from `err.message`.

### Step 11: GUI API Client

Update `gui/public/js/api.js`:
- Add `api.errorLog` namespace with:
  - `list(params?)` — `GET /api/error-log?severity=...&source=...&limit=...&offset=...`
  - `get(id)` — `GET /api/error-log/${id}`
  - `clear()` — `DELETE /api/error-log`
  - `count()` — `GET /api/error-log?limit=0` (returns only `total`).

### Step 12: GUI Error Log View

Create `gui/public/js/views/error-log.js`:
- Export `renderErrorLog(container, params)`.
- Fetch entries via `api.errorLog.list()`.
- Render filter dropdowns (severity, source) at the top.
- Render table with columns: Timestamp, Severity, Source, Context, Message.
- Timestamp shows relative time (e.g. "3 min ago") with full ISO in `title` attribute.
- Severity shown as a colored badge (`error` = red, `warning` = orange).
- Context shows `project/workspace/repo` as a breadcrumb, linked to the relevant view where possible.
- Clicking a row toggles a detail panel below it showing the full `Details` text in a `<pre>` block.
- "Clear All" button with `showConfirm()` dialog, calls `api.errorLog.clear()`, re-renders.
- Filter changes re-fetch and re-render the table.

### Step 13: GUI App Bootstrap and Navigation

Update `gui/public/js/app.js`:
- Import and register the error log view: `router.register('#/error-log', renderErrorLog)`.

Update `gui/public/index.html`:
- Add nav link: `<a href="#/error-log" class="nav-link">Error Log</a>` between Settings and the theme toggle.

### Step 14: GUI Styling

Update `gui/public/css/styles.css`:
- Add styles for error log severity badges (`.severity-error`, `.severity-warning`).
- Add styles for expandable detail rows (`.error-detail-row`, `.error-detail-content`).
- Add styles for the error log nav badge (`.nav-badge`).

### Step 15: Tests

Create `src/tests/error-log.manager.test.ts`:
- Test `append()`: creates entry with auto-incremented ID and timestamp.
- Test `list()`: returns entries in reverse chronological order.
- Test `list()` with filters: severity and source filtering.
- Test `list()` with pagination: limit and offset.
- Test `getById()`: retrieves by ID, returns undefined for missing.
- Test `clear()`: empties the store.
- Test FIFO eviction: appending beyond `MAX_ERROR_LOG_ENTRIES` removes oldest.
- Use temp directory with `process.on('exit')` cleanup (following test conventions).

Create `src/server/__tests__/routes/error-log.test.ts`:
- Test `GET /api/error-log` — returns entries with correct shape.
- Test `GET /api/error-log/:id` — returns 404 for missing.
- Test `DELETE /api/error-log` — returns 204, clears entries.
- Test query param filtering.

## Dependencies

- `src/storage/json-storage.ts` — existing storage primitives (no new deps).
- `src/storage/storage.types.ts` — `BaseStore` interface.
- `src/config/config.types.ts` — `AppConfig` for `storageFolder`.
- `src/git/git-credentials.ts` — `stripEmbeddedCredentials()` already applied by orchestrators before error strings reach the log.
- No new npm dependencies.

## Required Components

### New Files

| File | Purpose |
|------|---------|
| `src/error-log/error-log.types.ts` | Type definitions for error log entries and store |
| `src/error-log/error-log.manager.ts` | ErrorLogManager class — CRUD + FIFO eviction |
| `src/server/routes/error-log.ts` | REST API route handlers |
| `gui/public/js/views/error-log.js` | GUI error log viewer |
| `src/tests/error-log.manager.test.ts` | Unit tests for ErrorLogManager |
| `src/server/__tests__/routes/error-log.test.ts` | Route handler tests |

### Modified Files

| File | Change |
|------|--------|
| `src/storage/json-storage.ts` | Seed `error-log.json` in `initializeStorage()` |
| `src/server/index.ts` | Instantiate `ErrorLogManager`, wire into orchestrators/polling/routes |
| `src/orchestration/workspace-orchestrator.ts` | Accept + call `ErrorLogManager` on clone failures |
| `src/orchestration/repository-orchestrator.ts` | Accept + call `ErrorLogManager` on clone failures |
| `src/orchestration/branch-orchestrator.ts` | Accept + call `ErrorLogManager` on branch switch failures |
| `src/server/pollingManager.ts` | Accept + call `ErrorLogManager` on fetch failures (with dedup) |
| `src/server/router.ts` | Log unhandled handler rejections |
| `gui/public/js/api.js` | Add `api.errorLog` namespace |
| `gui/public/js/app.js` | Register `#/error-log` route |
| `gui/public/index.html` | Add "Error Log" nav link |
| `gui/public/css/styles.css` | Add error log view styles |

## Assumptions

- The error log is **global** (not per-project) since errors can cross project boundaries (polling, global repository operations).
- **500 entries** is a sufficient cap for troubleshooting recent failures while keeping disk usage under ~500 KB.
- Polling deduplication state does **not** need to survive server restarts — at worst, one duplicate entry per previously-failing repo on restart.
- The `ErrorLogManager` parameter is **optional** in orchestrator/polling constructors to maintain backward compatibility with existing tests that don't inject it. If not provided, logging is silently skipped.
- **Security:** All error messages have already been sanitised via `stripEmbeddedCredentials()` before reaching the error log. The error log does not introduce new credential exposure vectors. The `Details` field is rendered via `textContent` (not `innerHTML`) in the GUI, consistent with the existing toast XSS-safety pattern.
- **Concurrency:** The stateless re-read-from-disk pattern means concurrent appends could race, but this is the same trade-off accepted by all other managers in the codebase. For an error log, occasional lost entries under extreme concurrency are acceptable.

## Constraints

- All relative imports must use `.js` extensions (Node16 ESM).
- PascalCase keys in stored JSON and API responses (consistent with existing storage and API conventions).
- No new npm dependencies.
- Tests use the Node.js built-in test runner with `process.on('exit')` cleanup for temp files.
- Credential security rules apply: `stripEmbeddedCredentials()` must be applied to any git stderr before it enters the error log. (Already done by orchestrators — verify this invariant is maintained.)

## Out of Scope

- **Log rotation** — the FIFO cap at 500 entries serves this purpose. No time-based rotation.
- **Log export** (CSV, download) — can be added later if needed.
- **Real-time updates** (WebSocket push to GUI) — manual refresh is sufficient for v1.
- **Notification system** (email, webhook) — out of scope.
- **Debug/info severity levels** — only `error` and `warning` are needed for failure tracking.
- **CLI error log viewer** — the log is accessible via the GUI and direct JSON file inspection.
- **Per-project error log views** — the global view with context filtering is sufficient.

## Acceptance Criteria

- Error log entries are persisted to `{storageFolder}/error-log.json` and survive server restarts.
- Clone failures in workspace setup and repository addition produce error log entries.
- Branch switch failures produce error log entries.
- Polling fetch failures produce error log entries with deduplication (no flooding).
- Unhandled route handler rejections produce error log entries.
- `GET /api/error-log` returns entries in reverse chronological order with filtering and pagination.
- `DELETE /api/error-log` clears all entries.
- The GUI error log view displays entries in a table with expandable details.
- Severity and source filters work correctly in the GUI.
- The error log never exceeds 500 entries (FIFO eviction verified by test).
- No credential tokens appear in error log entries (security invariant).
- All existing tests continue to pass with no changes.
- **Type audit:** Exported types match the plan specification — verify that each new/modified interface property name, type, and optionality align with the plan before marking the WP complete.

## Testing Strategy

### Unit Tests (`src/tests/error-log.manager.test.ts`)

- CRUD operations: append, list, getById, clear.
- FIFO eviction: append 501 entries → verify store has 500, oldest removed.
- Filtering: by severity, by source, combined.
- Pagination: limit/offset with correct total count.
- Auto-increment ID: sequential IDs across appends.
- Empty store: list returns `{ entries: [], total: 0 }`.

### Route Tests (`src/server/__tests__/routes/error-log.test.ts`)

- `GET /api/error-log` — correct response shape, query param parsing.
- `GET /api/error-log/:id` — 200 for existing, 404 for missing.
- `DELETE /api/error-log` — 204 response, store cleared.
- Invalid ID format — 400 response.

### Integration Verification (Manual)

- Start server, trigger a clone failure (invalid repo URL), verify error log entry appears in GUI.
- Verify polling deduplication: unreachable repo generates at most one log entry per sweep-to-sweep transition.
- Verify credential stripping: use a credential-bearing URL, trigger a failure, verify no token in log.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Disk I/O overhead from frequent logging** | FIFO cap (500 entries) bounds file size. Polling deduplication rate-limits the most frequent source. Stateless read-write is consistent with existing manager pattern — acceptable overhead. |
| **Concurrency race on append** | Same trade-off as all other managers. Acceptable for an error log — worst case is a lost entry under simultaneous failures. |
| **Polling flood from many unreachable repos** | In-memory deduplication set in PollingManager — only first occurrence and state transitions are logged. |
| **Credential leakage in error details** | `stripEmbeddedCredentials()` is already applied by orchestrators before error strings are assigned. Verify this invariant in code review. Error log does not introduce new surfaces. |
| **Breaking existing tests** | `ErrorLogManager` is an optional constructor parameter. Existing tests that don't pass it continue to work — logging is silently skipped. |
| **Unbounded query results** | Default `limit` of 100 on `GET /api/error-log`. GUI fetches with a reasonable page size. |
