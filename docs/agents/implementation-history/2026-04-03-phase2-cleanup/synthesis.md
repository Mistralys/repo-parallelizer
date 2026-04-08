# Phase 2 Cleanup — Synthesis

## Synthesis

### Completion Status
- Status: COMPLETE
- Completed by: Standalone Developer Agent

### Implementation Summary

Addressed all actionable items from the Phase 2 synthesis document:

**Security fixes (Critical Path):**
1. **Path traversal prevention** — Added `isValidKebabCase()` validation (with `trim()`) for explicit IDs in `RepositoryManager.add()`, `ProjectManager.create()`, and `ProjectManager.rename()`. Path-traversal sequences like `../../etc/passwd` are now rejected at the storage layer.
2. **Credential redaction** — `RepositoryManager.add()` now redacts embedded credentials from URLs before interpolating them into error messages (`//token@` → `//***@`). A private `redactUrl()` helper handles the transformation.

**Architecture improvements (Gold Nuggets):**
3. **Shared `STABLE_WORKSPACE_ID` constant** — Exported from `workspace.types.ts`, imported in both `workspace.manager.ts` and `project.manager.ts`. The duplicate per-module constant in `project.manager.ts` was removed.
4. **`BaseStore` interface** — Added to `storage.types.ts`. Both `RepositoryStore` and `ProjectIndex` now extend `BaseStore` instead of independently declaring `SchemaVersion`.
5. **Typed seed calls** — `initializeStorage()` now uses `writeJsonFile<RepositoryStore>(...)` and `writeJsonFile<ProjectIndex>(...)` for seed objects, importing the types from the model modules.

**Test improvements:**
6. **Consolidated `initializeStorage` tests** — Removed 8 duplicate `initializeStorage` tests and the orphaned `makeTestConfig` helper from `json-storage.test.ts`. The comprehensive `storage-init.test.ts` (10 tests including 3 unique edge cases) is now the sole authority.
7. **Explicit `AppConfig` return types** — Added `: AppConfig` return type annotation (and `AppConfig` import) to `makeTestConfig()` helpers in `repository.manager.test.ts`, `project.manager.test.ts`, and `workspace.manager.test.ts`.
8. **Cross-project isolation test** — Added to `workspace.manager.test.ts`: verifies that workspace operations on project A leave project B's workspaces unaffected.
9. **`updateWorkspace()` null guard** — Added defensive null guard for `ws` in `ProjectManager.updateWorkspace()`, matching the existing pattern in `renameWorkspace()`. Throws a descriptive error if the workspace does not exist.

**New tests added (12 total):**
- `repository.manager.test.ts`: 5 tests (path traversal, uppercase, spaces, trim, credential redaction)
- `project.manager.test.ts`: 6 tests (create: path traversal, uppercase, trim; rename: path traversal, uppercase, trim)
- `workspace.manager.test.ts`: 1 test (cross-project isolation)

### Documentation Updates
- `README.md` — Updated the `add()`, `create()`, and `rename()` parameter tables and throws documentation to reflect that explicit IDs are now validated via `isValidKebabCase()`. Replaced the "Caller-owned ID validation" section with a new "ID validation" section documenting the enforcement-at-storage-layer pattern and credential redaction behavior.

### Verification Summary
- Tests run: `npm test` (tsc + node --test dist/tests/*.test.js)
- Static analysis run: TypeScript strict compilation (`tsc`)
- Result: **180 tests, 0 failures** (net change: +12 new tests, -8 duplicate tests removed)

### Files Changed

| File | Change |
|---|---|
| `src/models/repository/repository.manager.ts` | Added `isValidKebabCase` import, `redactUrl()` helper, ID validation guard in `add()`, credential redaction in error messages |
| `src/models/project/project.manager.ts` | Added `isValidKebabCase` import, `STABLE_WORKSPACE_ID` import, ID validation guards in `create()` and `rename()`, null guard in `updateWorkspace()` |
| `src/models/workspace/workspace.manager.ts` | Imported `STABLE_WORKSPACE_ID` from `workspace.types.ts`, removed local constant |
| `src/models/workspace/workspace.types.ts` | Exported `STABLE_WORKSPACE_ID` constant |
| `src/storage/storage.types.ts` | Added `BaseStore` interface |
| `src/storage/json-storage.ts` | Added `RepositoryStore` and `ProjectIndex` imports, typed seed calls |
| `src/models/repository/repository.types.ts` | `RepositoryStore` extends `BaseStore` |
| `src/models/project/project.types.ts` | `ProjectIndex` extends `BaseStore` |
| `src/tests/json-storage.test.ts` | Removed 8 duplicate `initializeStorage` tests and `makeTestConfig` helper |
| `src/tests/repository.manager.test.ts` | Added `AppConfig` return type, 5 new security guard tests |
| `src/tests/project.manager.test.ts` | Added `AppConfig` return type, 6 new validation tests |
| `src/tests/workspace.manager.test.ts` | Added `AppConfig` return type, 1 cross-project isolation test |
| `README.md` | Updated ID validation docs, `add()`/`create()`/`rename()` parameter tables |

### Code Insights
- [low] (improvement) `src/models/repository/repository.types.ts`: `ProjectData` still has `SchemaVersion: number` instead of extending `BaseStore`. This was intentional — `ProjectData` is the per-project file shape and its `SchemaVersion` is set from the module constant `SCHEMA_VERSION`, but switching to `extends BaseStore` would be consistent.
- [low] (improvement) No observations — code in the touched files is clean and consistent after these changes.

### Additional Comments
- The "Structured git command arguments" item from the Phase 2 synthesis (deferred issue #3) was not actioned here as it is forward-looking guidance for Phase 3 implementation, not a code fix.
- Test count moved from 176 → 180 (net +4: 12 added, 8 removed).
