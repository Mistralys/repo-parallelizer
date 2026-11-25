# GUI Frontend

The frontend is a vanilla JavaScript SPA with no build step, served as static files by the built-in HTTP server from `gui/public/`.

## Architecture

- **Routing:** Hash-based client-side router (`#/path`) with named parameter extraction (`:id`, `:wid`).
- **Module system:** Native ES modules loaded by the browser. No bundler.
- **State management:** None — every view fetches fresh data from the REST API on render. Most mutations trigger a full view re-render; however, some views perform targeted in-place DOM updates without a full re-render (e.g. `workspace-detail.js` inserts the "Open in VS Code" button and updates the status/health DOM in place on each poll cycle).
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
| `#/repositories` | `repositories.js` | Repository CRUD table. Each row's **Name** column renders as a clickable `<a class="repo-name-display repo-name-link">` element linking to `#/repositories/${encodeURIComponent(repo.id)}`. A **Description** column (`<td class="repo-description-cell">`) renders `truncateDescription(repo.description)` — the description trimmed to `DESCRIPTION_TRUNCATE_LENGTH` (60) characters with a trailing `…` when longer, full untruncated text always available via the cell's `title` attribute — or `—` when the repository has no description. Both create and edit use a single shared modal component, `showRepositoryModal({ mode, repo })` (`components/repository-modal.js`): a "+ Add Repository" button opens it in create mode (URL required, Name/ID/Description optional, ID auto-inferred from the URL when left blank), and each row's Edit button opens it in edit mode, pre-filled with the row's URL/Name/ID/Description/Credential — URL, Name, and Description are editable in edit mode, but the ID field is disabled (repository IDs cannot be renamed post-creation). The Credential field is present in both modes (previously only settable from the Repository Detail page), populated via `api.repositories.credentialOptionsForUrl(url)` and re-fetched on URL edits. A **Credential** column shows a CSS-styled badge built by `buildCredentialBadge()` from `utils/dom.js`: `.credential-badge.credential-badge--set` (green checkmark, `aria-label="Credential configured"`) when a credential is associated, or `.credential-badge.credential-badge--none` (muted dash, `aria-label="No credential configured"`) when none is set. A **Sync** column shows a view-local `buildSyncBadge()` span (`.sync-badge.sync-badge--on`/`.sync-badge--off`) reflecting the already-normalised `repo.infoSync?.enabled` — no per-row network request is made to render the list. State is never conveyed by colour alone: the badge carries visible text ("On"/"Off") in addition to its `aria-label` ("Workspace info sync enabled"/"Workspace info sync off"). |
| `#/repositories/:id` | `repository-detail.js` | Repository overview: when present, `repo.description` is rendered as a `<p class="project-meta-description text-secondary">` under the header (reusing `project-detail.js`'s existing class rather than introducing a new one), followed by a **Credential** section, a **Workspace info sync** section, and a table of every workspace across every project that contains the given repository. The Credential section (built by `buildCredentialSection(repoId, storedCredentialId)`) fetches `GET /api/repositories/:id/credential-options` asynchronously and renders a `<select>` dropdown with a "None" option plus each matching credential as `label (host)`. The sole option matching with `auto=true` (when exactly one exists) is labeled with a "(recommended match)" suffix but is never pre-selected on its own — only a stored `credentialId` pre-selects an option, so a repository with no stored credential keeps showing "None", matching the repositories list's "No credential configured" badge. Changes call `PUT /api/repositories/:id/credential` to persist the selection. The Credential section's heading (`.section-title`) carries `tabIndex = -1` so it can be scrolled to and focused programmatically — see the Workspace info sync section's `configure-credential` fix action, below. The **Workspace info sync** section (`buildRepositoryInfoSyncSection(repo, { onRepositoryChanged, onConfigureCredential })`, `views/repository-info-sync-section.js`) is mounted directly after the Credential section; `onRepositoryChanged` is `applyRepositoryUpdate()`, which mutates the already-fetched `repo` object in place (`Object.assign`) and rebuilds/swaps only the header DOM, so the workspace-table row builders keep seeing current `repo.name`/`repo.description` values without needing to be rebuilt — no full navigation. See [Repository Info Sync Section](#repository-info-sync-section) below. A **Files** section (`buildRepositoryFilesSection(repo, infoSyncStatus, { onChanged })`, `views/repository-files-section.js`, Milestone 2) is mounted directly after the Workspace info sync section, using the same `infoSyncStatus` fetched once for that section; its `onChanged` callback rebuilds the Workspace info sync section from scratch (there is no public refresh method on that M1-owned module) so a file add/update/delete updates its pending-changes list and Commit & Push availability. See [Repository Files Section](#repository-files-section) below. The workspace table rows show Project (link to `#/projects/:pid`), Workspace (link to `#/projects/:pid/workspaces/:wid`), and the shared Branch/Status/Actions cells from `buildRepoStatusCells`. STABLE workspace rows show plain-text branch names; all other rows have a clickable branch-switch trigger. A "Refresh" button re-discovers the full project/workspace set (calls `api.projects.list()` + the full fan-out) and diffs against the existing rows: new rows are appended, removed rows are dropped, and existing rows are updated in-place via `api.status.refresh()` — protected by a `refreshInProgress` mutex. A 404 response for the repository renders a "not found" message with a link back to `#/repositories`. An empty-state message is shown when no projects contain the repository. Individual project/workspace fetch failures are handled gracefully via `Promise.allSettled` — partial results are displayed and a warning toast is shown when any fetch failed. The webserver URL is fetched once during initial load; the "Browse" button is shown only when `webserverUrl` is configured. `buildRepoStatusCells` is called with an `onError` callback (`(msg) => showToast(msg, 'error')`) so Git GUI button failures are surfaced as toasts without a dynamic `import('./toast.js')` inside the component. |
| `#/projects/:id` | `project-detail.js` | Project metadata, tabbed workspace/repository/custom-files/danger-zone management. The **Custom Files** tab (after Repositories) is built by `buildCustomFilesSection()` from `project-custom-files.js` using `project.CustomFiles` from the already-fetched project; the active tab is remembered per project in a module-level `_activeTab`, so the full re-render after a mutation keeps the user on the same tab. The tab bar wraps on narrow screens. The workspace table includes a **Health** column: initialized workspaces with health issues show a warning badge with issue count; healthy and uninitialized workspaces show an empty cell. Health is fetched in parallel with status for all initialized workspaces via `Promise.allSettled` (graceful degradation — fetch failures leave the health cell empty). The project's repository table (`buildRepositoriesSection`) includes a **Credential** column built by `buildCredentialBadge()` from `utils/dom.js`: `.credential-badge.credential-badge--set` when a credential is associated, `.credential-badge.credential-badge--none` when none is set. It also has a **Role / relations** column: an inline click-to-edit cell built per row by `buildRepositoryRoleCell()` from `project-repository-roles.js` (see [Repository role cell](#repository-role-cell-viewsproject-repository-rolesjs)); `buildRepositoriesSection` takes the stored roles as a new optional trailing parameter, read from the raw `project.RepositoryRoles` because `normaliseProject()` does not carry it. |
| `#/projects/:id/workspaces/:wid` | `workspace-detail.js` | Live git status with countdown-based polling and manual refresh. Health report fetched in parallel on initial load and on every poll/refresh cycle. Unhealthy workspaces render a `.health-alert` card (via the shared `buildHealthAlert()` component, `components/health-alert.js` — see [Health Alert Component](#health-alert-component) below) with per-issue rows and fix buttons (`Regenerate File` for `regenerate-workspace-file` issues, `Fix Setup` for `setup-workspace` issues, `Configure` for `configure-credential` issues — navigates to `#/repositories`, losing the affected repository context; the user must locate the repository manually to assign a credential). The header management row includes an **"Open in VS Code"** button followed by an **"Open in Terminal"** button (both shown only when `workspace.initialized` is `true`; both dynamically inserted after a successful Setup without a full re-render — "Open in Terminal" is inserted immediately after "Open in VS Code"). The repository status table has a 4th **"Actions"** column; each repository row contains a **"Browse"** button (shown only when `webserverUrl` is configured, opens `{webserverUrl}/{projectId}/{workspaceId}/{repoId}/` in a new tab via `window.open`) followed by a **"Git GUI"** button that calls `api.workspaces.launch.githubDesktop()`. The webserver URL is fetched once during the initial data load (in parallel with other requests) via `api.config.webserverUrl.get()`. In non-STABLE workspaces, each **Branch** cell is a clickable trigger (`<button class="branch-switch-trigger">`) that opens an inline quick-switch popover via `showBranchQuickSwitch()`. STABLE workspace branch cells remain plain text. `buildRepoStatusCells` is called with an `onError` callback so Git GUI button failures show as toasts. DOM clearing uses `clearElement()` from `utils/dom.js` throughout (no `innerHTML = ''` assignments). A **Description** section and a **Notes** section (both built by the shared `buildTextFieldSection()`) are appended below the repository status table, Description first: each contains a `<textarea id="workspace-description-textarea">` / `<textarea id="workspace-notes-textarea">` pre-populated from `workspace.description` / `workspace.notes`, a 1000 ms debounced `input` listener that calls `api.workspaces.update()`, and an `aria-live="polite"` status span that shows "Saving…" / "Saved" / "Save failed." feedback. A successful Description save also updates `workspace.description` in the view's closure; the static, muted description text in the header row does not live-update. A **Workspace directives** section (`buildWorkspaceDirectivesSection(projectId, wid)`, `views/workspace-directives.js` — see [Workspace directives section](#workspace-directives-section-viewsworkspace-directivesjs) below) is appended directly below Notes; `workspace-detail.js` only imports and appends it. **Credential-error badge:** when a clone fails because no credential is configured, the view replaces the generic "No data" badge with an amber `<a class="status-badge status-badge-credential">` (built by the internal `buildMissingCredentialBadge(repoId)`) that links to `#/repositories/:id`. This badge is distinct from the `buildCredentialBadge()` span in `utils/dom.js` (`.credential-badge--set` / `.credential-badge--none`), which shows *assignment status* in the repository and project-detail lists — not a clone-failure indicator. |
| `#/projects/:id/workspaces/:wid/branch-switch` | `branch-switch.js` | 3-step branch switch wizard. |
| `#/settings` | `settings.js` | Settings view with four sections: **Git Credentials** (add, inline-edit, and delete named per-host PATs; each credential has a Label, Host, and Token; the credentials table renders columns Label / Host / Token / Actions; clicking Edit enables inline editing of Label and Token — Host is read-only; clicking Save calls `PUT /api/config/credentials` with the credential id; clicking Delete calls `DELETE /api/config/credentials/:id` with a confirmation dialog that warns about affected repositories), **Repositories Refresh Delay** (configurable `gitPollingIntervalSeconds`), **Webserver URL** (base URL of the local webserver; enables the "Browse" button in the workspace-detail view), and **Notes Display** (card height in px and column count for the notes grid, backed by `GET/PUT /api/config/notes-display`). All non-credentials sections share a single **"Save Settings"** footer button that calls each section's `save()` function in parallel via `Promise.all()`. The Notes Display section is built by `buildNotesDisplaySection()`, which uses CSS classes `notes-display-section` (section wrapper), `notes-display-input-row` (flex row for label + input + unit), `notes-display-label` (label element), `notes-display-input` (number input), and `notes-display-unit` (unit span, e.g. "px"). |
| `#/error-log` | `error-log.js` | Paginated, filterable error log table with expandable detail rows and "Clear All" action. Severity filter options: **All Severities** / **Error** / **Warning** / **Audit** / **Info**. Each option corresponds to a `.severity-{value}` CSS badge class applied to the severity column. |
| `#/notes` | `notes-collected.js` | Two-panel notes view: a left sidebar listing all workspaces grouped by collapsible project groups (workspaces with notes carry a `.has-notes` class and a blue dot indicator), and a right scrollable main panel of editable note cards. On initial load only workspaces with non-empty notes show cards. Clicking a sidebar item for a workspace with a card scrolls the main panel to it; clicking one without a card creates a new empty card and focuses the textarea. Each card header contains a clickable workspace ID link to `#/projects/:pid/workspaces/:wid`. Textareas auto-save after 1000 ms of inactivity via `api.workspaces.update()`; saving empty text removes the card and clears the sidebar indicator. A `.notes-empty-state` message is shown when no cards are present. |

> **Maintainer note — Settings sections:** `settings.js` has a module-level JSDoc block (at the top of the file) that lists all active settings sections. When adding or removing a `build*Section()` factory from `settings.js`, update that JSDoc list to keep it in sync with the route description in this table.

## API Client

`api.js` exports a namespaced `api` object with the following top-level groups:

- `api.repositories` — `list()`, `get(id)`, `create(data)`, `update(id, data)`, `delete(id)`, `touchRefreshTimestamp(id)`, `credentialOptions(id)`, `credentialOptionsForUrl(url)`, `updateCredential(id, credentialId)`
- `api.projects` — `list()`, `get(id)`, `create(data)`, `update(id, data)`, `rename(id, newId)`, `delete(id)`, `addRepository(pid, rid)`, `removeRepository(pid, rid)`, `setRepositoryRole(pid, rid, role)`, `directives.{list,create,update,remove}`
- `api.workspaces` — `list(pid)`, `get(pid, wid)`, `create(pid, data)`, `update(pid, wid, data)`, `rename(pid, wid, newId)`, `delete(pid, wid)`, `setup(pid, wid)`, `health(pid, wid)`, `regenerateFile(pid, wid)`, `launch.vscode(pid, wid)`, `launch.githubDesktop(pid, wid, rid)`, `launch.terminal(pid, wid)`, `directives.{list,create,update,remove}`
- `api.branches` — `list(pid, wid)`, `switch(pid, wid, assignments)`
- `api.status` — `get(pid, wid)`, `refresh(pid, wid)`
- `api.config.credentials` — `list()`, `add(data)`, `update(id, data)`, `remove(id)`
- `api.config.polling` — `get()`, `set(seconds)`
- `api.config.webserverUrl` — `get()`, `set(url)`
- `api.config.notesDisplay` — `get()`, `set(data)`
- `api.errorLog` — `list(params?)`, `get(id)`, `clear()`, `sources()`, `count()`
- `api.notes` — `list()`
- `api.version` — `get()`

### `api.repositories` — Credential Methods

| Method | HTTP | Description |
|---|---|---|
| `credentialOptions(id)` | `GET /api/repositories/:id/credential-options` | Fetch credentials compatible with the repository's URL hostname. Returns an array of `{ credentialId, label, host, auto }` objects. An empty array is returned when no credentials match or the URL is non-HTTPS (e.g. SSH). |
| `credentialOptionsForUrl(url)` | `GET /api/repositories/credential-options?url=` | Fetch credentials compatible with an arbitrary (not-yet-registered or in-edit) URL's hostname, without requiring an existing repository. Transforms the server's `{ credentials, autoSelected }` response into the same flat `{ credentialId, label, host, auto }[]` array as `credentialOptions(id)`. Used by the create/edit repository modal. |
| `updateCredential(id, credentialId)` | `PUT /api/repositories/:id/credential` | Associate a credential with the repository, or clear the association. Pass `''` (empty string) to clear — the client normalizes it to `null` before sending, which is what the server expects. Returns the updated repository object. |

**`updateCredential` caller contract:** `credentialId` must always be a `string`. Passing `undefined` causes `JSON.stringify` to silently strip the key from the request body, producing an empty `{}` payload instead of `{ credentialId: null }`. Always pass `''` when the intent is to clear the association — the client converts it to `null` internally.

**`credentialOptions` auto-match semantics:** Each returned option includes an `auto` boolean, `true` only on the sole entry when exactly one credential matches the host. The GUI never pre-selects on `auto` alone — it only labels that option with a `(recommended match)` suffix (same wording in both the create/edit modal and the repository detail page's Credential section). Only a stored `CredentialId`/`credentialId` pre-selects an option; a repository with none stored always shows "None" selected, regardless of how many (if any) options are auto-matched.

---

### `api.workspaces` — Health & File Methods

| Method | HTTP | Description |
|---|---|---|
| `health(pid, wid)` | `GET /api/projects/:id/workspaces/:wid/health` | Fetch the health report for an initialized workspace. Returns `{ healthy: boolean, issues: Array<{ type: string, severity: string, message: string, fixAction: string, repositoryId?: string }> }`. |
| `regenerateFile(pid, wid)` | `POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file` | Regenerate the workspace's full artefact set (the `.code-workspace` file and the three generated index files) from the current repository list, without cloning. Returns `{ success: boolean }`. |

**`health()` issue `fixAction` values:**
- `regenerate-workspace-file` — missing or stale `.code-workspace` file, or a missing generated index file (`workspace-index-missing`); surface a `Regenerate Files` button (relabelled from `Regenerate File`). `POST .../regenerate-workspace-file` now regenerates the full artefact set (`.code-workspace` plus all three index files), so the relabel matches the endpoint's actual behaviour.
- `setup-workspace` — uncloned repository; surface a `Fix Setup` button.
- `none` — a hand-authored (unmanaged) index file (`workspace-index-unmanaged`); no automated fix is offered, so the issue renders as a message row with no button.

### `api.projects.setRepositoryRole` — Repository Role Method

`api.projects.setRepositoryRole(projectId, repoId, role)` sets (or, with empty text, clears) a repository's `Role / relations` text within a project. It issues `PUT /api/projects/:id/repositories/:repoId/role` with body `{ role }` (path segments `encodeURIComponent`-encoded) and resolves to `{ role }`, the stored, server-normalised text. Used by the repository table's role cell.

### `api.projects.directives` / `api.workspaces.directives` — Agent Directive Methods

Owner-defined agent directives, rendered into the generated `AGENTS.md`. Request bodies are `{ text }`; responses use the stored PascalCase shape (`{ Id, Text }`). The server re-renders the generated files after every mutation. Path segments are `encodeURIComponent`-encoded.

| Method | Scope | Description |
|---|---|---|
| `api.projects.directives.list(pid)` / `create(pid, text)` / `update(pid, directiveId, text)` / `remove(pid, directiveId)` | project-wide (every workspace) | `GET`/`POST` `/api/projects/:id/directives`, `PUT`/`DELETE` `/api/projects/:id/directives/:directiveId`. `create` returns the created directive (HTTP 201). |
| `api.workspaces.directives.list(pid, wid)` / `create(pid, wid, text)` / `update(pid, wid, directiveId, text)` / `remove(pid, wid, directiveId)` | one workspace | Same shapes under `/api/projects/:id/workspaces/:wid/directives`. |

> **Naming:** deletion is `remove` here (like `api.repositories.files` and `api.config.credentials`), unlike `api.projects.customFiles.delete`.

### `api.workspaces.launch` — External-App Launch Methods

External-application launchers are grouped under the `api.workspaces.launch` sub-namespace. New launcher methods should be added here rather than as flat methods on `api.workspaces`.

| Method | HTTP | Description |
|---|---|---|
| `launch.vscode(pid, wid)` | `POST /api/projects/:id/workspaces/:wid/launch/vscode` | Open the workspace's `.code-workspace` file in VS Code. No request body. Returns `{ success: boolean }`. 400 if the workspace file does not exist on disk (run setup first). 500 on OS-level spawn failure (logged under Source: `'app-launcher'`, Operation: `'launch-vscode'`). |
| `launch.githubDesktop(pid, wid, rid)` | `POST /api/projects/:id/workspaces/:wid/launch/github-desktop/:rid` | Open a repository's local clone directory in GitHub Desktop. No request body. Returns `{ success: boolean }`. 400 if the repository directory does not exist on disk (run setup first). 500 on OS-level spawn failure (logged under Source: `'app-launcher'`, Operation: `'launch-github-desktop'`). |
| `launch.terminal(pid, wid)` | `POST /api/projects/:id/workspaces/:wid/launch/terminal` | Open the workspace's root folder in a native terminal window. No request body. Returns `{ success: boolean }`. 400 if the workspace's on-disk root folder does not exist (run setup first). 500 on OS-level spawn failure (logged under Source: `'app-launcher'`, Operation: `'launch-terminal'`). |

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
    severity: 'error',   // optional — 'error' | 'warning' | 'audit' | 'info'
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
| Confirm Dialog | `components/confirm-dialog.js` | `showConfirm(title, message): Promise<void>` | Modal with Cancel/Confirm. Resolves on confirm, rejects on cancel. Built on the shared `modal-shell.js` primitive (overlay/modal/ARIA DOM, Escape/backdrop-cancel, focus trap, focus restoration); `showConfirm()` supplies its own body/actions content and passes `confirmBtn` as the initial-focus target. |
| File Definition Table & Editor | `components/file-definition-editor.js` | `buildFileDefinitionTable(options): HTMLElement`, `buildFileDefinitionEditor(options): HTMLFormElement` | Callback-driven table and add/edit form for a file definition (label/directory/file name/description/content + "List in AGENTS.md"), extracted from the project Custom Files tab so a second consumer (a repository-level files section) can reuse them without duplicating the form. Neither function binds to a project/repository or calls an API directly — see [File Definition Table & Editor](#file-definition-table--editor-component) below. |
| Form Helpers | `components/form-helpers.js` | `createFormField()`, `validateRequired()`, `WORKSPACE_ID_PATTERN` | Form field generation and validation. |
| Health Alert | `components/health-alert.js` | `buildHealthAlert(report, { title?, actions? }): HTMLElement\|null` | Renders a `HealthReport` as a `.health-alert` card with one `.health-alert-issue` row per issue; returns `null` for an absent/healthy/empty report. See [Health Alert Component](#health-alert-component) below. |
| Info Commit Dialog | `components/info-commit-dialog.js` | `showInfoCommitDialog({ repoId, pendingFiles?, defaultMessage? }): Promise<string\|null>` | Confirms **and performs** the "Commit & Push" action for a repository's managed `.workspace/info.json` clone. Built on `modal-shell.js` with `className: 'modal--form'`. See [Info Commit Dialog Component](#info-commit-dialog-component) below. |
| Modal Shell | `components/modal-shell.js` | `createModalShell(options): { overlay, modal, mount(initialFocusEl?), close(), setBusy(busy) }` | Shared overlay/modal DOM construction, Escape/backdrop-cancel wiring, Tab/Shift+Tab focus trap, focus restoration, and busy-gating primitive. `options`: `{ titleText, ariaLabelledbyId, ariaDescribedbyId?, className?, onCancel }`. Callers append their own body/actions content to `modal`, then call `mount()`/`close()`. Used by `confirm-dialog.js`, `repository-modal.js`, `repository-info-import-modal.js`, and `info-commit-dialog.js`. |
| Repo Status Cells | `components/repo-status-cells.js` | `buildRepoStatusCells(opts)`, `makeBranchTrigger(branchName, ariaLabel)`, `updateRepoStatusCells(row, repoId, statusInfo, isStable, onBranchCellClick)` | Shared factory for the Branch, Status badge, and Actions `<td>` cells used across repository rows. See [Repo Status Cells Component](#repo-status-cells-component) below. |
| Repository Info Import Modal | `components/repository-info-import-modal.js` | `showRepositoryInfoImportModal({ repoId, repoName?, preview }): Promise<{ applied: boolean }>` | Per-field diff/choice modal offered when a repository's managed `.workspace/info.json` differs from Paralizer's own data (`incoming`/`conflict` states). Built on `modal-shell.js` with `className: 'modal--form'`. See [Repository Info Import Modal Component](#repository-info-import-modal-component) below. |
| Repository Modal | `components/repository-modal.js` | `showRepositoryModal({ mode, repo }): Promise<Repository>` | Create/edit modal for a repository (URL, Name, ID, Description, Credential). Built on `modal-shell.js` with `className: 'modal--form'`. See [Repository Modal Component](#repository-modal-component) below. |
| Status Badge | `components/status-badge.js` | `createStatusBadge(gitStatusInfo): HTMLElement` | Git status badge with branch pill and detail chips. |
| Theme Toggle | `components/theme-toggle.js` | `createThemeToggle(): HTMLButtonElement` | Light/dark mode toggle button. Reads/persists theme in `localStorage`. |
| Toast | `components/toast.js` | `showToast(message, type, duration): HTMLElement\|null` | Auto-dismissing notification in `#toast-container`. Message is rendered via `textContent` (not `innerHTML`) — server-controlled strings including git error output are XSS-safe to pass directly. |

### Health Alert Component

`components/health-alert.js` exports `buildHealthAlert(report, options)`, extracted from `workspace-detail.js`'s formerly-private `buildHealthAlertSection()` if-chain so a second health-reporting view (the repository info-sync section) can reuse the same rendering without duplicating markup or the fix-action dispatch.

- **`report`**: a `HealthReport` (`{ healthy: boolean, issues: Array<{ type, severity, message, fixAction, repositoryId? }> }`) or `null`. Returns `null` when the report is absent, `healthy`, or has no issues — the caller should skip appending anything in that case.
- **`options.title`**: heading text shown above the issue rows. Defaults to `'Workspace health issues detected'`.
- **`options.actions`**: a registry mapping a `fixAction` string to `{ label, loadingLabel?, onClick(issue) }`. This replaces the growing if-chain the original `workspace-detail.js` dispatcher used — a caller adds one registry entry per fix action rather than a new branch. An issue whose `fixAction` has no matching entry (including the explicit `'none'` sentinel, or any `fixAction` the caller does not recognise) renders as a message-only row with no button.
- `onClick(issue)` may return a `Promise`; the button is disabled and its label swapped to `loadingLabel` (falling back to `label`) for the duration, then restored.
- Markup and CSS classes (`.health-alert`, `.health-alert-title`, `.health-alert-issue`, `__message`, `__action`) are unchanged from the original `workspace-detail.js` implementation. No `innerHTML` assignment is used.

`workspace-detail.js`'s `buildHealthAlertSection()` now calls `buildHealthAlert()` with a three-entry `actions` registry (`regenerate-workspace-file`, `setup-workspace`, `configure-credential`) reproducing its three original fix buttons — see the `workspace-detail.js` row in the Views table, above.

> **Resolved latent risk (Milestone 2, this plan's cross-cutting WP):** `buildActionCell()`'s click handler now wraps the awaited `onClick(issue)` call in a `catch` (logging via `console.error`, no new import) ahead of the existing `finally` that re-enables the button and restores its label — a rejecting `onClick` (including the repository info-sync section's lengthened `import` → `discard`-confirmation → apply chain) no longer raises an unhandled promise rejection. This closes the gap previously carried forward from WP-011's QA/code-review, where only `workspace-detail.js`'s callers caught internally and a new caller had to do the same; a caller may still catch internally for its own purposes, but the component itself is now the safety net.

### File Definition Table & Editor Component

`components/file-definition-editor.js` exports `buildFileDefinitionTable(options)` and `buildFileDefinitionEditor(options)`, extracted from the project Custom Files tab's formerly-private `buildFileTable()`/`buildEditorForm()` so a second consumer (a repository-level files section) can reuse the same table/form without duplicating markup, Tab-key handling, dirty-change tracking, or accessibility wiring. Both operate on the *normalised* (camelCase) file shape used by the views (`normaliseCustomFile()` in `views/project-custom-files.js` bridges from the PascalCase API shape) and are purely callback-driven — neither binds to a project/repository ID or calls `api.*` itself; the calling view decides what "edit", "delete", and "save" mean.

- **`buildFileDefinitionTable({ files, formatPath, caption?, pathColumnHeader?, statusColumn?, onEdit, onDelete })`**: renders the scrollable `.custom-files-table-wrap`/`.custom-files-table` with Label, a path column (header text via `pathColumnHeader`, cell text via `formatPath(file)`), an optional extra `statusColumn` (`{ header, render(file), ariaLabel?(file) }` — e.g. the project view's "In AGENTS.md" column), and Actions (Edit/Delete). `onEdit(file)` fires on click; `onDelete(file)` may return a `Promise` — the row's Delete button disables for its duration and re-enables only on rejection (a resolution is assumed to be followed by the caller re-rendering or removing the row). Any confirmation dialog belongs in the `onDelete` callback, not in the table.
- **`buildFileDefinitionEditor({ file, showExecutable?, pathPrefixLabel?, computeExecutableHint?, formatPathPreview?, onSave, onDelete?, onClose })`**: the add/edit form (Label*, Directory, File name*, Description, Content with the Tab-key/Escape handling, and the "List in the workspace AGENTS.md" switch). `showExecutable` (default `false`) additionally renders a manual **"Executable"** checkbox — omitted when the executable bit is decided purely by the content/extension heuristic, as in the project view. `onSave(payload)` receives `{ label, directory, fileName, description, content, listInAgents[, executable] }` (the `executable` key is present only when `showExecutable` is `true`) and must reject with an `Error` whose `message` is shown inline on failure. Passing `onDelete` adds a Delete button to the form itself (in addition to any table-row Delete action); omitting it means the form offers no delete action of its own. `onClose()` fires after a confirmed Cancel (when dirty) or a successful in-form delete. `computeExecutableHint(fileName, content)` and `formatPathPreview(directory, fileName)` customise the live "Will be written to …" summary line; both default to no hint / a plain untidied join respectively, so a caller that wants the project view's exact tidying rules passes its own formatter (e.g. `formatCustomFilePath`).
- No `innerHTML` is used anywhere in either function (enforced by `file-definition-editor.test.mjs`). Markup/CSS classes (`.custom-files-table`, `.custom-file-form`, `.custom-file-content`, `.custom-file-switch`, `.custom-file-summary`, `.custom-file-form-error`, `.unsaved-indicator`) are unchanged from the original project-view implementation.

`views/project-custom-files.js`'s `buildFileTable()`/`buildEditorForm()` now delegate to these two functions, supplying its own project-specific `onEdit`/`onDelete`/`onSave` wiring (`api.projects.customFiles.*`, `showConfirm`, toasts) and the "In AGENTS.md" `statusColumn`; its exported API (`normaliseCustomFile`, `formatCustomFilePath`, `isExecutableHint`, `buildCustomFilesSection`) and its own section shell (busy/error state, delete confirmation, reload) are unchanged — see the Custom Files tab entry, below.

### Directive List Editor Component

`components/directive-list-editor.js` exports `buildDirectiveListEditor(options)`: an ordered list of single-paragraph directives with inline add, edit and delete. It is scope-agnostic and callback-driven (it never calls `api.*` itself), so the same component can serve project-wide and workspace-scoped directives. Options: `directives` (initial `{ Id, Text }[]`), `maxLength` (counter limit), `maxCount` (the add button is disabled at the limit), `scopeLabel` (e.g. `"project"`, used in labels and the empty state), `onCreate(text)`, `onUpdate(id, text)`, `onDelete(id)` and `reload()` (re-reads the list). After every successful mutation the editor calls `reload()` and re-renders in place, so the host view needs no re-render.

- A character counter (`n / max`) sits under the textarea; the form only blocks empty text — the server is authoritative for length, duplicates, count and generated-marker text.
- A rejected save or delete shows the server message inline (`role="alert"`) next to the control; the editor stays open.
- Delete asks for confirmation through `confirm-dialog.js`; delete results are announced via `toast.js`.
- All text is rendered through `textContent` (no `innerHTML`). Styles live in a directive section at the end of `styles.css`. Tests: `directive-list-editor.test.mjs`.

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

### Repository Modal Component

`components/repository-modal.js` exports `showRepositoryModal({ mode, repo })`, a single component serving both the "Add Repository" and "Edit Repository" flows — the two modes share all five fields (URL, Name, ID, Description, Credential), differing only in pre-fill and which fields are disabled.

| Param | Type | Description |
|---|---|---|
| `mode` | `'create'\|'edit'` | Which flow to render. |
| `repo` | `{ id, name, url, description?, credentialId? }` | Required (and only used) when `mode === 'edit'`. Supplies the pre-fill values and the baseline `credentialId` used for the unchanged-selection comparison at submit. |

**Returns:** `Promise<Repository>` — resolves with the normalised, saved repository; rejects with `Error('User cancelled')` on Cancel/Escape/backdrop-click.

**Fields:**
- **URL** — required in both modes, always editable.
- **Name** — optional in both modes, always editable.
- **ID** — editable in create mode; disabled (via `.disabled = true`, since `createFormField()` has no `disabled` option) and excluded from the edit-mode payload.
- **Description** — a `'textarea'`-type field (`createFormField('Description', 'textarea', 'description', { placeholder: 'Optional — short description.' })`), optional in both modes, pre-filled from `repo.description || ''` in edit mode. The `create()` payload omits `description` entirely when the trimmed value is blank (mirroring the optional-field pattern already used for `name`/`id`); the `update()` payload always includes `description` (even `''`), so clearing the field in edit mode persists the clear through `PUT /api/repositories/:id`.
- **Credential** — a `<select>` scaffolded with a "None" option, repopulated after every `credentialOptionsForUrl()` fetch, plus a hint `<span>` below it (hidden unless there is something to explain).

**Credential selection priority:** after each fetch, the select's value is chosen by `computeSelectedCredentialId(options, storedCredentialId)`: (1) the stored credential ID when still present among the fetched options, (2) `''` (None) otherwise. The sole option flagged `auto: true` (when exactly one exists) is never auto-selected — its label is decorated with a `(recommended match)` suffix instead, so a repository with no stored `CredentialId` always shows "None" selected, consistent with the repositories list's "No credential configured" badge. `storedCredentialId` is `repo.credentialId ?? ''` in edit mode and `''` in create mode, fixed for the lifetime of the modal instance.

**Empty-state hint:** when the fetched `options` array is empty, the hint `<span>` explains why: "Credentials can only be matched to HTTPS URLs…" when the URL's scheme isn't `https:` (mirroring the server's `extractHost()` HTTPS-only check), or "No saved credential is configured for this URL's host." otherwise. The hint is cleared when the URL is blank or `options` is non-empty.

**Fetch timing:** edit mode fetches `credentialOptionsForUrl(repo.url)` once on mount; create mode skips the initial fetch (no repository exists yet to match credentials against). In both modes, an `input` listener on the URL field debounces (~400ms) a re-fetch and rebuild of the select whenever the URL changes.

**Submit sequencing:** `validateRequired(form, ['url'])` guards the call; a single `resolvedRepo` variable is reassigned as each call succeeds. Create mode: `api.repositories.create()` → `normaliseRepo()`, then `api.repositories.updateCredential()` when a credential is selected. Edit mode: `api.repositories.update(repo.id, { name, url })` → `normaliseRepo()`, then `updateCredential()` only when the selection differs from `storedCredentialId`. A rejected `updateCredential()` call is caught independently — it shows an error toast but still resolves the Promise with the pre-credential-update `resolvedRepo`, since the primary save already succeeded. A rejected primary `create()`/`update()` call re-enables Submit/Cancel/Escape/backdrop-click, shows an error toast, and keeps the modal open without resolving/rejecting.

**Busy-gating:** while any of the three API calls is in flight, `shell.setBusy(true)` disables Escape/backdrop-cancel and the component separately disables the Submit/Cancel buttons (the shell has no knowledge of caller-specific buttons — see the Modal Shell entry above).

### Repository Info Import Modal Component

`components/repository-info-import-modal.js` exports `showRepositoryInfoImportModal({ repoId, repoName, preview })`, the per-field (and, as of Milestone 2, per-file) diff dialog offered when a repository's managed `.workspace/info.json` carries values that differ from Paralizer's own data (info-sync states `incoming` and `conflict`). Built on `modal-shell.js` with `className: 'modal--form'`.

| Param | Type | Description |
|---|---|---|
| `repoId` | `string` | Repository ID; forwarded to `api.repositories.infoSync.applyImport()`. |
| `repoName` | `string` (optional) | Shown in the modal title when present (`Import workspace info — {repoName}`), otherwise `Import workspace info`. |
| `preview` | `{ state: 'incoming'\|'conflict', fields: Array<{ field, current, incoming }>, files?: Array<{ path, kind: 'incoming-only'\|'local-only'\|'changed', changes?, problem? }> }` | The diff preview, as returned by `api.repositories.infoSync.importPreview()`. `files` (Milestone 2) is optional for backward compatibility with a pre-Milestone-2 preview payload — a missing or non-array value renders no file rows. |

**Returns:** `Promise<{ applied: boolean }>` — **always resolves, never rejects**, unlike `confirm-dialog.js`'s `showConfirm()`: `{ applied: true }` after a successful Apply, `{ applied: false }` on Cancel/Escape/backdrop-click.

**Field filtering:** only `Name` and `Description` are importable (`Url` is informational-only and never imported — see `repository-info.ts`'s `diffRepositoryInfo()`, which already excludes it server-side). The modal re-filters `preview.fields` against a literal `IMPORTABLE_FIELDS` set defensively, so a `Url` row is never rendered even if the preview payload ever carried one.

**Per-field row:** each differing field renders as a `<fieldset>`/`<legend>` naming the field, "Current"/"Incoming" value blocks (an empty value renders the placeholder `"(empty)"` rather than a blank block), and a Keep/Import radio pair. The default radio selection is `"import"` when `preview.state === 'incoming'` and `"keep"` when `preview.state === 'conflict'`; a `conflict` state also shows an explanatory paragraph above the field rows.

**Files table (Milestone 2):** when `preview.files` is non-empty, a "Files" heading and one `<fieldset>` row per `RepositoryFileDiff` render below the field rows. Each row names the path, a kind label ("Added in repository" / "Removed in repository" / "Changed"), the differing-field summary for `changed` diffs, any `problem` text, and the two radios allowed for that diff's `kind` — a literal `FILE_ACTION_CONFIG` table mirrors the server's `ALLOWED_FILE_IMPORT_ACTIONS` (`src/orchestration/repository-info.ts`) exactly: `add`/`discard` for `incoming-only`, `keep`/`delete` for `local-only`, `overwrite`/`keep` for `changed`. Defaults follow the field rows' per-state pattern: state `incoming` defaults to the action that takes the incoming side (`add`/`delete`/`overwrite`); state `conflict` defaults to the action that keeps Paralizer's own data (`discard`/`keep`/`keep`, regardless of diff kind — Open Question 7's resolution, consistent with M1's existing "keep" default for conflicting fields). A `problem` diff always defaults to, and is locked onto, its one safe action — the destructive radio is rendered but `disabled` rather than omitted, so a selection the server would reject can never be submitted.

**Apply:** sends the fields whose Import radio is checked and every file row's currently-selected action to `api.repositories.infoSync.applyImport(repoId, { fields: selectedFields, files: selectedFiles })` (WP-012's selections-object call shape) — an empty field selection (every field left on Keep) is valid and sent as `[]`, and a preview with no `files` sends `files: []`. When the current file selection contains at least one `discard` — the one destructive action, since it removes an incoming-only file from the managed clone and the next Commit & Push removes it from the repository — clicking Apply first awaits `showConfirm()` listing exactly the affected paths; cancelling (the Promise rejects) leaves the modal open with the selection untouched and sends nothing, while confirming proceeds to the `applyImport()` call. A selection with no `discard` applies directly, with no confirmation step. A failed `applyImport()` call shows the error inline in a `role="alert"` paragraph and re-enables the form; it does not close the modal.

**Double-click guard:** the Apply handler disables the button immediately on click — before the possibly-awaited discard confirmation — so a rapid double-click can send at most one `applyImport()` request even while a confirmation dialog is pending.

**Busy-gating and focus:** `shell.setBusy(true)` disables Escape/backdrop-cancel during the `applyImport()` call; the Apply/Cancel buttons are separately disabled. Initial focus lands on the first row's (field row, or file row when there are no field diffs) currently-selected radio, or is left to the shell's default when there are no differing fields or files.

**Styled by WP-014:** `.info-import-file`, `.info-import-file__kind`, `.info-import-file__changes`, `.info-import-file__problem`, and `.info-import-files-heading` gained their rule blocks in `styles.css` alongside the Repository Files section below, rather than shipping unstyled — see that section's CSS note.

### Info Commit Dialog Component

`components/info-commit-dialog.js` exports `showInfoCommitDialog({ repoId, pendingFiles, defaultMessage })`. Unlike a typical confirmation dialog, this component **performs** the "Commit & Push" action itself (calling `api.repositories.infoSync.commitPush()`) rather than just collecting a message for the caller to act on — this lets a 409 (upstream changed the info folder) or 502 (push failed, possibly with the credential write-access hint) surface inline in the dialog's own `role="alert"` region. Built on `modal-shell.js` with `className: 'modal--form'`.

| Param | Type | Description |
|---|---|---|
| `repoId` | `string` | Repository ID; forwarded to `api.repositories.infoSync.commitPush()`. |
| `pendingFiles` | `string[]` (optional) | Paths with uncommitted changes in the managed main folder, rendered as a scrollable, bounded-height list with wrapping paths. Shows "No pending files." when empty/absent. |
| `defaultMessage` | `string` (optional) | Server-suggested commit message (`InfoSyncStatus.defaultCommitMessage`) used to pre-fill the textarea. |

**Returns:** `Promise<{ message: string, result: CommitPushResult }\|null>` — resolves with the **trimmed, already-committed** message plus the `CommitPushResult` returned by `commitPush()` (`{ committed, pushed, commitSha?, filterFallback? }`) after a successful Commit & Push; resolves with `null` on Cancel/Escape/backdrop-click. Never rejects. A non-null return is the caller's signal that the commit already happened and the section's status should be re-fetched — there is no separate "apply" step. **Milestone 2:** widened from the message-only `string\|null` return so the caller can name the pushed commit SHA/branch and surface a `filterFallback` notice (see **Known gaps**, below — now resolved).

**Validation:** the commit message textarea has a live character counter (`"{n} / 500 characters"`) and inline validation (`aria-invalid`, `aria-describedby`) requiring a trimmed length of 1–500; the Commit & Push button is disabled while invalid, re-validated on every keystroke and again (defensively) at click time.

**Commit & Push:** on click, with a valid message, calls `api.repositories.infoSync.commitPush(repoId, trimmedMessage)`. A failed call (including the 409/502 write-access-hint cases) shows the error inline in a `role="alert"` paragraph, re-enables the form, and keeps the dialog open without resolving.

**Busy-gating and focus:** `shell.setBusy(true)` plus the message textarea, Commit & Push, and Cancel controls are all disabled while the request is in flight. Initial focus lands on the commit message field.

---

### Repository Info Sync Section

`views/repository-info-sync-section.js` exports `buildRepositoryInfoSyncSection(repo, { onRepositoryChanged?, onConfigureCredential? }): { element: HTMLElement, cleanup: function(): void }`, the "Workspace info sync" section on the repository detail page (mounted directly after the Credential section — see the `#/repositories/:id` row in the Routes table, above). It is a single state-machine component: the whole section body is rebuilt from scratch on every state change via one `safeRender()` entry point rather than patched in place, since the state space is small and the DOM is cheap to recreate.

**Rendered order** (top to bottom, matching the plan's step 16 spec): section heading (`<h2 class="section-title" tabIndex="-1">`, focus target for the rules below) → toggle/Save row → status block (`<dl role="status" aria-live="polite">`) → pending-files list (only when `status.pendingChanges` is non-empty) → health alert (`buildHealthAlert()`, only when unhealthy) → action row (Refresh / Import… / Commit & Push).

**Toggle/Save row:** the `role="switch"` checkbox only updates a local `pendingEnabled` value — it never calls `saveSettings` itself. The Save button is disabled unless `pendingEnabled !== status.enabled` (dirty) or a request is in flight; its label becomes "Cloning repository…" / "Removing clone…" while `saveSettings()` is in flight for an enable/disable. A help paragraph (`id="info-sync-help-{repoId}"`, tied to the checkbox via `aria-describedby`) explains that enabling creates a managed clone, writes/keeps `.workspace/info.json` in sync (recreating it if deleted), offers existing differing data for import, that committing is a separate step, and that credentials are never written to the file. A failed `saveSettings()` call re-fetches status silently (`reloadStatusSilently()`), reverts `pendingEnabled` to the re-fetched `status.enabled`, and shows the error inline in a `role="alert"` paragraph above the toggle row — it never leaves a half-saved toggle state. Disabling while `status.pendingChanges` is non-empty first calls `showConfirm()` listing the pending files; declining aborts, confirming retries `saveSettings(repoId, { enabled: false, discardPendingChanges: true })`.

**Button-enablement matrix** (`computeButtonMatrix(status, busy)`, plan step 16(b)): a `BASE_BUTTON_MATRIX` keyed by state (`disabled`, `main-folder-unavailable`, `in-sync`, `write-required`, `incoming`, `conflict`, `invalid-file`, `id-mismatch`, `unsupported-schema`) gives each of Refresh/Import/Commit a `{ hidden?, disabled?, primary?, reason? }` entry; any state missing from the matrix falls back to the `invalid-file` row. `in-sync` with a non-empty `pendingChanges` is treated as `write-required` (an already-written file with uncommitted changes in the managed clone is still hash-"in-sync" but has something to commit). While `busy` is true, every non-hidden button is forced `disabled` with the shared reason `"A request for this section is already in progress."`, overriding any state-specific reason. Each button is built by `buildReasonedButton(id, label)`, which pairs the `<button>` with a visually-hidden (`.sr-only`) reason `<span id="${id}-reason">`; `applyButtonState()` wires `title` + `aria-describedby` to that span whenever the button is disabled with a reason, and toggles `.btn-primary`/`.btn-secondary` for the `primary` flag (Import is `primary` in the `incoming`/`conflict` states).

**State labels:** `STATE_LABELS` maps all nine `InfoSyncStatus.state` values to their display text (`in-sync` → "Up to date", `write-required` → "Will be written on next sync", `incoming` → "Import available", `conflict` → "Conflict", `disabled` → "Off", `main-folder-unavailable` → "Main folder unavailable", `invalid-file` → "Invalid info file", `id-mismatch` → "Id mismatch", `unsupported-schema` → "Unsupported file version"), rendered as a `.status-pill.info-sync-state--{state}` pill — state is never conveyed by colour alone, the pill always carries the label text.

**Loading / error feedback:** before the first `status` load resolves, the body shows a `role="status"`/`aria-live="polite"` "Loading sync status…" placeholder (`section[aria-busy="true"]`); a failed initial load replaces the whole body with the error message in a `role="alert"` paragraph plus a "Retry" button that re-runs `load()`. Save/Refresh/recreate-main-folder/import-preview failures instead keep the existing body and prepend the inline `role="alert"` error described above. Success toasts (`showToast(..., 'success')`): "Sync enabled"/"Sync disabled" after Save, one of three Refresh outcomes chosen by `describeRefreshOutcome()` ("Incoming changes found — import available." / "Fetched and fast-forwarded." / "Already up to date." — a best-effort read of the before/after status, since `InfoSyncStatus` carries no explicit "did we fast-forward" flag), "Main folder recreated." after recreate, "Import applied." after a successful import, and `describeCommitOutcome(result)` after Commit & Push — `` `Pushed {sha7} to {branch}.` `` when both `result.commitSha` and `status.mainFolder.defaultBranch` are known, falling back to `"Committed and pushed."` otherwise. A shared module-private `notifyFilterFallback(result, transfer)` helper then shows a separate info toast ("The remote does not support partial-clone filtering — a full {clone|fetch} was used.") whenever the action's own response carries `filterFallback: true` — called after Save (only when enabling, `transfer: 'clone'`), Refresh (`'fetch'`), recreate-main-folder (`'clone'`), and Commit & Push (`'fetch'`), so the four call sites share one copy of the text and condition instead of each re-implementing it.

**Conflict auto-open:** `autoOpenedConflicts` is a **module-level** `Set<repoId>` (not per-render, not per-instance) — a repository whose `conflict` state has already auto-opened the import modal during the current page visit never reopens it, even after a re-render triggered by Save/Refresh/Commit/import, navigating away and back, or a user cancelling the auto-opened modal. `maybeAutoOpenConflict()` is called after every status-changing action and the initial load; it is a no-op while `modalOpen` or `busy`, or once the repo ID is already in the set. Since an auto-open has no human "opener" to return focus to, it explicitly focuses the section heading immediately before calling `doImport()`, giving `modal-shell.js`'s own focus-restoration a sane target. The health alert's Import… fix action (and the action row's Import… button) remain the always-reachable manual fallback regardless of auto-open state.

**Focus management:** `safeRender()` is the single rebuild entry point every handler calls; it checks whether focus was inside the section before the rebuild and, if the previously-focused element no longer exists afterwards, moves focus to the section heading. This one mechanism satisfies "focus moves to the section heading when the opener was replaced" for every action that can destroy the focused control (Save, Refresh, recreate-main-folder, a successful import) without special-casing each one individually.

**Post-action refresh split (plan step 16(e)):** a successful import is the only action that can change `Name`/`Description`, so it alone re-fetches the full repository (`api.repositories.get(repoId)`) and calls `options.onRepositoryChanged(updatedRepo)` — wired by `repository-detail.js` to `applyRepositoryUpdate()`, which patches the page header without a full navigation. Save, Refresh, recreate-main-folder, and Commit & Push only re-fetch this section's own `InfoSyncStatus` via `reloadStatusSilently()`/the action's own response; they never call `onRepositoryChanged`.

**Health alert integration:** `buildHealthActions()` registers five `fixAction` handlers consumed by the shared `buildHealthAlert()` component (title: "Workspace info sync issues") — `recreate-main-folder`, `refresh`, `commit-push`, `import`, and `configure-credential` (which calls `options.onConfigureCredential()`, wired by `repository-detail.js` to scroll to and focus the Credential section's heading).

**Known gap vs. the original plan spec, resolved by Milestone 2's cross-cutting WP:** `showInfoCommitDialog()` previously resolved with only the trimmed commit message (no `commitSha`/`defaultBranch`), so Commit & Push showed a generic "Committed and pushed." toast rather than the plan's "Pushed {short sha} to {default branch}." wording — see **Returns**, above, and `describeCommitOutcome()`, below.

**Remaining known gap vs. the original plan spec, resolved:** `saveSettings()`, `refresh()` and `recreateManagedClone()` return `RepositoryInfoSyncRemoteStatus` (`RepositoryInfoSyncStatus` plus an optional `filterFallback`, see `api-surface.md`; `api.js`'s matching `InfoSyncRemoteStatus` JSDoc typedef documents the same shape for the GUI layer) and the `PUT /info-sync`/`POST /refresh`/`POST /recreate-main-folder` responses pass it through unchanged (see `rest-api.md`). Save (on enable), Refresh and recreate-main-folder now read `result.filterFallback` off those responses via the shared `notifyFilterFallback()` helper described above, alongside Commit & Push's existing `CommitPushResult.filterFallback` — all four call sites now surface the plan's `filterFallback` info toast through the one helper.

**Cleanup:** `cleanup()` sets an internal `destroyed` flag checked by every async continuation (`load()`, `doImport()`, `doRefresh()`, `doRecreateMainFolder()`, `doCommitPush()`) so a response arriving after the view has navigated away never touches a detached DOM tree.

**CSS accessibility floor — in-run check only:** the section's, both modals', and the Sync badge's rule blocks in `styles.css` (`.repository-info-sync*`, `.status-pill`/`.info-sync-state--*`, `.info-sync-action-row`, `.info-import-*`, `.sync-badge*`, `.info-commit-pending-files`) use only `var(--…)` colours, `flex-wrap` on the action row, `overflow-wrap: anywhere` on the main folder path and diff values, a stacked import-diff-row layout plus a ≥16px input/textarea font size inside the existing `@media (max-width: 768px)` block, and introduce no animation outside the existing `@media (prefers-reduced-motion: reduce)` block. `gui/public/js/__tests__/styles.info-sync.test.mjs` is the first GUI test that reads `styles.css` as plain text and asserts these string-level rules — the GUI suites are jsdom-only with no browser tooling configured, so it is the only in-run check for this floor; measured contrast, real reflow at 320px/200% zoom, and keyboard-only walkthroughs remain a manual, post-run verification.

---

### Repository Files Section

`views/repository-files-section.js` exports `buildRepositoryFilesSection(repo, status, { onChanged? }): { element: HTMLElement, cleanup: function(): void }`, the **Files** section on the repository detail page (Milestone 2) — mounted directly after the Workspace info sync section (see the `#/repositories/:id` row in the Routes table, above). It renders small per-repository files (mainly wrapper scripts) that Paralizer writes into the repository's managed main folder (`.workspace/files/`) while info sync is enabled; the files reach workspace clones only through git (Commit & Push from the managed clone, then a pull in each workspace) — Paralizer never copies them into workspaces directly.

Like `views/project-custom-files.js`, it wraps the shared `buildFileDefinitionTable()`/`buildFileDefinitionEditor()` (`components/file-definition-editor.js` — see [File Definition Table & Editor Component](#file-definition-table--editor-component) above) with its own section shell, and reuses that view's `formatCustomFilePath()`/`isExecutableHint()` helpers rather than duplicating them (both are pure, scope-neutral).

| Param | Type | Description |
|---|---|---|
| `repo` | `{ id: string, name?: string }` | Normalised repository, as already fetched by `repository-detail.js`. |
| `status` | `{ enabled: boolean }\|null` | The repository's info-sync status (only `enabled` is read) at mount time, from the same `api.repositories.infoSync.status()` fetch `repository-detail.js` uses for the info sync section — no duplicate request. `null` (e.g. that fetch failed) is treated as disabled, the safer default. |
| `options.onChanged` | `function(): void` (optional) | Called after every successful add/update/delete so the caller can refresh the info-sync section's own status (pending changes, Commit & Push availability). Not called for a failed mutation or a cancelled delete confirmation. `repository-detail.js` wires this to rebuild the Workspace info sync section from scratch, since that M1-owned section exposes no public refresh method. |

**Intro text (verbatim):** "Files are written to the repository's `.workspace/files/` folder and reach workspaces only after Commit & Push and a pull. Paralizer never copies them into workspaces."

**Read-only while sync is disabled:** the list and table stay visible, but every mutation control (Add File button, each row's Edit/Delete buttons) is `disabled` with a shared `title` hint ("Enable workspace info sync above to manage repository files."), and a visible `.repository-files-enable-hint` paragraph ("Enable workspace info sync above to add, edit, or delete repository files.") is shown above the table/empty-state. Opening the editor is a no-op while disabled, defensively, even though the only controls that reach it are already disabled.

**Table column:** the shared table's `statusColumn` is repurposed as a "Run with" column — `sh .workspace/files/<path>` for a file whose `executable` flag is set, an em dash (with `aria-label="Not executable"`) otherwise.

**Executable checkbox:** the editor form passes `showExecutable: true` (see [File Definition Table & Editor Component](#file-definition-table--editor-component)). For a **new** file only, `wireExecutableAutoCheck()` keeps the checkbox tracking `isExecutableHint(fileName, content)` live as those fields change, until the user manually toggles the checkbox — after which the manual choice sticks and the heuristic no longer overrides it. An **existing** file's checkbox shows (and defaults to) its saved, explicit `executable` flag untouched by the heuristic.

**Normalisation:** `normaliseRepositoryFile(f)` mirrors `project-custom-files.js`'s `normaliseCustomFile()` (PascalCase-or-camelCase backend shape → the camelCase shape the shared editor/table expect), widened with the explicit `executable` boolean repository files carry — project custom files have no such field, only the client-side heuristic hint.

**Delete confirmation:** `showConfirm('Delete Repository File', ...)` names the file's label and path and explains it is removed from the managed clone on the next sync, and from the repository itself once committed and pushed.

**CRUD wiring:** add/update/delete call `api.repositories.files.create/update/remove(repoId, ...)` directly (no intermediate per-view API layer); a successful mutation shows a success toast, closes the editor, re-fetches this section's own file list, and — unless the section has been torn down in the meantime — invokes `onChanged`.

**Cleanup:** `cleanup()` sets an internal `destroyed` flag checked by the async load/afterChange continuations, so a response arriving after the view has navigated away never touches a detached DOM tree.

**CSS:** the section's and the import modal's Files table rule blocks (`.repository-files-*`, `.info-import-file*`, `.info-import-files-heading`) in `styles.css` reuse the existing custom-files classes where sensible and use only `var(--…)` colours, consistent with the rest of the page.

Tests: `gui/public/js/views/repository-files-section.test.mjs`.

---

### Custom Files tab (`views/project-custom-files.js`)

CRUD for the files a project copies into every workspace (`api.projects.customFiles.{list,create,update,delete}`). The table and the add/edit form are built by the shared `buildFileDefinitionTable()`/`buildFileDefinitionEditor()` (`components/file-definition-editor.js` — see [File Definition Table & Editor Component](#file-definition-table--editor-component) above); this view owns only the project-specific wiring (the API calls, `showConfirm`/toast text, the "In AGENTS.md" status column) and its own section shell (busy/error state, delete confirmation, reload).

- **List:** table (`.custom-files-table`, inside a `.custom-files-table-wrap` scroll container) with label + description, workspace-relative path, "Listed" state for AGENTS.md (the view's `statusColumn`), and Edit/Delete buttons whose `aria-label`s include the file label. Empty state: "No custom files yet." An intro paragraph states that copies are overwritten on sync and removed on delete/move.
- **Editor form** (`.custom-file-form`, one at a time, shared by add and edit): Label*, Directory, File name*, Description, Content (`.custom-file-content`: monospace, `wrap=off`, no spellcheck, no highlighting) and a **"List in the workspace AGENTS.md"** checkbox with `role="switch"`, default off. No manual Executable checkbox — this view does not pass `showExecutable`, so the executable bit stays purely heuristic. A polite live region shows the resulting path and "marked executable" (client mirror of `isExecutableFile`, display only, via the `computeExecutableHint`/`formatCustomFilePath` hooks). Server rejections are shown inline in a `role="alert"` paragraph; the form stays open.
- **Keyboard:** in the content textarea Tab inserts a tab character; Escape makes the next Tab/Shift+Tab move focus normally (no keyboard trap) — the field hint says so.
- **Dirty tracking:** an "Unsaved changes" indicator; Cancel asks for confirmation (`showConfirm`) when dirty. Delete uses `showConfirm` and states that copies in all workspaces are removed from disk.
- Exports `normaliseCustomFile`, `formatCustomFilePath`, `isExecutableHint`, `buildCustomFilesSection`. Tests: `project-custom-files.test.mjs`.

### Repository role cell (`views/project-repository-roles.js`)

Inline click-to-edit **Role / relations** cell of the project's repository table (`.repos-table`). `buildRepositoryRoleCell(projectId, repoId, initialRole)` returns a `<td class="repo-role-cell">`. It shows a `.repo-role-display` button (placeholder `Add role…` with `.repo-role-display--empty` when no role is set); a click swaps it for a `.repo-role-input` text input (`maxLength` 500).

- **Saving:** on blur or Enter, via `api.projects.setRepositoryRole(projectId, repoId, text)`. A `settled` flag ensures one save per edit (Enter followed by blur does not save twice). Unchanged text makes no request. Saving empty (or whitespace-only) text clears the role. The cell displays the server-normalised `role` returned by the `PUT`.
- **Escape** cancels the edit without saving. A failed save shows an error toast, keeps the editor open and re-enables it for retry.
- Role text is rendered with `textContent` / `input.value` only (no `innerHTML` for user text).
- Exports `buildRepositoryRoleCell`, `REPOSITORY_ROLE_MAX_LENGTH` (client mirror of the server limit) and `ROLE_PLACEHOLDER`. Tests: `project-repository-roles.test.mjs`, `api.directives.test.mjs`. CSS: `.repo-role-*` rules in `styles.css`.

### Directives tab (`views/project-directives.js`)

Project-wide agent directives, shown in the **Directives** tab (`{ id: 'directives', label: 'Directives' }`) of `project-detail.js`, which only imports the module, registers the tab entry and appends the panel. `buildProjectDirectivesSection(projectId)` fetches the list itself via `api.projects.directives.list` (not from the project payload) and hosts `buildDirectiveListEditor()` wired to `api.projects.directives.{create,update,remove,list}`, so a mutation never forces a full project-view re-render. An intro paragraph explains that directives are written into every workspace's `AGENTS.md` and that workspace-specific directives are managed per workspace.

- Exports `buildProjectDirectivesSection`, `DIRECTIVE_MAX_LENGTH` and `DIRECTIVES_MAX_COUNT` (client mirrors of the server's limits, used only for the counter and the add-button limit). Tests: `project-directives.test.mjs`, `api.directives.test.mjs`.

### Workspace directives section (`views/workspace-directives.js`)

Workspace-scoped agent directives, shown as the **Workspace directives** section below Notes on the workspace page. `buildWorkspaceDirectivesSection(projectId, wid)` returns a `<section class="workspace-directives-section">` (heading, intro paragraph, body) and mirrors `views/project-directives.js`: it fetches the list itself via `api.workspaces.directives.list` and hosts `buildDirectiveListEditor()` (`scopeLabel: 'workspace'`) wired to `api.workspaces.directives.{create,update,remove,list}` — never the project endpoints — so a mutation never forces a workspace-view re-render or touches the status poll. The intro explains that directives are written into this workspace's generated `AGENTS.md` only and that project-wide directives are managed on the project page. A failed load renders a `role="alert"` `.form-error` message in place of the editor.

- Exports `buildWorkspaceDirectivesSection`. It imports `DIRECTIVE_MAX_LENGTH` and `DIRECTIVES_MAX_COUNT` from `project-directives.js` (a cross-view coupling; a shared constants module is a possible cleanup). Loading/error scaffolding duplicates the project view's.
- Keeps directive logic out of the large `workspace-detail.js`, which holds only the import and the `appendChild` mount. Tests: `workspace-detail.directives.test.mjs` (list, create and load-failure paths against the workspace endpoints).

## Utilities

| Utility | File | Export | Purpose |
|---|---|---|---|
| Normalise | `utils/normalise.js` | `normaliseRepo()`, `normaliseProject()`, `normaliseWorkspace()`, `normaliseNotesResponse()` | Maps PascalCase backend keys to camelCase frontend keys. `normaliseWorkspace` includes `folderPath` (from `FolderPath`) and `notes` (from `Notes ?? notes ?? ''`). `normaliseNotesResponse()` transforms the `GET /api/notes` PascalCase response into a camelCase `{ projects: [...] }` structure. |
| Constants | `utils/constants.js` | `STABLE_WS_ID`, `APP_NAME_SHORT`, `CREDENTIAL_MISSING_SENTINEL` | Shared GUI constants. `STABLE_WS_ID = 'STABLE'` is the canonical definition; `APP_NAME_SHORT = 'Paralizer'` is the short app name used in browser tab titles; `CREDENTIAL_MISSING_SENTINEL = 'requires a credential for host'` is the sentinel substring matched against orchestrator clone-error messages to detect missing-credential failures (imported by `workspace-detail.js`). Import from here instead of hardcoding the strings in views. |
| DOM | `utils/dom.js` | `clearElement(el)`, `buildCredentialBadge(credentialId)` | DOM utilities. `clearElement` removes all children from an element via `removeChild` loop (preferred over `innerHTML = ''`). `buildCredentialBadge(credentialId)` builds a CSS-styled `<span>` with `.credential-badge` and either `.credential-badge--set` (green checkmark, credential present) or `.credential-badge--none` (muted dash, no credential); always includes an `aria-label` for accessibility. Used by `repositories.js` and `project-detail.js` to eliminate duplicated badge construction code. |

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

### Page Title Convention

Every view sets `document.title` using `APP_NAME_SHORT` from `utils/constants.js`. The router's `_render()` method resets the title to `APP_NAME_SHORT` before calling each view, preventing stale titles from carrying over during async data loads.

- **Static views** (dashboard, repositories, settings, error-log, branch-switch): Set `document.title` synchronously at the top of the render function using the pattern `'{Section Name} - ' + APP_NAME_SHORT`.
- **Entity-detail views** (project-detail, repository-detail, workspace-detail): Set `document.title` inside the `.then()` callback after the data fetch resolves, once the entity name is available.

| View | Title format |
|---|---|
| Dashboard | `Dashboard - Paralizer` |
| Repositories | `Repositories - Paralizer` |
| Repository Detail | `{repo.name} - Paralizer` |
| Project Detail | `{project.name} - Paralizer` |
| Workspace Detail | `{project.name} {wid} - Paralizer` |
| Branch Switch | `Branch Switch - Paralizer` |
| Settings | `Settings - Paralizer` |
| Error Log | `Error Log - Paralizer` |

### Workspace Detail View (`workspace-detail.js`)

The workspace detail view (`#/projects/:id/workspaces/:wid`) renders live git status for all repositories in a workspace.

**Key behaviours:**

- **Initial load:** Calls `api.status.refresh()` (force-refresh via live git-fetch) instead of `api.status.get()` (cached), ensuring fresh data even when the polling cache is empty.
- **Refresh toolbar:** A `.workspace-refresh-toolbar` row between the header and the status table displays a countdown label ("Next refresh in Xs") and a "Refresh Now" button. The countdown ticks every second; when it reaches 0, an automatic poll is triggered via `api.status.get()`. The "Refresh Now" button triggers a force-refresh via `api.status.refresh()` and resets the countdown.
- **Countdown-based polling:** Replaces the previous `setInterval(fn, 10000)` approach. A 1-second `setInterval` decrements a counter. At zero it triggers `doPoll()` (cached). A `refreshInProgress` flag prevents race conditions between manual and automatic refreshes.
- **Reactive missing-repos row:** After each poll or manual refresh, the "X repositories have no data" message is re-evaluated. When all repos have status data, the row is removed. When the count changes, the text updates.
- **Setup button in-place update:** After a successful workspace setup, the DOM is mutated in-place: the setup button is removed from `mgmtRow`, an "Open in VS Code" button (`buildOpenVscodeButton`) followed by an "Open in Terminal" button (`buildOpenTerminalButton`) are each inserted before the Rename button, and `workspace.initialized` is set to `true` in the local variable. Only after these DOM mutations does `onSetupSuccess()` fire, triggering an immediate force-refresh and starting the countdown — no router re-render needed.
- **Retry Setup:** The retry button also triggers `doRefresh()` after a successful re-setup instead of reloading the page.
- **Per-repo quick branch switch:** In non-STABLE workspaces, each branch cell in the status table renders a `<button class="branch-switch-trigger">` (styled as inline text with a dotted underline). Clicking it expands an inline popover via `showBranchQuickSwitch()` (dynamically imported from `components/branch-quick-switch.js`), anchored below the clicked cell. The popover shows a filterable list of local branches and a text input pre-filled with the current branch; confirming calls `api.branches.switch()` with a single-entry assignment and triggers `doRefresh()`. STABLE workspace branch cells are plain text with no click behaviour. Both `buildStatusTableSection()` and the inlined polling-update loop receive `isStable` and `onBranchCellClick` parameters so polling updates preserve the clickable style.
- **Repo status cells:** The Branch, Status badge, and Actions `<td>` cells for each repository row are built and updated via `buildRepoStatusCells()` and `updateRepoStatusCells()` from `components/repo-status-cells.js`. These functions locate cells by CSS class (`.repo-branch-cell`, `div[data-repo-id]`) rather than by hardcoded cell indices, so additional cells can be prepended to a row without breaking polling updates.
- **Cleanup contract:** The returned cleanup function clears the 1-second countdown interval.
- **Description and Notes sections:** Both appended below the repository status table (Description first, Notes second) by the shared `buildTextFieldSection(label, idSuffix, initialValue, onSave)` builder. `buildNotesSection(initialNotes, onSave)` remains as a one-line wrapper calling `buildTextFieldSection('Notes', 'notes', initialNotes, onSave)` for call-site readability; the Description section calls `buildTextFieldSection('Description', 'description', workspace.description, onSave)` directly. See [`buildTextFieldSection()`](#buildtextfieldsectionlabel-idsuffix-initialvalue-onsave) below.

#### `buildTextFieldSection(label, idSuffix, initialValue, onSave)`

Builds a `<section class="workspace-{idSuffix}-section">` containing a labelled textarea and a debounced auto-save mechanism. Internal helper — not exported from `workspace-detail.js`. Generalised from the original single-field `buildNotesSection()`; passing `idSuffix: 'notes'` reproduces its original DOM byte-for-byte. Shared by the Description and Notes sections, which are both plain string fields on the same workspace resource, saved through the same `api.workspaces.update()` call.

| Parameter | Type | Description |
|---|---|---|
| `label` | `string` | Visible label text for the field (e.g. `'Notes'`, `'Description'`). |
| `idSuffix` | `string` | Kebab-case suffix used to derive element IDs and class names (e.g. `'notes'`, `'description'`). |
| `initialValue` | `string` | Pre-populated value from the workspace (`workspace.notes` or `workspace.description`); written directly to `textarea.value`. |
| `onSave` | `(value: string) => Promise<void>` | Called with the current textarea value after a 1000 ms debounce. Should persist the field via `api.workspaces.update(projectId, wid, { notes })` or `{ description }`. The Description section's `onSave` also updates `workspace.description` in the render closure after a successful save; the Notes section's `onSave` does not update a closure variable. |

**Returns:** `HTMLElement` — the `<section>` element ready to be appended to the view container.

**DOM structure** (IDs/classes derived from `idSuffix`, shown here for `idSuffix: 'notes'`):

```
<section class="workspace-notes-section">
  <label for="workspace-notes-textarea" class="workspace-notes-label">Notes</label>
  <textarea id="workspace-notes-textarea" class="workspace-notes-textarea">…</textarea>
  <span class="workspace-notes-status" aria-live="polite" hidden>…</span>
</section>
```

The Description section renders the equivalent structure with `workspace-description-section` / `-label` / `-textarea` / `-status` class and ID names.

**Layout:** `.workspace-{idSuffix}-section` uses a CSS grid (`grid-template-columns: 1fr auto`): the label and save-status span share row 1 — label left, status right-aligned — and the textarea spans both columns in row 2. This ensures the save-status indicator is always adjacent to the label rather than appearing below the textarea.

**Behaviour:**

- A `debounceTimer` (closure-scoped per section instance) is cleared and rescheduled on every `input` event; the `onSave` call fires after 1000 ms of inactivity.
- Before `await onSave(...)`: sets `statusEl.textContent = 'Saving…'` and makes the span visible.
- On success: sets `statusEl.textContent = 'Saved'`; hides the span after 3 seconds.
- On error: sets `statusEl.textContent = 'Save failed.'` (span remains visible).
- The `aria-live="polite"` attribute ensures screen readers announce status changes without interrupting current speech.

**Note:** The static, muted description text rendered inline in `buildHeaderSection()` (quick-glance summary near the workspace header) is intentionally left unchanged and does not live-update after a Description-section save — it is a separate, read-only rendering of the same underlying value.

### Tabbed Navigation (Project Detail)

The project detail view organises content into three tabs: **Repositories**, **Workspaces**, and **Danger Zone**. Tabs are implemented with `.tab-nav` / `.tab-btn` / `.tab-panel` CSS classes and ARIA `role="tablist"` / `role="tab"` / `role="tabpanel"` attributes. Switching is handled by a single delegated click listener on the tab nav container. Only one panel is visible at a time (`.tab-panel.active`).

### Error Log View (`error-log.js`)

The error log view (`#/error-log`) renders a paginated, filterable table of error log entries fetched from `GET /api/error-log`.

**Key behaviours:**

- **Filter bar:** Severity and Source dropdowns re-fetch entries on change via `api.errorLog.list()`. The severity dropdown is driven by `SEVERITY_OPTIONS` in `error-log.js` and contains five entries: `all` ("All Severities"), `error` ("Error"), `warning` ("Warning"), `audit` ("Audit"), `info` ("Info"). Source options are **fetched dynamically** from `GET /api/error-log/sources` (`api.errorLog.sources()`) on view mount and after "Clear All" — no hardcoded list. The filter bar is rebuilt after each sources fetch via `rebuildFilterBar()`.
- **Expandable detail rows:** Each data row (`<tr class="error-log-entry-row">`) is keyboard-accessible (`role="button"`, `tabindex="0"`, `aria-expanded`). Clicking or pressing Enter/Space toggles a hidden `<tr class="error-log-detail-row">` below it containing a `<pre class="error-log-detail-pre">` with the entry's `details` field.
- **Severity badges:** Rendered via `buildSeverityBadge()` as a `<span class="severity-badge severity-{value}">` element. Supported CSS classes and their visual semantics:
  - `.severity-error` — red/danger (`--badge-error` / `--badge-error-bg`)
  - `.severity-warning` — amber/warning (`--color-warning` / `--color-warning-light`)
  - `.severity-audit` — blue/indigo (`--badge-ahead` / `--badge-ahead-bg`)
  - `.severity-info` — neutral/grey (`--color-text-muted` / `--color-border-light`)
  - Unknown severities fall back to no colour modifier (`.severity-badge` base styles only).
- **Timestamps:** Displayed as relative time (e.g. "3 min ago") with the full ISO timestamp in the `title` tooltip. Falls back to the raw string on parse failure.
- **Clear All:** Prompts a `showConfirm()` dialog before calling `api.errorLog.clear()` (HTTP DELETE). Resets filters and reloads on success.
- **XSS safety:** All dynamic text is set via `textContent`, never `innerHTML`.
- **No router injection:** `error-log.js` does not export `setRouter()` — it never needs to navigate away programmatically.
- **No cleanup function:** `renderErrorLog` returns no cleanup — there is no polling or other side-effect to tear down.
- **Shared time utility:** `relativeTime()` is imported from `utils/time.js` (shared with `status-badge.js`'s `formatLastActivity()`).

**Nav badge:** The `#error-log-badge` span inside the "Error Log" nav link displays a live error count. `nav-badge.js` polls `api.errorLog.count()` every 30 seconds and hides the badge when the count is 0. The error-log view calls `refreshNavBadge()` after "Clear All".
