# Plan

## Summary

Address all actionable items from the Phase 4 synthesis strategic recommendations and open items. This rework hardens the orchestration layer before Phase 5 (GUI Backend) begins consuming it, ensuring that the API surface exposed to HTTP route handlers is robust, consistent, and free of known defects.

## Architectural Context

Phase 4 delivered five orchestrators and one VS Code workspace file manager in `src/orchestration/`. The synthesis identified 9 open items across three priority tiers. All items have been verified against the current codebase — every issue is confirmed present.

Phase 5 will expose these orchestrators through HTTP API endpoints (e.g., `DELETE /api/projects/:id` calls `ProjectOrchestrator.deleteProject()`). Any gaps in input validation or rollback handling become exploitable once a network API is in front of them. The Phase 5 plan explicitly states it delegates to orchestrators and does not re-implement business logic — so the orchestration layer must be correct and complete before Phase 5 begins.

### Key files affected:

- `src/orchestration/vscode-workspace.ts` — unused `projectName` parameter
- `src/orchestration/project-orchestrator.ts` — rollback gap and missing path-traversal guard in `renameProject()`
- `src/orchestration/repository-orchestrator.ts` — missing path-traversal guard in `addRepositoryToProject()`
- `src/orchestration/branch-orchestrator.ts` — unconditional `DateModified` update in `switchBranches()`
- `src/git/git-clone.ts` — no warning on cleartext transport URLs
- `src/tests/project-orchestrator.test.ts` — new tests for rollback and path-traversal
- `src/tests/repository-orchestrator.test.ts` — new test for add path-traversal guard
- `src/tests/branch-orchestrator.test.ts` — new test for `DateModified` skip-on-failure

## Approach / Architecture

This is a surgical rework — no new modules, no new architectural patterns. Each step modifies an existing file to close a specific gap. The changes fall into four categories:

1. **Dead code removal** — remove the unused `projectName` parameter and update all callers.
2. **Defensive hardening** — add try/catch rollback, path-traversal guards, and cleartext URL warnings.
3. **Behaviour correction** — fix `switchBranches()` `DateModified` update to skip when all operations fail.
4. **Test coverage** — add tests for every new guard and changed behaviour.

## Rationale

- All items were identified in the Phase 4 synthesis and independently verified against the current source.
- Phase 5 route handlers will call these orchestrators directly. The Phase 5 plan states: *"Route handlers delegate to orchestrators and return JSON responses."* Fixing these gaps now prevents shipping known defects through the API layer.
- Item prioritisation follows the synthesis tiers and risk to Phase 5. Audit logging (medium priority, item 5) is deferred to Phase 5 where the server context provides a natural logging infrastructure. The `deleteRepositoryGlobally()` efficiency concern (low priority, item 9) is deferred as the synthesis itself notes expected project counts are small.

## Detailed Steps

### Step 1: Remove unused `projectName` parameter from `generateWorkspaceFile()`

**File:** `src/orchestration/vscode-workspace.ts`

1. Remove the `projectName` parameter from the `generateWorkspaceFile()` function signature.
2. Remove the corresponding `@param projectName` line from the JSDoc.

**Callers to update (remove the first argument):**

3. `src/orchestration/workspace-orchestrator.ts` — `generateWorkspaceFile(project.Name, workspaceId, ...)` → `generateWorkspaceFile(workspaceId, ...)`
4. `src/orchestration/repository-orchestrator.ts` — `generateWorkspaceFile(projectName, workspaceId, ...)` → `generateWorkspaceFile(workspaceId, ...)`
5. `src/orchestration/project-orchestrator.ts` — `generateWorkspaceFile(renamedProject.Name, workspaceId, ...)` → `generateWorkspaceFile(workspaceId, ...)`

**Tests:** Existing tests should continue to pass since the parameter was unused. If any test helper calls `generateWorkspaceFile()` with 4 arguments, update those too.

### Step 2: Add try/catch rollback to `createProject()`

**File:** `src/orchestration/project-orchestrator.ts`

1. Wrap the `fs.mkdirSync()` call and the `createWorkspace()` delegation in a try/catch block.
2. In the catch branch, call `this.projectManager.remove(project.Id)` to clean up the orphaned data entry.
3. Re-throw the original error so callers still see the failure.

```typescript
async createProject(...): Promise<OrchestrationResult> {
    const project = this.projectManager.create(name, repositoryIds, description, id);

    try {
        fs.mkdirSync(this.projectFolder(project.Id), { recursive: true });
        return await this.workspaceOrchestrator.createWorkspace(project.Id, STABLE_WORKSPACE_ID);
    } catch (error) {
        // Rollback: remove orphaned project data entry
        this.projectManager.remove(project.Id);
        throw error;
    }
}
```

**Tests:** Add a test in `src/tests/project-orchestrator.test.ts` that causes `createWorkspace()` to fail (e.g., with an unreachable repo URL) and verifies the project data entry is cleaned up. Note: the rollback is a best-effort safeguard — `mkdirSync` with `{ recursive: true }` is unlikely to fail in normal operation, but the `createWorkspace()` call can fail if all clones fail and the orchestrator throws.

### Step 3: Add path-traversal guard to `renameProject()`

**File:** `src/orchestration/project-orchestrator.ts`

1. After computing `newProjectFolder`, add a `path.resolve() + startsWith()` check identical to the one in `deleteProject()`.
2. The guard should validate that both the old and new paths are within `this.config.projectsFolder`.
3. Throw an `Error` with a descriptive security message on violation.

```typescript
const resolvedNewProjectFolder = path.resolve(newProjectFolder);
const resolvedProjectsFolder = path.resolve(this.config.projectsFolder);
if (!resolvedNewProjectFolder.startsWith(resolvedProjectsFolder + path.sep)) {
    throw new Error(
        `Security check failed: new project path "${resolvedNewProjectFolder}" is not under projectsFolder "${resolvedProjectsFolder}"`
    );
}
```

**Tests:** Add a test in `src/tests/project-orchestrator.test.ts` that calls `renameProject('valid-id', '../../outside')` and verifies it throws with a security error.

### Step 4: Add path-traversal guard to `addRepositoryToProject()`

**File:** `src/orchestration/repository-orchestrator.ts`

1. Before the clone loop, compute the clone destination path and validate it is within `this.config.projectsFolder` using the same `path.resolve() + startsWith()` pattern.
2. Apply the guard **per-workspace** inside the clone loop, before calling `cloneRepository()`.

```typescript
const resolvedProjectsFolder = path.resolve(this.config.projectsFolder);
// Inside workspace loop, before cloning:
const resolvedDest = path.resolve(destination);
if (!resolvedDest.startsWith(resolvedProjectsFolder + path.sep)) {
    throw new Error(
        `Security check failed: clone path "${resolvedDest}" is not under projectsFolder "${resolvedProjectsFolder}"`
    );
}
```

**Tests:** Add a test in `src/tests/repository-orchestrator.test.ts` that verifies the path-traversal guard rejects construction of a clone path outside the projects folder.

### Step 5: Add cleartext URL warning to `cloneRepository()`

**File:** `src/git/git-clone.ts`

1. After the existing `isAllowedUrl()` check passes, check if the URL starts with `http://` or `git://`.
2. If so, emit a `console.warn()` with a clear message: `"Warning: cloning over cleartext protocol (${protocol}). Consider using https:// or ssh:// for security."`.
3. Do NOT reject the URL — this is a warning only, as the synthesis specifies.

**Tests:** Add a test in `src/tests/git-clone.test.ts` that verifies a `console.warn` is emitted when cloning from an `http://` URL. Use a spy on `console.warn`.

### Step 6: Fix `switchBranches()` to skip `DateModified` on total failure

**File:** `src/orchestration/branch-orchestrator.ts`

1. After all per-repo operations complete, check whether at least one operation succeeded.
2. Only call `this.workspaceManager.update(projectId, workspaceId, {})` if at least one repository switch succeeded.
3. Update the JSDoc to reflect the new behaviour.

```typescript
const anySuccess = Object.values(results).some((r) => r.success);
if (anySuccess) {
    this.workspaceManager.update(projectId, workspaceId, {});
}
```

**Tests:** Add a test in `src/tests/branch-orchestrator.test.ts` that assigns branches that all fail (e.g., conflicting branch names) and verifies `DateModified` is NOT updated. Add a complementary test that verifies `DateModified` IS updated when at least one succeeds (likely already covered by existing tests).

### Step 7: Run full test suite

1. Run `npx vitest run` (or equivalent project test command) and confirm all 337 existing tests plus the new tests pass.
2. Fix any regressions introduced by the parameter removal or behaviour changes.

## Dependencies

- Phase 4 deliverables (all present in the codebase)
- No external dependencies or new packages

## Required Components

- **MODIFY** `src/orchestration/vscode-workspace.ts` — remove `projectName` parameter
- **MODIFY** `src/orchestration/workspace-orchestrator.ts` — update `generateWorkspaceFile()` call
- **MODIFY** `src/orchestration/project-orchestrator.ts` — rollback in `createProject()`, path guard in `renameProject()`, update `generateWorkspaceFile()` call
- **MODIFY** `src/orchestration/repository-orchestrator.ts` — path guard in `addRepositoryToProject()`, update `generateWorkspaceFile()` call
- **MODIFY** `src/orchestration/branch-orchestrator.ts` — conditional `DateModified` update
- **MODIFY** `src/git/git-clone.ts` — cleartext URL warning
- **MODIFY** `src/tests/project-orchestrator.test.ts` — rollback + path-traversal tests
- **MODIFY** `src/tests/repository-orchestrator.test.ts` — path-traversal test
- **MODIFY** `src/tests/branch-orchestrator.test.ts` — DateModified skip test
- **MODIFY** `src/tests/git-clone.test.ts` — cleartext URL warning test

## Assumptions

- The kebab-case ID validation in managers prevents most path-traversal attempts in practice, but the guards are needed for defence-in-depth consistency.
- The `console.warn()` for cleartext URLs is appropriate for a single-developer CLI/GUI tool. A structured logger can replace it in a future phase if needed.
- The `createProject()` rollback covers the `mkdirSync` failure and `createWorkspace()` failure scenarios. It does not attempt to undo partial workspace clone results — that is already handled by the workspace orchestrator's partial-failure contract.

## Constraints

- No new files or modules — all changes are surgical modifications to existing code.
- No new npm dependencies.
- No changes to the `AppConfig` interface.
- Existing test expectations must not break (only additions and parameter adjustments).

## Out of Scope

- **Audit logging** (synthesis item 5) — Deferred. Phase 5 introduces the HTTP server which provides the natural context for request logging. Adding `console.log` calls now would be replaced immediately. The Phase 5 plan should include a logging strategy.
- **`deleteRepositoryGlobally()` efficiency** (synthesis item 9) — Deferred. The sequential `list() + getById()` pattern is correct and the synthesis notes expected project counts are small. Optimisation can be revisited if performance profiling shows a bottleneck.
- **Open documentation-forward items** (synthesis item 4) — None found. Grep for `TODO|FIXME|@documentation-forward` across `src/orchestration/` and `src/tests/` returned 0 results. These items appear to have been resolved during the Phase 4 implementation or were tracked only in the synthesis narrative. No action needed.

## Acceptance Criteria

- `generateWorkspaceFile()` has no `projectName` parameter. All callers pass 3 arguments.
- `createProject()` rolls back the project data entry if `mkdirSync()` or `createWorkspace()` throws.
- `renameProject()` throws a security error when the new ID would resolve outside `projectsFolder`.
- `addRepositoryToProject()` throws a security error when the clone destination would resolve outside `projectsFolder`.
- `cloneRepository()` emits a `console.warn` for `http://` and `git://` URLs.
- `switchBranches()` does not update `DateModified` when all per-repo operations failed.
- All existing tests pass. New tests cover every changed behaviour.
- Total test count is ≥ 343 (337 existing + ≥ 6 new).

## Testing Strategy

Each step includes specific test additions:

| Step | Test File | New Tests |
|------|-----------|-----------|
| 1 | (existing tests, parameter adjustment only) | 0 |
| 2 | `src/tests/project-orchestrator.test.ts` | 1 (rollback on failure) |
| 3 | `src/tests/project-orchestrator.test.ts` | 1 (path-traversal in rename) |
| 4 | `src/tests/repository-orchestrator.test.ts` | 1 (path-traversal in add) |
| 5 | `src/tests/git-clone.test.ts` | 1 (cleartext URL warning) |
| 6 | `src/tests/branch-orchestrator.test.ts` | 2 (DateModified skip + confirm-on-success) |

All tests are integration tests using local bare git repos and temp directories, following the existing test conventions.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Removing `projectName` parameter breaks test helpers** | Grep all test files for `generateWorkspaceFile` before committing; the parameter was confirmed unused so only the argument count changes |
| **Rollback in `createProject()` masks the original error** | Re-throw the original error after rollback; the catch block only performs cleanup |
| **Path-traversal guards reject valid edge-case IDs** | Guards use `path.resolve() + startsWith()` which correctly handles relative segments; kebab-case ID validation upstream prevents IDs containing `..` or `/` |
| **Cleartext URL warning is noisy in test output** | Tests spy on `console.warn` and restore it after; warning only fires for `http://` and `git://` prefixes which are not used in test fixtures |
| **Phase 5 expects `generateWorkspaceFile()` with 4 parameters** | Phase 5 plan does not call `generateWorkspaceFile()` directly — it delegates to orchestrators. No API contract is broken |

## Phase 5 Alignment Notes

The Phase 5 plan has been reviewed for any references to the changed APIs:

1. **Route handlers call orchestrators, not `generateWorkspaceFile()` directly** — the parameter removal is invisible to Phase 5.
2. **Phase 5 API endpoints for delete/rename** call `ProjectOrchestrator.deleteProject()`, `renameProject()`, etc. — these now have consistent path-traversal guards matching the defence-in-depth expectation.
3. **Phase 5's `POST /api/repositories`** calls orchestrator-level add — the new path guard in `addRepositoryToProject()` protects the clone path.
4. **Phase 5's `POST /api/projects/:id/workspaces/:wid/branches/switch`** calls `switchBranches()` — the corrected `DateModified` behaviour is semantically better for the API (status 200 with all-failures result should not silently update timestamps).
5. **Phase 5 polling uses `fetchAndGetStatus()`** which already has timeout support from Phase 3 hardening — no conflict.
6. **No Phase 5 dependency on audit logging** — the Phase 5 plan does not reference any existing logging infrastructure. Logging can be designed as part of Phase 5 server infrastructure.
