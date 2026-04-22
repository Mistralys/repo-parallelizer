# Plan

## Summary

Follow-up rework plan addressing all actionable strategic recommendations from the `2026-04-21-repository-overview-screen` synthesis. The changes span five areas: extracting a shared `STABLE_WS_ID` constant, adding a `test:gui` npm script, inlining `updateStatusTable`, introducing a `clearElement` utility to replace inconsistent DOM-clearing patterns, and refactoring the `showToast` dynamic import to an `onError` callback in `buildRepoStatusCells`. Two lower-priority "future iteration" items (repository-not-found error state and auto-discovery on Refresh) are included as well.

## Architectural Context

The GUI is a vanilla JavaScript SPA under `gui/public/js/` with no build step. Key modules involved:

- **Views:** `views/workspace-detail.js`, `views/repository-detail.js`, `views/project-detail.js` — all reference the `'STABLE'` workspace ID independently.
- **Shared component:** `components/repo-status-cells.js` — exports `buildRepoStatusCells()`, `makeBranchTrigger()`, `updateRepoStatusCells()`. Currently does a lazy `await import('./toast.js')` inside a Git GUI button click handler to show error toasts.
- **Utilities directory:** `gui/public/js/utils/` — contains `normalise.js`, `nav-highlight.js`, `time.js`. This is the correct home for new shared utilities.
- **Root `package.json`** — contains `"test"` script for backend tests; no `"test:gui"` script exists.

Conventions enforced by `constraints.md` and `gui-frontend.md`:
- No frameworks; native ES modules loaded by the browser.
- Router injection via `setRouter()` — views never import `router.js` directly.
- Cleanup contract: views with side-effects return a cleanup function.
- `innerHTML = ''` is used in `workspace-detail.js` (4 occurrences); `repo-status-cells.js` uses `removeChild` loops with explicit comments discouraging `innerHTML`.

## Approach / Architecture

Seven discrete steps, ordered from quick wins to larger refactors:

1. **Create `gui/public/js/utils/constants.js`** with `STABLE_WS_ID` and import it everywhere.
2. **Add `test:gui` npm script** to root `package.json`.
3. **Add `clearElement` utility** to `gui/public/js/utils/dom.js` and adopt it across views and components.
4. **Refactor `buildRepoStatusCells`** to accept an `onError` callback, eliminating the dynamic `import('./toast.js')`.
5. **Inline `updateStatusTable`** in `workspace-detail.js` at its two call sites.
6. **Add a "repository not found" error state** to `repository-detail.js` that differentiates a 404 response from other failures.
7. **Add auto-discovery on Refresh** in `repository-detail.js` so newly added projects/workspaces appear without a full page reload.

## Rationale

- **Constants extraction** prevents silent drift if the STABLE ID convention ever changes (3 source files + 1 test file currently define it independently).
- **`test:gui` script** closes a CI blind spot: 64+ frontend tests exist but are invisible to `npm test`. A dedicated script is the minimal fix; integration into the main `npm test` can follow later.
- **`clearElement` utility** resolves the inconsistency flagged by the Developer and Reviewer. The `removeChild` loop pattern is marginally safer (no HTML parser invocation) and is already the convention in the newest component.
- **`onError` callback** decouples `repo-status-cells.js` from `toast.js`, making it side-effect–free and easier to test. Both consumer views (`workspace-detail.js`, `repository-detail.js`) already import `showToast` and can pass it directly.
- **Inlining `updateStatusTable`** eliminates a trivial wrapper that adds indirection without value — the function is a 3-line loop called at exactly 2 sites.
- **Repository-not-found error state** improves UX when navigating to a deleted or mistyped repository ID.
- **Auto-discovery on Refresh** ensures the view stays current without requiring a page reload when projects/workspaces are added in another tab.

## Detailed Steps

### Step 1 — Extract `STABLE_WS_ID` to a shared constants module

1. **Create** `gui/public/js/utils/constants.js` exporting `STABLE_WS_ID = 'STABLE'`.
2. **Update** `gui/public/js/views/workspace-detail.js`: remove the local `const STABLE_WS_ID = 'STABLE'` (line 71) and add `import { STABLE_WS_ID } from '../utils/constants.js'`.
3. **Update** `gui/public/js/views/repository-detail.js`: remove the local `const STABLE_WS_ID = 'STABLE'` (line 63) and add the same import.
4. **Update** `gui/public/js/views/project-detail.js`: replace the inline `=== 'STABLE'` (line 503) with an import of `STABLE_WS_ID` and use `=== STABLE_WS_ID`.
5. **Update** `gui/public/js/views/repository-detail.test.mjs`: remove the local constant (line 72) and import from the source or redefine it in a test-helper, depending on how the test module resolution is configured. If native browser imports can't be resolved in the Node test environment (jsdom), keep a local constant but add a comment referencing the canonical source.
6. **Verify** no other files use a hardcoded `'STABLE'` string for workspace ID comparison.

### Step 2 — Add `npm run test:gui` script

1. **Edit** root `package.json`: add `"test:gui": "node --test 'gui/public/js/**/*.test.mjs'"` to the `scripts` object.
2. **Run** `npm run test:gui` to confirm all 64 existing tests pass.
3. **Update** `CONTRIBUTING.md` to replace the manual glob command with `npm run test:gui` and remove the debt note about the missing script.
4. **Update** `docs/agents/project-manifest/tech-stack.md` to add the new script to the Build & Scripts table.

### Step 3 — Add `clearElement` utility

1. **Create** `gui/public/js/utils/dom.js` exporting:
   ```js
   export function clearElement(el) {
       while (el.firstChild) el.removeChild(el.firstChild);
   }
   ```
2. **Update** `gui/public/js/views/workspace-detail.js`: replace the 4 occurrences of `el.innerHTML = ''` (lines 114, 827, 917, 1148) with `clearElement(el)`. Add the import at the top.
3. **Update** `gui/public/js/components/repo-status-cells.js`: replace the 2 `while (...removeChild...)` loops (lines 186-188, 203-205) with `clearElement()` calls. Add the import.
4. **Audit** other GUI files for `innerHTML = ''` usage and convert any found.

### Step 4 — Refactor `buildRepoStatusCells` to accept `onError` callback

1. **Add** an optional `onError` property to the `opts` parameter of `buildRepoStatusCells(opts)` in `gui/public/js/components/repo-status-cells.js`. Type: `(message: string) => void`.
2. **Replace** the dynamic `import('./toast.js')` block in the Git GUI button's click handler (lines 124-126) with a call to `opts.onError(message)` when the callback is provided. If `onError` is not provided, silently swallow the error (the button is already disabled/re-enabled in the `finally` block).
3. **Update** `gui/public/js/views/workspace-detail.js`: pass `onError: (msg) => showToast(msg, 'error')` in the `buildRepoStatusCells` call inside `buildRepoStatusRow`.
4. **Update** `gui/public/js/views/repository-detail.js`: pass the same `onError` callback in the `buildRepoStatusCells` call inside `buildRow`.
5. **Update** the existing `repo-status-cells.test.mjs` to test the `onError` callback path instead of mocking the dynamic import.
6. **Update** `docs/agents/project-manifest/gui-frontend.md`: update the `buildRepoStatusCells(opts)` table to document the new `onError` option.

### Step 5 — Inline `updateStatusTable` in `workspace-detail.js`

1. In `gui/public/js/views/workspace-detail.js`, replace the call at line 972 (`updateStatusTable(tbody, fresh, isStable, onBranchCellClick)`) with the inlined loop:
   ```js
   for (const [repoId, statusInfo] of Object.entries(fresh)) {
       const row = tbody.querySelector(`tr[data-repo-id="${CSS.escape(repoId)}"]`);
       if (!row) continue;
       updateRepoStatusCells(row, repoId, statusInfo, isStable, onBranchCellClick);
   }
   ```
2. Do the same for the call at line 1002.
3. **Remove** the `updateStatusTable` function definition (lines 239-245) and its JSDoc block (lines 233-238).
4. **Note:** `repository-detail.js` has its own `updateStatusTable` with a different signature (takes `rowDescriptors` instead of a `statusMap`). That function is not affected by this change.

### Step 6 — Add "repository not found" error state

1. In `gui/public/js/views/repository-detail.js`, in the `.catch()` block (around line 601), inspect the error for a 404 status indicator. The `api.js` `request()` helper throws errors; check for `err.status === 404` or a similar convention used by the API client.
2. When a 404 is detected, render a dedicated message: e.g., `"Repository '${repoId}' was not found. It may have been deleted."` with a link back to `#/repositories`.
3. For all other errors, keep the existing generic error paragraph.
4. **Verify** what the `api.repositories.get()` call throws on 404 by inspecting `gui/public/js/api.js`'s `request()` helper to understand the error shape.

### Step 7 — Add auto-discovery on Refresh

1. In `gui/public/js/views/repository-detail.js`, modify `doRefresh()` (lines 546-592) to re-discover the project/workspace set rather than only refreshing status for the existing `currentRows`.
2. The approach: re-run the project/workspace discovery fan-out (the same `Promise.allSettled` logic used in the initial load), then diff against `currentRows`:
   - New rows: append to the table.
   - Removed rows: remove from the table.
   - Existing rows: update status in-place (existing behaviour).
3. Update `currentRows` to reflect the new full set.
4. Ensure the `refreshInProgress` mutex and `container.isConnected` guard remain intact.
5. The existing partial-failure toast should continue to fire if any fetch fails.

## Dependencies

- Step 3 (clearElement) should be completed before Step 4 (onError refactor) to avoid editing `repo-status-cells.js` twice.
- Steps 1 and 2 are fully independent of all other steps.
- Steps 5, 6, and 7 are independent of each other.

## Required Components

### New Files
- `gui/public/js/utils/constants.js` — shared `STABLE_WS_ID` constant.
- `gui/public/js/utils/dom.js` — shared `clearElement()` utility.

### Modified Files
- `gui/public/js/views/workspace-detail.js` — steps 1, 3, 5.
- `gui/public/js/views/repository-detail.js` — steps 1, 4, 6, 7.
- `gui/public/js/views/project-detail.js` — step 1.
- `gui/public/js/views/repository-detail.test.mjs` — step 1.
- `gui/public/js/components/repo-status-cells.js` — steps 3, 4.
- `gui/public/js/components/repo-status-cells.test.mjs` — step 4.
- `package.json` — step 2.
- `CONTRIBUTING.md` — step 2.
- `docs/agents/project-manifest/tech-stack.md` — step 2.
- `docs/agents/project-manifest/gui-frontend.md` — steps 1, 3, 4.
- `docs/agents/project-manifest/api-surface.md` — steps 3, 4 (new exports).

## Assumptions

- The `gui/public/js/utils/` directory is the correct location for new shared utilities (consistent with existing `normalise.js`, `nav-highlight.js`, `time.js`).
- The `api.js` `request()` helper propagates HTTP status codes on errors (needs verification in Step 6; if not, the error shape must be adapted).
- The `repository-detail.test.mjs` can import from `../utils/constants.js` in the Node.js test environment, or a local re-declaration with a referencing comment is acceptable.

## Constraints

- No frameworks — vanilla JavaScript with native ES modules.
- All imports must use relative paths with `.js` extensions.
- No build step for the frontend.
- The STABLE workspace invariant (`'STABLE'` string) is enforced at the storage layer and must not be changed — only the _location_ of the constant definition moves.

## Out of Scope

- Integrating `test:gui` into the main `npm test` command or a pre-commit hook (can be done separately).
- Adding polling to the repository detail view (explicitly rejected in the synthesis as too expensive).
- Refactoring other views to use `clearElement` beyond the files identified in the synthesis.

## Acceptance Criteria

- `STABLE_WS_ID` is defined in exactly one source file (`gui/public/js/utils/constants.js`) and imported by all consumers.
- `npm run test:gui` runs all `*.test.mjs` files under `gui/public/js/` and passes.
- `CONTRIBUTING.md` references `npm run test:gui` instead of the manual glob command.
- `tech-stack.md` lists the `test:gui` script.
- No `innerHTML = ''` pattern remains in `workspace-detail.js`; all DOM clearing uses `clearElement()`.
- `repo-status-cells.js` uses `clearElement()` instead of inline `removeChild` loops.
- `buildRepoStatusCells` accepts an `onError` callback; the dynamic `import('./toast.js')` is removed.
- Both consumer views (`workspace-detail.js`, `repository-detail.js`) pass an `onError` callback to `buildRepoStatusCells`.
- `updateStatusTable` no longer exists in `workspace-detail.js`; its logic is inlined at the two call sites.
- Navigating to `#/repositories/nonexistent-id` shows a "not found" message with a link back to the repositories list.
- Clicking Refresh on the repository detail view discovers newly added projects/workspaces that contain the repository.
- All existing frontend tests (64+) and backend tests (752) continue to pass.
- Project manifest documents (`gui-frontend.md`, `tech-stack.md`, `api-surface.md`) are updated to reflect all changes.

## Testing Strategy

- **Unit tests:** Update existing `repo-status-cells.test.mjs` to verify the `onError` callback. Add/update `repository-detail.test.mjs` tests for the 404 error state and auto-discovery on Refresh.
- **Regression:** Run `npm test` (backend) and `npm run test:gui` (frontend) after every step to catch regressions.
- **Manual smoke test:** Launch the GUI, navigate through repository list → repository detail → workspace detail to confirm all views render correctly with the refactored imports and components.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Test files can't resolve `../utils/constants.js` in Node.js test environment** | Verify import resolution in the jsdom test harness before committing. Fall back to a local constant with a referencing comment if needed. |
| **`api.js` error shape doesn't carry HTTP status for 404 detection** | Inspect `request()` in `api.js` first. If no status is available, detect 404 by checking the error message string or modify `request()` to attach `err.status`. |
| **Auto-discovery on Refresh increases request volume** | The fan-out already uses `Promise.allSettled` with graceful degradation. The Refresh button is mutex-protected, preventing rapid re-fires. Acceptable for a local dev tool. |
| **Inlining `updateStatusTable` duplicates 4 lines** | The duplication is minimal (a `for` loop with a querySelector), and the indirection it removes is worth the trade-off. Both call sites are in the same function scope. |
