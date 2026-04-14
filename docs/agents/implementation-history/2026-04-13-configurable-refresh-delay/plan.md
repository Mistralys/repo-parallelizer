# Plan

## Summary

This plan covers two independent changes:

1. **Configurable Refresh Delay:** Expose the `gitPollingIntervalSeconds` configuration value as a user-editable setting in the GUI Settings screen. Changing the value persists it to `config.json`, restarts the server-side `PollingManager` with the new interval, and is consumed by the frontend workspace-detail view for its countdown-based polling. The setting has a default of 30 seconds and a minimum value of 10 seconds.

2. **Relocate VS Code Workspace Files:** Move `.code-workspace` files from the flat `{projectsFolder}/` root into per-project subdirectories at `{projectsFolder}/{projectSlug}/`. File naming stays the same (`{projectSlug}-{workspaceId}.code-workspace`). This collocates workspace files with the cloned repository directories they reference, keeping each project's on-disk footprint self-contained.

## Architectural Context

### Relevant Server-Side Components

- **`src/config/config.types.ts`** — `AppConfig.gitPollingIntervalSeconds` (default: 30). Already exists as a config field.
- **`src/config/config.ts`** — `loadConfig()` reads the value; `saveConfigField()` persists individual fields to `config.json`. `DEFAULTS.gitPollingIntervalSeconds` is 30.
- **`src/server/pollingManager.ts`** — `PollingManager.start(intervalSeconds)` runs the git-fetch background loop. `start()` is a no-op if already running; `stop()` clears the interval. No method currently exists to restart with a different interval.
- **`src/server/index.ts`** — `startServer()` wires `PollingManager`, computes `pollInterval = config.pollIntervalSeconds ?? config.appConfig.gitPollingIntervalSeconds ?? 30`, and calls `pollingManager.start(pollInterval)`. The `_pollingManager` reference is module-level but unexposed.
- **`src/server/routes/config.ts`** — `registerConfigRoutes(router, appConfig, configPath?)` handles `GET/PUT/DELETE /api/config/credentials`. Receives the live `appConfig` object reference.

### Relevant Frontend Components

- **`gui/public/js/api.js`** — `api.config.credentials` namespace. No polling-related API methods exist.
- **`gui/public/js/views/settings.js`** — Settings view with a single "Git Credentials" section. No refresh-delay section exists.
- **`gui/public/js/views/workspace-detail.js`** — `POLL_INTERVAL_MS = 10_000` hard-coded constant controls the countdown-based polling for workspace status. The view does not consult any server configuration.
- **`gui/public/js/components/nav-badge.js`** — `POLL_INTERVAL_MS = 30_000` for error-log badge polling. Out of scope for this change (different concern).

### Relevant Workspace File Components

- **`src/orchestration/vscode-workspace.ts`** — `getWorkspaceFilePath(projectsFolder, projectSlug, workspaceId)` returns `path.join(projectsFolder, \`\${projectSlug}-\${workspaceId}.code-workspace\`)`. Currently stores files **flat** in `projectsFolder`.
- **`generateWorkspaceFile(workspaceId, repoPaths, filePath)`** — Creates/updates the `.code-workspace` JSON file. Already calls `fs.mkdirSync(parentDir, { recursive: true })`, so nested output paths work without additional directory creation logic.
- **`removeWorkspaceFile(filePath)`** — Deletes a workspace file. Consumes the path from `getWorkspaceFilePath`.
- **`src/orchestration/workspace-orchestrator.ts`** — Wraps `getWorkspaceFilePath` via `wsFilePath(projectId, workspaceId)`. Used in `createWorkspace()`, `deleteWorkspace()`, and `renameWorkspace()`.
- **`src/orchestration/repository-orchestrator.ts`** — Same `wsFilePath()` wrapper, used when adding/removing repositories triggers workspace file regeneration.
- **`src/orchestration/project-orchestrator.ts`** — Same `wsFilePath()` wrapper, used in project deletion and rename flows.

**Current disk layout:**
```
{projectsFolder}/
├── my-app-STABLE.code-workspace          ← flat alongside project dirs
├── my-app-DEV.code-workspace
├── my-app/                               ← project dir
│   ├── STABLE/
│   │   ├── repo-a/
│   │   └── repo-b/
│   └── DEV/
│       └── ...
```

**Target disk layout:**
```
{projectsFolder}/
├── my-app/                               ← project dir
│   ├── my-app-STABLE.code-workspace      ← moved into project dir
│   ├── my-app-DEV.code-workspace
│   ├── STABLE/
│   │   ├── repo-a/
│   │   └── repo-b/
│   └── DEV/
│       └── ...
```

### Existing Patterns

- Config endpoints receive the live `appConfig` object and mutate it in-place for immediate effect.
- `saveConfigField()` handles disk persistence of individual fields.
- The settings view follows a section-based layout (heading → description → interactive content).
- The `POLL_INTERVAL_MS` constant in workspace-detail is referenced in 5 locations for countdown computations.

## Approach / Architecture

The plan comprises two independent change sets that share no code dependencies and can be implemented in any order.

### Change Set A — Configurable Refresh Delay

The change spans three layers:

1. **Backend — REST endpoints:** Add `GET /api/config/polling` and `PUT /api/config/polling` in `src/server/routes/config.ts`. The GET returns the current `gitPollingIntervalSeconds`. The PUT validates (minimum 10), updates the in-memory `appConfig`, persists to disk, and restarts the `PollingManager`.

2. **Backend — PollingManager restart:** Add a `restart(intervalSeconds)` method to `PollingManager` that calls `stop()` then `start()`. Pass the `PollingManager` reference to `registerConfigRoutes` so the PUT endpoint can trigger a restart.

3. **Frontend — Settings view:** Add a "Repositories Refresh Delay" section to `settings.js` with a number input (min=10, default=30, step=1, unit label "seconds"). On save, call `PUT /api/config/polling`. On mount, call `GET /api/config/polling` to populate the current value.

4. **Frontend — Workspace-detail view:** On render, fetch the configured interval via `GET /api/config/polling` and use it instead of the hardcoded `POLL_INTERVAL_MS`. The constant becomes a fallback default if the API call fails.

### Change Set B — Relocate VS Code Workspace Files

A single-point change with zero caller modifications:

1. **`getWorkspaceFilePath`:** Change the path formula from `path.join(projectsFolder, \`\${projectSlug}-\${workspaceId}.code-workspace\`)` to `path.join(projectsFolder, projectSlug, \`\${projectSlug}-\${workspaceId}.code-workspace\`)`. This inserts the `projectSlug` as an intermediate directory segment.

2. **No caller changes needed:** All three orchestrators (`WorkspaceOrchestrator`, `RepositoryOrchestrator`, `ProjectOrchestrator`) call `getWorkspaceFilePath` via their private `wsFilePath()` helper. The path change propagates automatically to `generateWorkspaceFile`, `removeWorkspaceFile`, and rename flows.

3. **Migration of existing files:** Add a one-time migration utility that moves `.code-workspace` files from the old flat location to the new per-project subdirectory. This runs on server startup by scanning `projectsFolder` for files matching the `{projectSlug}-{workspaceId}.code-workspace` pattern and relocating them into `{projectsFolder}/{projectSlug}/`.

4. **Update tests:** The `getWorkspaceFilePath` unit tests in `src/tests/vscode-workspace.test.ts` assert on the old flat path and must be updated to expect the nested path.

## Rationale

- **Single source of truth:** Using the existing `gitPollingIntervalSeconds` config field means the CLI, config file, and GUI all share one setting. No new config field is needed.
- **PollingManager restart:** The PUT endpoint must restart the polling manager so changes take effect immediately. A simple `restart()` method composed from `stop()` + `start()` is minimal and safe — any in-flight sweep completes naturally.
- **Min 10 seconds:** Prevents overly aggressive polling that could overwhelm remotes or the local machine with git fetch subprocesses.
- **Frontend reads from backend:** Rather than duplicating the value in `localStorage`, the frontend reads the authoritative value from the server. This keeps all configuration in `config.json`.
- **Workspace file relocation — minimal change surface:** Only `getWorkspaceFilePath` needs modification. All callers (three orchestrators) consume its output via `wsFilePath()` and pass it opaquely to `generateWorkspaceFile`, `removeWorkspaceFile`, and `fs.renameSync`. The path change propagates automatically. `generateWorkspaceFile` already creates parent directories via `fs.mkdirSync(parentDir, { recursive: true })`, so the nested project directory is created on-demand.
- **Co-location with cloned repos:** Workspace files describe the repositories inside `{projectsFolder}/{projectSlug}/{workspaceId}/`. Storing them alongside these directories makes the on-disk layout more intuitive and simplifies manual cleanup (deleting a project directory removes everything).

## Detailed Steps

### Step 1 — Add `restart()` to `PollingManager`

In `src/server/pollingManager.ts`, add:

```typescript
restart(intervalSeconds: number): void {
    this.stop();
    this.start(intervalSeconds);
}
```

### Step 2 — Add polling config REST endpoints

In `src/server/routes/config.ts`:

- Update `registerConfigRoutes` signature to accept an optional `pollingManager?: PollingManager` parameter.
- Add `GET /api/config/polling` — returns `{ gitPollingIntervalSeconds: number }`.
- Add `PUT /api/config/polling` — accepts `{ seconds: number }`, validates `seconds >= 10` and is a finite integer, updates `appConfig.gitPollingIntervalSeconds`, calls `saveConfigField('gitPollingIntervalSeconds', seconds, configPath)`, calls `pollingManager.restart(seconds)` if provided, returns the updated value.

### Step 3 — Wire PollingManager into config route registration

In `src/server/index.ts`, update the `registerConfigRoutes(router, config.appConfig)` call to pass `pollingManager` as the fourth argument:

```typescript
registerConfigRoutes(router, config.appConfig, undefined, pollingManager);
```

### Step 4 — Add API client methods

In `gui/public/js/api.js`, extend the `config` namespace:

```javascript
config: {
    credentials: { /* existing */ },
    polling: {
        get() { return request('GET', '/api/config/polling'); },
        set(seconds) { return request('PUT', '/api/config/polling', { seconds }); },
    },
}
```

### Step 5 — Add "Refresh Delay" section to Settings view

In `gui/public/js/views/settings.js`:

- Add a new section below the Git Credentials section with heading "Repositories Refresh Delay".
- Render a description paragraph explaining the setting.
- On mount, call `api.config.polling.get()` and populate a number input with the current value.
- Add a "Save" button that calls `api.config.polling.set(value)`. Validate `value >= 10` client-side before submission. Show a toast on success/failure.
- The number input has `min="10"`, `step="1"`, and a "seconds" suffix label.

### Step 6 — Use server-configured interval in workspace-detail

In `gui/public/js/views/workspace-detail.js`:

- Keep `const POLL_INTERVAL_MS = 30_000` as a fallback default (matching the server default).
- In `renderWorkspaceDetail`, add `api.config.polling.get()` to the initial `Promise.all` fetch.
- Extract the returned `gitPollingIntervalSeconds`, convert to milliseconds, and use it in place of `POLL_INTERVAL_MS` for the `remainingSeconds` calculation and all countdown references.

### Step 7 — Update `config.dist.json` (no change needed)

`config.dist.json` already contains `"gitPollingIntervalSeconds": 30`. No update required.

### Step 8 — Update manifest documents

- **`rest-api.md`** — Add `GET /api/config/polling` and `PUT /api/config/polling` entries.
- **`api-surface.md`** — Add `restart(intervalSeconds)` to `PollingManager` public API. Update `getWorkspaceFilePath` path formula.
- **`gui-frontend.md`** — Add `api.config.polling` to API client docs, add "Refresh Delay" section to settings view description.
- **`constraints.md`** — Add the 10-second minimum polling interval constraint.

### Step 9 — Relocate workspace file output path

In `src/orchestration/vscode-workspace.ts`, update `getWorkspaceFilePath` to nest the file inside the project subdirectory:

```typescript
// BEFORE
return path.join(projectsFolder, `${projectSlug}-${workspaceId}.code-workspace`);

// AFTER
return path.join(projectsFolder, projectSlug, `${projectSlug}-${workspaceId}.code-workspace`);
```

No changes are needed in the three orchestrators (`WorkspaceOrchestrator`, `RepositoryOrchestrator`, `ProjectOrchestrator`) — they all call `getWorkspaceFilePath` via their private `wsFilePath()` helper, and `generateWorkspaceFile` already creates parent directories via `fs.mkdirSync(parentDir, { recursive: true })`.

### Step 10 — Add workspace file migration utility

Add an exported function `migrateWorkspaceFiles(projectsFolder, projectSlugs)` to `src/orchestration/vscode-workspace.ts` that:

1. For each project slug, scans `{projectsFolder}/` for files matching `{slug}-*.code-workspace`.
2. For each matching file, moves it to `{projectsFolder}/{slug}/{filename}` using `fs.renameSync`.
3. Skips files that already exist at the target location (idempotent).
4. Returns a count of migrated files (for logging).

### Step 11 — Call migration on server startup

In `src/server/index.ts`, after loading the config and project list, call `migrateWorkspaceFiles` with the list of known project slugs. This is a one-time migration that becomes a no-op once all files have been moved. Log the count of migrated files if > 0.

### Step 12 — Update workspace file tests

In `src/tests/vscode-workspace.test.ts`:

- Update the two `getWorkspaceFilePath` test assertions to expect the nested path format (e.g., `path.join('/projects', 'my-project', 'my-project-STABLE.code-workspace')`).
- Add tests for `migrateWorkspaceFiles`: verify files are moved, verify idempotency, verify no error when source files don't exist.

## Dependencies

- No new runtime dependencies. All changes use existing infrastructure (`saveConfigField`, `PollingManager`, vanilla DOM APIs).

## Required Components

### Modified files

- `src/server/pollingManager.ts` — add `restart()` method
- `src/server/routes/config.ts` — add GET/PUT polling endpoints, update function signature
- `src/server/index.ts` — pass `pollingManager` to `registerConfigRoutes`, call workspace file migration on startup
- `gui/public/js/api.js` — add `api.config.polling` namespace
- `gui/public/js/views/settings.js` — add refresh delay section
- `gui/public/js/views/workspace-detail.js` — read configured interval from API
- `src/orchestration/vscode-workspace.ts` — update `getWorkspaceFilePath` path formula, add `migrateWorkspaceFiles` utility

### Modified test files

- `src/tests/vscode-workspace.test.ts` — update path assertions, add migration tests

### Manifest files to update

- `docs/agents/project-manifest/rest-api.md`
- `docs/agents/project-manifest/api-surface.md`
- `docs/agents/project-manifest/gui-frontend.md`
- `docs/agents/project-manifest/constraints.md`

## Assumptions

- The `appConfig` object passed to `registerConfigRoutes` is the same live reference used throughout the server lifetime (confirmed by code review — `startServer` creates one `config.appConfig` object shared by all subsystems).
- `PollingManager.stop()` + `start()` is safe to call while a sweep is in progress (confirmed: stop clears the interval handle, in-flight sweep completes naturally, then start creates a new interval).
- The workspace-detail view can tolerate a slightly delayed parallel fetch for the polling config on render (adds one small `GET /api/config/polling` to the existing `Promise.all`).
- The project subdirectory (`{projectsFolder}/{projectSlug}/`) already exists by the time workspace files are generated, because repos are cloned into `{projectsFolder}/{projectSlug}/{workspaceId}/{repoId}/` first. For edge cases (no repos cloned yet), `generateWorkspaceFile` creates the directory via `fs.mkdirSync(parentDir, { recursive: true })`.
- The server startup code has access to the full list of project slugs (via `ProjectManager` or storage) needed for migration scanning.

## Constraints

- **Minimum interval:** 10 seconds. Enforced both server-side (PUT returns 400 for values < 10) and client-side (HTML `min` attribute + JS validation).
- **Integer values only:** The interval must be a finite positive integer. Fractional seconds are rejected.
- **No server restart required:** Changes take effect immediately via in-memory mutation + PollingManager restart.
- **Field allowlist:** The PUT endpoint operates on a specific known field (`gitPollingIntervalSeconds`), not a generic `saveConfigField` passthrough. No allowlist guard issue.

## Out of Scope

- **Nav badge polling interval** (`nav-badge.js`, 30s) — this polls error log counts, not repository status. Remains hardcoded.
- **Authentication/authorization** — consistent with existing config endpoints (localhost only).
- **Server-side minimum enforcement in `loadConfig()`** — the `loadConfig` function does not currently clamp or validate numeric bounds; this plan follows the same pattern and enforces minimums only at the API boundary.
- **Test implementation** — tests for the new endpoints and PollingManager.restart() are recommended but not detailed in this plan.

## Acceptance Criteria

### Configurable Refresh Delay

- The Settings view (`#/settings`) displays a "Repositories Refresh Delay" section with a number input showing the current value.
- Saving a valid value (≥ 10) persists it to `config.json` and immediately changes the server-side polling interval.
- Saving an invalid value (< 10, non-numeric, empty) shows an error and does not persist.
- The workspace-detail view reads the configured interval on mount and uses it for the countdown timer.
- `GET /api/config/polling` returns `{ gitPollingIntervalSeconds: <number> }`.
- `PUT /api/config/polling` with `{ seconds: <number >= 10 }` returns the updated value.
- `PUT /api/config/polling` with `{ seconds: 5 }` returns 400 with a descriptive error message.
- The default value remains 30 seconds when `gitPollingIntervalSeconds` is absent from `config.json`.

### Workspace File Relocation

- `getWorkspaceFilePath('/projects', 'my-app', 'STABLE')` returns `/projects/my-app/my-app-STABLE.code-workspace`.
- Creating a new workspace generates its `.code-workspace` file inside the project subdirectory.
- Deleting a workspace removes the file from the project subdirectory.
- Renaming a workspace creates the new file in, and removes the old file from, the project subdirectory.
- On server startup, existing `.code-workspace` files in the flat `{projectsFolder}/` root are migrated into their respective project subdirectories.
- Migration is idempotent — running it again when files are already in-place produces no errors and no duplicate files.
- All existing `vscode-workspace.test.ts` tests pass with updated path assertions.

## Testing Strategy

### Configurable Refresh Delay

- **Unit tests** for `PollingManager.restart()`: verify it starts a new interval after stop.
- **Server route tests** for `GET /api/config/polling` and `PUT /api/config/polling`:
  - Returns current value on GET.
  - Persists and returns new value on valid PUT.
  - Returns 400 on PUT with value < 10.
  - Returns 400 on PUT with non-numeric or missing `seconds`.
- **Integration / manual testing** for the settings UI:
  - Page loads with the current value pre-populated.
  - Save button updates the value and shows a success toast.
  - Invalid input is rejected client-side.
  - Workspace-detail countdown updates to reflect the new delay.

### Workspace File Relocation

- **Unit tests** for `getWorkspaceFilePath`: update existing assertions to expect nested path.
- **Unit tests** for `migrateWorkspaceFiles`:
  - Given files at the old flat location, they are moved into the project subdirectory.
  - Given files already at the target location, no error is thrown (idempotent).
  - Given no matching files, returns 0 and no errors.
- **Integration test**: the existing `generateWorkspaceFile` tests implicitly validate that the nested directory is created by `fs.mkdirSync`.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Race between restart and in-flight sweep** | `stop()` only clears the interval handle; an active sweep finishes safely. `start()` creates a new interval. No data corruption possible. |
| **Stale frontend value after server config change** | Workspace-detail fetches the configured interval on every mount. If the config changes between navigations, the next visit picks up the new value. |
| **Breaking existing tests that call `registerConfigRoutes`** | New `pollingManager` parameter is optional (defaults to `undefined`). Existing callers are unaffected. |
| **Frontend fetch failure for polling config** | Fallback to the hardcoded default (30s). The workspace-detail view continues to function with a reasonable default. |
| **Workspace migration race with concurrent access** | Migration runs synchronously at server startup before the HTTP server begins listening. No concurrent workspace operations are possible during migration. |
| **Orphaned workspace files after migration** | Migration only moves files it can attribute to a known project slug. Unrecognized `.code-workspace` files in `projectsFolder/` are left in place, avoiding data loss. |
| **Project deletion leaves empty directory** | `ProjectOrchestrator.deleteProject` already removes the `{projectsFolder}/{projectSlug}/` tree recursively, which will now also clean up workspace files inside it. No additional cleanup needed. |
