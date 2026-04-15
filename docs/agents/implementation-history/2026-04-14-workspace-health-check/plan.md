# Plan

## Summary

Introduce a per-workspace **health check** system that detects structural issues (missing `.code-workspace` file, missing repository clones) and surfaces them in the GUI with one-click fix buttons. The health check runs:

1. **On workspace load** — when the user navigates to a workspace-detail view.
2. **Alongside the polling cycle** — piggybacking on the existing countdown-based refresh in the workspace-detail view.
3. **On project load** — a summary health indicator per workspace in the project-detail workspace table.

The system is designed to be **extensible**: new check types can be added by implementing a check function and a corresponding fix action, without changing the core health check framework.

## Architectural Context

### Existing infrastructure

- **`withInitialized()` helper** in `src/server/routes/workspaces.ts` — Augments workspace GET responses with `Initialized: boolean` (folder existence) and `FolderPath: string`. This is the current "health check" — it's a single boolean.
- **`PollingManager`** in `src/server/pollingManager.ts` — Background sweep for git status. Runs on a configurable interval. The workspace-detail view uses its results via `api.status.get()` / `api.status.refresh()`.
- **Workspace-detail view** (`gui/public/js/views/workspace-detail.js`) — Already has a "Retry Setup" button shown when repos have no status data. This is an ad-hoc health indicator embedded in the view logic.
- **`generateWorkspaceFile()`** in `src/orchestration/vscode-workspace.ts` — Creates/updates `.code-workspace` files. Idempotent — preserves existing `settings` and other properties.
- **`getWorkspaceFilePath()`** in `src/orchestration/vscode-workspace.ts` — Computes the `.code-workspace` file path from `projectsFolder`, `projectId`, `workspaceId`.
- **`WorkspaceOrchestrator.createWorkspace()`** — Clones repos + generates workspace file. Existing `POST .../setup` endpoint delegates to this.
- **Normalise utility** (`gui/public/js/utils/normalise.js`) — Maps PascalCase backend keys to camelCase. `normaliseWorkspace()` currently handles `Initialized`, `FolderPath`.

### Key patterns

- Backend workspace responses are **stateless per-request** (re-check filesystem every time).
- GUI views follow the **full-refresh-on-mutation** pattern.
- Views with side-effects return **cleanup functions** for the router.
- **Router injection** via `setRouter()` avoids circular imports.

## Approach / Architecture

### Design: dedicated health check endpoint

Rather than scattering filesystem checks across multiple existing endpoints, introduce a **single dedicated health check endpoint** per workspace:

```
GET /api/projects/:id/workspaces/:wid/health
```

This endpoint returns a structured report with an array of **issues**, each with a type, human-readable message, severity, and a machine-readable `fixAction` that the frontend can use to decide which fix button to render.

#### Health check response shape

```json
{
    "healthy": false,
    "issues": [
        {
            "type": "workspace-file-missing",
            "severity": "warning",
            "message": "VS Code workspace file is missing.",
            "fixAction": "regenerate-workspace-file"
        },
        {
            "type": "repository-not-cloned",
            "severity": "warning",
            "message": "Repository \"my-repo\" is not cloned.",
            "repositoryId": "my-repo",
            "fixAction": "setup-workspace"
        }
    ]
}
```

#### Fix action endpoints

Two fix-action endpoints (one new, one existing):

| Fix Action | Endpoint | Behaviour |
|---|---|---|
| `regenerate-workspace-file` | `POST .../regenerate-workspace-file` **(new)** | Regenerates only the `.code-workspace` file from the current project repository list. Lightweight, no cloning. |
| `setup-workspace` | `POST .../setup` **(existing)** | Runs full workspace setup — clones missing repos and regenerates the workspace file. Already idempotent. |

### Backend module: workspace health checker

A new module `src/orchestration/workspace-health.ts` encapsulating the health check logic as a side-effect-free function (read-only filesystem access, no mutations). This keeps the check logic independent of HTTP concerns and testable in isolation.

```typescript
// New file: src/orchestration/workspace-health.ts

interface WorkspaceHealthIssue {
    type: string;
    severity: 'error' | 'warning';
    message: string;
    fixAction: string;
    repositoryId?: string;  // Present only for repo-specific issues
}

interface WorkspaceHealthReport {
    healthy: boolean;
    issues: WorkspaceHealthIssue[];
}

function checkWorkspaceHealth(
    projectId: string,
    workspaceId: string,
    projectsFolder: string,
    repositoryIds: string[],
): WorkspaceHealthReport
```

#### Checks implemented in this plan

1. **`workspace-file-missing`** — The `.code-workspace` file does not exist on disk (computed via `getWorkspaceFilePath()` + `fs.existsSync()`). Fix: `regenerate-workspace-file`.
2. **`repository-not-cloned`** — A repository directory does not contain a `.git` subdirectory (same check as `WorkspaceOrchestrator.createWorkspace()` uses). Fix: `setup-workspace`. One issue per missing repo.

#### Extensibility

Adding a new check in the future (e.g. "workspace file is stale — contains repos no longer in project", "repo is on wrong branch") requires only:
1. Add a new check block in `checkWorkspaceHealth()`.
2. Define a `fixAction` string.
3. If the fix requires a new endpoint, add one.
4. Add a button mapping in the frontend `healthIssueFixButton()` helper.

### Frontend: health check integration

#### Workspace-detail view

- On load, fetch `GET .../health` alongside the existing parallel data fetch.
- If the report has issues, render a **health alert section** between the header and the status table — a dismissable card listing each issue with its fix button.
- After a fix action succeeds, re-fetch the health check and update the alert section in-place.
- On each polling cycle tick (piggybacked on the 1-second countdown interval), do NOT re-fetch health — it's filesystem I/O and should only run on explicit refresh or page load. However, when the user clicks "Refresh Now" or the automatic poll fires, also re-fetch health.

#### Project-detail view

- On load, fetch health for all initialized workspaces in parallel (alongside the existing status fetches).
- Show a health indicator icon/badge in the workspace table row when issues exist.
- No inline fix buttons on the project listing — the user clicks into the workspace to see details and fix.

### Existing `Initialized` field

The existing `Initialized` boolean and `FolderPath` fields on workspace GET responses remain unchanged. The health check is a separate concern — `Initialized: false` means the workspace has never been set up (show "Setup" button as today), while health issues apply to workspaces that are initialized but have structural problems.

## Rationale

- **Dedicated endpoint vs. inlining in existing responses:** A separate `/health` endpoint keeps the existing GET workspace responses lean and backwards-compatible. Health checks involve filesystem I/O (multiple `existsSync` calls) that aren't needed for simple CRUD operations.
- **Backend module vs. inline route logic:** `workspace-health.ts` as a standalone side-effect-free function is easily unit-testable and keeps route handlers thin.
- **Direct `ProjectManager` injection vs. delegation through orchestrator:** `WorkspaceOrchestrator` already holds a `projectManager` internally, so an alternative would be to expose a method on the orchestrator. However, both the health check and `regenerate-workspace-file` endpoint only need the project's repository list — a thin data lookup. Injecting `ProjectManager` directly into the route keeps the dependency explicit and avoids adding a pass-through method to the orchestrator.
- **Not integrating with PollingManager:** The polling manager runs background sweeps for all workspaces across all projects. Health checks are workspace-specific and only needed when a user is actively viewing a workspace. Piggybacking on the frontend's per-view polling cycle is more efficient.
- **Fix actions as machine-readable strings:** This allows the frontend to map each issue type to a specific button and API call without coupling to the backend's internal naming.

## Detailed Steps

### Step 1: Create `src/orchestration/workspace-health.ts`

New file with:
- `WorkspaceHealthIssue` interface
- `WorkspaceHealthReport` interface
- `checkWorkspaceHealth()` function

The function:
1. Builds the `.code-workspace` file path via `getWorkspaceFilePath()`. **Note:** the function's second parameter is named `projectSlug` in the signature, but in this codebase project IDs and slugs are identical — pass `projectId` directly.
2. Checks `fs.existsSync()` on the workspace file — adds `workspace-file-missing` issue if absent.
3. For each `repositoryId`, checks `fs.existsSync(path.join(projectsFolder, projectId, workspaceId, repoId, '.git'))` — adds `repository-not-cloned` issue if absent.
4. Returns `{ healthy: issues.length === 0, issues }`.

### Step 2: Create the `regenerate-workspace-file` endpoint

In `src/server/routes/workspaces.ts`:
- Add `ProjectManager` to the `registerWorkspaceRoutes()` signature.
- Import `generateWorkspaceFile` and `getWorkspaceFilePath` from `../../orchestration/vscode-workspace.js`.
- Register `POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file`:
  1. Verify project exists (via `projectManager.getById()`).
  2. Verify workspace exists (via `workspaceManager.getById()`).
  3. Verify workspace folder exists on disk — `400` if not (must be initialized first).
  4. Compute `repoPaths` from `project.Repositories` and call `generateWorkspaceFile()`.
  5. Return `200` with `{ success: true }`.

### Step 3: Create the health check endpoint

In `src/server/routes/workspaces.ts`:
- Import `checkWorkspaceHealth` from `../../orchestration/workspace-health.js`.
- Register `GET /api/projects/:id/workspaces/:wid/health`:
  1. Verify project exists via `projectManager.getById(params['id'])` — `404` if not. Verify workspace exists via `workspaceManager.getById()` — `404` if not.
  2. If workspace folder does not exist (not initialized), return `200` with `{ healthy: true, issues: [] }` — non-initialized workspaces have no structural health issues (they need "Setup" first, which is a different concern).
  3. Extract repository IDs from `project.Repositories` (the same `projectManager` instance added in Step 2). Call `checkWorkspaceHealth(projectId, workspaceId, appConfig.projectsFolder, repositoryIds)`.
  4. Return `200` with the `WorkspaceHealthReport`.

### Step 4: Update `registerWorkspaceRoutes()` call site

In `src/server/index.ts`, pass `projectManager` as the new 5th argument to `registerWorkspaceRoutes()`.

### Step 5: Add `api.workspaces.health()` and `api.workspaces.regenerateFile()` to API client

In `gui/public/js/api.js`, add to the `workspaces` namespace:
```javascript
health(projectId, wid) {
    return request('GET',
        `/api/projects/${euc(projectId)}/workspaces/${euc(wid)}/health`);
},
regenerateFile(projectId, wid) {
    return request('POST',
        `/api/projects/${euc(projectId)}/workspaces/${euc(wid)}/regenerate-workspace-file`);
},
```

### Step 6: Add health alert section to workspace-detail view

In `gui/public/js/views/workspace-detail.js`:

1. **Add to the parallel data fetch** (`Promise.all`): include `api.workspaces.health(projectId, wid)`.
2. **Create `buildHealthAlertSection(projectId, workspaceId, healthReport, onFixed)`** function:
   - Returns `null` if `healthReport.healthy`.
   - Otherwise renders a card/section with:
     - A heading: "Workspace Health Issues"
     - One row per issue: icon + message + fix button.
     - Fix button mapping:
       - `regenerate-workspace-file` → calls `api.workspaces.regenerateFile()`.
       - `setup-workspace` → calls `api.workspaces.setup()`.
     - On fix success: show toast, call `onFixed()` callback which re-fetches health and updates the section.
3. **Insert the section** between the header and the refresh toolbar (or instead of the status table area, before the toolbar).
4. **On each "Refresh Now" or auto-poll**, re-fetch health and update the alert section. Add a helper `refreshHealthAlert()` called from `doRefresh()` and `doPoll()`.
5. **Retain the existing "Retry Setup" block** (lines ~810–860) but narrow its trigger condition. The existing block fires when repos have *no status data* (a runtime/polling concern — the clone may have succeeded but the status fetch hasn't run yet). The health check detects repos with *no `.git/` directory* (a structural concern — the repo was never cloned). These are overlapping but not identical signals. To avoid duplication without losing the runtime signal:
   - Remove the `repository-not-cloned` case from the retry block (now covered by health alerts).
   - Keep the retry block for repos that are structurally present (`.git/` exists) but have no status data yet — this covers the transient polling-lag case that the health check intentionally does not address.

### Step 7: Add health indicator to project-detail workspace table

In `gui/public/js/views/project-detail.js`:

1. **In `renderProjectDetail`**, for each initialized workspace, fetch `api.workspaces.health(projectId, ws.id)` in parallel alongside the existing status fetches. **Scalability note:** each health fetch triggers a separate HTTP request with filesystem I/O on the backend. For projects with many workspaces (>10), consider introducing a batch endpoint (`GET /api/projects/:id/health`) in a follow-up plan to avoid N+1 request overhead. For the current scale this is acceptable.
2. **In `buildWorkspacesSection()`**, add a health status cell or badge to each workspace row:
   - Green check / empty when `healthy === true`.
   - Warning icon + issue count when `healthy === false`.
   - No indicator when workspace is not initialized (shows "Setup" button instead).
3. The badge is informational only — no fix buttons in the project-detail table. The user navigates to the workspace to fix issues.

### Step 8: Add CSS for the health alert section

In `gui/public/css/styles.css`:
- `.workspace-health-alert` — Card/section styling (subtle warning background).
- `.workspace-health-issue-row` — Flex row for issue message + fix button.
- `.health-indicator-badge` — Small icon/badge for the project-detail table.

## Dependencies

- `getWorkspaceFilePath()` (existing export from `src/orchestration/vscode-workspace.ts`)
- `generateWorkspaceFile()` (existing export from `src/orchestration/vscode-workspace.ts`)
- `ProjectManager.getById()` (existing — needs to be passed to route registration)
- `fs.existsSync()` (Node.js built-in)

## Required Components

### New files
- `src/orchestration/workspace-health.ts` — Health check logic (types + `checkWorkspaceHealth()`)

### Modified files
- `src/server/routes/workspaces.ts` — New endpoint + expanded function signature + health endpoint
- `src/server/index.ts` — Pass `projectManager` to `registerWorkspaceRoutes()`
- `gui/public/js/api.js` — New `health()` and `regenerateFile()` methods
- `gui/public/js/views/workspace-detail.js` — Health alert section + removal of ad-hoc retry block
- `gui/public/js/views/project-detail.js` — Health badge in workspace table
- `gui/public/css/styles.css` — Health alert and badge styling

### Manifest documents to update
- `docs/agents/project-manifest/api-surface.md` — New types + `checkWorkspaceHealth()` signature
- `docs/agents/project-manifest/rest-api.md` — New endpoints
- `docs/agents/project-manifest/gui-frontend.md` — Health alert component, updated workspace-detail and project-detail docs
- `docs/agents/project-manifest/data-flows.md` — Health check data flow
- Re-run `ctx generate` for the new file in `src/orchestration/`

## Assumptions

- The `.code-workspace` file path is deterministic and can always be recomputed via `getWorkspaceFilePath()`.
- Regenerating the workspace file only needs the project's repository list and workspace ID — no repo-specific state beyond slug and expected path.
- `generateWorkspaceFile()` is safe to call at any time (idempotent, preserves existing settings).
- Health checks are cheap enough to run on every workspace-detail load and on each manual/automatic refresh cycle.

## Constraints

- All relative TypeScript imports must use `.js` extensions (Node16 ESM).
- `checkWorkspaceHealth()` must be side-effect-free (no filesystem writes, no mutations) — it only reads the filesystem via `fs.existsSync()`. It is not "pure" in the strict FP sense since its output depends on external disk state.
- GUI code must use `textContent` for all dynamic strings (XSS safety).
- The new `regenerate-workspace-file` endpoint must validate that the workspace folder exists before generating the file.
- The health check endpoint must not fail for uninitialized workspaces — return `healthy: true` instead (uninitialized is not a health issue, it's a setup concern).

## Out of Scope

- **Automatic background health checks** via PollingManager — health is checked on-demand in the frontend only.
- **File-watcher events** for `.code-workspace` deletion — pull-based only.
- **Workspace file staleness detection** (e.g. file references repos no longer in project) — this is a future extensibility target, not part of this plan.
- **Branch correctness checks** (e.g. repo is on wrong branch vs. expected) — future extensibility.

## Acceptance Criteria

- `GET /api/projects/:id/workspaces/:wid/health` returns a `WorkspaceHealthReport` with `healthy: boolean` and `issues: WorkspaceHealthIssue[]`.
- For an initialized workspace with no issues, `healthy` is `true` and `issues` is empty.
- When the `.code-workspace` file is deleted, the health check returns a `workspace-file-missing` issue.
- When a repository's `.git/` directory is missing, the health check returns a `repository-not-cloned` issue for that repo.
- `POST .../regenerate-workspace-file` creates the `.code-workspace` file and returns `200`.
- In workspace-detail, a health alert section appears when issues exist, with per-issue fix buttons.
- Clicking "Regenerate File" re-creates the `.code-workspace` file, dismisses the issue, and shows a success toast.
- Clicking the "Re-clone" / "Setup" fix for a missing repo triggers `POST .../setup` and updates the health section.
- In project-detail, a health status indicator appears in each initialized workspace's row.
- The ad-hoc "Retry Setup" logic in workspace-detail is refined: structural clone failures are now surfaced by the health check system, while the retry block is retained only for the transient "no status data yet" case.
- **Type audit:** `WorkspaceHealthIssue` and `WorkspaceHealthReport` interfaces match this plan specification.

## Testing Strategy

- **Unit tests** for `checkWorkspaceHealth()`: create temp directory structures with/without `.code-workspace` files and `.git/` directories, verify the returned report.
- **Integration tests** for the health endpoint: register routes, call `GET .../health`, verify response shape and correctness for healthy and unhealthy workspaces.
- **Integration tests** for `POST .../regenerate-workspace-file`: set up a workspace, delete the `.code-workspace` file, call the endpoint, verify the file is recreated.
- **Manual GUI tests:**
  1. Set up a workspace, delete the `.code-workspace` file, navigate to workspace-detail — verify health alert appears with "Regenerate" button.
  2. Click "Regenerate" — verify the file is recreated, alert disappears, toast shown.
  3. Delete a repo's `.git/` directory — verify health alert shows "repository not cloned" with fix button.
  4. Check project-detail — verify health badge shows for the affected workspace.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Adding `projectManager` to `registerWorkspaceRoutes()` breaks existing call site and tests** | Simple parameter addition. Call site in `src/server/index.ts` already has `projectManager`. Tests will need updating but the change is mechanical. |
| **Health check filesystem I/O is slow for many repos** | `existsSync` is fast for presence checks. The check runs only when a user views a specific workspace, not globally. For project-detail, health is fetched in parallel across workspaces. |
| **Overlap between "Retry Setup" and health alerts** | The retry block is narrowed to cover only the transient "no status data" case (polling lag). Structural clone failures are handled by health alerts with typed issue cards and per-issue fix buttons. Both use the same `POST .../setup` endpoint. |
| **Race condition: file re-created between health check and fix click** | Fix actions are idempotent. Regenerating an existing file updates `folders` only. Running setup on an already-cloned repo is a no-op. Post-fix health re-check confirms the issue is resolved. |
| **Future checks may need async I/O** | `checkWorkspaceHealth()` currently uses only sync `fs.existsSync()`. If future checks need async I/O, the function signature can be changed to return `Promise<WorkspaceHealthReport>` — the endpoint handler already supports async. |
