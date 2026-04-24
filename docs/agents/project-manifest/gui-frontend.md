# GUI Frontend

The frontend is a vanilla JavaScript SPA with no build step, served as static files by the built-in HTTP server from `gui/public/`.

## Architecture

- **Routing:** Hash-based client-side router (`#/path`) with named parameter extraction (`:id`, `:wid`).
- **Module system:** Native ES modules loaded by the browser. No bundler.
- **State management:** None — every view fetches fresh data from the REST API on render. Mutations trigger a full view re-render.
- **Styling:** Pico CSS (classless variant) as base layer, with a custom `styles.css` override layer using CSS custom properties. Light/dark theme switching via `data-theme` attribute on `<html>`.

## Router

The `Router` class (`gui/public/js/router.js`) manages view lifecycle:

1. Listens for `hashchange` events.
2. Matches the hash against registered patterns.
3. Calls the previous view's cleanup function (if returned).
4. Clears the `#app` container.
5. Calls the matched view function with `(container, params)`.
6. Stores any cleanup function returned by the view.

## Routes

| Hash Pattern | View | Description |
|---|---|---|
| `#/` | `dashboard.js` | Project listing with a filter/sort toolbar and a "Create Project" form. The toolbar (`.project-filter-toolbar`) sits between the page header and the project list and contains three labelled controls — each has a visible `<label class="filter-label">` with a `for`/`id` binding: a debounced search input (`id="project-filter-search"`, `type="search"`, ~250 ms), a repository filter `<select id="project-filter-repo">` populated from `api.repositories.list()` (always rendered; disabled with a "No repositories" placeholder when no repos exist or when the fetch fails — a toast is shown on failure), and a sort `<select id="project-filter-sort">` with `alpha` (Alphabetical, default) and `activity` (Last Activity) options. All three controls fire an `onFilterChange(FilterState)` callback on change. The current filter state (`{ search, repoId, sort }`) is maintained in `renderDashboard` and flows into `buildFilterToolbar`, `applyFiltersAndSort`, and `renderProjectGrid`. `applyFiltersAndSort(filterState, allProjects)` is a pure exported function — it receives the project list as an explicit parameter (no closure over module state) and can be unit-tested without DOM involvement. Filter changes re-apply the current state to the in-memory `_allProjects` cache without re-fetching; creating a new project re-fetches all project data from the API and re-applies the current filter/sort state. An empty-state message — "No projects match the current filters." vs "No projects yet." — distinguishes filtered-empty from truly-empty lists. |
| `#/repositories` | `repositories.js` | Repository CRUD table. Each row's **Name** column renders as a clickable `<a class="repo-name-display repo-name-link">` element linking to `#/repositories/${encodeURIComponent(repo.id)}`. Clicking Edit switches the Name cell to an inline `<input>` for in-place editing; Save/Cancel restore the link with updated or original text. |
| `#/repositories/:id` | `repository-detail.js` | Repository overview: table of every workspace across every project that contains the given repository. Each row shows Project (link to `#/projects/:pid`), Workspace (link to `#/projects/:pid/workspaces/:wid`), and the shared Branch/Status/Actions cells from `buildRepoStatusCells`. STABLE workspace rows show plain-text branch names; all other rows have a clickable branch-switch trigger. A "Refresh" button re-discovers the full project/workspace set (calls `api.projects.list()` + the full fan-out) and diffs against the existing rows: new rows are appended, removed rows are dropped, and existing rows are updated in-place via `api.status.refresh()` — protected by a `refreshInProgress` mutex. A 404 response for the repository renders a "not found" message with a link back to `#/repositories`. An empty-state message is shown when no projects contain the repository. Individual project/workspace fetch failures are handled gracefully via `Promise.allSettled` — partial results are displayed and a warning toast is shown when any fetch failed. The webserver URL is fetched once during initial load; the "Browse" button is shown only when `webserverUrl` is configured. `buildRepoStatusCells` is called with an `onError` callback (`(msg) => showToast(msg, 'error')`) so Git GUI button failures are surfaced as toasts without a dynamic `import('./toast.js')` inside the component. |
| `#/projects/:id` | `project-detail.js` | Project metadata, tabbed repo/workspace/danger-zone management. The workspace table includes a **Health** column: initialized workspaces with health issues show a warning badge with issue count; healthy and uninitialized workspaces show an empty cell. Health is fetched in parallel with status for all initialized workspaces via `Promise.allSettled` (graceful degradation — fetch failures leave the health cell empty). |
| `#/projects/:id/workspaces/:wid` | `workspace-detail.js` | Live git status with countdown-based polling and manual refresh. Health report fetched in parallel on initial load and on every poll/refresh cycle. Unhealthy workspaces render a `.health-alert` card with per-issue rows and fix buttons (`Regenerate File` for `regenerate-workspace-file` issues, `Fix Setup` for `setup-workspace` issues). The header management row includes an **"Open in VS Code"** button (shown only when `workspace.initialized` is `true`; dynamically inserted after a successful Setup without a full re-render). The repository status table has a 4th **"Actions"** column; each repository row contains a **"Browse"** button (shown only when `webserverUrl` is configured, opens `{webserverUrl}/{projectId}/{workspaceId}/{repoId}/` in a new tab via `window.open`) followed by a **"Git GUI"** button that calls `api.workspaces.launch.githubDesktop()`. The webserver URL is fetched once during the initial data load (in parallel with other requests) via `api.config.webserverUrl.get()`. In non-STABLE workspaces, each **Branch** cell is a clickable trigger (`<button class="branch-switch-trigger">`) that opens an inline quick-switch popover via `showBranchQuickSwitch()`. STABLE workspace branch cells remain plain text. `buildRepoStatusCells` is called with an `onError` callback so Git GUI button failures show as toasts. DOM clearing uses `clearElement()` from `utils/dom.js` throughout (no `innerHTML = ''` assignments). |
| `#/projects/:id/workspaces/:wid/branch-switch` | `branch-switch.js` | 3-step branch switch wizard. |
| `#/settings` | `settings.js` | Settings view with three sections: **Git Credentials** (add/delete per-host PATs), **Repositories Refresh Delay** (configurable `gitPollingIntervalSeconds`), and **Webserver URL** (base URL of the local webserver; enables the "Browse" button in the workspace-detail view). All non-credentials sections share a single **"Save Settings"** footer button that calls each section's `save()` function in parallel. |
| `#/error-log` | `error-log.js` | Paginated, filterable error log table with expandable detail rows and "Clear All" action. |

## API Client

`api.js` exports a namespaced `api` object with six groups:

- `api.repositories` — `list()`, `get(id)`, `create(data)`, `update(id, data)`, `delete(id)`
- `api.projects` — `list()`, `get(id)`, `create(data)`, `update(id, data)`, `rename(id, newId)`, `delete(id)`, `addRepository(pid, rid)`, `removeRepository(pid, rid)`
- `api.workspaces` — `list(pid)`, `get(pid, wid)`, `create(pid, data)`, `update(pid, wid, data)`, `rename(pid, wid, newId)`, `delete(pid, wid)`, `setup(pid, wid)`, `health(pid, wid)`, `regenerateFile(pid, wid)`, `launch.vscode(pid, wid)`, `launch.githubDesktop(pid, wid, rid)`
- `api.branches` — `list(pid, wid)`, `switch(pid, wid, assignments)`
- `api.status` — `get(pid, wid)`, `refresh(pid, wid)`
- `api.config.credentials` — `list()`, `set(data)`, `delete(host)`
- `api.config.polling` — `get()`, `set(seconds)`
- `api.config.webserverUrl` — `get()`, `set(url)`
- `api.errorLog` — `list(params?)`, `get(id)`, `clear()`, `count()`

### `api.workspaces` — Health & File Methods

| Method | HTTP | Description |
|---|---|---|
| `health(pid, wid)` | `GET /api/projects/:id/workspaces/:wid/health` | Fetch the health report for an initialized workspace. Returns `{ healthy: boolean, issues: Array<{ type: string, severity: string, message: string, fixAction: string, repositoryId?: string }> }`. |
| `regenerateFile(pid, wid)` | `POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file` | Regenerate the `.code-workspace` file from the current repository list without cloning. Returns `{ success: boolean }`. |

**`health()` issue `fixAction` values:**
- `regenerate-workspace-file` — missing or stale `.code-workspace` file; surface a `Regenerate File` button.
- `setup-workspace` — uncloned repository; surface a `Fix Setup` button.

### `api.workspaces.launch` — External-App Launch Methods

External-application launchers are grouped under the `api.workspaces.launch` sub-namespace. New launcher methods (e.g. "Open in Terminal") should be added here rather than as flat methods on `api.workspaces`.

| Method | HTTP | Description |
|---|---|---|
| `launch.vscode(pid, wid)` | `POST /api/projects/:id/workspaces/:wid/launch/vscode` | Open the workspace's `.code-workspace` file in VS Code. No request body. Returns `{ success: boolean }`. 400 if the workspace file does not exist on disk (run setup first). 500 on OS-level spawn failure (logged under Source: `'app-launcher'`, Operation: `'launch-vscode'`). |
| `launch.githubDesktop(pid, wid, rid)` | `POST /api/projects/:id/workspaces/:wid/launch/github-desktop/:rid` | Open a repository's local clone directory in GitHub Desktop. No request body. Returns `{ success: boolean }`. 400 if the repository directory does not exist on disk (run setup first). 500 on OS-level spawn failure (logged under Source: `'app-launcher'`, Operation: `'launch-github-desktop'`). |

**Caller contract:** All path parameters (`pid`, `wid`, `rid`) are passed through `encodeURIComponent` inside `api.js`. Callers are responsible for validating that these values are not `undefined`/`null` before invoking these methods — `encodeURIComponent` will coerce them to the strings `'undefined'`/`'null'` rather than throwing.

### `api.errorLog` Reference

| Method | HTTP | Description |
|---|---|---|
| `list(params?)` | `GET /api/error-log[?...]` | Fetch error log entries with optional filtering and pagination. |
| `get(id)` | `GET /api/error-log/:id` | Fetch a single entry by numeric ID. |
| `clear()` | `DELETE /api/error-log` | Delete all entries. Resolves with `undefined` on HTTP 204. |
| `count()` | `GET /api/error-log?limit=0` | Fetch only the total count (no entries payload). Useful for badges. |

**`list()` params shape:**

```js
api.errorLog.list({
    severity: 'error',   // optional — 'error' | 'warning'
    source:   'clone',   // optional — exact-match on Source field
    limit:    10,        // optional — max entries to return (default 100 server-side)
    offset:   0,         // optional — zero-based page offset
})
```

All params are optional. Omitting `params` entirely (or passing `undefined`) sends a bare `GET /api/error-log`.

**`clear()` 204 contract:** The underlying `request()` helper resolves with `undefined` when the server returns HTTP 204 (no body). Callers should not try to read a response value from `clear()`.

**`count()` pattern:** Sends `GET /api/error-log?limit=0`. The server returns `{ entries: [], total: N }`. Read `response.total` for the count. This is the recommended approach for polling a badge counter without transferring entry data.

### `api.config.polling` Reference

| Method | HTTP | Description |
|---|---|---|
| `get()` | `GET /api/config/polling` | Fetch the current polling interval. Resolves with `{ gitPollingIntervalSeconds: number }`. |
| `set(seconds)` | `PUT /api/config/polling` | Update the polling interval. `seconds` must be a finite integer ≥ 10. Resolves with `{ gitPollingIntervalSeconds: number }`. |

**Used by:** `settings.js` (`buildRefreshDelaySection()`) to populate the number input on mount and to persist the updated value on save.

## Reusable Components

| Component | File | Export | Purpose |
|---|---|---|---|
| Branch Quick Switch | `components/branch-quick-switch.js` | `showBranchQuickSwitch(options): Promise<{ switched: boolean, newBranch?: string }>` | Inline popover anchored below a branch cell. Fetches available branches via `api.branches.list()`, shows a filterable list with a text input, and calls `api.branches.switch()` on confirm. `options`: `{ anchorEl, projectId, wid, repoId, currentBranch }`. Dynamically imported on first click via `import()` to avoid loading for STABLE workspaces. |
| Confirm Dialog | `components/confirm-dialog.js` | `showConfirm(title, message): Promise<void>` | Modal with Cancel/Confirm. Resolves on confirm, rejects on cancel. |
| Form Helpers | `components/form-helpers.js` | `createFormField()`, `validateRequired()`, `WORKSPACE_ID_PATTERN` | Form field generation and validation. |
| Repo Status Cells | `components/repo-status-cells.js` | `buildRepoStatusCells(opts)`, `makeBranchTrigger(branchName, ariaLabel)`, `updateRepoStatusCells(row, repoId, statusInfo, isStable, onBranchCellClick)` | Shared factory for the Branch, Status badge, and Actions `<td>` cells used across repository rows. See [Repo Status Cells Component](#repo-status-cells-component) below. |
| Status Badge | `components/status-badge.js` | `createStatusBadge(gitStatusInfo): HTMLElement` | Git status badge with branch pill and detail chips. |
| Theme Toggle | `components/theme-toggle.js` | `createThemeToggle(): HTMLButtonElement` | Light/dark mode toggle button. Reads/persists theme in `localStorage`. |
| Toast | `components/toast.js` | `showToast(message, type, duration): HTMLElement\|null` | Auto-dismissing notification in `#toast-container`. Message is rendered via `textContent` (not `innerHTML`) — server-controlled strings including git error output are XSS-safe to pass directly. |

### Repo Status Cells Component

`components/repo-status-cells.js` encapsulates the reusable Branch, Status badge, and Actions cell-building logic shared between the workspace-detail and repository-detail views. It exports three named functions:

#### `buildRepoStatusCells(opts)`

Builds the three shared status `<td>` cells for a single repository row.

| Option | Type | Required | Description |
|---|---|---|---|
| `repoId` | `string` | Yes | Unique repository identifier. |
| `repoName` | `string` | Yes | Human-readable display name; used in aria-labels. Falls back to `repoId` when no richer name is available. |
| `statusInfo` | `Object\|null` | Yes | `GitStatusInfo` from the API, or `null` when no status data is available yet. |
| `projectId` | `string` | Yes | ID of the parent project. |
| `wid` | `string` | Yes | ID of the parent workspace. |
| `isStable` | `boolean` | No | When `true`, the branch cell renders as plain text (no clickable trigger). |
| `onBranchCellClick` | `function` | No | Callback `(anchorEl, repoId, currentBranch)` wired to the branch trigger button. Only active when `isStable` is falsy. |
| `webserverUrl` | `string\|null` | No | Base URL of the local webserver. When truthy, a "Browse" button is inserted before the "Git GUI" button inside `actionsCell`. |
| `onError` | `function` | No | Callback `(message: string) => void` invoked when the "Git GUI" button's click handler fails. When omitted the error is silently swallowed. Consumer views should pass `(msg) => showToast(msg, 'error')`. |

**Returns:** `{ branchCell: HTMLTableCellElement, badgeCell: HTMLTableCellElement, actionsCell: HTMLTableCellElement }`

- `branchCell` carries class `repo-branch-cell`.
- `badgeCell` carries class `repo-badge-cell`; its inner `<div data-repo-id>` wrapper is the polling target.
- `actionsCell` carries class `repo-actions-cell`; contains a "Git GUI" button (always present) and an optional "Browse" button.

#### `makeBranchTrigger(branchName, ariaLabel)`

Builds a `<button class="branch-switch-trigger">` styled as inline text. Extracted to avoid duplicating setup in both `buildRepoStatusCells` (initial render) and `updateRepoStatusCells` (polling updates). The click handler is wired by the caller.

**Returns:** `HTMLButtonElement`

#### `updateRepoStatusCells(row, repoId, statusInfo, isStable, onBranchCellClick)`

Updates an existing repository row's Branch and badge cells in-place.

| Param | Type | Description |
|---|---|---|
| `row` | `HTMLTableRowElement` | The `<tr>` to update. |
| `repoId` | `string` | Repository identifier (used to find the `div[data-repo-id]` badge wrapper). |
| `statusInfo` | `Object\|null` | New `GitStatusInfo` from the API, or `null`. |
| `isStable` | `boolean` | When `true`, the branch cell is rebuilt as plain text. |
| `onBranchCellClick` | `function` | Wired to the branch trigger button in non-STABLE workspaces. |

Cells are located by CSS class (`.repo-branch-cell`) and badge wrapper attribute (`div[data-repo-id]`) — **not** by hardcoded cell indices — so callers can prepend additional cells without breaking this function.

> **aria-label fallback:** The branch trigger button aria-label is constructed as `"Switch branch for <name>"` where `<name>` is `row.dataset.repoName` when present on the `<tr>`, falling back to `repoId` when the attribute is absent or empty.

> **Error handling:** The "Git GUI" button calls `opts.onError(message)` when provided, or silently swallows the error when `onError` is absent. The button is disabled during the async call and re-enabled in the `finally` block regardless of outcome. The previous dynamic `import('./toast.js')` inside the click handler has been removed; callers inject the error handler via the `onError` option.

---

## Utilities

| Utility | File | Export | Purpose |
|---|---|---|---|
| Normalise | `utils/normalise.js` | `normaliseRepo()`, `normaliseProject()`, `normaliseWorkspace()` | Maps PascalCase backend keys to camelCase frontend keys. `normaliseWorkspace` now includes `folderPath` (from `FolderPath` in the API response). |
| Constants | `utils/constants.js` | `STABLE_WS_ID` | Shared GUI constants. `STABLE_WS_ID = 'STABLE'` is the canonical definition; import from here instead of hardcoding the string in views. |
| DOM | `utils/dom.js` | `clearElement(el)` | DOM utility — removes all children from an element via `removeChild` loop (preferred over `innerHTML = ''`). |

## Theme Switching

The GUI supports manual light/dark mode switching:

- **Mechanism:** The `data-theme` attribute on `<html>` controls the active theme (`"light"` or `"dark"`). Pico CSS v2 reads this attribute for its base styling. The custom `styles.css` remaps all `--color-*` custom properties in a `:root[data-theme="dark"]` block.
- **Toggle:** A `createThemeToggle()` button in the top nav bar (`#theme-toggle-container`) switches between modes on click.
- **Persistence:** The selected theme is stored in `localStorage` under the key `"theme"` and restored on page load.
- **Default:** `"light"` when no stored preference exists.

## Key Patterns

### Router Injection (Avoiding Circular Dependencies)

Views that need `router.navigate()` export a `setRouter(router)` function. `app.js` calls `setRouter()` before `router.start()`. Views never import `router.js` directly.

Views using router injection: `dashboard.js`, `project-detail.js`, `workspace-detail.js`, `branch-switch.js`, `repository-detail.js`.

### Cleanup Contract

Views with side-effects (e.g. `setInterval` polling) return a synchronous cleanup function from their entry point. The router calls it before rendering the next view. The cleanup must be returned **before** any async operations, so the router can register it immediately.

Views returning cleanup: `workspace-detail.js` (clears 1-second countdown interval).

### Workspace Detail View (`workspace-detail.js`)

The workspace detail view (`#/projects/:id/workspaces/:wid`) renders live git status for all repositories in a workspace.

**Key behaviours:**

- **Initial load:** Calls `api.status.refresh()` (force-refresh via live git-fetch) instead of `api.status.get()` (cached), ensuring fresh data even when the polling cache is empty.
- **Refresh toolbar:** A `.workspace-refresh-toolbar` row between the header and the status table displays a countdown label ("Next refresh in Xs") and a "Refresh Now" button. The countdown ticks every second; when it reaches 0, an automatic poll is triggered via `api.status.get()`. The "Refresh Now" button triggers a force-refresh via `api.status.refresh()` and resets the countdown.
- **Countdown-based polling:** Replaces the previous `setInterval(fn, 10000)` approach. A 1-second `setInterval` decrements a counter. At zero it triggers `doPoll()` (cached). A `refreshInProgress` flag prevents race conditions between manual and automatic refreshes.
- **Reactive missing-repos row:** After each poll or manual refresh, the "X repositories have no data" message is re-evaluated. When all repos have status data, the row is removed. When the count changes, the text updates.
- **Setup button in-place update:** After a successful workspace setup, the DOM is mutated in-place: the setup button is removed from `mgmtRow`, an "Open in VS Code" button (`buildOpenVscodeButton`) is inserted before the Rename button, and `workspace.initialized` is set to `true` in the local variable. Only after these DOM mutations does `onSetupSuccess()` fire, triggering an immediate force-refresh and starting the countdown — no router re-render needed.
- **Retry Setup:** The retry button also triggers `doRefresh()` after a successful re-setup instead of reloading the page.
- **Per-repo quick branch switch:** In non-STABLE workspaces, each branch cell in the status table renders a `<button class="branch-switch-trigger">` (styled as inline text with a dotted underline). Clicking it expands an inline popover via `showBranchQuickSwitch()` (dynamically imported from `components/branch-quick-switch.js`), anchored below the clicked cell. The popover shows a filterable list of local branches and a text input pre-filled with the current branch; confirming calls `api.branches.switch()` with a single-entry assignment and triggers `doRefresh()`. STABLE workspace branch cells are plain text with no click behaviour. Both `buildStatusTableSection()` and the inlined polling-update loop receive `isStable` and `onBranchCellClick` parameters so polling updates preserve the clickable style.
- **Repo status cells:** The Branch, Status badge, and Actions `<td>` cells for each repository row are built and updated via `buildRepoStatusCells()` and `updateRepoStatusCells()` from `components/repo-status-cells.js`. These functions locate cells by CSS class (`.repo-branch-cell`, `div[data-repo-id]`) rather than by hardcoded cell indices, so additional cells can be prepended to a row without breaking polling updates.
- **Cleanup contract:** The returned cleanup function clears the 1-second countdown interval.

### Tabbed Navigation (Project Detail)

The project detail view organises content into three tabs: **Repositories**, **Workspaces**, and **Danger Zone**. Tabs are implemented with `.tab-nav` / `.tab-btn` / `.tab-panel` CSS classes and ARIA `role="tablist"` / `role="tab"` / `role="tabpanel"` attributes. Switching is handled by a single delegated click listener on the tab nav container. Only one panel is visible at a time (`.tab-panel.active`).

### Error Log View (`error-log.js`)

The error log view (`#/error-log`) renders a paginated, filterable table of error log entries fetched from `GET /api/error-log`.

**Key behaviours:**

- **Filter bar:** Severity (`all` / `error` / `warning`) and Source dropdowns re-fetch entries on change via `api.errorLog.list()`. Source options are **fetched dynamically** from `GET /api/error-log/sources` (`api.errorLog.sources()`) on view mount and after "Clear All" — no hardcoded list. The filter bar is rebuilt after each sources fetch via `rebuildFilterBar()`.
- **Expandable detail rows:** Each data row (`<tr class="error-log-entry-row">`) is keyboard-accessible (`role="button"`, `tabindex="0"`, `aria-expanded`). Clicking or pressing Enter/Space toggles a hidden `<tr class="error-log-detail-row">` below it containing a `<pre class="error-log-detail-pre">` with the entry's `details` field.
- **Severity badges:** Rendered via `buildSeverityBadge()` using `.severity-badge .severity-error` or `.severity-badge .severity-warning` CSS classes.
- **Timestamps:** Displayed as relative time (e.g. "3 min ago") with the full ISO timestamp in the `title` tooltip. Falls back to the raw string on parse failure.
- **Clear All:** Prompts a `showConfirm()` dialog before calling `api.errorLog.clear()` (HTTP DELETE). Resets filters and reloads on success.
- **XSS safety:** All dynamic text is set via `textContent`, never `innerHTML`.
- **No router injection:** `error-log.js` does not export `setRouter()` — it never needs to navigate away programmatically.
- **No cleanup function:** `renderErrorLog` returns no cleanup — there is no polling or other side-effect to tear down.
- **Shared time utility:** `relativeTime()` is imported from `utils/time.js` (shared with `status-badge.js`'s `formatLastActivity()`).

**Nav badge:** The `#error-log-badge` span inside the "Error Log" nav link displays a live error count. `nav-badge.js` polls `api.errorLog.count()` every 30 seconds and hides the badge when the count is 0. The error-log view calls `refreshNavBadge()` after "Clear All".
