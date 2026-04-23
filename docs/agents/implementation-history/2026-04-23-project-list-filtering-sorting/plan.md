# Plan

## Summary

Add filtering and sorting capabilities to the projects list on the dashboard view (`#/`). Users will be able to filter projects by freeform search term and by repository membership, and sort them alphabetically or by last activity date. Last activity is maintained as a persisted field on project metadata, updated by the polling manager after each sweep or on-demand workspace refresh using post-processing of the in-memory cache — the sweep loop itself remains untouched.

## Research Findings Applied

This plan incorporates findings from the research report `docs/agents/research/2026-04-23-project-list-filtering-sorting.md`, which evaluated four patterns for `LastActivity` sourcing. Pattern 1 (Persist on Domain Model) was selected with two key simplifications from the research:

1. **Per-project granularity** — `LastActivity` is placed on `ProjectData` rather than `ProjectWorkspace`. The dashboard only needs a per-project max for sorting; per-workspace granularity is speculative and can be added later without breaking changes.
2. **Post-processing instead of sweep refactor** — Rather than restructuring `runSweep()`'s flat repo iteration to track per-workspace grouping inline, `LastActivity` is computed as a post-processing step: after `fetchWithStagger()` completes, iterate the cache, use `extractContext()` to group entries by project, compute the max `lastActivity`, and persist. This eliminates the plan's highest-risk item.

## Architectural Context

The dashboard view lives at `gui/public/js/views/dashboard.js`. It renders project cards in a `div.project-grid` container. On load it:

1. Calls `api.projects.list()` → returns `ProjectIndexEntry[]` (`{ Id, Name }`).
2. For each project, calls `api.projects.get(id)` and `api.workspaces.list(id)` in parallel to obtain full `ProjectData` (including `Repositories[]`) and workspace counts.
3. Renders a card per project via `buildProjectCard()`.

Project data model (`src/models/project/project.types.ts`):
- `ProjectData` — full project stored at `{storageFolder}/projects/{id}.json`. Contains `Id`, `Name`, `Description`, `DateCreated`, `DateModified`, `Repositories`, `Workspaces`, `SchemaVersion`.
- `ProjectWorkspace` — workspace metadata within `ProjectData.Workspaces`. Contains `Description`, `DateCreated`, `DateModified`.
- `ProjectIndexEntry` — lightweight index entry with `Id` and `Name`.

Status refresh flow (`src/server/pollingManager.ts`):
- `PollingManager` maintains an in-memory cache (`Map<string, GitStatusInfo>`) keyed by absolute repo path.
- `refreshWorkspace(projectId, workspaceId)` fetches live status for all repos in a workspace via `fetchWithStagger()`.
- A background sweep (`runSweep()`) calls `getAllRepoPaths()` to collect all repo paths flat, then passes them to `fetchWithStagger()`.
- `GitStatusInfo.lastActivity` contains the ISO 8601 timestamp of the latest commit.
- `extractContext(repoPath, projectsFolder)` already exists at the bottom of `pollingManager.ts` — it parses `{projectsFolder}/{projectId}/{workspaceId}/{repoId}` into `{ ProjectId, WorkspaceId, RepositoryId }`.

Existing filter UI pattern: the error-log view (`gui/public/js/views/error-log.js`) uses a flex-based filter bar with `<select>` dropdowns and event-driven `onFilterChange()` callbacks. CSS class `error-log-filter-bar` provides the layout pattern.

Repository data: `api.repositories.list()` returns `Repository[]` with `{ Id, Name, Url }`.

## Approach / Architecture

### Backend: Persist `LastActivity` on project metadata

Add a `LastActivity?: string` field (ISO 8601 timestamp) to `ProjectData`. This field represents the most recent git commit activity across all workspaces and repositories of the project. It is updated by the `PollingManager` after every sweep and on-demand workspace refresh, using a post-processing step that reads from the in-memory cache — not by restructuring the fetch loop. This avoids requiring extra API calls on the dashboard — the field is already present in `ProjectData` returned by `api.projects.get(id)`.

### Frontend: Client-side filter/sort toolbar

Add a filter toolbar between the page header and the project grid in the dashboard view. The toolbar contains:

1. **Search input** — freeform text that filters project cards by matching against project name, ID, and description (case-insensitive substring match).
2. **Repository filter** — a `<select>` dropdown listing all registered repositories (plus an "All repositories" default option). When a repository is selected, only projects containing that repository are shown.
3. **Sort selector** — a `<select>` with two options: "Alphabetical" (default) and "Last Activity". Alphabetical sorts by project name (case-insensitive ascending). Last Activity sorts by `ProjectData.LastActivity` (descending; projects without activity data sort to the end).

All filtering and sorting is client-side against the already-fetched project data array. The repository list is fetched once on load to populate the dropdown.

## Rationale

- **`LastActivity` on `ProjectData`** rather than `ProjectWorkspace`: per-project granularity is all the dashboard needs for sorting. Per-workspace granularity would require the frontend to compute max across workspaces and adds unnecessary disk I/O (N writes per workspace vs. 1 write per project). Per-workspace can be added later as a non-breaking extension.
- **Post-processing approach** rather than inline sweep refactoring: the research report identified the `runSweep()` refactor as the plan's primary risk. By computing `LastActivity` after `fetchWithStagger()` completes — iterating the cache and using the existing `extractContext()` helper to group by project — the sweep loop remains completely untouched. This also applies cleanly to `refreshWorkspace()`.
- **Only-write-if-changed** optimization: `updateLastActivity()` short-circuits if the new value equals the current value, avoiding unnecessary disk I/O on most sweep cycles (activity timestamps rarely change between sweeps).
- **Null short-circuit**: when the computed max `lastActivity` is `null` (no repos have commit activity), the persist step is skipped entirely — no disk read needed.
- **PollingManager as the write site** rather than the status route handler: the polling manager already has `ProjectManager` injected, already reads project data to compute repo paths, and covers both manual refresh and background sweeps — a single code path.
- **Dedicated `updateLastActivity()` method** rather than reusing `update()`: updating `LastActivity` must NOT modify `DateModified` (which represents user-initiated metadata edits), so a separate method avoids side effects.
- **Client-side filtering/sorting** rather than server-side: the project count in a typical installation is small (tens, not thousands), making client-side filtering simpler and more responsive. No new endpoints or query parameters needed.
- **No filter state persistence**: consistent with the existing SPA pattern where views fetch fresh data on each render.

## Detailed Steps

### Backend

1. **Extend `ProjectData` interface** (`src/models/project/project.types.ts`):
   - Add `LastActivity?: string` (ISO 8601 timestamp, optional) to the `ProjectData` interface.
   - This field is NOT added to `ProjectWorkspace` — per-project granularity is sufficient.
   - No `SchemaVersion` bump is needed — `LastActivity` is an optional field with no migration required; existing project files without it will simply read as `undefined`.

2. **Add `updateLastActivity()` to `ProjectManager`** (`src/models/project/project.manager.ts`):
   - New public method: `updateLastActivity(projectId: string, lastActivity: string): void`.
   - Reads the project file, compares `project.LastActivity` with the new value. If unchanged, returns immediately (skip the write).
   - If changed, sets `project.LastActivity = lastActivity` and writes back. Does NOT update `DateModified`.
   - If the project doesn't exist, silently returns (defensive — polling may race with deletion).

3. **Add `persistLastActivity()` private helper to `PollingManager`** (`src/server/pollingManager.ts`):
   - New private method: `persistLastActivity(): void`.
   - Iterates all entries in `this.cache`, calls `extractContext()` on each key to get `{ ProjectId }`.
   - Groups entries by `ProjectId`, computes the max `GitStatusInfo.lastActivity` per project (ignoring `null` values).
   - For each project with a non-null max, calls `this.projectManager.updateLastActivity(projectId, maxLastActivity)`.
   - This method does NOT touch the sweep loop — it reads from the cache that `fetchWithStagger()` already populated.

4. **Call `persistLastActivity()` from `runSweep()` and `refreshWorkspace()`** (`src/server/pollingManager.ts`):
   - In `runSweep()`: call `this.persistLastActivity()` after `await this.fetchWithStagger(repoPaths)` completes. The sweep loop itself is not restructured.
   - In `refreshWorkspace()`: call `this.persistLastActivity()` after `await this.fetchWithStagger(repoPaths)` completes. This ensures on-demand refreshes also update the project-level timestamp.
   - **Efficiency note:** `persistLastActivity()` iterates the entire cache, so after a single workspace refresh it recomputes `LastActivity` for every polled project — not just the affected one. This is an acceptable trade-off: the cache is small (in-memory map iteration), `updateLastActivity()` short-circuits unchanged values (no disk write), and scoping to a single project would add complexity for negligible gain.

5. **Update unit tests**:
   - `src/tests/project.manager.test.ts`: Add test for `updateLastActivity()` — verifies the field is set, `DateModified` is unchanged, nonexistent project silently returns, and unchanged value skips the write.
   - `src/server/__tests__/pollingManager.test.ts`: Verify that `persistLastActivity()` is called after sweep and refresh, and that `updateLastActivity()` receives the correct max timestamp.

### Frontend

6. **Fetch repository list in dashboard** (`gui/public/js/views/dashboard.js`):
   - In `renderDashboard()`, fetch `api.repositories.list()` in parallel with the initial project list load.
   - Pass the repository list to the new filter toolbar builder.
   - **Error handling:** If `api.repositories.list()` fails, render the toolbar without the repository filter dropdown (search and sort remain functional). Show a toast with the error message so the user is aware.

7. **Build the filter/sort toolbar** (`gui/public/js/views/dashboard.js`):
   - New internal function `buildFilterToolbar(repositories, onFilterChange)` that creates the toolbar DOM:
     - **Search input**: `<input type="search" class="form-input" placeholder="Search projects…">` with `input` event listener (debounced ~250ms).
     - **Repository filter**: `<select class="form-select">` with a default "All repositories" option (`value` = `''`) followed by one option per repository (`value` = repo ID, label = repo Name). Use `change` event listener.
     - **Sort selector**: `<select class="form-select">` with options "Alphabetical" (value `alpha`, default) and "Last Activity" (value `activity`). Use `change` event listener.
   - All three controls fire the same `onFilterChange()` callback with the current filter/sort state.
   - Insert the toolbar between the page header and the project list container.

8. **Refactor `renderProjectList()` to support filter/sort** (`gui/public/js/views/dashboard.js`):
   - Extract data fetching from rendering: fetch all project data once and store in a module-level array of `{ project: ProjectData, wsCount: number }` objects (preserving both the full project data for filtering/sorting and the workspace count for card rendering).
   - The dashboard uses raw API responses (PascalCase keys) for project data — it does NOT use `normaliseProject()` from `utils/normalise.js`. This is consistent with the existing `buildProjectCard()` pattern which already handles both key casings inline. The `LastActivity` field is accessed as `project.LastActivity` directly.
   - New function `applyFiltersAndSort(projects, filters)` that:
     - Filters by search term (case-insensitive substring match on name, ID, description).
     - Filters by selected repository ID (project must contain the selected repo; empty value = no filter).
     - Sorts by chosen order: alphabetical (name ascending, case-insensitive; tiebreaker: project ID ascending) or last-activity (`project.LastActivity` descending; `null`/`undefined` sorts last; tiebreaker: name ascending).
     - Returns the filtered/sorted array.
   - New function `renderProjectGrid(listContainer, filteredProjects)` that clears the container and renders the cards.
   - The `onFilterChange` callback applies filters, re-renders the grid, and shows an empty-state message when no projects match ("No projects match the current filters.").

9. **Add CSS for the filter toolbar** (`gui/public/css/styles.css`):
   - New `.project-filter-toolbar` class following the same flex layout pattern as `.error-log-filter-bar` (flex, gap, flex-wrap, margin-bottom).
   - Style adjustments for the repository dropdown (appropriate min-width).
   - Style for the search input within the toolbar (auto width, appropriate min-width).
   - Filter labels using `.filter-label` pattern (font-size-sm, font-weight 500, secondary color).

10. **Update "Create Project" re-render flow**:
    - After successful project creation, re-fetch all project data (not just re-render from stale cache) and re-apply current filters.

### Manifest Updates

11. **Update `gui-frontend.md`**: Update the `#/` route description to mention the filter/sort toolbar, search, repository filter, and sort order selector.

12. **Update `api-surface.md`**: Add `updateLastActivity()` to the `ProjectManager` section and `LastActivity` to `ProjectData`.

13. **Update `rest-api.md`**: Note that `ProjectData` now includes `LastActivity` (no new endpoints).

## Dependencies

- `api.repositories.list()` — already exists, used to populate the repository filter dropdown.
- `api.projects.get(id)` — already called by the dashboard; `ProjectData.LastActivity` will be available once backend changes are deployed.
- `ProjectManager` — already injected into `PollingManager`.

## Required Components

### Modified Files

- `src/models/project/project.types.ts` — add `LastActivity` to `ProjectData`.
- `src/models/project/project.manager.ts` — add `updateLastActivity()`.
- `src/server/pollingManager.ts` — add `persistLastActivity()`, call it after sweep and refresh.
- `gui/public/js/views/dashboard.js` — filter toolbar, data caching, client-side filter/sort logic.
- `gui/public/css/styles.css` — filter toolbar styles.
- `docs/agents/project-manifest/gui-frontend.md` — update route description.
- `docs/agents/project-manifest/api-surface.md` — update `ProjectData` and `ProjectManager`.
- `docs/agents/project-manifest/rest-api.md` — note `LastActivity` field.

### Modified Test Files

- `src/tests/project.manager.test.ts` — test `updateLastActivity()`.
- `src/server/__tests__/pollingManager.test.ts` — test `persistLastActivity()` integration with sweep and refresh.

### No New Files

All changes are modifications to existing files.

## Assumptions

- The project count per installation is small enough (< 100) that client-side filtering and sorting is performant without pagination or server-side support.
- `LastActivity` only needs to be as fresh as the last status refresh — it is acceptable to show stale data for projects that haven't been polled recently.
- The `extractContext()` helper in `pollingManager.ts` reliably parses `{projectsFolder}/{projectId}/{workspaceId}/{repoId}` from all cache keys.

## Constraints

- `updateLastActivity()` must NOT modify `DateModified` on the project — `DateModified` is reserved for user-initiated metadata changes.
- All relative TypeScript imports must use `.js` extensions (Node16 ESM requirement).
- Frontend uses vanilla JS with ES modules — no framework, no build step.
- DOM clearing must use `clearElement()` from `utils/dom.js` (no `innerHTML = ''`).

## Out of Scope

- Server-side filtering or pagination of projects.
- Persisting filter/sort state across route navigations or sessions.
- Per-workspace `LastActivity` granularity (can be added later as a non-breaking extension to `ProjectWorkspace`).
- Adding `LastActivity` to `ProjectIndexEntry` (would optimize the list endpoint but the dashboard already fetches individual projects).
- External debounce library — the ~250ms debounce in step 7 will use a simple inline utility function, not an external dependency.
- Displaying `LastActivity` on the project card (activity is used for sorting only, not displayed on the card).
- Refactoring the existing `showLoading()` function in `dashboard.js` (which uses `innerHTML` to set a loading indicator) — this is pre-existing and unrelated to the filter/sort feature.

## Acceptance Criteria

- Freeform search input filters the project list in real-time by matching against project name, ID, and description (case-insensitive).
- Repository filter dropdown shows all registered repositories; selecting one filters the project list to only projects containing that repository.
- Sort selector toggles between alphabetical (by name, ascending) and last-activity (descending; projects without activity sort last).
- Clearing all filters restores the full project list.
- Creating a new project re-fetches data and applies current filters.
- `LastActivity` is persisted on project metadata after each sweep and on-demand workspace refresh.
- `DateModified` on the project is NOT affected by `LastActivity` updates.
- `updateLastActivity()` short-circuits without writing if the value is unchanged.
- **Type audit:** `ProjectData.LastActivity` is `string | undefined` (optional). `updateLastActivity()` signature matches the plan.

## Testing Strategy

### Backend

- **Unit test `updateLastActivity()`**: Verify field is written, `DateModified` unchanged, nonexistent project silently returns, and unchanged value skips the write (verify by checking `DateModified` is not bumped and/or mock `saveProject` to count calls).
- **Unit test `PollingManager`**: Verify that after `refreshWorkspace()` and `runSweep()`, `updateLastActivity()` is called with the correct max `lastActivity` per project. Verify that projects with all-null `lastActivity` values are skipped.
- **Existing tests**: Ensure all existing project and polling manager tests still pass.

### Frontend

- **Manual testing via the GUI**:
  - Search filters projects by name, ID, description.
  - Repository filter shows correct repos; selecting one filters the list.
  - Sort selector changes the order.
  - Empty state message appears when no projects match.
  - Creating a project updates the list with filters applied.
  - Navigating away and back resets filters.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Disk I/O on every poll sweep**: Writing `LastActivity` to the project JSON file on every poll cycle could be frequent. | `updateLastActivity()` short-circuits if the new value equals the current `LastActivity` — no write on most sweep cycles since commit timestamps rarely change. Additionally, null `lastActivity` skips the disk read entirely. |
| **Race between deletion and `LastActivity` write**: A project may be deleted between the sweep start and the `LastActivity` write. | `updateLastActivity()` silently returns if the project doesn't exist (defensive). |
| **`extractContext()` parsing failure**: Cache keys that don't match the expected path convention would produce empty context objects. | `extractContext()` already handles this gracefully (returns `{}`). `persistLastActivity()` skips entries where `ProjectId` is undefined. |
| **Multiple workspaces contribute to one project's `LastActivity`**: The cache may contain entries from different workspaces of the same project with different timestamps. | `persistLastActivity()` groups all cache entries by project and takes the max `lastActivity` across all of them, which is the correct per-project value. |

