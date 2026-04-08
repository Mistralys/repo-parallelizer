# Plan — Phase 6: GUI Frontend

## Summary

Build the browser-based frontend using plain HTML, CSS, and vanilla JavaScript. This includes a hash-based client-side router, all views for managing repositories, projects, and workspaces, Git status display with polling, the multi-step branch switching workflow, confirmation dialogs for destructive operations, and a custom API client.

## Architectural Context

Phase 5 delivers:
- HTTP server on a configurable port (`serverPort`, default 4200).
- Static file serving from an arbitrary directory passed as `staticDir` to `startServer()`.
- REST API endpoints for all CRUD and orchestration operations.
- Git status polling with cached results accessible via API.
- `NotFoundError` class (`src/errors.ts`) used for type-safe 404 discrimination in route handlers.
- `isPlainObject()` utility shared via `src/server/requestUtils.ts`.

The CLI entry point (`src/index.ts`) currently only loads and validates config — it does **not** yet call `startServer()`. This phase must wire the entry point to actually start the server.

The tool description specifies:
- Frontend: Plain HTML, CSS, and vanilla JavaScript.
- Hash-based client-side router.
- Hand-written views.
- Custom API client.

## Approach / Architecture

```
gui/
├── public/
│   ├── index.html              # Single-page application shell
│   ├── css/
│   │   └── styles.css          # All application styles
│   └── js/
│       ├── app.js              # Application bootstrap and router setup
│       ├── router.js           # Hash-based client-side router
│       ├── api.js              # API client (fetch wrapper)
│       ├── components/
│       │   ├── confirm-dialog.js   # Reusable confirmation dialog
│       │   ├── status-badge.js     # Git status badge component
│       │   ├── toast.js            # Notification toasts
│       │   └── form-helpers.js     # Form validation and input helpers
│       └── views/
│           ├── dashboard.js        # Home / project overview
│           ├── repositories.js     # Repository list + CRUD
│           ├── project-detail.js   # Single project view with workspaces
│           ├── workspace-detail.js # Single workspace with repo status
│           └── branch-switch.js    # Multi-step branch switching wizard
```

The application is a single-page app (SPA) loaded from `index.html`. The hash router intercepts `hashchange` events and renders views into a main content area. Views are JavaScript modules that generate DOM elements and bind event handlers. The API client centralizes all HTTP calls.

## Rationale

- **Vanilla JS** per the spec — no React, Vue, or build tools. Files are served directly.
- **Hash-based routing** avoids server-side route handling; the server always serves `index.html` for the root.
- **JS modules** (ES module `<script type="module">`) enable clean file separation without a bundler.
- **Reusable components** (dialog, toast, status badge) avoid duplication across views.

## Detailed Steps

### 1. Application Shell

1. **Create `gui/public/index.html`**:
   - Standard HTML5 document.
   - `<link>` to `css/styles.css`.
   - Layout structure: header (app name + nav links), main content area (`<div id="app">`), toast container.
   - `<script type="module" src="js/app.js">`.

### 2. CSS Styling

2. **Create `gui/public/css/styles.css`**:
   - Clean, functional design suitable for a development tool (not marketing pretty).
   - Layout: sidebar navigation or top nav with links to Repositories, Projects.
   - Table styles for list views.
   - Form styles for create/edit forms.
   - Status badge styles: colored indicators for Git status (clean, modified, ahead, behind).
   - Modal/dialog styles for confirmations.
   - Toast notification styles (slide in/out).
   - Responsive basics (works on typical dev screen widths, no mobile optimization needed).

### 3. Hash Router

3. **Create `gui/public/js/router.js`**:
   - `Router` class:
     - `register(hashPattern, viewFunction)` — Registers a route. Supports parameters: `#/projects/:id`.
     - `navigate(hash)` — Programmatic navigation.
     - `start()` — Listens for `hashchange` events, renders the matching view into `#app`.
   - Extracts parameters from hash patterns and passes them to view functions.
   - Default route: `#/` → dashboard.

### 4. API Client

4. **Create `gui/public/js/api.js`**:
   - `api` object with methods mirroring the backend endpoints:
     - `repositories.list()`, `.get(id)`, `.create(data)`, `.update(id, data)`, `.delete(id)`
     - `projects.list()`, `.get(id)`, `.create(data)`, `.update(id, data)`, `.rename(id, newId)`, `.delete(id)`
     - `projects.addRepository(projectId, repoId)`, `.removeRepository(projectId, repoId)`
     - `workspaces.list(projectId)`, `.get(projectId, wid)`, `.create(projectId, data)`, `.update(projectId, wid, data)`, `.rename(projectId, wid, newId)`, `.delete(projectId, wid)`
     - `branches.list(projectId, wid)`, `.switch(projectId, wid, assignments)`
     - `status.get(projectId, wid)`, `.refresh(projectId, wid)`
   - Each method calls `fetch()` with the appropriate method, URL, and body.
   - Centralized error handling: non-2xx responses throw with the error message from the API.
   - **Backend response shapes to account for:**
     - `branches.list()` returns `{ branches: Record<string, BranchInfo[]>, suggestions: string[] }`. `suggestions` is a pre-computed, case-insensitive-deduplicated list of branch names across all repos — use this for the quick-pick in the wizard.
     - `branches.switch()` returns `{ results: Record<repoId, { success: boolean, conflict: boolean, error?: string }> }`. Note the `results` wrapper and the explicit `conflict` boolean per repo.
     - `status.get()` and `status.refresh()` return `Record<repoPath, GitStatusInfo | null>`, keyed by **absolute repo path** (not repo ID). The frontend must map repo paths to repository IDs/names for display (the path ends with `.../<workspaceId>/<repoId>`).

### 5. Reusable Components

5. **Create shared components**:
   - **`confirm-dialog.js`**: `showConfirm(title, message, onConfirm)` — Renders a modal dialog with Cancel/Confirm buttons. Returns a Promise that resolves on confirm, rejects on cancel.
   - **`status-badge.js`**: `createStatusBadge(gitStatusInfo)` — Returns a DOM element showing branch name, modified file count, commits ahead/behind, and last activity. Color-coded.
   - **`toast.js`**: `showToast(message, type)` — Shows a brief notification (success, error, info). Auto-dismisses.
   - **`form-helpers.js`**: `createFormField(label, type, name, options)` — Helper to generate form fields with labels and validation. `validateRequired(form, fields)` — Checks required fields and shows inline errors.

### 6. Dashboard View

6. **Create `gui/public/js/views/dashboard.js`**:
   - Lists all projects with summary info (name, repository count, workspace count).
   - Each project links to `#/projects/:id`.
   - Quick-action button to create a new project.
   - Shows repository count as a secondary stat.

### 7. Repositories View

7. **Create `gui/public/js/views/repositories.js`**:
   - Table listing all repositories: ID, Name, URL.
   - "Add Repository" button → inline form or modal: URL (required), Name (optional), ID (optional, shows inferred value).
   - Edit button per row → inline edit for Name.
   - Delete button per row → confirmation dialog explaining that the repo will be removed from all projects.

### 8. Project Detail View

8. **Create `gui/public/js/views/project-detail.js`**:
   - Header: Project name, description (editable inline), ID.
   - Section: **Repositories** — List of project's repos with "Add" (picks from global list) and "Remove" (with confirmation) actions.
   - Section: **Workspaces** — List of workspaces with:
     - Workspace ID, description, date created.
     - Link to workspace detail view.
     - Delete button (disabled for STABLE, confirmation for others).
   - "Add Workspace" button → form: ID (2-6 uppercase A-Z), description.
   - "Rename Project ID" action with confirmation dialog explaining consequences.
   - "Delete Project" button with confirmation.

### 9. Workspace Detail View

9. **Create `gui/public/js/views/workspace-detail.js`**:
   - Header: Workspace ID within project context, description.
   - **Repository Status Table**: For each repository in the workspace:
     - Repository name/ID.
     - Current branch.
     - Git status badge (modified files, commits ahead/behind, last activity, conflict indicator).
     - Error indicator for failed clones.
   - The status API returns data keyed by absolute repo path. The view must extract the repo ID from the path (last segment) or cross-reference with the project's repository list to display human-readable names.
   - Status auto-refreshes at the polling interval (re-fetches from the status API endpoint).
   - "Switch Branches" button → navigates to branch switch wizard.
   - "Rename Workspace ID" action (disabled for STABLE) with confirmation.
   - "Delete Workspace" button (disabled for STABLE) with confirmation.

### 10. Branch Switch Wizard

10. **Create `gui/public/js/views/branch-switch.js`**:
    - **Step 1: Choose Branch**
      - Text input for a new branch name.
      - OR select from the `suggestions` array returned by `branches.list()` — this is already a case-insensitive-deduplicated list of branch names across all repos.
      - "Next" button.
    - **Step 2: Assign Branches per Repo**
      - Table with one row per repository.
      - Each row has:
        - Repository name.
        - Text input pre-filled with the branch from Step 1.
        - Select dropdown populated from `branches[repoId]` (the per-repo `BranchInfo[]` from the list endpoint). The branch from Step 1 is shown in a separate option group at the top of the dropdown. Selecting an option copies the value into the text input.
      - User can customize branch per repo.
      - "Back" and "Confirm" buttons.
    - **Step 3: Results**
      - The response is `{ results: Record<repoId, { success, conflict, error? }> }`.
      - Shows per-repo outcome: success, conflict, or error.
      - When `conflict` is `true`, show a message that the user should resolve conflicts manually.
      - "Done" button returns to workspace detail.

### 11. Application Bootstrap

11. **Create `gui/public/js/app.js`**:
    - Instantiate the router.
    - Register all routes:
      - `#/` → dashboard
      - `#/repositories` → repositories
      - `#/projects/:id` → project detail
      - `#/projects/:id/workspaces/:wid` → workspace detail
      - `#/projects/:id/workspaces/:wid/branch-switch` → branch wizard
    - Start the router.

### 12. Entry Point Wiring

12. **Modify `src/index.ts`** to start the HTTP server:
    - Import `startServer` from `./server/index.js`.
    - After loading config, call `startServer()` with:
      - `appConfig`: the loaded `AppConfig`.
      - `staticDir`: resolved to `gui/public/` relative to the tool root (e.g. `path.resolve(__dirname, '..', 'gui', 'public')`).
      - `serverPort` and `pollIntervalSeconds` from the config.
    - Handle the returned Promise: log a startup message on success, write an error to stderr and exit with code 1 on failure.

### 13. Git Status Polling (Frontend)

13. **Add status polling logic** to the workspace detail view:
    - When the workspace detail view is active, set a `setInterval` that calls `api.status.get(projectId, wid)` at the configured polling interval.
    - Update the status badges in-place without re-rendering the entire view.
    - Clear the interval when navigating away from the view.

## Dependencies

- Phase 5: HTTP server with static file serving and all API endpoints.

## Required Components

- **NEW** `gui/public/index.html`
- **NEW** `gui/public/css/styles.css`
- **NEW** `gui/public/js/app.js`
- **NEW** `gui/public/js/router.js`
- **NEW** `gui/public/js/api.js`
- **NEW** `gui/public/js/components/confirm-dialog.js`
- **NEW** `gui/public/js/components/status-badge.js`
- **NEW** `gui/public/js/components/toast.js`
- **NEW** `gui/public/js/components/form-helpers.js`
- **NEW** `gui/public/js/views/dashboard.js`
- **NEW** `gui/public/js/views/repositories.js`
- **NEW** `gui/public/js/views/project-detail.js`
- **NEW** `gui/public/js/views/workspace-detail.js`
- **NEW** `gui/public/js/views/branch-switch.js`
- **MODIFY** `src/index.ts` — Wire `startServer()` call with `staticDir` pointing to `gui/public/`

## Assumptions

- Modern browsers only (ES modules, `fetch`, `async/await` — no IE11).
- Single developer using a recent Chrome/Firefox/Safari.
- No build step — JS files are served as-is.
- The frontend polling interval matches the server's polling interval (or is slightly faster to pick up cached updates promptly).

## Constraints

- No JavaScript frameworks or libraries — vanilla JS only.
- No CSS preprocessors — plain CSS only.
- No bundler — ES modules loaded directly by the browser.
- All API communication via `fetch` with JSON bodies.

## Out of Scope

- Mobile-responsive design (dev tool, used on desktop).
- Accessibility audit (functional tool, not public-facing).
- Theming or dark mode.
- Internationalization.

## Acceptance Criteria

- Opening `http://localhost:4200` in a browser shows the dashboard with a list of projects.
- User can navigate between all views using the hash-based router.
- User can perform full CRUD on repositories, projects, and workspaces through the GUI.
- Workspace detail view shows live Git status for all repositories, refreshed periodically.
- Branch switch wizard walks through all three steps and displays per-repo results.
- Confirmation dialogs appear before all destructive operations.
- Error states (failed clones, API errors) are displayed via toast notifications.
- Navigation between views is smooth with no full page reloads.

## Testing Strategy

- **Manual end-to-end testing**: Create repositories → create a project → create workspaces → switch branches → verify Git status display → delete entities.
- **API client testing**: Mock `fetch` to verify correct request construction.
- **Router testing**: Verify hash patterns match correctly and parameters are extracted.
- **Component testing**: Render confirmation dialog, toast, status badge in isolation and verify behavior.
- **Cross-browser smoke test**: Verify in Chrome and Firefox.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Vanilla JS views become hard to maintain** | Keep views small and focused; extract shared logic into components |
| **Memory leaks from polling intervals** | Clear intervals on view teardown (router calls a cleanup function) |
| **Race conditions in rapid navigation** | Views check if they're still active before updating DOM after async calls |
| **Large branch lists in the switch wizard** | Limit displayed branches; add a search/filter input |
| **No build step means no minification** | Acceptable for a local dev tool; consider later if needed |

## Work Package Decomposition

| WP     | Title                                         | Dependencies    | Plan Steps      | Files                                                         |
|--------|-----------------------------------------------|-----------------|-----------------|---------------------------------------------------------------|
| WP-001 | Application Shell, CSS, and Hash Router       | —               | 1, 2, 3         | `index.html`, `styles.css`, `router.js`                       |
| WP-002 | API Client and Reusable Components            | WP-001          | 4, 5            | `api.js`, `confirm-dialog.js`, `status-badge.js`, `toast.js`, `form-helpers.js` |
| WP-003 | Dashboard View and Application Bootstrap      | WP-001, WP-002  | 6, 11           | `dashboard.js`, `app.js`                                      |
| WP-004 | Repositories View                             | WP-003          | 7               | `repositories.js`, `app.js` (modify)                          |
| WP-005 | Project Detail View                           | WP-003          | 8               | `project-detail.js`, `app.js` (modify)                        |
| WP-006 | Workspace Detail View with Git Status Polling | WP-005          | 9, 13           | `workspace-detail.js`, `app.js` (modify), `router.js` (modify if needed) |
| WP-007 | Branch Switch Wizard                          | WP-006          | 10              | `branch-switch.js`, `app.js` (modify)                         |
| WP-008 | CLI Entry Point Wiring                        | WP-001          | 12              | `src/index.ts` (modify)                                       |

### Dependency Graph

```
WP-001 (Shell, CSS, Router)
  ├── WP-002 (API Client, Components)
  │     └── WP-003 (Dashboard, Bootstrap)
  │           ├── WP-004 (Repositories View)
  │           └── WP-005 (Project Detail View)
  │                 └── WP-006 (Workspace Detail + Polling)
  │                       └── WP-007 (Branch Switch Wizard)
  └── WP-008 (Entry Point Wiring)
```

### Notes on Parallelism

- **WP-004** and **WP-005** can be developed in parallel (both depend on WP-003, but are independent of each other).
- **WP-008** can be developed in parallel with WP-002 through WP-007 (only depends on WP-001).

### Key API Corrections (from codebase analysis)

The status API (`GET /api/projects/:id/workspaces/:wid/status`) returns `Record<repoId, GitStatusInfo | null>` keyed by **repository ID** (not absolute path as the plan's Step 4 notes originally stated). The backend route iterates `project.Repositories` and uses each repo ID as the key. This simplifies the frontend — no path-to-ID mapping is needed.
