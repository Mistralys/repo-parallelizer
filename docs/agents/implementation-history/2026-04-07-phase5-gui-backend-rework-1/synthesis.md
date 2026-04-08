## Synthesis

### Completion Status
- Status: COMPLETE
- Completed by: Standalone Developer Agent

### Implementation Summary
- Created `src/errors.ts` with a `NotFoundError extends Error` class for type-safe HTTP 404 discrimination.
- Updated all three manager classes (`RepositoryManager`, `ProjectManager`, `WorkspaceManager`) to throw `NotFoundError` for entity-not-found conditions, while keeping plain `Error` for validation, protection, and conflict scenarios.
- Extracted the duplicated `isPlainObject()` type guard into `src/server/requestUtils.ts` as a shared export, removing local copies from `repositories.ts`, `projects.ts`, `workspaces.ts`, and `branches.ts`.
- Replaced all `msg.includes('does not exist')` string-matching patterns in route catch blocks with `instanceof NotFoundError` checks.
- Fixed the DELETE workspace handler to return HTTP 400 (not 404) when STABLE protection or other validation errors occur.
- Fixed the GET branches handler's outer catch to return 500 for non-`NotFoundError` errors from the orchestrator (previously returned 404 for all errors).
- Fixed the POST status/refresh handler to return 500 for non-`NotFoundError` errors from `pollingManager.refreshWorkspace()`.
- Removed the unused `_repoManager: RepositoryManager` parameter from `registerProjectRoutes()` and updated the call site in `src/server/index.ts`.

### Documentation Updates
- No documentation updates were required because no public HTTP API contract changed (same endpoints, same request/response shapes), and no setup or operational expectations were modified. The changes are strictly internal error-handling improvements.

### Verification Summary
- Tests run: `npm test` — full suite of 517 tests
- Static analysis run: `npx tsc --noEmit` — zero type errors
- Result: All 517 tests pass, zero failures, zero type errors

### Code Insights
- [low] (convention) `src/server/routes/repositories.ts`: ~~The PUT handler uses a pre-check `repoManager.exists(id)` followed by a catch on `repoManager.update()` — technically a TOCTOU race. The catch block maps all errors to 404, which happens to be correct since `update()` only throws `NotFoundError`. However, switching to `instanceof NotFoundError` like the other routes would make the intent explicit and consistent.~~ **DONE** — catch block now uses `instanceof NotFoundError` → 404, else → 500.
- [low] (convention) `src/server/routes/repositories.ts`: ~~The DELETE handler uses a blanket `catch {}` (ignoring the error value entirely) and always returns 404. This is acceptable since `remove()` only throws `NotFoundError`, but using `instanceof NotFoundError` with a 500 fallback would be more consistent with the other route files.~~ **DONE** — catch block now uses `instanceof NotFoundError` → 404, else → 500.
- [low] (refactor) `src/server/routes/workspaces.ts`: ~~The GET list handler maps all errors from `workspaceManager.list()` to 404. Since `list()` now only throws `NotFoundError`, this works correctly, but the catch block could use an explicit `instanceof` check for consistency and safety against future error types.~~ **DONE** — catch block now uses `instanceof NotFoundError` → 404, else → 500.
- [low] (improvement) `src/server/__tests__/routes/projects.test.ts`: The `MockRepositoryManager` class was removed since it was no longer needed after the `_repoManager` parameter removal. The cleanup was straightforward.
- [low] (improvement) `src/server/__tests__/routes/status.test.ts`: The existing test "returns 404 when refreshWorkspace throws" was updated to expect 500 instead — this was a semantic correction aligned with the plan's intent. A `NotFoundError`-specific test could be added in the future if `PollingManager` is updated to throw `NotFoundError`.

### Additional Comments
- The `NotFoundError` class is intentionally minimal (no additional properties beyond `name` and `message`). If future phases need more typed errors (e.g., `ValidationError`, `ConflictError`), they can follow the same pattern in `src/errors.ts`.
- All changes are backward-compatible at the HTTP API level — no endpoint signatures, request shapes, or success response shapes changed. The only observable difference is that `DELETE /api/projects/:id/workspaces/STABLE` now returns 400 instead of 404, and generic errors in branches/status routes return 500 instead of 404.
