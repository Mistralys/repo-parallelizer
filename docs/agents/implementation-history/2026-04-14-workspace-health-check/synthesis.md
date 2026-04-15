# Project Synthesis Report
**Plan:** 2026-04-14-workspace-health-check
**Date:** 2026-04-15
**Status:** COMPLETE — All 10 work packages delivered

---

## Executive Summary

This session delivered a full **Workspace Health Check** feature for the repo-parallelizer tool, covering the complete stack from backend orchestration to GUI rendering.

The feature enables the tool to detect and surface two classes of workspace health problems: missing `.code-workspace` files and uncloned repositories. Users can now see a health status badge on the project-detail workspace table and, when drilling into a workspace, view per-issue alert cards with actionable fix buttons (`Regenerate File` and `Fix Setup`). Health checks are fully integrated into the automatic polling/refresh cycle.

**Delivery scope:**

| Layer | Deliverable |
|---|---|
| Backend — Orchestration | `workspace-health.ts` — `checkWorkspaceHealth()` + `WorkspaceHealthIssue` / `WorkspaceHealthReport` types |
| Backend — Server | GET `/api/projects/:id/workspaces/:wid/health` endpoint |
| Backend — Server | POST `/api/projects/:id/workspaces/:wid/regenerate-workspace-file` endpoint |
| Frontend — API client | `api.workspaces.health()` and `api.workspaces.regenerateFile()` methods in `api.js` |
| Frontend — CSS | `.health-alert`, `.health-alert-issue`, `.health-badge` classes in `styles.css` |
| Frontend — Views | Health column + badge in `project-detail.js` |
| Frontend — Views | Health alert card with fix buttons in `workspace-detail.js` |
| Tests | 8 unit tests for `workspace-health.ts` + 11 integration tests for new endpoints |
| Documentation | `api-surface.md`, `rest-api.md`, `gui-frontend.md`, `data-flows.md` all updated; CTX regenerated |

---

## Metrics

| Metric | Value |
|---|---|
| Work packages delivered | 10 / 10 (100%) |
| Acceptance criteria met | All — 100% across all WPs |
| Test suite start (WP-001) | 699 passing |
| Test suite end (WP-009) | 718 passing |
| Net new tests | +19 |
| Security audit findings — Critical/High | 0 |
| Security audit findings — Medium | 0 |
| Security audit findings — Low/Info | 3 (all pre-existing patterns) |
| Rework cycles | 1 (WP-003 CSS — 1 implementation + 1 QA + 1 code-review re-pass) |
| Reviewer Fix-Forwards applied | 3 (WP-002, WP-003, WP-008) |

---

## Files Modified

| File | Change |
|---|---|
| `src/orchestration/workspace-health.ts` | **New** — core health check module |
| `src/server/routes/workspaces.ts` | Added GET `/health` + POST `/regenerate-workspace-file` endpoints |
| `src/server/index.ts` | Updated `registerWorkspaceRoutes()` call site (added `projectManager`) |
| `src/server/__tests__/routes/workspaces.test.ts` | Updated `buildSut()` for new signature |
| `src/server/__tests__/routes/workspaces-health.test.ts` | **New** — 11 integration tests |
| `src/tests/workspace-health.test.ts` | **New** — 8 unit tests |
| `gui/public/css/styles.css` | Health alert + badge CSS classes |
| `gui/public/js/api.js` | `api.workspaces.health()` + `api.workspaces.regenerateFile()` |
| `gui/public/js/views/project-detail.js` | Health column + parallel health fetch |
| `gui/public/js/views/workspace-detail.js` | Health alert card, fix buttons, poll/refresh integration |
| `docs/agents/project-manifest/api-surface.md` | New workspace health types + function |
| `docs/agents/project-manifest/rest-api.md` | Two new endpoint rows |
| `docs/agents/project-manifest/gui-frontend.md` | Updated views + API client documentation |
| `docs/agents/project-manifest/data-flows.md` | Sections 12 + 13 (health check + regenerate flows) |

---

## Rework Register

### WP-003 — CSS Health Alert Styles (1 rework cycle)

**Root cause:** CSS opacity misunderstanding — the implementation used `opacity: 0.6` on `.health-alert-issue + .health-alert-issue` with `opacity: calc(1/0.6)` on `> *` children intending to "restore" opacity, but CSS opacity creates an off-screen compositing layer: the counter value clamps to `1.0` and has zero effect. Consequence was all issue rows after the first rendering at 60% opacity with no recovery.

**Fix:** Replaced the 4-line dead-code block with `border-top: 1px solid var(--color-border-light)` — a clean neutral separator using the existing dual-theme token.

**Lesson:** CSS `opacity` is a compositing operation, not a channel alpha. It cannot be "cancelled" by applying an inverse opacity to children. Use `rgba()` or HSLA colors with alpha for color-level transparency.

---

## Strategic Recommendations (Gold Nuggets)

### 1. Add path boundary assertion to `workspaceFolder()` [Security / Defense-in-Depth]

**Source:** Security Audit WP-002 / WP-007 (Low/Info — A01)

The `workspaceFolder()` helper constructs filesystem paths from URL-derived parameters (`projectId`, `workspaceId`) without asserting that the resolved path starts with `appConfig.projectsFolder`. In practice, the data-layer gates (`projectManager.getById` → undefined → 404; `workspaceManager.getById` → undefined → 404) prevent traversal vectors from reaching the filesystem code, making this safe today. However, as the server grows, adding a single assertion:

```typescript
if (!resolvedPath.startsWith(appConfig.projectsFolder)) {
  throw new Error('Resolved path escapes projects folder boundary');
}
```

would provide defense-in-depth that survives future refactors. This is a 2-line change with high long-term value.

---

### 2. Extract shared server test helpers [Technical Debt]

**Source:** Developer WP-009, QA WP-009

`mockRequest()` / `mockResponse()` (~30 lines) are duplicated verbatim in `workspaces.test.ts` and `workspaces-health.test.ts`. A shared `src/server/__tests__/test-helpers.ts` would eliminate the duplication. As the route test surface grows (new endpoints, new WPs), this de-duplication will pay increasing dividends.

---

### 3. Consolidate double health fetch after setup fix [Performance / Correctness]

**Source:** Developer WP-005, QA WP-005, Reviewer WP-005

In `workspace-detail.js`, the `onSetup` callback calls `doRefresh()` (fire-and-forget, which internally fetches health) followed by `fetchAndRenderHealth()`. This triggers two concurrent health fetches to the same endpoint; last-writer-wins on `currentHealthReport`. Currently harmless, but if health checks become expensive (e.g., checking many repos), this race becomes inefficient. The fix is to `await doRefresh()` inside `onSetup` and drop the separate `fetchAndRenderHealth()` call.

---

### 4. Replace `{} as never` with typed cast in integration tests [Code Quality]

**Source:** Reviewer WP-009

In `workspaces-health.test.ts`, `stubOrchestrator = {} as never` is safe because neither health endpoint accesses the orchestrator. However, `as never` suppresses TypeScript's type checking entirely. Replacing it with `{} as WorkspaceOrchestrator` would allow `tsc` to surface any gap if a future route handler change added orchestrator access. A structural no-op change with improved long-term safety.

---

### 5. Add zero-repository workspace test case [Test Coverage]

**Source:** QA WP-009

A workspace with zero repositories is semantically valid and returns `{ healthy: true, issues: [] }` per the `WorkspaceHealthReport` contract. No integration test explicitly covers this case. Adding one test would document the expected contract and prevent regressions if the iteration logic in `checkWorkspaceHealth()` is ever modified.

---

## Open Items for Next Planner Cycle

| Priority | Item |
|---|---|
| Medium | Add `startsWith(projectsFolder)` path boundary assertion to `workspaceFolder()` |
| Medium | Extract `mockRequest`/`mockResponse` to `src/server/__tests__/test-helpers.ts` |
| Low | Consolidate double health fetch in `onSetup` callback (`workspace-detail.js`) |
| Low | Replace `{} as never` with `{} as WorkspaceOrchestrator` in `workspaces-health.test.ts` |
| Low | Add zero-repository integration test for GET `.../health` |
| Low | If warning palette is extended, define `--color-warning-rgb` channel properties to enable `rgba()` alpha separators in health alert styles |
| Note | `.git file` vs `.git directory` edge case is documented in `workspace-health.ts` JSDoc — `fs.existsSync` treats both as cloned. Use `fs.statSync().isDirectory()` if worktree distinction is ever needed |
