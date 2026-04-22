# Plan — Repository Overview Screen

## Summary

Add a new **Repository Overview** screen (`#/repositories/:id`) to the GUI that shows every workspace across all projects where a given repository is used. Each row displays the same branch/status/actions information as the workspace-detail repository list, with additional Project and Workspace columns for context. A shared helper component is extracted to avoid duplicating the common table-row rendering logic between this new view and `workspace-detail.js`. Repository labels on the existing Repositories list page become clickable links to this new screen.

## Architectural Context

### Existing GUI structure

- **Router:** Hash-based SPA router in `gui/public/js/router.js` with named parameter support (`:id`).
- **Route registration:** `gui/public/js/app.js` registers all routes and injects router into views that need `navigate()`.
- **Repositories list:** `gui/public/js/views/repositories.js` — table with columns ID, Name, URL, Actions. Repository labels are plain text.
- **Workspace detail:** `gui/public/js/views/workspace-detail.js` — status table with columns Repository, Branch, Status, Actions. Contains `buildRepoStatusRow()`, `updateStatusTable()`, `makeBranchTrigger()` — all currently module-private.
- **Shared components:** `gui/public/js/components/` — `status-badge.js`, `branch-quick-switch.js`, `toast.js`, etc.
- **Normalisation:** `gui/public/js/utils/normalise.js` — `normaliseRepo()`, `normaliseProject()`, `normaliseWorkspace()`.
- **API client:** `gui/public/js/api.js` — namespaced methods: `api.repositories`, `api.projects`, `api.workspaces`, `api.status`, `api.config`.

### Data model constraints

- No backend endpoint returns "which projects/workspaces use a repository". This must be composed client-side by:
  1. `GET /api/projects` → list all projects.
  2. `GET /api/projects/:id` (per project) → load full project data including `Repositories[]`.
  3. Filter to projects whose `Repositories` array includes the target repo ID.
  4. `GET /api/projects/:id/workspaces` (per matching project) → list workspaces.
  5. `GET /api/projects/:id/workspaces/:wid/status` (per initialized workspace) → get status for the specific repo.
- Scale: this is a local dev tool; the N+1 fan-out is acceptable.
- The `api.workspaces.launch.githubDesktop(pid, wid, rid)` endpoint already exists and works with arbitrary project/workspace/repo combinations.

## Approach / Architecture

### 1. Extract shared component: `components/repo-status-cells.js`

Extract the reusable parts of `buildRepoStatusRow()` from `workspace-detail.js` into a new shared component. The component exports a function that builds the **Branch**, **Status**, and **Actions** table cells for a single repository status entry. Both `workspace-detail.js` and the new `repository-detail.js` consume this helper, each prepending their own context columns (Repository name vs. Project + Workspace).

**Shared function signature:**

```js
/**
 * Build the Branch, Status, and Actions <td> cells for a repo status row.
 *
 * @param {Object} opts
 * @param {string} opts.repoId
 * @param {string} opts.repoName
 * @param {Object|null} opts.statusInfo
 * @param {string} opts.projectId
 * @param {string} opts.wid
 * @param {boolean} [opts.isStable]
 * @param {function(HTMLElement, string, string): void} [opts.onBranchCellClick]
 * @param {string|null} [opts.webserverUrl]
 * @returns {{ branchCell: HTMLTableCellElement, badgeCell: HTMLTableCellElement, actionsCell: HTMLTableCellElement }}
 */
export function buildRepoStatusCells(opts) { ... }
```

Each returned cell must carry a CSS class for identification by the shared update function: `branchCell` → `.repo-branch-cell`, `badgeCell` → `.repo-badge-cell`, `actionsCell` → `.repo-actions-cell`. The badge wrapper `<div>` inside `badgeCell` must retain the existing `data-repo-id` attribute used by polling.

Also export:
- `makeBranchTrigger(branchName, ariaLabel)` — the branch switch trigger button builder.
- `updateRepoStatusCells(row, statusInfo, isStable, onBranchCellClick)` — in-place update of branch + badge cells within an existing `<tr>`. Locates cells via the `.repo-branch-cell` / `.repo-badge-cell` CSS classes (not positional index), so it works regardless of column count in the consuming view. Used by polling updates.

### 2. New view: `views/repository-detail.js`

A new view registered at `#/repositories/:id`. No polling — manual "Refresh" button only (polling all workspaces across all projects would be too expensive).

**Data loading flow:**
1. Fetch repository details via `api.repositories.get(id)`.
2. Fetch all projects via `api.projects.list()`.
3. For each project, fetch full data via `api.projects.get(pid)`, filter to those containing this repo.
4. For each matching project, fetch workspaces via `api.workspaces.list(pid)`.
5. For each initialized workspace, fetch status via `api.status.get(pid, wid)`, extract the single repo's status.
6. Fetch `webserverUrl` config once.

Steps 2–5 are parallelised where possible using `Promise.allSettled` (not `Promise.all`) so that individual project or workspace fetch failures do not abort the entire load. Failed fetches are silently skipped — the corresponding rows are omitted from the table. If all fetches fail, the empty state message is shown. A `showToast('Some data could not be loaded', 'warning')` is displayed when at least one fetch failed but others succeeded, so the user knows the table may be incomplete.

**Table columns:** Project, Workspace, Branch, Status, Actions.

- **Project** cell: clickable link to `#/projects/:pid`.
- **Workspace** cell: clickable link to `#/projects/:pid/workspaces/:wid`. Shows workspace ID. Renders `(not initialized)` badge for uninitialized workspaces.
- **Branch** / **Status** / **Actions** cells: rendered via the shared `buildRepoStatusCells()` helper for initialized workspaces. For uninitialized workspaces, these three cells are rendered empty (no branch trigger, no status badge, no action buttons) — the `(not initialized)` badge in the Workspace cell provides sufficient context.

**Header section:** Repository name, ID, URL (as external link), and a back link to `#/repositories`.

**Refresh button:** A "Refresh" button in the header that re-fetches all status data (using `api.status.refresh` for force-refresh) and updates the table in-place.

**Router injection:** Exports `setRouter(router)` for the Project/Workspace navigation links.

### 3. Modify `repositories.js` — clickable labels

Change the Name display span (`nameSpan`, currently a plain `<span>`) to an `<a>` element linking to `#/repositories/${encodeURIComponent(repo.id)}`. The link is only visible in read mode; when the Edit button is clicked, the span is hidden and the `<input>` is shown — no conflict. The ID cell remains plain text.

### 4. Register new route in `app.js`

```js
import { renderRepositoryDetail, setRouter as setRepositoryDetailRouter } from './views/repository-detail.js';

setRepositoryDetailRouter(router);
router.register('#/repositories/:id', renderRepositoryDetail);
```

Route ordering: `#/repositories/:id` must be registered **after** `#/repositories` to avoid the parameterised route matching the literal path. (The router tries routes in registration order and stops at first match.)

### 5. Refactor `workspace-detail.js`

- Import `buildRepoStatusCells`, `makeBranchTrigger`, `updateRepoStatusCells` from `components/repo-status-cells.js`.
- Remove the duplicated local implementations.
- `buildRepoStatusRow()` constructs only the Repository name cell, then appends the cells from `buildRepoStatusCells()`.
- `updateStatusTable()` delegates to `updateRepoStatusCells()` for the branch + badge update.

## Rationale

- **Shared component over full shared table:** The two views have different column schemas (Repository vs. Project+Workspace) and different lifecycle models (polling vs. manual refresh). Sharing only the common cells keeps each view in control of its own layout and lifecycle, avoiding a complex abstraction.
- **No new backend endpoint:** The client-side composition approach avoids backend changes for a pure GUI feature. The local-tool context makes the fan-out acceptable.
- **No polling in repository overview:** Polling status for all workspaces across all projects would generate O(projects × workspaces) requests every interval. A manual refresh button keeps the feature simple and efficient.
- **Name cell as navigation anchor:** The name cell is a passive display span in read mode — the inline edit is toggled only by the explicit "Edit" button. Making the name a clickable link has no conflict. The name is the user-facing label and the natural link target.

## Detailed Steps

1. **Create `gui/public/js/components/repo-status-cells.js`**
   - Move `makeBranchTrigger()` from `workspace-detail.js`.
   - Create `buildRepoStatusCells()` — extracts the Branch cell, Status badge cell, and Actions cell (Git GUI + Browse) construction from `buildRepoStatusRow()`. Each returned cell must have a CSS class (`.repo-branch-cell`, `.repo-badge-cell`, `.repo-actions-cell`) so the update function can locate them by class rather than positional index.
   - Create `updateRepoStatusCells(row, statusInfo, isStable, onBranchCellClick)` — extracts the branch + badge in-place update logic from `updateStatusTable()`. Uses `.repo-branch-cell` / `.repo-badge-cell` class selectors to find the target cells within the row.
   - Import `createStatusBadge` from `status-badge.js` and `api` from `api.js`.

2. **Refactor `gui/public/js/views/workspace-detail.js`**
   - Import `buildRepoStatusCells`, `makeBranchTrigger`, `updateRepoStatusCells` from `../components/repo-status-cells.js`.
   - Remove local `makeBranchTrigger()` function.
   - Refactor `buildRepoStatusRow()` to build only the repo name/ID `<td>`, then call `buildRepoStatusCells()` for the remaining cells and append them.
   - Refactor `updateStatusTable()` to call `updateRepoStatusCells()` for each row.
   - Verify the `data-repo-id` attribute on `<tr>` and badge wrapper `<div>` is preserved (polling depends on it).

3. **Create `gui/public/js/views/repository-detail.js`**
   - Implement the view function `renderRepositoryDetail(container, params)`.
   - Export `setRouter(router)`.
   - Data loading: parallel fetch of repo details, all projects, webserver URL config.
   - Filter projects to those containing the repo, fetch their workspaces and statuses.
   - Render header: back link, repo name/ID, URL.
   - Render table: Project, Workspace, Branch, Status, Actions columns.
   - Render "Refresh" button that re-fetches all status data and updates in-place.
   - Use `buildRepoStatusCells()` for Branch/Status/Actions.
   - Handle empty state when no projects use this repository.
   - Handle partial-failure state: use `Promise.allSettled` for all fan-out fetches; omit failed rows and show a warning toast when at least one fetch failed.
   - Render uninitialized workspace rows with empty Branch/Status/Actions cells (pass `null` statusInfo to `buildRepoStatusCells()`, or skip the helper and create three empty `<td>` elements).

4. **Modify `gui/public/js/views/repositories.js`**
   - Change the Name display span (`nameSpan`) from a plain `<span>` to an `<a>` element linking to `#/repositories/${encodeURIComponent(repo.id)}`. The link is only visible in read mode; when the Edit button is clicked, the span is hidden and the `<input>` is shown — no conflict.
   - Import nothing new — the link is a plain `<a href="...">` (no router injection needed since it's a hash link the browser will handle natively).

5. **Update `gui/public/js/app.js`**
   - Import `renderRepositoryDetail` and `setRouter as setRepositoryDetailRouter` from `./views/repository-detail.js`.
   - Call `setRepositoryDetailRouter(router)`.
   - Register `router.register('#/repositories/:id', renderRepositoryDetail)` **after** `router.register('#/repositories', renderRepositories)`.

6. **Update documentation**
   - `docs/agents/project-manifest/gui-frontend.md`: Add the new route, document the new view and shared component.
   - `.context/project-folder-structure.md`: Re-run `ctx generate` to reflect new files.

## Dependencies

- `gui/public/js/components/status-badge.js` — `createStatusBadge()` (existing).
- `gui/public/js/components/branch-quick-switch.js` — `showBranchQuickSwitch()` (existing, dynamically imported).
- `gui/public/js/api.js` — `api.repositories.get()`, `api.projects.list()`, `api.projects.get()`, `api.workspaces.list()`, `api.status.get()`, `api.status.refresh()`, `api.workspaces.launch.githubDesktop()`, `api.config.webserverUrl.get()` (all existing).
- `gui/public/js/utils/normalise.js` — `normaliseRepo()`, `normaliseProject()`, `normaliseWorkspace()` (existing).
- `gui/public/js/components/toast.js` — `showToast()` (existing).

## Required Components

### New files
- `gui/public/js/components/repo-status-cells.js` — shared table cell builder.
- `gui/public/js/views/repository-detail.js` — repository overview view.

### Modified files
- `gui/public/js/views/workspace-detail.js` — refactored to use shared component.
- `gui/public/js/views/repositories.js` — clickable repo Name links.
- `gui/public/js/app.js` — new route registration + router injection.
- `docs/agents/project-manifest/gui-frontend.md` — document new route, view, component.

## Assumptions

- The number of projects and workspaces is small enough that client-side fan-out is acceptable (local dev tool).
- The repository overview does not need live polling; a manual refresh button is sufficient.
- Branch quick-switch should work on the repository overview screen for non-STABLE workspaces (same behaviour as workspace-detail).
- The existing `api.workspaces.launch.githubDesktop(pid, wid, rid)` endpoint works correctly when called from any context.

## Constraints

- **Node16 ESM:** All new `.js` files in `gui/public/js/` use native ES module syntax (`import`/`export`). No relative import extension needed for browser-native ESM (unlike the backend).
- **No build step:** The frontend has no bundler — files are served directly.
- **Router injection pattern:** The new view must follow the `setRouter()` / `_router` null-guard pattern established by `dashboard.js`, `project-detail.js`, `workspace-detail.js`, and `branch-switch.js`.
- **XSS safety:** All dynamic text set via `textContent`, never `innerHTML`.
- **Cleanup contract:** The new view does not need a cleanup function (no polling intervals), but if a manual refresh is in-flight when navigating away, it should be safely ignored (use `container.isConnected` guard).

## Out of Scope

- **New backend endpoint** for "repositories used by" — the client-side composition approach is sufficient.
- **Live polling** on the repository overview screen.
- **Inline editing** of repository metadata on the overview screen (already available on `#/repositories`).
- **Search/filter** on the repository overview table (can be added later).
- **Tests** for the shared component using jsdom (deferred to a follow-up if desired).

## Acceptance Criteria

- Clicking a repository name on the `#/repositories` page navigates to `#/repositories/:id`.
- The `#/repositories/:id` view loads and displays a table of all workspaces (across all projects) that contain this repository.
- Each row shows: Project (clickable link), Workspace (clickable link), Branch, Status badge, Actions (Git GUI + optional Browse).
- Branch quick-switch works for non-STABLE workspace rows.
- The "Refresh" button re-fetches all status data and updates the table in-place.
- An empty state message is shown when no projects use this repository.
- The `workspace-detail.js` view continues to work identically after the refactor to use the shared component.
- Back navigation from the repository overview returns to `#/repositories`.
- No regressions in existing views.

## Testing Strategy

- **Manual testing:** Navigate through the repositories list → repository detail → back. Verify table data, links, Git GUI button, branch quick-switch, refresh button, and empty states.
- **Regression testing:** Verify workspace-detail view behaviour is unchanged after the refactor — polling updates, branch switching, Git GUI, Browse buttons.
- **Edge cases:** Repository with no projects, repository in multiple projects with different workspace counts, uninitialized workspaces (no status data).
- **Build verification:** Run `tsc` (build) — no TypeScript compilation involved for GUI JS files, but ensures no backend breakage.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **N+1 API requests on initial load** may feel slow with many projects | Parallelise all fetches with `Promise.all`; show a loading spinner during the fan-out. Future optimisation: add a backend endpoint if needed. |
| **Refactoring `workspace-detail.js` may break polling updates** | Preserve all `data-repo-id` attributes and cell ordering. Manually verify countdown-based polling and in-place badge updates after refactor. |
| **Route ordering conflict between `#/repositories` and `#/repositories/:id`** | Register the literal route before the parameterised route in `app.js`. The router matches in registration order and stops at first match. |
| **Branch quick-switch in repository overview may need different context** | The existing `showBranchQuickSwitch` component accepts `{ projectId, wid, repoId, currentBranch }` — all available in the repository overview row context. No changes needed. |
