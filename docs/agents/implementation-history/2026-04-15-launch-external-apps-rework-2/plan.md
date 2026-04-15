# Plan

## Summary

Follow-up rework addressing four actionable items from the `2026-04-15-launch-external-apps-rework-1` synthesis strategic recommendations: standardise compound-check ordering in the workspace routes, create a `gui/package.json` with `"type": "module"` to eliminate the `MODULE_TYPELESS_PACKAGE_JSON` warning, remove redundant defensive spy guards from two GUI test files, and extend the `resolveWorkspace()` helper extraction pattern to other route files that contain duplicated inline lookup-and-404 patterns.

## Architectural Context

### Route handler patterns (`src/server/routes/`)

All route files follow the same architecture: a `register*Routes()` function receives manager and orchestrator dependencies and registers handlers on the `Router` instance. Most handlers need to look up an entity (project, workspace, repository) and return a 404 if it is not found.

Currently, only `src/server/routes/workspaces.ts` has extracted this into a reusable private helper (`resolveWorkspace()`). All other route files duplicate the pattern inline:

| Route file | Inline lookup patterns | Entities |
|---|---|---|
| `src/server/routes/branches.ts` | 2 | workspace (via `workspaceManager.getById`) |
| `src/server/routes/status.ts` | 4 | project (`projectManager.getById`) + workspace (`workspaceManager.getById`) — both validated per route |
| `src/server/routes/projects.ts` | 2 | project (`projectManager.getById`) |
| `src/server/routes/repositories.ts` | 3 | repository (`repoManager.getById`) |
| `src/server/routes/error-log.ts` | 1 | error log entry (`errorLogManager.getById`) |
| `src/server/routes/config.ts` | 0 | (no entity lookups) |

### Compound-check ordering inconsistency

Within `src/server/routes/workspaces.ts`, three handlers perform compound checks (both project and workspace):

- **`regenerate-workspace-file`** (line ~318): project check first, then `resolveWorkspace()` — correct order.
- **`health`** (line ~366): project check first, then `resolveWorkspace()` — correct order.
- **`launch/github-desktop/:rid`** (line ~437): `resolveWorkspace()` first, then project check — **inconsistent**.

When both entities are missing, the inconsistent handler returns a workspace-404 instead of a project-404, unlike the other two handlers.

### GUI module system

The GUI is a vanilla JS SPA with no build step. Test files use `.mjs` extension and `import`/`export` syntax. There is no `gui/package.json` — only the root `package.json` exists, and it does not declare `"type": "module"`. Node.js emits `MODULE_TYPELESS_PACKAGE_JSON` when it reparses `.js` files imported from `.mjs` test files because the nearest `package.json` does not declare a module type. This warning appears on every test run. A previous synthesis (phase-6) and the current `CONTRIBUTING.md` both document this as a known pre-existing condition.

### Defensive spy guards

Both `gui/public/js/views/workspace-detail.vscode-button.test.mjs` (line 70) and `gui/public/js/views/workspace-detail.open-button.test.mjs` (line 76) contain:
```js
if (!api.workspaces.launch) api.workspaces.launch = {};
```
This guard was added during the `launch` sub-namespace transition. Since `gui/public/js/api.js` now unconditionally exports `api.workspaces.launch` as a populated object with both `vscode()` and `githubDesktop()` methods, the guard is dead code.

## Approach / Architecture

Four independent changes, each scoped to a small set of files:

1. **Compound-check ordering fix** — In the `launch/github-desktop/:rid` handler in `workspaces.ts`, move the `projectManager.getById()` check before the `resolveWorkspace()` call, matching the pattern used by `health` and `regenerate-workspace-file`.

2. **GUI `package.json` creation** — Create a minimal `gui/package.json` containing only `{ "type": "module" }`. This tells Node.js that `.js` files under `gui/` are ESM, eliminating the `MODULE_TYPELESS_PACKAGE_JSON` warning. Remove the warning note from `CONTRIBUTING.md` since it will no longer apply.

3. **Defensive spy guard removal** — Remove the `if (!api.workspaces.launch) api.workspaces.launch = {};` lines from both test files. The assignment to the spy method directly after already works because `api.workspaces.launch` is guaranteed to exist.

4. **Resolve-helper extraction in other route files** — Apply the `resolveWorkspace()` pattern to route files with 2+ inline lookup-and-404 repetitions. Specifically:
   - `branches.ts`: Extract a private `resolveWorkspace()` helper (same shape as the one in `workspaces.ts`, reusing the `workspaceManager` dependency already in scope).
   - `status.ts`: Extract both `resolveProject()` and `resolveWorkspace()` private helpers.
   - `projects.ts`: Extract a private `resolveProject()` helper.
   - `repositories.ts`: Extract a private `resolveRepository()` helper.
   - `error-log.ts`: Only 1 occurrence — skip extraction (not worth a helper for a single call site).

## Rationale

- **Ordering fix:** Consistent error responses reduce debugging friction. A project-404 is more informative than a workspace-404 when both are missing, because the project is the parent entity.
- **GUI `package.json`:** This has been flagged in two prior synthesis reports. A single-file addition eliminates persistent warning noise from every test run. The root `package.json` should NOT be modified to add `"type": "module"` because the TypeScript backend uses `Node16` module resolution and emits `.js` files that are already handled correctly by the `tsconfig.json` `module` setting.
- **Spy guard removal:** Dead code removal keeps test files honest and avoids misleading future contributors into thinking `launch` might not exist.
- **Helper extraction:** Reduces code duplication across route files, improves consistency, and makes future error-format changes a single-point edit per entity type. The `error-log.ts` file is excluded because extracting a helper for a single use site adds indirection without reducing duplication.

## Detailed Steps

### Step 1 — Standardise compound-check ordering in `launch/github-desktop/:rid`

In `src/server/routes/workspaces.ts`, within the `launch/github-desktop/:rid` handler:

1. Move the `projectManager.getById()` block (project existence check + project repository membership check) **before** the `resolveWorkspace()` call.
2. Verify that the handler now follows the pattern: project check → workspace check → filesystem check → business logic.
3. Update the existing test in `src/tests/workspace-orchestrator.test.ts` (or the relevant server test file) to confirm that when both project and workspace are missing, the response is a 404 with a project-not-found message.

### Step 2 — Create `gui/package.json`

1. Create `gui/package.json` with content: `{ "type": "module" }`.
2. In `CONTRIBUTING.md`, remove the `> **Note:** Node may emit a MODULE_TYPELESS_PACKAGE_JSON warning…` block (lines ~92–93).
3. Run `node --test gui/public/js/**/*.test.mjs` to verify the warning is gone and all GUI tests still pass.

### Step 3 — Remove defensive spy guards

1. In `gui/public/js/views/workspace-detail.vscode-button.test.mjs`, remove the line `if (!api.workspaces.launch) api.workspaces.launch = {};`.
2. In `gui/public/js/views/workspace-detail.open-button.test.mjs`, remove the line `if (!api.workspaces.launch) api.workspaces.launch = {};`.
3. Run `node --test gui/public/js/views/workspace-detail.vscode-button.test.mjs gui/public/js/views/workspace-detail.open-button.test.mjs` to confirm both test suites still pass.

### Step 4 — Extract resolve helpers in route files

For each route file below, extract a private helper function inside the existing `register*Routes()` function (matching the `resolveWorkspace()` pattern in `workspaces.ts`), then replace all inline occurrences:

#### 4a. `src/server/routes/branches.ts`
- Extract `resolveWorkspace(res, projectId, workspaceId): WorkspaceInfo | undefined`.
- Replace 2 inline lookup blocks.

#### 4b. `src/server/routes/status.ts`
- Extract `resolveProject(res, projectId): ProjectInfo | undefined`.
- Extract `resolveWorkspace(res, projectId, workspaceId): WorkspaceInfo | undefined`.
- Replace 4 inline lookup blocks (2 project + 2 workspace).

#### 4c. `src/server/routes/projects.ts`
- Extract `resolveProject(res, projectId): ProjectInfo | undefined`.
- Replace 2 inline lookup blocks.

#### 4d. `src/server/routes/repositories.ts`
- Extract `resolveRepository(res, repositoryId): RepositoryInfo | undefined`.
- Replace the inline lookup blocks where the pattern is duplicated. Note: some handlers use `NotFoundError` exception-based patterns rather than `undefined`-check patterns — only convert the `undefined`-check occurrences to use the helper. Exception-based error handling (e.g., in DELETE and PUT) should remain as-is because those operations may throw `NotFoundError` from the manager for race-condition coverage.

### Step 5 — Verify

1. Run `npx tsc --noEmit` — must be clean.
2. Run `npm test` — all backend tests pass.
3. Run `node --test gui/public/js/**/*.test.mjs` — all GUI tests pass, no `MODULE_TYPELESS_PACKAGE_JSON` warning.

## Dependencies

- Steps 1–4 are independent and can be parallelised.
- Step 5 (verify) depends on all preceding steps.

## Required Components

- `src/server/routes/workspaces.ts` — modify (step 1)
- `gui/package.json` — **new file** (step 2)
- `CONTRIBUTING.md` — modify (step 2)
- `gui/public/js/views/workspace-detail.vscode-button.test.mjs` — modify (step 3)
- `gui/public/js/views/workspace-detail.open-button.test.mjs` — modify (step 3)
- `src/server/routes/branches.ts` — modify (step 4a)
- `src/server/routes/status.ts` — modify (step 4b)
- `src/server/routes/projects.ts` — modify (step 4c)
- `src/server/routes/repositories.ts` — modify (step 4d)

## Assumptions

- The `resolveWorkspace()` helper shape in `workspaces.ts` is the accepted pattern for this codebase. Other route files should use the same shape (return entity or `undefined` after sending 404).
- The `gui/package.json` will not interfere with the root `package.json` or the TypeScript build. Node.js uses the nearest `package.json` for module type resolution, so `gui/package.json` affects only files under `gui/`.
- The `api.workspaces.launch.test.mjs` file does NOT contain the defensive guard (it was only in the two view test files).

## Constraints

- All relative TypeScript imports must use `.js` extensions.
- Helper functions must be private (defined inside `register*Routes()`) — not exported.
- No changes to HTTP response shapes or status codes — behaviour-preserving refactors only.
- The root `package.json` must NOT be modified to add `"type": "module"`.

## Out of Scope

- The ledger routing guard stale-pointer issue (synthesis incident note) — this is an infrastructure-level concern outside the application codebase.
- Architectural decision documentation for the `api.workspaces.launch` convention — already documented in `CONTRIBUTING.md` and `api.js` per the synthesis.
- Extraction of a resolve helper in `error-log.ts` — only one occurrence, not worth the indirection.
- Adding tests for the compound-check ordering change beyond verifying existing tests still pass (the existing test suite already covers the individual 404 cases).

## Acceptance Criteria

- The `launch/github-desktop/:rid` handler checks project existence before workspace existence.
- A `gui/package.json` file exists with `{ "type": "module" }`.
- Running `node --test gui/public/js/**/*.test.mjs` produces no `MODULE_TYPELESS_PACKAGE_JSON` warning.
- The `CONTRIBUTING.md` warning note about `MODULE_TYPELESS_PACKAGE_JSON` is removed.
- Neither `workspace-detail.vscode-button.test.mjs` nor `workspace-detail.open-button.test.mjs` contain `if (!api.workspaces.launch)` guards.
- `branches.ts`, `status.ts`, `projects.ts`, and `repositories.ts` each have extracted resolve helper(s) replacing their inline lookup-and-404 patterns.
- `npx tsc --noEmit` is clean.
- `npm test` passes (all backend tests).
- `node --test gui/public/js/**/*.test.mjs` passes (all GUI tests).

## Testing Strategy

All changes are behaviour-preserving refactors. The existing test suites (733 backend + GUI tests) serve as the regression gate. No new tests are required, though the compound-check ordering change should be verified by confirming the existing `launch/github-desktop` 404 tests still pass after reordering.

Run sequence:
1. `npx tsc --noEmit` — type safety
2. `npm test` — backend regression
3. `node --test gui/public/js/**/*.test.mjs` — GUI regression + warning elimination

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Compound-check reorder changes observable behaviour** | Only affects the error message when *both* project and workspace are missing simultaneously — an edge case. Existing tests cover individual 404 paths. |
| **`gui/package.json` changes module resolution for production GUI files** | The GUI already uses ES module syntax (`import`/`export`) in all `.js` files. Declaring `"type": "module"` aligns the package metadata with the actual module format. No runtime change. |
| **Resolve helper extraction introduces subtle differences** | Each helper must produce byte-identical 404 responses to the inline code it replaces. Verify by running the full test suite after each extraction. |
| **`repositories.ts` has mixed error patterns** | Only convert `undefined`-check patterns. Leave `NotFoundError`-based catch blocks untouched to avoid changing exception-driven control flow. |
