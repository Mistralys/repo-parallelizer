## Synthesis

### Completion Status
- Date: 2026-04-15
- Status: COMPLETE
- Completed by: Standalone Developer Agent

### Implementation Summary
- Added `webserverUrl?: string` to the `AppConfig` interface and `config.dist.json` (empty default, no migration needed for existing installs).
- `loadConfig()` now parses `webserverUrl` from `config.json`: absent/null/empty-string all map to `undefined`; non-empty values are trimmed and have trailing slashes stripped.
- Added `GET /api/config/webserver-url` and `PUT /api/config/webserver-url` endpoints to `registerConfigRoutes()`. The PUT handler validates input type, strips trailing slashes, rejects dangerous URL schemes (`javascript:`, `data:`, `vbscript:`), and persists via the existing `saveConfigField()` helper.
- Added `api.config.webserverUrl.get()` and `api.config.webserverUrl.set(url)` methods to the frontend API client.
- Added a `buildWebserverUrlSection()` function to `settings.js`, wired into `renderSettings()` between the Refresh Delay section and the footer. Its `save()` is included in the `Promise.all()` inside the "Save Settings" footer button.
- Added a conditional "Browse" button to `buildRepoStatusRow()` in `workspace-detail.js`. The button is rendered before "Git GUI" when `webserverUrl` is truthy; clicking it opens `{webserverUrl}/{projectId}/{workspaceId}/{repoId}/` in a new tab via `window.open`. The webserver URL is fetched once during the initial `Promise.all()` data load and passed down through `buildStatusTableSection()` to each row.

### Documentation Updates
- `docs/agents/project-manifest/api-surface.md`: Added `webserverUrl?: string` to the `AppConfig` type block.
- `docs/agents/project-manifest/rest-api.md`: Added full "Webserver URL" section documenting the two new endpoints, validation rules, and request/response shapes.
- `docs/agents/project-manifest/gui-frontend.md`: Updated the Settings route description to list three sections; updated workspace-detail to describe the Browse button and its URL construction; added `api.config.webserverUrl` to the API client namespace list.

### Verification Summary
- Tests run: `npm test` (full suite — all test files via Node.js built-in test runner)
- Static analysis run: `npm run build` (TypeScript strict-mode compile)
- Result: **PASS** — 752 tests, 0 failures; 0 TypeScript errors. 19 new tests added (7 `loadConfig` cases, 12 route-level cases).

### Code Insights
- [low] (improvement) `src/server/routes/config.ts`: **IMPLEMENTED** — Extracted a private `extractScheme(url: string): string` helper for the URL scheme validation in the `PUT /api/config/webserver-url` handler. The helper is reusable for any future URL-handling endpoints in this file.
- [low] (debt) `gui/public/js/views/workspace-detail.js`: **IMPLEMENTED** — Added `.catch(() => null)` guard to `api.status.refresh()` in the initial `Promise.all()`. A transient status-refresh failure no longer kills the entire view render; the page loads with empty status badges (same graceful degradation as polling, health, and webserver URL fetches). The `workspace.get` and `projects.get` fetches remain unguarded — those are genuinely critical and should propagate to the error view.
- [low] (improvement) `gui/public/js/views/workspace-detail.js`: **IMPLEMENTED** — Refactored `buildRepoStatusRow` from 8 positional parameters to a single named options object (`{ repoId, repoName, statusInfo, projectId, wid, isStable, onBranchCellClick, webserverUrl }`). The call site in `buildStatusTableSection` updated to match. JSDoc updated to document the options shape.

### Additional Comments
- The `webserverUrl` field is intentionally absent from `config.dist.json` as a non-empty value — it is set to `""` (empty string) which `loadConfig()` treats as "not configured". This means existing installations picking up the new `config.dist.json` as a reference are unaffected.
- The Browse button uses `encodeURIComponent` on projectId, workspaceId, and repoId to ensure URL safety when IDs contain special characters.
