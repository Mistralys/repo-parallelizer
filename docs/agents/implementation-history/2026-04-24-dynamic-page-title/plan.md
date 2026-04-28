# Plan

## Summary

Add dynamic browser page titles to every GUI view so that each browser tab shows contextual information instead of a static "Repo Parallelizer" string. Static views (Dashboard, Repositories, Settings, Error Log) show their section name; entity-detail views show the entity's human-readable name. The workspace detail view — the primary motivation — shows `{PROJECT_NAME} {WORKSPACE_ID} - Paralizer`. A default title ("Paralizer") is set by the router before each view renders, so stale titles never carry over.

## Architectural Context

- **Router** ([gui/public/js/router.js](gui/public/js/router.js)): Hash-based SPA router. The `_render(viewFn, params)` method clears the container, runs the previous view's cleanup, then calls the matched view function. This is the single point through which every view transition passes.
- **Dashboard** ([gui/public/js/views/dashboard.js](gui/public/js/views/dashboard.js)): No route params. Fetches `api.projects.list()`. No single-entity context.
- **Repositories** ([gui/public/js/views/repositories.js](gui/public/js/views/repositories.js)): No route params. Fetches `api.repositories.list()`. No single-entity context.
- **Repository Detail** ([gui/public/js/views/repository-detail.js](gui/public/js/views/repository-detail.js)): Route param `id`. Fetches `api.repositories.get(id)` → normalised `repo` object with `repo.name`.
- **Project Detail** ([gui/public/js/views/project-detail.js](gui/public/js/views/project-detail.js)): Route param `id`. Fetches `api.projects.get(id)` → normalised `project` object with `project.name`.
- **Workspace Detail** ([gui/public/js/views/workspace-detail.js](gui/public/js/views/workspace-detail.js)): Route params `id`, `wid`. Fetches project and workspace data in a `Promise.all` call. After resolution, has `project.name` and `wid`.
- **Branch Switch** ([gui/public/js/views/branch-switch.js](gui/public/js/views/branch-switch.js)): Route params `id`, `wid`. Does **not** fetch the project object — only calls `api.branches.list()`. Has `projectId` (kebab-case slug) and `wid` from params.
- **Settings** ([gui/public/js/views/settings.js](gui/public/js/views/settings.js)): No route params. Global config only.
- **Error Log** ([gui/public/js/views/error-log.js](gui/public/js/views/error-log.js)): No route params. Aggregate view.
- **Constants** ([gui/public/js/utils/constants.js](gui/public/js/utils/constants.js)): Shared GUI constants module; currently exports `STABLE_WS_ID`.
- **HTML** ([gui/public/index.html](gui/public/index.html)): Static `<title>Repo Parallelizer</title>` — the initial page load title before the router takes over.

No views currently set `document.title`. The HTML `<title>` is the only source of the browser tab text.

## Title Format per View

| View | Route | Title Format | Example |
|------|-------|--------------|---------|
| Dashboard | `#/` | `Dashboard - Paralizer` | Dashboard - Paralizer |
| Repositories | `#/repositories` | `Repositories - Paralizer` | Repositories - Paralizer |
| Repository Detail | `#/repositories/:id` | `{repo.name} - Paralizer` | my-backend-api - Paralizer |
| Project Detail | `#/projects/:id` | `{project.name} - Paralizer` | My Project - Paralizer |
| Workspace Detail | `#/projects/:id/workspaces/:wid` | `{project.name} {wid} - Paralizer` | My Project DEV - Paralizer |
| Branch Switch | `#/projects/:id/workspaces/:wid/branch-switch` | `Branch Switch - Paralizer` | Branch Switch - Paralizer |
| Settings | `#/settings` | `Settings - Paralizer` | Settings - Paralizer |
| Error Log | `#/error-log` | `Error Log - Paralizer` | Error Log - Paralizer |

**Design notes:**
- Static views use their section name as context (e.g. `Dashboard - Paralizer`). This is more useful than a bare `Paralizer` when multiple tabs are open.
- Entity-detail views use the entity's human-readable name (fetched from the API).
- Branch Switch does not fetch project data, so it uses a static section label. Adding an API call solely for the page title is not justified.

## Approach / Architecture

Two structural changes, plus one title-setting line per view:

1. **Add `APP_NAME_SHORT` constant** to `gui/public/js/utils/constants.js` — value `'Paralizer'`. This is the canonical short app name used in page titles.

2. **Reset page title on navigation** in the router's `_render()` method. Before calling the new view function, set `document.title = APP_NAME_SHORT` (imported from constants). This ensures that stale contextual titles from the previous view are never carried forward, and provides a clean fallback during loading.

3. **Set the page title in each view:**
   - **Static views** (dashboard, repositories, settings, error-log, branch-switch): Set `document.title` synchronously at the top of the render function, before any async work.
   - **Entity-detail views** (project-detail, repository-detail, workspace-detail): Set `document.title` inside the `.then()` callback after the data fetch resolves, once the entity name is available.

## Rationale

- **Router-level reset** prevents stale titles without requiring every view to explicitly clear. Static views immediately override with their section name; entity views override after data loads.
- **Constant over inline string** ensures the short app name is consistent and easy to change.
- **Setting entity titles after data fetch** (not before) avoids flashing a partial title. The router's default "Paralizer" is shown during loading, then replaced with the full contextual title.
- **Static view titles set synchronously** because no data fetch is needed — the section name is known immediately.
- The HTML `<title>` stays as "Repo Parallelizer" (the full name) for the initial page load / bookmark fallback. The router immediately overrides it to "Paralizer" once it starts.

## Detailed Steps

1. **Add constant to `gui/public/js/utils/constants.js`:**
   - Export `APP_NAME_SHORT = 'Paralizer'`.

2. **Update `gui/public/js/router.js` — `_render()` method:**
   - Import `APP_NAME_SHORT` from `'./utils/constants.js'`.
   - At the top of `_render()`, before calling the view function, add `document.title = APP_NAME_SHORT;`.

3. **Update `gui/public/js/views/dashboard.js` — `renderDashboard()` function:**
   - Import `APP_NAME_SHORT` from `'../utils/constants.js'`.
   - At the top of `renderDashboard`, set `document.title = 'Dashboard - ' + APP_NAME_SHORT;` synchronously (before the API fetch).

4. **Update `gui/public/js/views/repositories.js` — `renderRepositories()` function:**
   - Import `APP_NAME_SHORT` from `'../utils/constants.js'`.
   - At the top of `renderRepositories`, set `document.title = 'Repositories - ' + APP_NAME_SHORT;` synchronously.

5. **Update `gui/public/js/views/repository-detail.js` — `renderRepositoryDetail()` function:**
   - Import `APP_NAME_SHORT` from `'../utils/constants.js'`.
   - Inside the `.then()` callback, after `const repo = normaliseRepo(rawRepo);`, add:
     ```js
     document.title = `${repo.name || repoId} - ${APP_NAME_SHORT}`;
     ```

6. **Update `gui/public/js/views/project-detail.js` — `renderProjectDetail()` function:**
   - Import `APP_NAME_SHORT` from `'../utils/constants.js'`.
   - Inside the `.then()` callback, after the project is normalised, add:
     ```js
     document.title = `${project.name || projectId} - ${APP_NAME_SHORT}`;
     ```
   - Note: the variable name for the normalised project is `normProject` in this view (see line 866: `const normProject = normaliseProject(project);`). Use `normProject.name`.

7. **Update `gui/public/js/views/workspace-detail.js` — `renderWorkspaceDetail()` function:**
   - Import `APP_NAME_SHORT` from `'../utils/constants.js'` (add to existing import that already imports `STABLE_WS_ID`).
   - Inside the `.then()` callback, after `const project = normaliseProject(rawProject);`, add:
     ```js
     document.title = `${project.name} ${wid} - ${APP_NAME_SHORT}`;
     ```

8. **Update `gui/public/js/views/branch-switch.js` — `renderBranchSwitch()` function:**
   - Import `APP_NAME_SHORT` from `'../utils/constants.js'`.
   - At the top of `renderBranchSwitch`, set `document.title = 'Branch Switch - ' + APP_NAME_SHORT;` synchronously (the view does not fetch project data).

9. **Update `gui/public/js/views/settings.js` — `renderSettings()` function:**
   - Import `APP_NAME_SHORT` from `'../utils/constants.js'`.
   - At the top of `renderSettings`, set `document.title = 'Settings - ' + APP_NAME_SHORT;` synchronously.

10. **Update `gui/public/js/views/error-log.js` — `renderErrorLog()` function:**
    - Import `APP_NAME_SHORT` from `'../utils/constants.js'`.
    - At the top of `renderErrorLog`, set `document.title = 'Error Log - ' + APP_NAME_SHORT;` synchronously.

11. **Update project manifest:**
    - Add `APP_NAME_SHORT` to `api-surface.md` (GUI constants section) if one exists.
    - Note the title-setting convention in `gui-frontend.md`.

## Dependencies

- None. All changes are within the existing GUI frontend codebase.

## Required Components

- `gui/public/js/utils/constants.js` — new export `APP_NAME_SHORT`
- `gui/public/js/router.js` — import constant, set default title in `_render()`
- `gui/public/js/views/dashboard.js` — import constant, set static title
- `gui/public/js/views/repositories.js` — import constant, set static title
- `gui/public/js/views/repository-detail.js` — import constant, set contextual title after data fetch
- `gui/public/js/views/project-detail.js` — import constant, set contextual title after data fetch
- `gui/public/js/views/workspace-detail.js` — import constant, set contextual title after data fetch
- `gui/public/js/views/branch-switch.js` — import constant, set static title
- `gui/public/js/views/settings.js` — import constant, set static title
- `gui/public/js/views/error-log.js` — import constant, set static title

## Assumptions

- `project.name` and `repo.name` are non-empty strings for valid entities (the normalisers fall back to `''`, but the detail views already assume the entity exists and render its name in the header).
- The short app name "Paralizer" is the preferred display name for tab titles.

## Constraints

- No build step for the frontend — all changes are vanilla JS ES modules.
- Relative imports must not introduce circular dependencies (the router imports from `utils/constants.js`, which has no imports).

## Out of Scope

- Changing the HTML `<title>` or the nav-brand text from "Repo Parallelizer" to "Paralizer".
- Adding an API call to branch-switch solely to display the project name in the title.

## Acceptance Criteria

- **Dashboard:** Tab title shows `Dashboard - Paralizer`.
- **Repositories list:** Tab title shows `Repositories - Paralizer`.
- **Repository detail:** Tab title shows `{Repo Name} - Paralizer` (e.g. `my-backend-api - Paralizer`).
- **Project detail:** Tab title shows `{Project Name} - Paralizer` (e.g. `My Project - Paralizer`).
- **Workspace detail:** Tab title shows `{Project Name} {WID} - Paralizer` (e.g. `My Project DEV - Paralizer`).
- **Branch switch:** Tab title shows `Branch Switch - Paralizer`.
- **Settings:** Tab title shows `Settings - Paralizer`.
- **Error log:** Tab title shows `Error Log - Paralizer`.
- Navigating between any two views always updates the title — no stale titles from previous views.
- During loading of entity-detail views, the tab briefly shows `Paralizer` (the router default) until the data fetch completes.

## Testing Strategy

- **Manual verification:** Navigate to every view in the GUI and confirm the browser tab title matches the expected format from the title table above. Verify that titles update correctly when navigating between views (no stale titles).
- **Multi-tab verification:** Open the same view type (e.g. two different workspace-detail views) in separate tabs — each tab should show its respective contextual title, making them distinguishable.
- **Entity-detail loading state:** Navigate directly to an entity-detail view via URL. During the loading spinner, the title should show `Paralizer`. After data loads, it should update to the contextual title.
- No automated tests are required for this change — `document.title` assignment is a side-effect with no return value, and the logic is trivial (string concatenation/interpolation).

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Import cycle if router imports from views** | The router only imports from `utils/constants.js`, which has no imports — no cycle is possible. |
| **Stale title if fetch fails** | The router resets the title to the default before the view runs. If the fetch fails, the title stays at "Paralizer", which is correct. |
| **Project name contains special characters** | `document.title` accepts arbitrary strings; no encoding is needed. |
