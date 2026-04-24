# Plan

## Summary

Follow-up rework addressing all actionable strategic recommendations from the `2026-04-23-project-list-filtering-sorting` synthesis. Five items are in scope: eliminating the last `innerHTML` usage in `dashboard.js`, refactoring `applyFiltersAndSort()` to a pure function, adding visible toolbar labels for sighted users, propagating the SchemaVersion versioning policy to all schema-guarded types, and adding a CI-resilience guard to the mtime-based test. The repo filter empty-state UX improvement (disabled placeholder dropdown) is included as a small incremental step alongside the toolbar label work.

## Architectural Context

### Frontend (`gui/public/js/views/dashboard.js`)

- **`showLoading()`** (line ~139): The sole remaining `innerHTML` usage in the file. All other DOM mutations use `clearElement()` (from `gui/public/js/utils/dom.js`) combined with `document.createElement()` / `appendChild()`.
- **`applyFiltersAndSort(filterState)`** (line ~432): Reads `_allProjects` as a module-level closure variable (declared at line ~406). The function filters and sorts the cached project list client-side. Only testable via rendered DOM assertions today.
- **`buildFilterToolbar()`** (line ~190): Creates a `.project-filter-toolbar` with three controls (search input, repo select, sort select). Each has `aria-label` attributes but **no visible `<label>` elements**. Contrast with the error-log toolbar in `gui/public/js/views/error-log.js` (lines ~75–93) which uses `.filter-label` class `<label>` elements with `for` attributes.
- **Repo dropdown** (line ~217): When `api.repositories.list()` returns an empty array, the dropdown is omitted entirely. Field fallbacks exist (`repo.id || repo.Id || ''`), but no user-facing indication that "no repositories are registered."

### Backend (`src/`)

- **`src/models/project/project.types.ts`** (lines 49–67): Contains the only SchemaVersion versioning policy JSDoc. Four other types inherit `SchemaVersion` via `BaseStore` (`src/storage/storage.types.ts`) but lack the policy documentation: `RepositoryStore`, `ProjectIndex`, `ErrorLogStore`, and `BaseStore` itself.
- **`src/tests/project.manager.test.ts`** (line ~639): The `updateLastActivity` short-circuit test uses `fs.statSync(filePath).mtimeMs` comparison. This is reliable on macOS/APFS and Linux ext4 but fragile on FAT-backed volumes or tmpfs with coarse mtime granularity (2-second resolution).

### CSS (`gui/public/css/styles.css`)

- `.filter-label` class (line ~658): Already defined and styled for the error-log filter bar. Reusable for the dashboard toolbar without new CSS.

## Approach / Architecture

Six discrete improvements, grouped by layer:

1. **`showLoading()` innerHTML elimination** — Replace the `innerHTML` template string with `clearElement()` + `createElement` calls, preserving the same DOM structure and ARIA attributes.
2. **`applyFiltersAndSort()` pure function refactor** — Add `allProjects` as a parameter. Update all call sites to pass `_allProjects` explicitly. This unlocks direct unit testing without DOM involvement.
3. **Visible toolbar labels** — Add `<label>` elements with class `filter-label` and `for` attributes to each control in `buildFilterToolbar()`, matching the pattern established in `error-log.js`. The existing `.filter-label` CSS applies automatically.
4. **Repo filter empty-state UX** — When `repos` is empty, render a disabled `<select>` with a single `<option>` reading "No repositories" instead of omitting the control entirely. Improves discoverability.
5. **SchemaVersion policy propagation** — Add the versioning policy JSDoc to `BaseStore.SchemaVersion` in `src/storage/storage.types.ts`. This is the single inheritance source for all schema-guarded types; documenting it there covers `RepositoryStore`, `ProjectIndex`, `ErrorLogStore`, and any future types.
6. **mtime test resilience** — Add a guard to the `updateLastActivity` short-circuit test: if the test environment has coarse mtime granularity (detected by checking whether two rapid writes produce the same `mtimeMs`), skip the mtime assertion and fall back to verifying that the file content is unchanged via `JSON.parse` + `deepStrictEqual`.

## Rationale

- **innerHTML removal** is a security hygiene improvement (defense-in-depth against future XSS if the loading message ever includes dynamic content) and a consistency win.
- **Pure function refactor** has a meaningful testability payoff — filter/sort logic can be unit-tested with plain data, no DOM fixture needed.
- **Visible labels** close a UX gap between the dashboard toolbar and the error-log toolbar, which already follows the visible-label pattern.
- **Documenting SchemaVersion at `BaseStore`** is more maintainable than duplicating the policy in every extending type. A single JSDoc at the inheritance root covers all consumers.
- **mtime test guard** is preventive engineering — the test is correct today but could silently break in a future CI environment change.
- **Repo filter empty-state** is a minor discoverability improvement that rounds out the graceful degradation story.

## Detailed Steps

### Step 1 — Replace `showLoading()` innerHTML with DOM API

1. Open `gui/public/js/views/dashboard.js`.
2. Replace the `showLoading()` function body:
   - Call `clearElement(el)`.
   - Create a `div.loading-indicator` with `aria-live="polite"` and `aria-label="Loading projects…"`.
   - Create a `span.spinner` with `aria-hidden="true"`.
   - Create a `span` with `textContent = "Loading projects…"`.
   - Append children.
3. Verify the dashboard loading state renders identically (visual inspection + existing tests).

### Step 2 — Refactor `applyFiltersAndSort()` to accept `allProjects` parameter

1. Change the function signature from `applyFiltersAndSort(filterState)` to `applyFiltersAndSort(filterState, allProjects)`.
2. Replace the closure reference to `_allProjects` inside the function body with the new `allProjects` parameter.
3. Update all call sites (search for `applyFiltersAndSort(` in `dashboard.js`) to pass `_allProjects` as the second argument.
4. Add new unit tests in `gui/public/js/__tests__/dashboard.test.mjs` that test `applyFiltersAndSort()` directly with plain data arrays (no DOM rendering). Test cases:
   - Search filter matches project name (case-insensitive).
   - Repository filter narrows results.
   - Sort by alphabetical order (ascending).
   - Sort by last activity (descending, nulls last).
   - Combined filter + sort.
   - Empty input returns all projects.

### Step 3 — Add visible labels to dashboard filter toolbar

1. In `buildFilterToolbar()`, before each control (`searchInput`, `repoSelect`, `sortSelect`):
   - Create a `<label>` element.
   - Set `className = 'filter-label'`.
   - Set `textContent` to `'Search:'`, `'Repository:'`, or `'Sort:'` respectively.
   - Set the `for` attribute to match an `id` added to the corresponding control.
   - Add `id` attributes to `searchInput`, `repoSelect`, and `sortSelect`.
2. Append each label before its control in the toolbar bar.
3. Update the `gui-frontend.md` manifest to document the visible labels.

### Step 4 — Repo filter disabled placeholder when no repositories

1. In `buildFilterToolbar()`, change the `if (Array.isArray(repos) && repos.length > 0)` block to always render the `<select>`, but:
   - When `repos.length === 0`: render a disabled `<select>` with a single option `"No repositories"`.
   - When `repos.length > 0`: render as today (enabled, populated with repo options).
2. Update tests to cover the empty-repos case.
3. Update `gui-frontend.md` to document the disabled-state behavior.

### Step 5 — Propagate SchemaVersion versioning policy to `BaseStore`

1. Open `src/storage/storage.types.ts`.
2. Add the versioning policy JSDoc (adapted from `project.types.ts`) to the `SchemaVersion` field in the `BaseStore` interface.
3. In `src/models/project/project.types.ts`, replace the per-field JSDoc with a shorter comment referencing `BaseStore` (e.g., `/** @see BaseStore.SchemaVersion for versioning policy. */`) to avoid duplication.
4. Update `api-surface.md` to reflect the documentation change.

### Step 6 — Add mtime test resilience guard

1. Open `src/tests/project.manager.test.ts`.
2. Before the mtime assertion, add a granularity probe:
   - Write a temp file, read its `mtimeMs`.
   - Write again immediately, read `mtimeMs` again.
   - If both values are equal (coarse granularity detected), skip the mtime assertion and instead compare file content before/after via `JSON.parse` + `deepStrictEqual`.
3. If mtime granularity is fine (values differ), keep the existing `strictEqual(mtimeBefore, mtimeAfter)` assertion.

## Dependencies

- Steps 1–4 are independent of each other (all frontend, different functions).
- Step 2's new unit tests depend on Step 2's refactor being complete.
- Step 3 and Step 4 both modify `buildFilterToolbar()` — they should be sequenced (Step 3 before Step 4, or combined into a single work package).
- Step 5 is independent (backend types only).
- Step 6 is independent (test file only).

## Required Components

### Existing files to modify
- `gui/public/js/views/dashboard.js` — Steps 1, 2, 3, 4
- `gui/public/js/__tests__/dashboard.test.mjs` — Steps 2, 3, 4
- `src/storage/storage.types.ts` — Step 5
- `src/models/project/project.types.ts` — Step 5
- `src/tests/project.manager.test.ts` — Step 6

### Documentation to update
- `docs/agents/project-manifest/gui-frontend.md` — Steps 3, 4
- `docs/agents/project-manifest/api-surface.md` — Step 5
- `.context/` — Regenerate via `ctx generate` after all changes

### No new files required
All changes are modifications to existing files. The new unit tests in Step 2 are additions to the existing test file.

## Assumptions

- The `.filter-label` CSS class in `styles.css` is sufficient for the dashboard toolbar labels without modification.
- The `clearElement()` utility in `gui/public/js/utils/dom.js` is available and imported in `dashboard.js`.
- The `applyFiltersAndSort()` function is not exported or called from outside `dashboard.js` (module-internal refactor only).
- The mtime granularity probe (Step 6) can reliably detect coarse-grained filesystems by writing twice in rapid succession.

## Constraints

- All relative imports in TypeScript files must use `.js` extensions.
- Frontend code is vanilla JS with no build step — no transpilation available.
- Node.js built-in test runner (`node --test`) for backend tests; browser-based test runner for frontend tests.
- No new runtime dependencies may be introduced.

## Out of Scope

- **`persistLastActivity()` ISO comparison** — The synthesis noted this as a "robustness note," not an actionable fix. The constraint is already documented in both source JSDoc and `data-flows.md`. No code change needed unless timestamp normalization changes.
- Visual redesign of the toolbar beyond adding labels.
- Performance optimization of filter/sort logic.
- Refactoring `_allProjects` into a reactive state store or similar pattern.

## Acceptance Criteria

1. `dashboard.js` contains zero `innerHTML` assignments.
2. `applyFiltersAndSort()` accepts `allProjects` as an explicit parameter; no closure over `_allProjects`.
3. New unit tests exercise `applyFiltersAndSort()` with plain data (no DOM).
4. Each toolbar control has a visible `<label>` with class `filter-label` and a `for`/`id` binding.
5. When no repositories exist, the toolbar shows a disabled dropdown with "No repositories" placeholder.
6. `BaseStore.SchemaVersion` in `storage.types.ts` has the versioning policy JSDoc.
7. `project.types.ts` SchemaVersion references `BaseStore` instead of duplicating the policy.
8. The mtime-based test in `project.manager.test.ts` handles coarse-grained filesystems gracefully.
9. All existing backend tests pass (763+).
10. All existing frontend tests pass (114+).
11. TypeScript build is clean (`tsc --noEmit`, 0 errors).
12. `gui-frontend.md` and `api-surface.md` are updated to reflect changes.
13. `.context/` files are regenerated via `ctx generate`.

## Testing Strategy

- **Step 1:** Run existing dashboard tests to confirm loading state renders correctly. Visual inspection of the loading spinner in the browser.
- **Step 2:** New unit tests for `applyFiltersAndSort()` covering all filter/sort combinations. Run full frontend test suite.
- **Step 3:** Visual inspection of toolbar labels. Verify `<label>` elements appear with correct `for` bindings. Run frontend tests.
- **Step 4:** Test with a mock API returning zero repositories — verify disabled dropdown appears. Run frontend tests.
- **Step 5:** `tsc --noEmit` confirms type correctness. Review JSDoc renders correctly.
- **Step 6:** Run `project.manager.test.ts` on local filesystem. If possible, test in a Docker container with tmpfs to verify the fallback path.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **`showLoading()` DOM replacement doesn't match the original visually** | Compare rendered HTML structure before and after. The replacement creates identical elements — `div.loading-indicator` > `span.spinner` + `span`. |
| **`applyFiltersAndSort()` is called from unexpected locations** | Grep the entire `gui/` tree for call sites before refactoring. The function is module-internal. |
| **Visible labels break toolbar layout on narrow screens** | The `.filter-label` class is already used in the error-log bar which has the same flex layout. Test at mobile breakpoints. |
| **mtime granularity probe is itself unreliable** | The probe writes to the same temp directory as the test, so it measures the actual filesystem behavior. False negatives (probe shows fine granularity on a coarse FS) are unlikely because the probe interval is ~0ms. |
| **Disabled repo dropdown confuses users who expect it to be interactive** | Use `disabled` attribute + muted styling (already handled by default browser styles for disabled selects) and descriptive placeholder text. |
