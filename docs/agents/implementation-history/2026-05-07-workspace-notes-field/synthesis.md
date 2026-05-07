# Synthesis Report — Workspace Notes Field
**Plan:** `2026-05-07-workspace-notes-field`  
**Date:** 2026-05-07  
**Status:** COMPLETE  
**Duration:** ~2 hours (08:10 – 10:19 UTC)  
**Work Packages:** 14 / 14 COMPLETE  

---

## Executive Summary

This session delivered the **workspace notes field** end-to-end across the full stack. Users can now attach free-form text notes to any workspace, with automatic persistence and two entry points in the GUI:

1. **Workspace Detail view** — a `Notes` textarea below the repository status table, auto-saving after 1 000 ms of inactivity with `Saving…` / `Saved` status feedback.
2. **Notes Collected view** (`#/notes`) — a new two-panel SPA view: a collapsible sidebar listing all workspaces (with visual dot indicator for those with notes) and a main panel of editable note cards, each linking back to the workspace detail view.

The feature is fully backward-compatible: pre-existing workspaces without stored notes default to `Notes: ''` on all read paths via `??` null-coalescing — no storage schema migration required.

---

## Scope of Changes

### Backend

| File | Change |
|---|---|
| `src/models/project/project.types.ts` | Added `Notes?: string` to `ProjectWorkspace` |
| `src/models/workspace/workspace.types.ts` | Added `Notes: string` to `WorkspaceInfo` |
| `src/models/workspace/workspace.manager.ts` | `update()` accepts `Notes`, all 5 `WorkspaceInfo` factory sites include `ws.Notes ?? ''` |
| `src/models/project/project.manager.ts` | `updateWorkspace()` Pick type expanded to include `'Notes'` |
| `src/server/routes/workspaces.ts` | `PUT /:wid` handler accepts `notes` field alongside `description` |
| `src/server/routes/notes.ts` | **New** — `GET /api/notes` route (all projects + workspace notes) |
| `src/server/index.ts` | `registerNotesRoutes()` registered |
| 6 × server test fixture files | `Notes: ''` added to `WorkspaceInfo` mock objects |
| `src/tests/workspace.manager.test.ts` | 5 new tests covering Notes persistence, defaults, DateModified |
| `src/server/__tests__/routes/workspaces.test.ts` | 4 new tests (notes-only, description-only, both, empty 400) |
| `src/server/__tests__/routes/notes.test.ts` | **New** — 8 tests including 500 error path |

### Frontend

| File | Change |
|---|---|
| `gui/public/js/api.js` | `api.notes.list()` namespace + JSDoc typedefs (`NotesResponse`, `NotesProject`, `NotesWorkspace`) |
| `gui/public/js/utils/normalise.js` | `normaliseWorkspace()` gains `notes` field; new `normaliseNotesResponse()` |
| `gui/public/js/views/workspace-detail.js` | `buildNotesSection()` helper — textarea, debounce, status indicator |
| `gui/public/js/views/notes-collected.js` | **New** — two-panel Notes Collected view |
| `gui/public/js/views/notes-collected.test.mjs` | **New** — 19 tests covering all 9 acceptance criteria |
| `gui/public/js/views/workspace-detail.notes.test.mjs` | **New** — 7 tests covering all 6 AC for the detail textarea |
| `gui/public/js/app.js` | `#/notes` → `renderNotesCollected` route registered |
| `gui/public/index.html` | `Notes` nav link added |
| `gui/public/css/styles.css` | `.workspace-notes-*`, `.notes-view`, `.notes-sidebar-*`, `.notes-card-*`, `.notes-empty-state` CSS |

### Documentation

| File | Change |
|---|---|
| `docs/agents/project-manifest/api-surface.md` | Notes fields on `ProjectWorkspace` / `WorkspaceInfo`; updated manager signatures; `normaliseNotesResponse()`, `renderNotesCollected()` |
| `docs/agents/project-manifest/rest-api.md` | `GET /api/notes` endpoint; expanded `PUT /:wid` body schema |
| `docs/agents/project-manifest/gui-frontend.md` | `#/notes` route, `buildNotesSection()` helper, `normaliseNotesResponse()`, eight API namespaces count |
| `docs/agents/project-manifest/tech-stack.md` | GUI browser requirements (`color-mix()` — Chromium 111+, Firefox 113+, Safari 16.2+) |
| `.context/` (9 files) | Regenerated via `ctx generate` (WP-008) |

---

## Metrics

| Metric | Value |
|---|---|
| WPs completed | 14 / 14 |
| Pipeline stages executed | 52 total (all PASS) |
| Code-review FAIL → rework cycles | 1 (WP-004: missing `try/catch` in `GET /api/notes`) |
| Security audits | 2 (WP-003, WP-004) — 0 Critical, 0 High, 0 Medium |
| Reviewer Fix-Forward patches applied | 4 |
| Backend tests (final) | 780 passing, 0 failures |
| GUI tests (final) | 172 passing, 0 failures |
| TypeScript compile | Clean (`tsc --noEmit`) |
| New backend test files | 1 (`notes.test.ts`) |
| New GUI test files | 2 (`notes-collected.test.mjs`, `workspace-detail.notes.test.mjs`) |

---

## Pipeline Incidents

### WP-004 — Code-Review FAIL (rework required)

**Root cause:** `src/server/routes/notes.ts` — the `GET /api/notes` handler had no `try/catch` around `projectManager.list()` / `workspaceManager.list()`. The project's `Router` documents that handlers own their error responses; when the router's `.catch()` fires it only logs — the client connection would hang on any storage error.

**Fix:** Wrapped handler body in `try/catch`; added `sendError(res, 500, 'Internal server error.')` in the catch clause. Added a new test `GET /api/notes returns 500 when projectManager.list() throws`. Rework PASS confirmed by both QA and Security Auditor re-audit.

**Lesson:** Any new route handler added to this codebase must wrap manager calls in `try/catch` and send a `500` response in the catch clause. This is not enforced by the router — it is a handler-level responsibility.

---

## Strategic Recommendations (Gold Nuggets)

### 1. `toWorkspaceInfo()` Factory Helper — High Priority

`workspace.manager.ts` has **5 hand-rolled `WorkspaceInfo` object literals** (`list`, `getById`, `update`, `rename`, `create`). This WP required updating all 5 to add `Notes`. Flagged by both the Developer (WP-001) and the Reviewer:

> "A private `toWorkspaceInfo(projectId, workspaceId, ws, notes?)` helper would make future field additions a one-site change."

**Recommendation:** Extract a `private toWorkspaceInfo()` helper before the next field is added.

### 2. Missing `Notes: ''` Assertions in Manager Tests — Low Priority

`workspace.manager.test.ts` tests `list WorkspaceInfo entries include all required fields` and `create returns WorkspaceInfo with correct fields` do not assert `Notes: ''`. TypeScript compensates at compile time, but an explicit assertion would catch a runtime regression the compiler cannot. Flagged by QA (WP-001).

### 3. `api-surface.md` GUI Views Section is Incomplete — Medium Priority

Only `renderNotesCollected()` was added to `api-surface.md` as a result of a code-review documentation-forward. Several existing view functions (`renderDashboard`, `renderRepositories`, etc.) remain undocumented there. A dedicated documentation pass should enumerate all `render*` exports for full discoverability.

### 4. `Save failed.` Status Text Does Not Auto-Hide — Low Priority (UX)

Both `workspace-detail.js` and `notes-collected.js` auto-hide the `Saved` indicator after 3 seconds, but `Save failed.` persists until the user types again. Inconsistent UX — both views should auto-hide error state on the same timer. Flagged by QA (WP-007, WP-008) and Reviewer (WP-008).

### 5. `notes.test.ts` Mock Lacks `destroy()` Stub — Low Priority

`mockRequest()` in `src/server/__tests__/routes/notes.test.ts` does not include a `destroy()` stub, unlike the analogous helper in `workspaces.test.ts`. Harmless since `GET /api/notes` never reads the request body, but creates a subtle mock inconsistency. Flagged by Reviewer (WP-004) and carried through QA re-verification.

### 6. Notes View Height Calc — Fixed, but Broader Pattern Applies

The `calc(100vh - var(--nav-height))` pattern was used for `.notes-view` — causing a scroll seam because `<main>` adds `24px` top + bottom padding. The Reviewer applied a Fix-Forward: `calc(100vh - var(--nav-height) - 48px)`. The `#app` element already used this correct form. **Any future full-height view** should use the 48 px–subtracted form from the start.

---

## Security Notes

- **XSS safety:** All dynamic text in `notes-collected.js` and `workspace-detail.js` uses `textContent`; workspace-detail links use `encodeURIComponent`. No `innerHTML` with user data.
- **Input validation:** `notes` field validated as `typeof string` before use; body size capped at 1 MB by `parseJsonBody`. No per-field length constraint — consistent with existing `description` handling; low risk for local-only tool.
- **Error masking:** `GET /api/notes` 500 response returns `'Internal server error.'`, not the raw exception message.
- **No new dependencies introduced.**

---

## Next Steps for the Planner

1. **Implement `toWorkspaceInfo()` helper** in `workspace.manager.ts` to eliminate the 5-site WorkspaceInfo factory duplication before the next workspace field is added.
2. **Auto-hide `Save failed.` status** in both `workspace-detail.js` and `notes-collected.js` (3-second timeout, matching `Saved` behaviour).
3. **Complete api-surface.md GUI Views section** — document remaining `render*` exports (dashboard, repositories, settings, error-log views).
4. **Add `Notes: ''` assertions** to `workspace.manager.test.ts` list and create tests (explicit coverage of runtime default).
5. **Run `ctx generate`** to refresh `.context/` after WP-010 changed `gui-frontend.md` and `tech-stack.md` (WP-008 regeneration is stale).
