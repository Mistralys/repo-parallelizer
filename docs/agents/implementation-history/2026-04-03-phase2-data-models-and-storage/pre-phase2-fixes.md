# Pre-Phase 2 Fixes

## Summary

Address four issues discovered during the Phase 2 readiness review. These must be resolved before Phase 2 implementation begins.

## Fixes

### ~~Fix 1: Change `SchemaVersion` type from `string` to `number`~~ ✅ Fixed

**File:** `src/storage/storage.types.ts`

The tool description schemas all use `"SchemaVersion": 1` (a numeric value). The current type alias is `string`, which will cause type mismatches when Phase 2 defines store interfaces like `{ Repositories: Repository[]; SchemaVersion: number }`.

**Action:** Change the type alias from `string` to `number`. Update the JSDoc to reflect numeric versioning.

**Before:**
```ts
export type SchemaVersion = string;
```

**After:**
```ts
export type SchemaVersion = number;
```

The type is not referenced anywhere in Phase 1 runtime code, so this is a zero-risk change. Verify with `npm test` that no tests break.

---

### ~~Fix 2: Switch test script to glob pattern~~ ✅ Fixed

**File:** `package.json`

The current test script explicitly enumerates each test file:

```json
"test": "tsc && node --test dist/tests/paths.test.js dist/tests/json-storage.test.js dist/tests/config.test.js dist/tests/slug.test.js"
```

Phase 2 will add multiple new test files. Each would need to be manually appended to this list.

**Action:** Replace the explicit file list with a glob pattern:

```json
"test": "tsc && node --test dist/tests/*.test.js"
```

Run `npm test` afterward and confirm all 56 existing tests still pass.

---

### ~~Fix 3: Update Phase 2 plan — `ProjectManager` needs `RepositoryManager`~~ ✅ Fixed

**File:** `docs/agents/plans/2026-04-03-phase2-data-models-and-storage/plan.md`

The plan states that `ProjectManager.create()` "validates repository IDs exist" (step 4), but the constructor signature only mentions receiving `config`. It needs access to `RepositoryManager` to perform that validation.

**Action:** In the plan's step 4, update the `ProjectManager` constructor description:

> Constructor receives config **and a reference to RepositoryManager**, resolves paths.

This mirrors the pattern already used by `WorkspaceManager` (which receives `ProjectManager`).

---

### ~~Fix 4: Update Phase 2 plan — Guard against empty slug from `inferSlugFromUrl()`~~ ✅ Fixed

**File:** `docs/agents/plans/2026-04-03-phase2-data-models-and-storage/plan.md`

The plan's step 2 says `RepositoryManager.add()` "Infers ID from URL if not provided" using `inferSlugFromUrl()`. That function returns an empty string for malformed URLs (documented in `src/utils/slug.ts`). The plan doesn't mention handling this.

**Action:** In step 2, update the `add()` method description to include:

> Validates the inferred ID is non-empty; throws a descriptive error if the URL cannot produce a valid slug.

---

## Acceptance Criteria

- [x] `SchemaVersion` type is `number` in `src/storage/storage.types.ts`.
- [x] `npm test` uses a glob pattern and all 56 existing tests pass.
- [x] Phase 2 plan step 4 specifies `RepositoryManager` as a `ProjectManager` constructor dependency.
- [x] Phase 2 plan step 2 specifies empty-slug validation in `RepositoryManager.add()`.
