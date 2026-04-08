# HTTP Server

Built-in HTTP server providing a REST API and static file serving for the GUI. Uses only Node.js built-in `http` module — no Express or other framework.

## Key Concepts

- **Custom Router**: Method-based route registration with path parameter extraction (`:param` syntax).
- **Static file server**: Serves the `gui/public/` directory for the frontend SPA.
- **Polling Manager**: Periodically fetches git status for active workspaces, caching results for the GUI.
- **REST API**: Full CRUD for repositories, projects, workspaces, plus branch operations and status polling.

## Folder Structure

| Directory/File | Responsibility |
|---|---|
| `index.ts` | Server start/stop lifecycle |
| `router.ts` | HTTP request router with parameter extraction |
| `staticServer.ts` | Static file serving for GUI assets |
| `pollingManager.ts` | Periodic git status polling and caching |
| `requestUtils.ts` | JSON body parsing, response helpers |
| `routes/` | REST API endpoint handlers (one file per resource domain) |
| `__tests__/` | Server-specific unit tests |

## Integration Points

- **Dependencies**: `config`, `models` (all managers), `orchestration` (all orchestrators).
- **Consumed by**: CLI entry point (server start), GUI (REST API).
- **Serves**: `gui/public/` as static files.
