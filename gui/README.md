# GUI Frontend

Vanilla JavaScript single-page application for managing repositories, projects, and workspaces. No build step, no framework — served directly by the built-in HTTP server.

## Key Concepts

- **Hash-based routing**: Navigation uses URL hash fragments (`#/path`). The router extracts parameters and dispatches to view functions.
- **ES modules**: All JavaScript files use native ES module imports.
- **Dependency injection**: The router is injected into views via `setRouter()` to avoid circular imports.
- **API client**: The `api.js` module provides a namespaced client (`repositories`, `projects`, `workspaces`, `branches`, `status`) matching the REST API.

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
