# Plan

## Summary

Add server-side endpoints and GUI controls to launch external applications from the workspace detail view: **GitHub Desktop** (per repository) and **VS Code** (per workspace). The browser cannot spawn local processes, so the GUI delegates to the server via two new POST endpoints. If the launch fails (e.g. command not found, path missing) the server returns an error, the GUI shows a toast, and the failure is recorded in the error log.

## Architectural Context

### Relevant modules and patterns

- **Server route registration:** Routes are grouped per resource in `src/server/routes/*.ts`. Each file exports a `register*Routes()` function called from `src/server/index.ts`. Route handlers receive `(req, res, params)` and use `sendJson()`/`sendError()` from `src/server/requestUtils.ts`.
- **Workspace routes:** `src/server/routes/workspaces.ts` — `registerWorkspaceRoutes(router, workspaceManager, workspaceOrchestrator, appConfig, projectManager)`. Currently does **not** receive an `ErrorLogManager` — this needs to change.
- **Workspace file paths:** `src/orchestration/vscode-workspace.ts` exports `getWorkspaceFilePath(projectsFolder, projectSlug, workspaceId)` → `{projectsFolder}/{projectId}/{projectId}-{workspaceId}.code-workspace`.
- **Repository local path pattern:** Cloned repositories live at `{projectsFolder}/{projectId}/{workspaceId}/{repoId}`.
- **Git subprocess pattern:** `src/git/git-cli.ts` uses `child_process.spawn()` with `shell: false` for all git commands. This new feature spawns non-git GUI applications (`code`, `github`), which requires a different spawning strategy (see Rationale).
- **Error log:** `ErrorLogManager.append()` accepts `Omit<ErrorLogEntry, 'Id' | 'Timestamp'>` and persists to `error-log.json`.
- **GUI workspace detail view:** `gui/public/js/views/workspace-detail.js` renders the workspace header (with management buttons) and a status table with one row per repository (columns: Repository, Branch, Status). Uses router injection and the cleanup contract.
- **API client:** `gui/public/js/api.js` exports the `api` namespace with methods mapping to REST endpoints.
- **Toast pattern:** `showToast(message, type, duration)` for user feedback.

## Approach / Architecture

### Two new POST endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/projects/:id/workspaces/:wid/launch/vscode` | Launch VS Code with the workspace's `.code-workspace` file. |
| `POST` | `/api/projects/:id/workspaces/:wid/launch/github-desktop/:rid` | Launch GitHub Desktop with the repository's local clone path. |

Both endpoints:
1. Validate that the project, workspace, and (for GitHub Desktop) repository exist.
2. Compute the target path and verify it exists on disk.
3. Spawn the external application via a new `launchApplication()` utility.
4. Return `200 { success: true }` on successful spawn.
5. On failure: return `500` with an error message, log to the error log, and the GUI shows an error toast.

### New utility module

A new `src/server/app-launcher.ts` module encapsulates the cross-platform process spawning logic. It exposes a single `launchApplication(command, args)` function that:
- Spawns the process as detached (fire-and-forget for GUI apps).
- Resolves on the `spawn` event (Node.js >= 15.1, project requires >= 18).
- Rejects on the `error` event (e.g. `ENOENT` when the command is not found).
- Uses `shell: true` on Windows only (`process.platform === 'win32'`) to resolve `.cmd` shims; uses `shell: false` on all other platforms (see Rationale).

### GUI changes

1. **"Open in VS Code" button** — added to the workspace header management row (`buildHeaderSection`), visible only when the workspace is initialized.
2. **"Open" link per repository** — added as a 4th column ("Actions") to the repository status table. Each row gets a small "Open" button that calls the GitHub Desktop endpoint.
3. **API client** — two new methods: `api.workspaces.openVscode(pid, wid)` and `api.workspaces.openGithubDesktop(pid, wid, rid)`.

## Rationale

### Why server-side process spawning?

The GUI is a browser-based SPA. Browsers cannot spawn local processes. The server runs on `localhost` and has access to the file system and process spawning — it is the natural execution point.

### Why `shell: true` on Windows?

On Windows, `code` and `github` are typically `.cmd` shims. Node.js `spawn()` with `shell: false` cannot resolve `.cmd` files. Using `shell: true` on Windows only solves this. This is a deliberate, scoped deviation from the git layer's `shell: false` convention. The security risk is negligible because:
- The command names are **hardcoded** (`code`, `github`) — never user-supplied.
- The arguments are **file paths** constructed from validated config (`projectsFolder`) and validated IDs (kebab-case/workspace-ID constraints).
- No user-supplied strings are interpolated into the command line.

### Why `spawn` event instead of timeout?

The `spawn` event (available since Node.js 15.1) fires when the process starts successfully. This is deterministic and avoids the fragile timeout-based approach for detecting spawn failures.

### Why a 4th "Actions" column instead of inline links?

A dedicated column keeps the table structure clean and extensible. Future actions (e.g. "Open in terminal") can be added to the same column without modifying the row layout.

## Detailed Steps

### Step 1 — Create `src/server/app-launcher.ts`

New file. Exports:

```typescript
function launchApplication(command: string, args: string[]): Promise<void>
```

Implementation:
- Uses `child_process.spawn()` with `detached: true`, `stdio: 'ignore'`.
- Sets `shell: process.platform === 'win32'` (Windows `.cmd` resolution).
- Listens for the `spawn` event → calls `child.unref()` and resolves.
- Listens for the `error` event → rejects with a descriptive error (includes the command name but **not** the full arguments to avoid leaking paths in logs).

### Step 2 — Modify `src/server/routes/workspaces.ts`

Add the `ErrorLogManager` parameter to `registerWorkspaceRoutes`.

Add two new route handlers inside the registration function:

**`POST /api/projects/:id/workspaces/:wid/launch/vscode`:**
1. Look up workspace via `workspaceManager.getById(params.id, params.wid)`. Return 404 if not found.
2. Compute workspace file path via `getWorkspaceFilePath(appConfig.projectsFolder, params.id, params.wid)`.
3. Verify the file exists on disk (`fs.existsSync`). Return 400 with `"Workspace file does not exist. Run setup first."` if absent.
4. Call `launchApplication('code', [filePath])`.
5. On success: `sendJson(res, 200, { success: true })`.
6. On failure: log to error log (`source: 'app-launcher'`, `operation: 'open-vscode'`), `sendError(res, 500, descriptive message)`.

**`POST /api/projects/:id/workspaces/:wid/launch/github-desktop/:rid`:**
1. Look up workspace via `workspaceManager.getById(params.id, params.wid)`. Return 404 if not found.
2. Verify repository `params.rid` belongs to the project via `projectManager.getById(params.id)`. Return 404 if either project or repo-in-project is not found.
3. Compute repo path: `path.join(appConfig.projectsFolder, params.id, params.wid, params.rid)`.
4. Verify the directory exists on disk. Return 400 with `"Repository directory does not exist. Run setup first."` if absent.
5. Call `launchApplication('github', [repoPath])`.
6. On success: `sendJson(res, 200, { success: true })`.
7. On failure: log to error log (`source: 'app-launcher'`, `operation: 'open-github-desktop'`), `sendError(res, 500, descriptive message)`.

### Step 3 — Modify `src/server/index.ts`

Pass `errorLogManager` as a new parameter to `registerWorkspaceRoutes()`.

### Step 4 — Modify `gui/public/js/api.js`

Add two new methods to the `api.workspaces` namespace:

```javascript
openVscode(projectId, wid) {
    return request(`/api/projects/${projectId}/workspaces/${wid}/launch/vscode`, { method: 'POST' });
},
openGithubDesktop(projectId, wid, repoId) {
    return request(`/api/projects/${projectId}/workspaces/${wid}/launch/github-desktop/${repoId}`, { method: 'POST' });
},
```

### Step 5 — Modify `gui/public/js/views/workspace-detail.js`

**5a. Add "Open in VS Code" button to the header section.**

In `buildHeaderSection()`, add a new button to `mgmtRow` (after the Setup button, before Rename). The button:
- Label: `Open in VS Code`
- Is shown only when `workspace.initialized` is `true`.
- On click: calls `api.workspaces.openVscode(projectId, workspace.id)`. Shows a success toast on success, an error toast on failure.
- After a successful setup (via `onSetupSuccess`), the button should be dynamically inserted into the management row.

**5b. Add "Open" button per repository row.**

In `buildRepoStatusRow()`:
- Add a 4th cell (after the badge cell) with class `repo-actions-cell`.
- Render a small "Open" button (`btn btn-secondary btn-sm`).
- On click: calls `api.workspaces.openGithubDesktop(projectId, workspaceId, repoId)`. Shows an error toast on failure.

This requires threading `projectId` and `workspaceId` through to `buildRepoStatusRow()` (currently it only receives `repoId`, `repoName`, and `statusInfo`).

In `buildStatusTableSection()`:
- Add a 4th `<th>` header with an empty label (or visually hidden "Actions" for accessibility).

In the `thead` construction within `buildStatusTableSection()`, change the header array from `['Repository', 'Branch', 'Status']` to `['Repository', 'Branch', 'Status', '']` (empty header for the actions column).

In `updateStatusTable()`:
- No changes needed — it updates the badge in cell index 2 (via `data-repo-id` on the wrapper `<div>`), which remains cell index 2. The new actions cell at index 3 is static and never updated by polling.

### Step 6 — Update manifest documents

- `rest-api.md` — Add the two new endpoints under a new "Launch" section.
- `api-surface.md` — Add `launchApplication()` signature.
- `gui-frontend.md` — Update the workspace-detail view description and the `api.workspaces` method table.

## Dependencies

- `child_process.spawn` (Node.js built-in — no new dependencies).
- `getWorkspaceFilePath()` from `src/orchestration/vscode-workspace.ts` (already exists).
- `ErrorLogManager` from `src/error-log/error-log.manager.ts` (already exists, needs to be wired into workspace routes).

## Required Components

### New files
- `src/server/app-launcher.ts` — Cross-platform application launcher utility.

### Modified files
- `src/server/routes/workspaces.ts` — Two new POST route handlers + `ErrorLogManager` parameter.
- `src/server/index.ts` — Pass `errorLogManager` to `registerWorkspaceRoutes()`.
- `gui/public/js/api.js` — Two new API methods.
- `gui/public/js/views/workspace-detail.js` — "Open in VS Code" button in header, "Open" button per repo row, 4th table column.
- `docs/agents/project-manifest/rest-api.md` — New "Launch" endpoints.
- `docs/agents/project-manifest/api-surface.md` — `launchApplication()` signature.
- `docs/agents/project-manifest/gui-frontend.md` — Updated workspace-detail description and API surface.

## Assumptions

- The `code` CLI command is available on the user's PATH (installed via VS Code's "Install 'code' command in PATH" action).
- The `github` CLI command is available on the user's PATH (installed by GitHub Desktop).
- Both commands accept a single positional argument (file/directory path) and launch the respective GUI application.
- The server is always running on the same machine where the applications are installed (localhost constraint).

## Constraints

- Relative imports must use `.js` extensions (Node16 ESM).
- `shell: false` on non-Windows platforms; `shell: true` only on Windows for `.cmd` resolution.
- Command names are hardcoded — never derived from user input.
- Path arguments are constructed from validated config and validated IDs only.
- Error messages exposed to the API must not leak full file system paths beyond what the API already exposes (the `FolderPath` field is already returned by workspace endpoints, so paths are not a secret from the API consumer).

## Out of Scope

- Adding a configuration option for custom command names (e.g. `code-insiders` instead of `code`). Can be added later if needed.
- Terminal launchers (e.g. "Open in Terminal") — same pattern but different commands.
- Authentication or authorisation for the launch endpoints (the server is localhost-only, consistent with existing endpoints).
- GUI styling polish (CSS for the actions column) — the existing Pico CSS classless styling and `.btn-sm` classes should provide adequate defaults.

## Acceptance Criteria

- Clicking "Open in VS Code" in the workspace header launches VS Code with the `.code-workspace` file.
- Clicking "Open" on a repository row launches GitHub Desktop with the repository's local clone path.
- If the command is not found on PATH, the GUI shows an error toast and the error is logged in the error log.
- If the target path does not exist (workspace not set up), the GUI shows an error toast explaining setup is needed.
- Both actions work on macOS, Linux, and Windows (correct command resolution).
- The "Open in VS Code" button is only shown for initialized workspaces and appears dynamically after workspace setup.
- API methods `api.workspaces.openVscode()` and `api.workspaces.openGithubDesktop()` are available in the frontend API client.

## Testing Strategy

- **Unit tests for `app-launcher.ts`:** Test with a known-good command (e.g. `node -e "process.exit(0)"`) to verify the `spawn` event resolves, and a non-existent command to verify the `error` event rejects. Platform-specific shell behaviour can be verified by checking `process.platform`.
- **Integration tests for route handlers:** Use the existing server test pattern (`src/server/__tests__/`). Spin up a test server, call the new endpoints, and verify 404/400/500 responses for invalid IDs, missing paths, and absent commands.
- **Manual testing:** Verify the full flow on macOS with `code` and `github` installed. Windows testing is recommended but can be deferred if no Windows dev environment is available.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **`code` or `github` not on PATH** | The endpoint returns a descriptive error ("Failed to launch \<app\>. Ensure the command is installed and available on PATH."). The error is logged. The GUI shows an error toast. |
| **Windows `.cmd` resolution fails** | `shell: true` on Windows handles `.cmd` shim resolution. Documented as a conscious platform-specific decision. |
| **Spawned process hangs or fails silently** | Using `detached: true` + `child.unref()` ensures the server process is not blocked. The `spawn` event confirms the process started; further lifecycle is the application's responsibility. |
| **Security: arbitrary command execution** | Commands are hardcoded (`code`, `github`). Arguments are validated paths. No user-supplied command strings. `shell: true` only on Windows with non-user-supplied arguments. |
| **Race condition: workspace deleted between validation and spawn** | Extremely unlikely (single-user localhost tool) and benign — the launched application would simply show its own "file not found" error. |
