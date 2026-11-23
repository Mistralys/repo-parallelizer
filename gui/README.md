# GUI Frontend

Vanilla JavaScript single-page application for managing repositories, projects, and workspaces. No build step, no framework — served directly by the built-in HTTP server.

## Key Concepts

- **Hash-based routing**: Navigation uses URL hash fragments (`#/path`). The router extracts parameters and dispatches to view functions.
- **ES modules**: All JavaScript files use native ES module imports.
- **Dependency injection**: The router is injected into views via `setRouter()` to avoid circular imports.
- **API client**: The `api.js` module provides a namespaced client (`repositories`, `projects`, `workspaces`, `branches`, `status`) matching the REST API, including `api.repositories.infoSync.*` for the opt-in `.workspace/info.json` repository sync and `api.repositories.files.*` (Milestone 2) for repository-scoped custom files, alongside `api.projects.customFiles.*` for the project-scoped equivalent.
- **Shared file editor/table component**: `components/file-definition-editor.js` (Milestone 2) factors the project Custom Files tab's table/form markup, Tab-key handling, and dirty-change tracking out into `buildFileDefinitionTable()`/`buildFileDefinitionEditor()`, reused by both `views/project-custom-files.js` and `views/repository-files-section.js` so the two near-identical file-management UIs (project-scoped vs. repository-scoped) do not diverge.
- **Static stylesheet test**: `public/js/__tests__/styles.info-sync.test.mjs` reads `public/css/styles.css` as plain text and asserts a handful of string-level accessibility/responsive rules for the info-sync CSS — the first GUI test to inspect the stylesheet rather than rendered DOM, since the jsdom test runner has no CSS engine. See `docs/agents/project-manifest/constraints.md`/`gui-frontend.md` for the pattern.

## Folder Structure

| Directory/File | Responsibility |
|---|---|
| `public/index.html` | HTML shell with `#app` container |
| `public/css/styles.css` | Full stylesheet with CSS custom properties |
| `public/js/app.js` | Application bootstrap and route registration |
| `public/js/router.js` | Hash-based SPA router with parameter extraction |
| `public/js/api.js` | REST API client with namespaced methods |
| `public/js/views/` | Page-level view functions (dashboard, project detail, etc.) |
| `public/js/components/` | Reusable UI components (dialogs, toasts, badges) |
| `public/js/utils/` | Utility functions (JSON key normalisation) |

## Integration Points

- **Dependencies**: Server REST API (all data access via HTTP).
- **Served by**: `src/server/staticServer.ts`.
