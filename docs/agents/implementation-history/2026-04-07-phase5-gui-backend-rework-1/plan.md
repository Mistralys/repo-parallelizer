# Plan

## Summary

Address the five actionable technical-debt items identified in the Phase 5 GUI Backend synthesis (recurring observations §1–§5). The scope covers extracting a shared `isPlainObject` utility, introducing a typed `NotFoundError` class in the manager layer, fixing the STABLE-workspace DELETE status-code mapping, removing the unused `_repoManager` parameter from `registerProjectRoutes`, and correcting the blanket 404 error mapping in the branch and status route catch blocks.

## Architectural Context

The server layer lives under `src/server/` and is a zero-dependency `node:http` backend built in Phase 5. Key files affected:

- **Route handlers:** `src/server/routes/repositories.ts`, `src/server/routes/projects.ts`, `src/server/routes/workspaces.ts`, `src/server/routes/branches.ts`, `src/server/routes/status.ts`
- **HTTP utilities:** `src/server/requestUtils.ts`
- **Server wiring:** `src/server/index.ts`
- **Manager layer:** `src/models/repository/repository.manager.ts`, `src/models/project/project.manager.ts`, `src/models/workspace/workspace.manager.ts`
- **Orchestration layer:** `src/orchestration/branch-orchestrator.ts`
- **Test files:** `src/server/__tests__/routes/*.ts`, `src/tests/workspace.manager.test.ts`, `src/tests/project.manager.test.ts`, `src/tests/repository.manager.test.ts`

Conventions:
- All errors in the manager layer are thrown as plain `new Error(…)` with descriptive messages containing `"does not exist"` for not-found scenarios.
- Route handlers discriminate 404 vs 400 via `msg.includes('does not exist')` — a string-coupling pattern explicitly flagged for replacement.
- Each route file independently defines a private `isPlainObject()` type-guard function with identical implementation.

## Approach / Architecture

1. **Shared `isPlainObject` utility** — Export the function from `src/server/requestUtils.ts` and replace the four local copies in `repositories.ts`, `projects.ts`, `workspaces.ts`, and `branches.ts` with imports.

2. **Typed `NotFoundError` class** — Introduce a `NotFoundError extends Error` class (new file `src/errors.ts` at the `src/` root, since it is a cross-cutting concern spanning models, orchestration, and server layers). Update all manager `throw new Error(…)` calls that signal "entity does not exist" to `throw new NotFoundError(…)`. Update route-handler catch blocks to use `instanceof NotFoundError` instead of `msg.includes('does not exist')`.

3. **STABLE workspace DELETE fix** — In `src/server/routes/workspaces.ts`, the DELETE handler's catch block currently maps all errors to 404. Refactor to check `instanceof NotFoundError` for 404, and return 400 for other errors (STABLE protection, validation). Add a test case covering `DELETE /api/projects/:id/workspaces/STABLE` → 400.

4. **Remove unused `_repoManager` parameter** — Drop the `_repoManager: RepositoryManager` parameter from the `registerProjectRoutes()` signature in `src/server/routes/projects.ts`. Update the call site in `src/server/index.ts` and any test files that pass this argument.

5. **Branch/status route error discrimination** — In `src/server/routes/branches.ts`, the GET handler's outer catch block (after workspace validation passes) maps all `orchestrator.getAvailableBranches()` errors to 404. Refactor to return 404 only for `NotFoundError`, and 500 for unexpected errors. Apply the same fix in `src/server/routes/status.ts` for the POST refresh handler's `pollingManager.refreshWorkspace()` catch block.

## Rationale

- **isPlainObject extraction:** Eliminates copy-paste code duplication across four files. A single source of truth reduces the risk of divergence and simplifies future changes to the guard.
- **NotFoundError typed class:** Replaces fragile string matching with type-safe `instanceof` checks. Makes status-code mapping refactor-safe and allows the manager layer to evolve error messages freely without breaking HTTP semantics.
- **Placement in `src/errors.ts`:** The class is referenced from `src/models/`, `src/orchestration/`, and `src/server/` — all three top-level source modules. Placing it under `src/` avoids pulling any of those layers into each other's import graphs.
- **STABLE DELETE fix:** The current behaviour (404 for a protection error) is semantically incorrect. A 400 (or 403) is the correct response when an entity exists but the operation is disallowed.
- **Unused parameter removal:** Dead code. Removing it simplifies the public API and eliminates a misleading signal to future maintainers.
- **Branch/status error discrimination:** Prevents git I/O failures from being misreported as 404 to the frontend, which would be confusing and hard to debug.

## Detailed Steps

### Step 1 — Create `NotFoundError` class

1. Create new file `src/errors.ts`.
2. Export `class NotFoundError extends Error` with a constructor that calls `super(message)` and sets `this.name = 'NotFoundError'`.

### Step 2 — Update manager layer to throw `NotFoundError`

1. In `src/models/repository/repository.manager.ts`:
   - Import `NotFoundError` from `../../errors.js`.
   - Replace `throw new Error(…)` with `throw new NotFoundError(…)` for the following methods: `update()` (line ~150), `remove()` (line ~168).

2. In `src/models/project/project.manager.ts`:
   - Import `NotFoundError` from `../../errors.js`.
   - Replace `throw new Error(…)` with `throw new NotFoundError(…)` for: `update()` (line ~185), `rename()` (line ~233), `remove()` (line ~270), `addRepository()` when project not found (line ~293), `removeRepository()` when project not found (line ~322), `addWorkspace()` when project not found (line ~352), `updateWorkspace()` for both project and workspace not found (lines ~383, ~387), `removeWorkspace()` when project not found (line ~409).
   - Keep `throw new Error(…)` for validation errors (e.g., repo ID doesn't exist at create time — that's a 400, not a 404).

3. In `src/models/workspace/workspace.manager.ts`:
   - Import `NotFoundError` from `../../errors.js`.
   - Replace `throw new Error(…)` with `throw new NotFoundError(…)` for entity-not-found errors in: `list()`, `getById()` (project not found), `create()` (project not found), `update()` (project/workspace not found), `rename()` (project/workspace not found), `remove()` (project/workspace not found).
   - Keep `throw new Error(…)` for STABLE protection errors and validation errors (already-exists, invalid ID, etc.).

### Step 3 — Extract `isPlainObject` to `requestUtils.ts`

1. Add `isPlainObject()` as a named export in `src/server/requestUtils.ts`.
2. In each of the four route files (`repositories.ts`, `projects.ts`, `workspaces.ts`, `branches.ts`):
   - Remove the local `isPlainObject()` function definition and its surrounding comments/section header.
   - Add `isPlainObject` to the existing `import { … } from '../requestUtils.js'` statement.

### Step 4 — Update route-handler catch blocks to use `instanceof NotFoundError`

1. In all five route files, import `NotFoundError` from `../../errors.js`.
2. Replace every `msg.includes('does not exist')` pattern with `err instanceof NotFoundError`:
   - `workspaces.ts` POST create, PUT update, PUT rename, DELETE
   - Any similar patterns in `repositories.ts` catch blocks
3. For the DELETE handler in `workspaces.ts`: change the catch block to:
   - If `err instanceof NotFoundError` → `sendError(res, 404, …)`
   - Else → `sendError(res, 400, …)` (catches STABLE-protection and other validation errors)

### Step 5 — Fix blanket 404 in branches and status routes

1. In `src/server/routes/branches.ts`, GET handler outer try/catch:
   - If `err instanceof NotFoundError` → 404
   - Else → 500 `"Internal server error."`
2. In `src/server/routes/status.ts`, POST refresh handler, `pollingManager.refreshWorkspace()` catch:
   - If `err instanceof NotFoundError` → 404
   - Else → 500 `"Internal server error."`

### Step 6 — Remove unused `_repoManager` parameter

1. In `src/server/routes/projects.ts`:
   - Remove the `_repoManager: RepositoryManager` parameter from the `registerProjectRoutes()` signature.
   - Remove the `import type { RepositoryManager }` statement if no longer referenced.
2. In `src/server/index.ts`:
   - Change `registerProjectRoutes(router, projectManager, repoManager)` to `registerProjectRoutes(router, projectManager)`.
3. In `src/server/__tests__/routes/projects.test.ts` (or wherever the test creates the route registration):
   - Remove the third argument from any `registerProjectRoutes(…)` calls.

### Step 7 — Update existing tests

1. Update manager-layer tests (`project.manager.test.ts`, `repository.manager.test.ts`, `workspace.manager.test.ts`) to assert that not-found errors are instances of `NotFoundError` rather than generic `Error`.
2. Update route-handler tests to verify:
   - `DELETE /api/projects/:id/workspaces/STABLE` → 400 (not 404).
   - A non-NotFoundError from `orchestrator.getAvailableBranches()` → 500 (not 404).
   - A non-NotFoundError from `pollingManager.refreshWorkspace()` → 500 (not 404).
3. Ensure all existing tests continue to pass (no regressions from the `isPlainObject` extraction or error-type change).

### Step 8 — Verify

1. Run `npx tsc --noEmit` to confirm zero type errors.
2. Run the full test suite (`npm test`) to confirm all tests pass.

## Dependencies

- Steps 2–5 depend on Step 1 (`NotFoundError` class must exist first).
- Step 3 is independent of Steps 1, 2, 4, 5 and can be executed in parallel.
- Step 4 depends on Steps 1 and 2 (managers must throw `NotFoundError` before routes can `instanceof` it).
- Step 5 depends on Steps 1 and 2.
- Step 6 is fully independent of all other steps.
- Step 7 depends on all preceding steps.
- Step 8 is the final verification step.

## Required Components

### New files
- `src/errors.ts` — Shared error classes (`NotFoundError`)

### Modified files
- `src/models/repository/repository.manager.ts` — Throw `NotFoundError` for not-found cases
- `src/models/project/project.manager.ts` — Throw `NotFoundError` for not-found cases
- `src/models/workspace/workspace.manager.ts` — Throw `NotFoundError` for not-found cases
- `src/server/requestUtils.ts` — Export `isPlainObject()`
- `src/server/routes/repositories.ts` — Import shared `isPlainObject`, import `NotFoundError`
- `src/server/routes/projects.ts` — Import shared `isPlainObject`, import `NotFoundError`, remove `_repoManager` param
- `src/server/routes/workspaces.ts` — Import shared `isPlainObject`, import `NotFoundError`, fix DELETE catch
- `src/server/routes/branches.ts` — Import shared `isPlainObject`, import `NotFoundError`, fix blanket 404
- `src/server/routes/status.ts` — Import `NotFoundError`, fix blanket 404
- `src/server/index.ts` — Remove third arg from `registerProjectRoutes()` call
- `src/tests/repository.manager.test.ts` — Assert `NotFoundError` instances
- `src/tests/project.manager.test.ts` — Assert `NotFoundError` instances
- `src/tests/workspace.manager.test.ts` — Assert `NotFoundError` instances
- `src/server/__tests__/routes/*.ts` — Update test assertions, add new test cases

## Assumptions

- The `NotFoundError` class is the only typed error subclass needed at this time. Other error categories (e.g., `ConflictError`, `ValidationError`) are out of scope unless explicitly encountered.
- All `"does not exist"` error messages in the manager layer represent true not-found conditions (confirmed by codebase grep).
- The `_repoManager` parameter in `registerProjectRoutes` is genuinely unused (confirmed: no references to it in the function body).

## Constraints

- Zero new runtime dependencies — the `NotFoundError` class uses only built-in JavaScript `Error` inheritance.
- The full test suite must remain green after all changes.
- No changes to the public HTTP API contract (same endpoints, same request/response shapes).

## Out of Scope

- Additional typed error classes beyond `NotFoundError` (e.g., `ValidationError`, `ConflictError`).
- Security-audit observations from Phase 5 (security headers, request timeouts, `0.0.0.0` binding) — these are separate hardening concerns.
- Refactoring the manager layer's error messages themselves.
- Changes to the `PollingManager` or `BranchOrchestrator` internals.

## Acceptance Criteria

- `isPlainObject()` is defined exactly once in the codebase (in `requestUtils.ts`) and imported by all route files that use it.
- A `NotFoundError` class exists in `src/errors.ts` and is used by all three managers for entity-not-found errors.
- All route-handler catch blocks use `instanceof NotFoundError` instead of `msg.includes('does not exist')`.
- `DELETE /api/projects/:id/workspaces/STABLE` returns HTTP 400 (not 404).
- A git I/O failure in `GET /api/projects/:id/workspaces/:wid/branches` (after workspace validation passes) returns HTTP 500 (not 404).
- A `refreshWorkspace()` failure in `POST /api/projects/:id/workspaces/:wid/status/refresh` returns HTTP 500 (not 404).
- `registerProjectRoutes()` accepts exactly two parameters: `router` and `projectManager`.
- `npx tsc --noEmit` exits 0.
- The full test suite passes with no regressions.

## Testing Strategy

- **Unit tests (manager layer):** Update existing tests to assert `NotFoundError` is thrown (via `expect(…).toBeInstanceOf(NotFoundError)` or equivalent). No new functionality is added to managers, so existing test coverage is sufficient after the assertion-type update.
- **Unit tests (route handlers):** Add targeted test cases:
  - DELETE workspace STABLE → 400
  - GET branches with orchestrator throwing a generic `Error` (not `NotFoundError`) → 500
  - POST status/refresh with pollingManager throwing a generic `Error` → 500
- **Integration:** Run the full test suite to catch any regressions from the `isPlainObject` extraction, import changes, or parameter removal.
- **Type checking:** `npx tsc --noEmit` as final gate.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Changing error types breaks existing tests** | Update test assertions in the same step as the manager changes; run tests incrementally per manager. |
| **Manager methods that throw for reasons other than not-found accidentally get converted to `NotFoundError`** | Each `throw` site was individually verified in the codebase grep — only `"does not exist"` messages are converted. Validation/protection errors (`"already exists"`, `"Cannot remove the STABLE workspace"`, `"Invalid"`) remain as plain `Error`. |
| **Removing `_repoManager` breaks a test that passes it positionally** | Search test files for `registerProjectRoutes` call sites and update all of them in the same step. |
| **`isPlainObject` extraction causes circular imports** | `requestUtils.ts` has no imports from route files; the dependency is strictly one-directional (routes → requestUtils). No risk of circularity. |
