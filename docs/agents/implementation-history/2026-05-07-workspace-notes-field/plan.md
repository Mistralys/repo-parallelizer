# Plan

## Summary

Add a free-form "Notes" text field to the workspace detail view in the GUI, positioned below the repositories list, with debounced auto-save on changes. Additionally, add a new top-level **"Notes"** navigation item with a two-panel layout: a **sidebar** listing all workspaces grouped by project (for quick access), and a **main content area** showing editable note cards. Clicking a workspace in the sidebar either scrolls to its existing note card or opens a new empty card for it.

## Architectural Context

- **Data model**: `ProjectWorkspace` ([src/models/project/project.types.ts](src/models/project/project.types.ts)) defines the per-workspace fields stored in `{storageFolder}/projects/{id}.json`. Current fields: `Description`, `DateCreated`, `DateModified`.
- **Manager**: `WorkspaceManager` ([src/models/workspace/workspace.manager.ts](src/models/workspace/workspace.manager.ts)) provides stateless CRUD. Its `update()` method accepts `{ Description?: string }` and always touches `DateModified`.
- **Route handler**: `PUT /api/projects/:id/workspaces/:wid` ([src/server/routes/workspaces.ts](src/server/routes/workspaces.ts)) currently requires a `description` field in the request body.
- **API client**: `api.workspaces.update(projectId, wid, data)` ([gui/public/js/api.js](gui/public/js/api.js)) sends an arbitrary object as the PUT body.
- **Normaliser**: `normaliseWorkspace()` ([gui/public/js/utils/normalise.js](gui/public/js/utils/normalise.js)) maps backend PascalCase keys to camelCase for views.
- **View**: `renderWorkspaceDetail()` ([gui/public/js/views/workspace-detail.js](gui/public/js/views/workspace-detail.js)) renders the full workspace page. The current DOM assembly order is: header → health alerts → refresh toolbar → status table → retry row → switch-branches button.
- **Type contract**: `WorkspaceInfo` ([src/models/workspace/workspace.types.ts](src/models/workspace/workspace.types.ts)) is the flat view returned by the manager; needs to carry the new field.
- **Navigation**: The `<nav class="nav-links">` in [gui/public/index.html](gui/public/index.html) contains Dashboard, Repositories, Error Log, Settings. Active state is managed by [gui/public/js/utils/nav-highlight.js](gui/public/js/utils/nav-highlight.js) using prefix matching.
- **Router & app.js**: [gui/public/js/app.js](gui/public/js/app.js) registers all hash routes and injects routers into views that need programmatic navigation.
- **Backend aggregation**: `GET /api/projects` returns index entries only (Id, Name). Full project data (including all Workspaces) requires fetching each project individually via `GET /api/projects/:id`.

## Approach / Architecture

### Part A: Workspace Notes Field (Backend + Workspace Detail)

Add an **optional** `Notes` field (`string`, default `''`) to the `ProjectWorkspace` interface, threaded through:

1. **Backend model** → **Manager** → **Route handler** (accept notes in PUT)
2. **API client** (already generic — no change needed)
3. **Normaliser** → **View** (textarea with debounced auto-save)

The notes field is **independent** of the description field. The PUT endpoint is relaxed to accept `notes` and/or `description` (at least one must be present).

### Part B: New REST Endpoint for Notes Data

Add a dedicated **`GET /api/notes`** endpoint on the backend that returns **all** workspaces across all projects, indicating which ones have notes. Response shape:

```typescript
{
    Projects: Array<{
        ProjectId: string;
        ProjectName: string;
        Workspaces: Array<{
            WorkspaceId: string;
            Notes: string;  // empty string when no notes
        }>;
    }>;
}
```

This single endpoint serves both the sidebar (full workspace tree) and the main content (non-empty notes). Returning all workspaces avoids a second fetch for the sidebar.

### Part C: Notes Navigation View (Frontend)

Add a new route `#/notes` with a **two-panel layout**:

**Left panel — Sidebar:**
- All workspaces grouped by project (collapsible project groups).
- Workspaces with existing notes are visually distinguished (e.g. bold or a dot indicator).
- Clicking a workspace with notes scrolls the main panel to focus its card.
- Clicking a workspace without notes creates a new empty note card in the main panel and scrolls to it.

**Right panel — Main content:**
- On initial load, shows cards only for workspaces that already have non-empty notes.
- Each card has a header row (project name › workspace ID, linking to the workspace detail view), an editable `<textarea>`, and a save-status indicator.
- Cards added via the sidebar start with an empty textarea.
- Auto-save on change (1000 ms debounce).
- When a note is saved as empty, the card is removed from the main panel and the sidebar indicator is updated.

### Auto-save Pattern

Both the workspace-detail textarea and the notes-view textareas use a **debounce of 1000 ms** after the last keystroke. A subtle "Saving…" / "Saved" indicator next to the label provides feedback.

## Rationale

- Extending the existing `PUT` endpoint avoids introducing a new endpoint for single-field updates.
- A dedicated `GET /api/notes` aggregation endpoint prevents the frontend from having to fetch every project individually just to collect notes.
- Storing notes inside the project JSON file means no new storage files or schemas are needed.
- Making `Notes` optional and defaulting to `''` preserves backward compatibility with existing data files that lack the field.
- A 1-second debounce balances responsiveness with avoiding excessive I/O on each keystroke.
- Placing "Notes" in the main nav gives quick access to the collected scratchpad.

## Detailed Steps

### Step 1: Extend `ProjectWorkspace` interface

**File:** `src/models/project/project.types.ts`

Add:
```typescript
/** Free-form workspace notes / scratchpad. Optional; defaults to empty string. */
Notes?: string;
```

### Step 2: Extend `WorkspaceInfo` type

**File:** `src/models/workspace/workspace.types.ts`

Add `Notes: string` (always present in the flat view — manager resolves the optional backend field to `''`).

### Step 3: Update `WorkspaceManager`

**File:** `src/models/workspace/workspace.manager.ts`

- In `list()` and `getById()`: include `Notes: ws.Notes ?? ''` in the returned object.
- In `update()`: extend the `changes` parameter type to `{ Description?: string; Notes?: string }` and pass `Notes` through to `projectManager.updateWorkspace()` when provided.

### Step 4: Update `ProjectManager.updateWorkspace()`

**File:** `src/models/project/project.manager.ts`

Currently accepts `Partial<{ Description: string; DateModified: string }>`. Extend to `Partial<{ Description: string; DateModified: string; Notes: string }>`.

Add a conditional assignment for `Notes` following the same pattern as `Description`:
```typescript
if (changes.Notes !== undefined) {
    ws.Notes = changes.Notes;
}
```

### Step 5: Update REST workspace route handler

**File:** `src/server/routes/workspaces.ts`

Relax the `PUT /api/projects/:id/workspaces/:wid` handler:
- Accept body shape `{ description?: string, notes?: string }`.
- Require at least one of `description` or `notes` to be present (return 400 otherwise).
- When `description` is present, include `Description` in the changes object.
- When `notes` is present (must be a string), include `Notes` in the changes object.

### Step 6: Add `GET /api/notes` endpoint

**File:** `src/server/routes/notes.ts` *(new file)*

Create a new route module that exports `registerNotesRoutes(router, projectManager)`:

```typescript
// GET /api/notes
// Returns: { Projects: Array<{ ProjectId, ProjectName, Workspaces: Array<{ WorkspaceId, Notes }> }> }
```

Implementation:
1. Call `projectManager.list()` to get all project index entries.
2. For each project, call `projectManager.getById(id)` to load full data.
3. Iterate `project.Workspaces`, collect all workspaces with their notes (including empty).
4. Return the structured response sorted by project name, then workspace ID within each project.

### Step 7: Register the notes route in the server

**File:** `src/server/index.ts`

Import and call `registerNotesRoutes(router, projectManager)` alongside the existing route registrations.

### Step 8: Add `api.notes.list()` to the API client

**File:** `gui/public/js/api.js`

Add a new namespace:
```javascript
const notes = {
    list() {
        return request('GET', '/api/notes');
    },
};
```

Export it as `api.notes` in the final `api` object.

### Step 9: Update normaliser

**File:** `gui/public/js/utils/normalise.js`

Add `notes` field to `normaliseWorkspace()`:
```javascript
notes: ws.Notes || ws.notes || '',
```

Add a new `normaliseNotesResponse()` helper to map the PascalCase `GET /api/notes` response to camelCase:
```javascript
export function normaliseNotesResponse(data) {
    return {
        projects: (data.Projects || data.projects || []).map((p) => ({
            projectId:   p.ProjectId   || p.projectId   || '',
            projectName: p.ProjectName || p.projectName || '',
            workspaces: (p.Workspaces || p.workspaces || []).map((ws) => ({
                workspaceId: ws.WorkspaceId || ws.workspaceId || '',
                notes:       ws.Notes       || ws.notes       || '',
            })),
        })),
    };
}
```

### Step 10: Build the notes section in workspace-detail view

**File:** `gui/public/js/views/workspace-detail.js`

Add a new helper function `buildNotesSection(projectId, wid, initialNotes)` that:
- Creates a `<section class="workspace-notes-section">` element.
- Renders a `<label>` ("Notes") with a subtle save-status indicator (`<span class="notes-save-status">`).
- Renders a `<textarea class="workspace-notes-textarea">` pre-filled with `initialNotes`.
- Wires an `input` event listener with a 1000 ms debounce that calls `api.workspaces.update(projectId, wid, { notes: textarea.value })`.
- On save success: shows "Saved" indicator (fades after 2s).
- On save failure: shows a toast error.
- Returns the section element.

Insert the section into the DOM assembly after the status table section (before the retry row / switch-branches button).

### Step 11: Create the Notes collected view

**File:** `gui/public/js/views/notes.js` *(new file)*

Create a view module exporting `renderNotes(container, params)` and `setRouter(router)`:

1. Show loading state using `clearElement(container)` from `../utils/dom.js` before rendering (per project constraint — no `innerHTML = ''`).
2. Fetch `api.notes.list()` — returns `{ projects: [...] }` with all workspaces grouped by project.
3. Render a **two-panel layout** (`<div class="notes-layout">`):

**Left panel — Sidebar** (`<aside class="notes-sidebar">`):
- For each project, render a collapsible group:
  - `<div class="notes-sidebar-group">` with a project name header (`<h3 class="notes-sidebar-project">`).
  - A list of workspace items (`<button class="notes-sidebar-item">`) displaying the workspace ID.
  - Items with non-empty notes get a `.has-notes` class (visually distinguished, e.g. bold text or a small dot indicator).
- Clicking a sidebar item:
  - If a card for that workspace already exists in the main panel → smooth-scroll to it and briefly highlight it (CSS flash animation).
  - If no card exists → create a new empty note card, append it to the main panel, scroll to it, and focus the textarea.

**Right panel — Main content** (`<div class="notes-main">`):
- On initial load, render cards only for workspaces with non-empty notes.
- If no workspaces have notes, show an empty-state message: "No workspace notes yet. Select a workspace from the sidebar to start writing."
- Each `.notes-card` contains:
  - A header row: **"Project Name › WORKSPACE_ID"** — workspace ID is a clickable link (`<a>`) navigating to `#/projects/:id/workspaces/:wid`.
  - A `<textarea class="workspace-notes-textarea">` pre-filled with the note text (or empty for newly opened cards).
  - A save-status indicator (`<span class="notes-save-status">`).
  - Debounced auto-save (1000 ms) calling `api.workspaces.update(projectId, workspaceId, { notes: value })`.
  - On successful save:
    - If the new text is non-empty → update sidebar item to `.has-notes`.
    - If the new text is empty → remove the card from the main panel, remove `.has-notes` from the sidebar item.
- Each card has a `data-project-id` and `data-workspace-id` attribute for sidebar click targeting.

4. Return no cleanup function (no polling/intervals needed).

### Step 12: Register the Notes route and navigation

**File:** `gui/public/js/app.js`

- Import `renderNotes` and `setRouter as setNotesRouter` from `./views/notes.js`.
- Call `setNotesRouter(router)`.
- Register `router.register('#/notes', renderNotes)`.

**File:** `gui/public/index.html`

Add a nav link between "Repositories" and "Error Log":
```html
<a href="#/notes" class="nav-link">Notes</a>
```

### Step 13: Add CSS styling

**File:** `gui/public/css/styles.css`

Add styles for:
- `.workspace-notes-section` — spacing and layout in workspace-detail.
- `.workspace-notes-textarea` — full-width textarea, min-height ~120px, resize vertical.
- `.notes-save-status` — subtle indicator text (opacity transition for fade).
- `.notes-layout` — two-panel flexbox layout (sidebar + main).
- `.notes-sidebar` — fixed-width left panel (~220px), scrollable, border-right separator.
- `.notes-sidebar-group` — project group with bottom spacing.
- `.notes-sidebar-project` — project name header (smaller font, uppercase, muted).
- `.notes-sidebar-item` — workspace button (full-width, text-align left, subtle hover).
- `.notes-sidebar-item.has-notes` — visual indicator for workspaces with notes (bold or dot).
- `.notes-main` — flex-grow right panel, scrollable, padding.
- `.notes-card` — card styling (border, padding, margin-bottom).
- `.notes-card-header` — header row with project/workspace links.
- `.notes-card.highlight` — brief flash animation for scroll-to-focus (via CSS keyframes).

### Step 14: Add backend tests

**File:** `src/tests/workspace.manager.test.ts`

Add test cases:
- `update()` with only `Notes` succeeds and persists the value.
- `update()` with both `Description` and `Notes` succeeds.
- `getById()` returns `Notes` field (default empty string for existing workspaces without notes).

### Step 15: Add route handler tests for workspace PUT

Extend workspace route tests to verify:
- PUT with `{ notes: "..." }` (no description) succeeds.
- PUT with `{ description: "...", notes: "..." }` succeeds.
- PUT with empty body returns 400.

### Step 16: Add route handler tests for `GET /api/notes`

**File:** `src/server/__tests__/routes/notes.test.ts` *(new file)*

Test cases:
- Returns empty projects array when no projects exist.
- Returns all workspaces for each project (including those without notes).
- `notes` field is empty string for workspaces without notes, populated string for those with notes.
- Results are sorted by project name, then workspace ID within each project.

### Step 17: Update project manifest documents

Per AGENTS.md §2 manifest maintenance rules, update:

- **`docs/agents/project-manifest/rest-api.md`** — Add `GET /api/notes` endpoint documentation with method, path, and response shape.
- **`docs/agents/project-manifest/api-surface.md`** — Update `ProjectWorkspace` (add `Notes?: string`), `WorkspaceInfo` (add `Notes: string`), and `WorkspaceManager.update()` (extended `changes` parameter).
- **`docs/agents/project-manifest/gui-frontend.md`** — Add `#/notes` route, `notes.js` view module, and the "Notes" nav link.

## Dependencies

- No new runtime dependencies.
- No new dev dependencies.

## Required Components

| Component | Action |
|---|---|
| `src/models/project/project.types.ts` | Modify — add `Notes?` to `ProjectWorkspace` |
| `src/models/workspace/workspace.types.ts` | Modify — add `Notes` to `WorkspaceInfo` |
| `src/models/workspace/workspace.manager.ts` | Modify — thread Notes through CRUD |
| `src/models/project/project.manager.ts` | Modify — accept Notes in `updateWorkspace()` |
| `src/server/routes/workspaces.ts` | Modify — relax PUT handler to accept notes |
| `src/server/routes/notes.ts` | **New** — `GET /api/notes` aggregation endpoint |
| `src/server/index.ts` | Modify — register notes routes |
| `gui/public/js/api.js` | Modify — add `api.notes` namespace |
| `gui/public/js/utils/normalise.js` | Modify — add notes field |
| `gui/public/js/views/workspace-detail.js` | Modify — add notes section |
| `gui/public/js/views/notes.js` | **New** — collected notes view |
| `gui/public/js/app.js` | Modify — register `#/notes` route |
| `gui/public/index.html` | Modify — add "Notes" nav link |
| `gui/public/css/styles.css` | Modify — add notes styling |
| `docs/agents/project-manifest/rest-api.md` | Modify — add `GET /api/notes` endpoint |
| `docs/agents/project-manifest/api-surface.md` | Modify — update `ProjectWorkspace`, `WorkspaceInfo`, `WorkspaceManager.update()` |
| `docs/agents/project-manifest/gui-frontend.md` | Modify — add `#/notes` route and `notes.js` view |
| `src/tests/workspace.manager.test.ts` | Modify — add test cases |
| `src/server/__tests__/routes/notes.test.ts` | **New** — route tests for `GET /api/notes` |

## Assumptions

- The notes field has no length validation beyond the 1 MB body limit already enforced by `parseJsonBody()`.
- Notes are plain text — no Markdown rendering in the frontend (just a `<textarea>`).
- Auto-save replaces the full notes string on each save (no diff/merge conflict handling).
- Concurrent editing from multiple browser tabs is not a concern (single-user tool).
- The `GET /api/notes` endpoint performs a full scan of all projects — acceptable performance for a single-user local tool with a small number of projects.
- When a note is edited to empty in the collected view, the card is removed and the sidebar indicator is updated.
- The sidebar shows all workspaces regardless of whether they have notes (enabling quick access to any workspace's notes).

## Constraints

- All relative TypeScript imports must use `.js` extensions.
- `WorkspaceManager` is stateless — no caching of notes between calls.
- GUI code must use vanilla JS (no framework, no build step).
- `clearElement()` must be used for DOM clearing (no `innerHTML = ''`).
- The notes nav link must use the same `nav-link` class for consistent active-state highlighting.
- The sidebar must remain scrollable independently of the main content panel.

## Out of Scope

- Rich-text editing or Markdown rendering.
- Notes history / undo.
- Per-repository notes (this is workspace-level only).
- Full-text search across notes.
- Sorting/filtering options in the sidebar.
- Drag-and-drop reordering of note cards.
- Real-time sync between the notes view and the workspace-detail view (navigating between them re-fetches fresh data).

## Acceptance Criteria

- A `<textarea>` with label "Notes" is visible below the repository status table on the workspace detail view.
- Typing in the textarea auto-saves after 1 second of inactivity.
- A "Saved" indicator appears briefly after a successful save.
- Navigating away and returning to the workspace shows the persisted notes.
- Existing workspaces without notes continue to function (empty string default).
- The PUT endpoint accepts `{ notes: "..." }` without requiring `description`.
- A "Notes" link appears in the main navigation bar.
- The `#/notes` view has a two-panel layout: sidebar (left) and note cards (right).
- The sidebar lists all workspaces grouped by project.
- Sidebar items for workspaces with existing notes are visually distinguished.
- Clicking a sidebar item for a workspace with notes scrolls to and highlights its card.
- Clicking a sidebar item for a workspace without notes creates a new empty card and focuses it.
- Each note card shows the workspace ID as a clickable link to the workspace detail.
- Each note card has an editable textarea with debounced auto-save.
- Editing a note to empty removes the card and updates the sidebar indicator.
- `GET /api/notes` returns all workspaces grouped by project with their notes.
- Backend tests pass for the new notes field and the aggregation endpoint.
- **Type audit:** `ProjectWorkspace.Notes` is `string | undefined`, `WorkspaceInfo.Notes` is `string`.

## Testing Strategy

- **Unit tests (backend):** Verify `WorkspaceManager.update()` persists notes, verify `getById()` returns notes defaulting to empty string.
- **Route tests (workspace):** Verify the relaxed PUT handler accepts notes-only, description-only, and both.
- **Route tests (notes):** Verify `GET /api/notes` returns all workspaces grouped by project with correct notes values.
- **Manual testing (GUI):** Type in the notes textarea (both workspace-detail and collected view), verify auto-save indicator, navigate away and back, confirm persistence. Test sidebar interactions: click workspace with notes (scroll + highlight), click workspace without notes (new card appears). Verify nav link highlighting.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Rapid typing causes excessive API calls** | 1000 ms debounce ensures at most 1 request per second of inactivity. |
| **Large notes bloating JSON file** | Acceptable — single-user tool with 1 MB body limit; workspace files are tiny. |
| **Breaking change to PUT endpoint** | Backward compatible — existing callers sending `{ description }` still work. New behavior only adds optional `notes` field. |
| **`GET /api/notes` performance with many projects** | Acceptable for a local tool. All data is read from local JSON files — no network I/O. |
| **Race condition on concurrent saves** | Not a concern — single-user local tool. Last-write-wins is acceptable. |
| **Stale data in collected view after editing in workspace-detail** | Acceptable — navigating to `#/notes` re-fetches all data. No real-time sync needed. |
| **Sidebar gets long with many projects/workspaces** | Independent scrolling with a fixed height; project groups provide visual structure. |
