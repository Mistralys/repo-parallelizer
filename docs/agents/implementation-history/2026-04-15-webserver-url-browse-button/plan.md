# Plan

## Summary

Add a new global configuration setting `webserverUrl` that stores the base URL of a local webserver serving the workspace repositories. When configured, a "Browse" button appears on each repository row in the workspace-detail view (before the existing "Git GUI" button). Clicking it opens the default browser to the repository's constructed URL (`{webserverUrl}/{projectId}/{workspaceId}/{repoId}/`). The setting is managed in the GUI Settings view alongside the existing Git Credentials and Refresh Delay sections, and persisted via new REST API endpoints.

## Architectural Context

### Configuration Layer
- **`src/config/config.types.ts`** — `AppConfig` interface defines all config fields. Currently: `projectsFolder`, `storageFolder`, `cloneDepth`, `serverPort`, `gitPollingIntervalSeconds`, `gitCredentials?`, `maxErrorLogEntries?`.
- **`src/config/config.ts`** — `loadConfig()` reads `config.json`, validates required fields, and applies defaults. `saveConfigField()` persists a single field to disk.
- **`config.dist.json`** — Template config; new fields with defaults should be added here.

### REST API Config Routes
- **`src/server/routes/config.ts`** — `registerConfigRoutes()` registers credentials and polling endpoints. Uses a named-options interface `ConfigRoutesOptions` receiving `router`, `appConfig`, `configPath?`, `pollingManager?`.
- Follows a clear pattern: GET returns current value, PUT validates and updates both in-memory `appConfig` and disk via `saveConfigField()`.

### GUI Settings View
- **`gui/public/js/views/settings.js`** — `renderSettings()` renders two settings sections (Git Credentials and Refresh Delay) plus a shared "Save Settings" footer. Each section builder returns `{ element, save }` and `save()` is called by the footer button.
- **`gui/public/js/api.js`** — `api.config` namespace groups `credentials` and `polling` sub-namespaces.

### Workspace Detail View
- **`gui/public/js/views/workspace-detail.js`** — `buildRepoStatusRow()` renders per-repository rows with 4 columns: Name, Branch, Status Badge, Actions. The Actions cell currently contains only the "Git GUI" button (which calls `api.workspaces.launch.githubDesktop()`).
- The "Browse" button is a purely client-side action (opens `window.open()`) — it does **not** need a backend launch endpoint like VS Code or GitHub Desktop.

### Disk Path Structure
Repository clones live at `{projectsFolder}/{projectId}/{workspaceId}/{repoId}/`. The browse URL mirrors this: `{webserverUrl}/{projectId}/{workspaceId}/{repoId}/`.

## Approach / Architecture

1. **New config field** (`webserverUrl?: string`) added to `AppConfig` and `config.dist.json`.
2. **New REST endpoints** (`GET /api/config/webserver-url`, `PUT /api/config/webserver-url`) follow the exact same pattern as the polling endpoints — simple get/set with validation.
3. **New settings section** in the GUI Settings view for editing the Webserver URL.
4. **New API client methods** under `api.config.webserverUrl`.
5. **Conditional "Browse" button** in the workspace-detail per-repository row. The webserver URL is fetched once when the workspace-detail view renders; when set, a "Browse" button is prepended before the "Git GUI" button in each row. When empty/not configured, the button is hidden entirely.

The Browse button opens the URL client-side via `window.open(url, '_blank')` — no backend endpoint is needed because this is a standard browser navigation, not an OS-level application launch.

## Rationale

- **Global config (not per-project):** The webserver typically serves the entire `projectsFolder` tree, so a single URL prefix applies to all projects.
- **Client-side `window.open()`:** Unlike VS Code or GitHub Desktop which require OS-level `spawn()`, opening a browser URL from a web-page is a native browser capability. No backend launch endpoint is needed. This also avoids the cross-platform complexity of launching the default browser from Node.js.
- **Optional field:** The setting defaults to empty/undefined. Existing installations are unaffected — the Browse button simply doesn't appear.
- **Same REST pattern as polling:** GET/PUT with validation keeps the API surface consistent.

## Detailed Steps

### Step 1 — Backend: Add `webserverUrl` to AppConfig

1. **`src/config/config.types.ts`**: Add `webserverUrl?: string` to the `AppConfig` interface with a JSDoc comment.
2. **`src/config/config.ts`**: Add `webserverUrl` to the return object in `loadConfig()`. **Important:** `loadConfig()` builds its return value field-by-field — it does not use spread/passthrough. The new field must be explicitly added to the return statement, following the same type-check pattern used for other optional fields:
   ```typescript
   webserverUrl: typeof raw['webserverUrl'] === 'string' && raw['webserverUrl'].trim() !== ''
       ? raw['webserverUrl'].trim().replace(/\/+$/, '')
       : undefined,
   ```
   This handles three cases: absent/null → `undefined`; empty string `""` → `undefined` (so a `config.dist.json` default of `""` is treated as "not configured"); non-empty string → trimmed with trailing slashes stripped (defence against manual `config.json` edits with a trailing slash).
3. **`config.dist.json`**: Add `"webserverUrl": ""` to the template.

### Step 2 — Backend: Add REST endpoints

4. **`src/server/routes/config.ts`**: Add two endpoints inside `registerConfigRoutes()`:
   - `GET /api/config/webserver-url` → Returns `{ webserverUrl: string | null }`. Returns `null` when not configured.
   - `PUT /api/config/webserver-url` → Body: `{ url: string }`. Validates that `url` is a string. If `url` is empty string `""`, clears the setting (sets to `undefined` in config). If non-empty, trims it and strips trailing slashes (to avoid double-slash when building URLs). **Scheme validation (defence-in-depth):** reject URLs whose scheme (lowercased, before the first `:`) is `javascript`, `data`, or `vbscript` — return 400 with a descriptive error. While this is a user-controlled setting, `window.open('javascript:...')` can execute code in some browsers, and the project's security posture favours defence-in-depth. Updates in-memory `appConfig.webserverUrl` and persists via `saveConfigField()`. Returns `{ webserverUrl: string | null }`.

### Step 3 — Frontend: Add API client methods

5. **`gui/public/js/api.js`**: Add `api.config.webserverUrl` sub-namespace with `get()` and `set(url)` methods:
   - `get()` → `GET /api/config/webserver-url`
   - `set(url)` → `PUT /api/config/webserver-url` with body `{ url }`

### Step 4 — Frontend: Add Settings section

6. **`gui/public/js/views/settings.js`**: Add a `buildWebserverUrlSection()` function (following the `buildRefreshDelaySection()` pattern) that:
   - Renders a text input for the URL.
   - Fetches and populates the current value on mount via `api.config.webserverUrl.get()`.
   - Returns `{ element, save }` where `save()` calls `api.config.webserverUrl.set()`.
   - Shows a description explaining the purpose of the setting.
7. **`gui/public/js/views/settings.js`**: In `renderSettings()`, add the new section between the Refresh Delay section and the footer. Wire its `save()` into the footer button's `Promise.all()` array. Update the module-level JSDoc at the top of the file to list three settings sections instead of two.

### Step 5 — Frontend: Add "Browse" button to workspace-detail

8. **`gui/public/js/views/workspace-detail.js`**: In `renderWorkspaceDetail()`, fetch the webserver URL once via `api.config.webserverUrl.get()` during the initial data load (can be done in parallel with other fetches via `Promise.allSettled()`).
9. **`gui/public/js/views/workspace-detail.js`**: Pass the webserver URL (or `null`) into `buildStatusTableSection()` and `buildRepoStatusRow()`.
10. **`gui/public/js/views/workspace-detail.js`**: In `buildRepoStatusRow()`, when `webserverUrl` is truthy, create a "Browse" button before the "Git GUI" button. The click handler constructs the URL as `{webserverUrl}/{projectId}/{workspaceId}/{repoId}/` and calls `window.open(url, '_blank')`.
11. **`gui/public/js/views/workspace-detail.js`**: In `updateStatusTable()`, no changes needed — the Browse button is static (not dependent on polling status data).

### Step 6 — Tests

12. **Backend unit test — config loading:** In the existing `src/tests/config.test.ts`, add test cases for `loadConfig()` with and without `webserverUrl` in the config file — verify that absent/null/empty-string all map to `undefined`, and a valid URL is preserved (with trailing slashes stripped).
13. **Backend unit test — API routes:** In `src/server/__tests__/` (where existing route-level tests live), add test cases for the new config endpoints:
    - `GET /api/config/webserver-url` returns `null` when not configured.
    - `PUT /api/config/webserver-url` with a valid URL persists and returns it.
    - `PUT /api/config/webserver-url` with an empty string clears the setting.
    - `PUT /api/config/webserver-url` validates input type.
    - `PUT /api/config/webserver-url` rejects `javascript:`, `data:`, and `vbscript:` scheme URLs with 400.
14. **Frontend test (optional):** Add a test for the Browse button construction in workspace-detail, verifying the URL is assembled correctly.

### Step 7 — Manifest updates

15. Update `docs/agents/project-manifest/api-surface.md` — add `webserverUrl?: string` to `AppConfig`.
16. Update `docs/agents/project-manifest/rest-api.md` — add the two new endpoints.
17. Update `docs/agents/project-manifest/gui-frontend.md` — update Settings view description to include the new section; update workspace-detail description to mention the Browse button.

## Dependencies

- No new npm packages required.
- No changes to the build pipeline.
- All changes build on existing infrastructure (`saveConfigField`, `registerConfigRoutes`, settings view pattern).

## Required Components

### Modified files
- `src/config/config.types.ts` — Add `webserverUrl` field
- `src/config/config.ts` — Parse `webserverUrl` in `loadConfig()`
- `config.dist.json` — Add `webserverUrl` default
- `src/server/routes/config.ts` — Add GET/PUT webserver-url endpoints
- `gui/public/js/api.js` — Add `api.config.webserverUrl` namespace
- `gui/public/js/views/settings.js` — Add Webserver URL section
- `gui/public/js/views/workspace-detail.js` — Add conditional Browse button
- `docs/agents/project-manifest/api-surface.md` — Document new config field
- `docs/agents/project-manifest/rest-api.md` — Document new endpoints
- `docs/agents/project-manifest/gui-frontend.md` — Document new UI elements

### No new files
All changes fit within existing files.

## Assumptions

- The webserver serves the `projectsFolder` directory at the configured URL. The path structure on the webserver matches the disk structure (`{projectId}/{workspaceId}/{repoId}/`).
- The webserver is an external concern — this tool only builds and opens the URL; it does not verify the webserver is running.
- Only HTTP/HTTPS URLs are expected. Dangerous schemes (`javascript:`, `data:`, `vbscript:`) are rejected by the PUT endpoint; all other schemes are accepted (e.g. `ftp:`).

## Constraints

- **Node16 ESM:** All relative imports in modified `.ts` files must use `.js` extensions.
- **No framework in GUI:** All DOM manipulation is vanilla JS with ES modules.
- **`saveConfigField` caller guard:** The `field` parameter passed to `saveConfigField` is hardcoded in the route handler (not user-supplied), matching the existing pattern.
- **Stateless read:** `loadConfig()` must remain idempotent — the new field is optional with no side effects.

## Out of Scope

- Validating that the webserver is actually running at the configured URL.
- Full protocol validation (HTTP vs HTTPS) — only dangerous schemes (`javascript:`, `data:`, `vbscript:`) are rejected; all other schemes are accepted.
- Per-project webserver URLs.
- Serving repositories through this tool's own HTTP server.
- Adding the Browse button to any view other than workspace-detail.

## Acceptance Criteria

- A new `webserverUrl` optional field exists in `AppConfig` and is correctly loaded from `config.json`.
- `config.dist.json` includes `"webserverUrl": ""`.
- `GET /api/config/webserver-url` returns the current value (or `null` when not set).
- `PUT /api/config/webserver-url` persists the value to `config.json` and updates the in-memory config.
- `PUT /api/config/webserver-url` with an empty string clears the setting.
- `PUT /api/config/webserver-url` rejects `javascript:`, `data:`, and `vbscript:` scheme URLs with HTTP 400.
- `loadConfig()` maps absent, null, and empty-string `webserverUrl` to `undefined`; strips trailing slashes from non-empty values.
- The Settings view has a "Webserver URL" section with a text input, populated on load.
- The "Save Settings" button persists the Webserver URL alongside other settings.
- When `webserverUrl` is configured, each repository row in workspace-detail shows a "Browse" button before the "Git GUI" button.
- Clicking "Browse" opens a new browser tab at `{webserverUrl}/{projectId}/{workspaceId}/{repoId}/`.
- When `webserverUrl` is not configured, the "Browse" button is not rendered.
- **Type audit:** Exported types match the plan specification — verify that `webserverUrl` is optional (`?`) in `AppConfig`.

## Testing Strategy

- **Backend config tests:** Unit tests for `loadConfig()` with and without `webserverUrl` in the config file.
- **Backend API tests:** HTTP-level tests for GET and PUT endpoints, including validation edge cases (missing body, wrong type, empty string clear).
- **Manual GUI testing:** Verify the settings section renders, saves, and populates correctly. Verify the Browse button appears/disappears based on the setting, and opens the correct URL.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Trailing slash inconsistency** in URL construction | `PUT` endpoint strips trailing slashes from the stored URL; URL construction always inserts a slash between segments. |
| **User enters a URL with path components** that duplicate the project path | Documentation in the settings description makes it clear this should be the base URL pointing to the `projectsFolder` root. |
| **Dangerous URL scheme** (`javascript:`, `data:`) | The PUT endpoint rejects `javascript:`, `data:`, and `vbscript:` schemes (defence-in-depth — `window.open('javascript:...')` can execute code in some browsers). |
| **Trailing slash in manually edited `config.json`** | `loadConfig()` strips trailing slashes at read time in addition to the PUT endpoint stripping at write time, preventing double-slash URLs. |
| **Fetch failure for webserver URL during workspace-detail load** | Use `Promise.allSettled()` — a failure to fetch the config simply hides the Browse button (graceful degradation). |
