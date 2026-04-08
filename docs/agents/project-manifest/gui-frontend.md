# GUI Frontend

The frontend is a vanilla JavaScript SPA with no build step, served as static files by the built-in HTTP server from `gui/public/`.

## Architecture

- **Routing:** Hash-based client-side router (`#/path`) with named parameter extraction (`:id`, `:wid`).
- **Module system:** Native ES modules loaded by the browser. No bundler.
- **State management:** None — every view fetches fresh data from the REST API on render. Mutations trigger a full view re-render.
- **Styling:** Single CSS file with CSS custom properties for theming.

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
| `#/` | `dashboard.js` | Project listing with creation form. |
| `#/repositories` | `repositories.js` | Repository CRUD table. |
| `#/projects/:id` | `project-detail.js` | Project metadata, repo/workspace management. |
| `#/projects/:id/workspaces/:wid` | `workspace-detail.js` | Live git status with 10s polling. |
| `#/projects/:id/workspaces/:wid/branch-switch` | `branch-switch.js` | 3-step branch switch wizard. |

## API Client

`api.js` exports a namespaced `api` object with five groups:

- `api.repositories` — `list()`, `get(id)`, `create(data)`, `update(id, data)`, `delete(id)`
- `api.projects` — `list()`, `get(id)`, `create(data)`, `update(id, data)`, `rename(id, newId)`, `delete(id)`, `addRepository(pid, rid)`, `removeRepository(pid, rid)`
- `api.workspaces` — `list(pid)`, `get(pid, wid)`, `create(pid, data)`, `update(pid, wid, data)`, `rename(pid, wid, newId)`, `delete(pid, wid)`
- `api.branches` — `list(pid, wid)`, `switch(pid, wid, assignments)`
- `api.status` — `get(pid, wid)`, `refresh(pid, wid)`

## Reusable Components

| Component | File | Export | Purpose |
|---|---|---|---|
| Confirm Dialog | `components/confirm-dialog.js` | `showConfirm(title, message): Promise<void>` | Modal with Cancel/Confirm. Resolves on confirm, rejects on cancel. |
| Form Helpers | `components/form-helpers.js` | `createFormField()`, `validateRequired()`, `WORKSPACE_ID_PATTERN` | Form field generation and validation. |
| Status Badge | `components/status-badge.js` | `createStatusBadge(gitStatusInfo): HTMLElement` | Git status badge with branch pill and detail chips. |
| Toast | `components/toast.js` | `showToast(message, type, duration): HTMLElement\|null` | Auto-dismissing notification in `#toast-container`. |

## Utilities

| Utility | File | Export | Purpose |
|---|---|---|---|
| Normalise | `utils/normalise.js` | `normaliseRepo()`, `normaliseProject()`, `normaliseWorkspace()` | Maps PascalCase backend keys to camelCase frontend keys. |

## Key Patterns

### Router Injection (Avoiding Circular Dependencies)

Views that need `router.navigate()` export a `setRouter(router)` function. `app.js` calls `setRouter()` before `router.start()`. Views never import `router.js` directly.

Views using router injection: `dashboard.js`, `project-detail.js`, `workspace-detail.js`, `branch-switch.js`.

### Cleanup Contract

Views with side-effects (e.g. `setInterval` polling) return a synchronous cleanup function from their entry point. The router calls it before rendering the next view. The cleanup must be returned **before** any async operations, so the router can register it immediately.

Views returning cleanup: `workspace-detail.js` (clears 10-second polling interval).
