## Synthesis

### Completion Status
- Date: 2026-04-23
- Status: COMPLETE
- Completed by: Standalone Developer Agent

### Implementation Summary
- **Step 1 — `showLoading()` innerHTML elimination:** Replaced the `innerHTML` template string in `showLoading()` with `clearElement()` + `createElement` calls producing an identical DOM structure (`div.loading-indicator` > `span.spinner` + `span`). Zero `innerHTML` assignments now remain in `dashboard.js`.
- **Step 2 — `applyFiltersAndSort()` pure function refactor:** Added `allProjects` as an explicit second parameter, removing the closure over the module-level `_allProjects` variable. The function is now `export`ed so it can be imported by tests. Both call sites in `renderProjectList` and `onFilterChange` updated to pass `_allProjects` explicitly.
- **Step 3 — Visible toolbar labels:** Added `<label class="filter-label">` elements with `for`/`id` bindings to all three toolbar controls (Search, Repository, Sort), matching the pattern established in `error-log.js`. IDs `project-filter-search`, `project-filter-repo`, and `project-filter-sort` added.
- **Step 4 — Repo filter empty-state UX:** The repository `<select>` is now always rendered. When `repos` is empty or the fetch fails, it renders as `disabled` with a single "No repositories" placeholder option instead of being omitted entirely.
- **Step 5 — SchemaVersion versioning policy at `BaseStore`:** Full versioning policy JSDoc added to `BaseStore.SchemaVersion` in `src/storage/storage.types.ts`. The verbose per-field JSDoc in `src/models/project/project.types.ts` replaced with `@see BaseStore.SchemaVersion for versioning policy.` to eliminate duplication. All four inheriting types (`RepositoryStore`, `ProjectIndex`, `ErrorLogStore`, and `BaseStore` itself) are now covered by the single canonical documentation location.
- **Step 6 — mtime test resilience guard:** The `updateLastActivity` short-circuit test in `project.manager.test.ts` now probes filesystem mtime granularity before asserting. On fine-granularity filesystems (the common case) the original `strictEqual(mtimeBefore, mtimeAfter)` assertion runs. On coarse-granularity filesystems (FAT, some tmpfs), the test falls back to `deepStrictEqual` on the JSON file content, confirming no write occurred via content equality rather than timestamp comparison.
- **Step 7 — New frontend unit tests:** Created `gui/public/js/__tests__/dashboard.test.mjs` with 16 unit tests for `applyFiltersAndSort()` covering search (name, ID, description, case-insensitivity, empty, no-match), repository filter, alphabetical sort (order, tiebreaker), activity sort (descending, null-last, null tiebreaker), combined filter+sort scenarios, empty input, and immutability of the input array.

### Documentation Updates
- `docs/agents/project-manifest/gui-frontend.md` — Dashboard route entry updated to document: visible `<label class="filter-label">` elements with `for`/`id` bindings; the disabled "No repositories" dropdown state; and `applyFiltersAndSort` as an exported pure function.
- `docs/agents/project-manifest/api-surface.md` — `BaseStore.SchemaVersion` field updated to include the versioning policy summary.
- `.context/` — Regenerated via `ctx generate` to reflect the new `gui/public/js/__tests__/` directory.

### Verification Summary
- Tests run: full backend suite (`npm test`), project.manager test suite (`node --test dist/tests/project.manager.test.js`), full frontend suite (`npm run test:gui`)
- Static analysis run: TypeScript build (`npm run build` → `tsc`)
- Result:
  - `tsc --noEmit` equivalent (build step): **PASS** — 0 errors
  - Backend tests: **PASS** — 763/763
  - Frontend tests: **PASS** — 130/130 (114 pre-existing + 16 new `dashboard.test.mjs`)

### Code Insights
- [low] (debt) `gui/public/js/views/dashboard.js` — **RESOLVED.** `renderProjectGrid` now accepts an explicit `hasAnyProjects` boolean parameter. The `_allProjects.length === 0` closure read has been removed; callers pass `_allProjects.length > 0` (or `false` for the empty-list early-return path). The module-level `_allProjects` variable is no longer read inside any rendering function.
- [low] (convention) `gui/public/js/__tests__/dashboard.test.mjs` — **RESOLVED.** Created `gui/public/js/__tests__/test-setup.mjs` exporting `installBrowserGlobalsShim()`. The inline shim in `dashboard.test.mjs` has been replaced with `before(installBrowserGlobalsShim)`. Future test files can import the utility instead of duplicating the stub code. The shim guards with `typeof ... === 'undefined'` checks so that test files installing a full fetch mock in their own `before()` hook are not affected.
- [low] (improvement) `src/storage/storage.types.ts` — **RESOLVED.** Added `@see BaseStore.SchemaVersion for the versioning policy` to the `SchemaVersion` type alias JSDoc, so contributors reading the type alias are immediately directed to the full policy documentation on `BaseStore`.

### Additional Comments
- The `before()` shim in `dashboard.test.mjs` is intentionally minimal — it only stubs enough of the global environment to allow the module import to succeed without error. The shim does not wire up a real DOM because `applyFiltersAndSort` is a pure data function that never touches `document` after the refactor.
- The mtime granularity probe writes a temp file into the same base directory as the test (`path.join(base, 'mtime-probe.tmp')`), ensuring it measures the actual filesystem being used by the test rather than a different mount point.
