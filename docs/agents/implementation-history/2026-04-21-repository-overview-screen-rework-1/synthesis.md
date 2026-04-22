## Synthesis

### Completion Status
- Date: 2026-04-21
- Status: COMPLETE
- Completed by: Standalone Developer Agent

### Implementation Summary

Seven discrete steps were implemented in full:

1. **`STABLE_WS_ID` constant extracted** — Created `gui/public/js/utils/constants.js` exporting `STABLE_WS_ID = 'STABLE'`. Removed local declarations from `workspace-detail.js` and `repository-detail.js`; replaced the inline string literal in `project-detail.js`. `repository-detail.test.mjs` retains a local re-declaration with a comment referencing the canonical source (native browser imports cannot be resolved in the Node.js jsdom test harness).

2. **`npm run test:gui` script** — Added `"test:gui": "node --test 'gui/public/js/**/*.test.mjs'"` to `package.json`. Updated `CONTRIBUTING.md` to remove the manual glob command and the "planned" debt note. Updated `tech-stack.md` Build & Scripts table.

3. **`clearElement` utility** — Created `gui/public/js/utils/dom.js` exporting `clearElement(el)`. Replaced all 4 `innerHTML = ''` occurrences in `workspace-detail.js` (including `showLoading`, the main render path, `renderHealthSection`, and the error catch block). Replaced the 2 `removeChild` loops in `repo-status-cells.js`'s `updateRepoStatusCells`. Also applied to `repository-detail.js` (3 occurrences) since that file was already a required modification target.

4. **`onError` callback on `buildRepoStatusCells`** — Added an optional `onError: (message: string) => void` parameter. The dynamic `import('./toast.js')` inside the Git GUI click handler was removed; the handler now calls `onError(message)` when the callback is provided, or silently swallows the error when absent. Both consumer views (`workspace-detail.js` and `repository-detail.js`) pass `onError: (msg) => showToast(msg, 'error')`. Added 2 new tests to `repo-status-cells.test.mjs` covering the callback-present and callback-absent error paths.

5. **`updateStatusTable` inlined in `workspace-detail.js`** — The 3-line helper was a trivial wrapper over `updateRepoStatusCells` called at exactly 2 sites (inside `doPoll` and `doRefresh`). The function body was inlined at both call sites and the function definition and JSDoc were removed. The `repository-detail.js` `updateStatusTable` (different signature — takes `rowDescriptors`) is unrelated and was not changed.

6. **Repository-not-found error state** — Modified `api.js` `request()` to attach `err.status = response.status` on thrown errors. In `repository-detail.js`, the `.catch()` block now checks `err.status === 404` and renders a dedicated "not found" message with the repository ID and a link back to `#/repositories`; all other errors continue to show the generic error paragraph. Added 2 new tests to `repository-detail.test.mjs`.

7. **Auto-discovery on Refresh** — Rewrote `doRefresh()` in `repository-detail.js`. Instead of only refreshing status for existing `currentRows`, it now calls `api.projects.list()` then re-runs the full `loadWorkspaceRows` discovery fan-out. The result is diffed against `currentRows`: new rows are appended to `tbody`, removed rows are dropped from `tbody`, and existing rows have their status force-refreshed via `api.status.refresh()`. When `tbody` was null (initial empty state) and new rows are found, the status section is replaced entirely via `container.replaceChild`. `currentRows` is updated to the final set. The `refreshInProgress` mutex and `container.isConnected` guards remain intact. Added 2 new tests to `repository-detail.test.mjs`.

### Documentation Updates
- `tech-stack.md` — Added `test:gui` script to the Build & Scripts table.
- `CONTRIBUTING.md` — Updated GUI test section to reference `npm run test:gui`; removed the "planned" debt note.
- `gui-frontend.md` — Updated route description for `#/repositories/:id` (auto-discovery, 404 handling, `onError` callback). Updated `#/projects/:id/workspaces/:wid` description (clearElement, onError). Updated `buildRepoStatusCells` options table to document `onError`. Updated error-handling note for the Git GUI button. Updated workspace-detail polling description to reflect inlined update loop. Updated Utilities table to add `constants.js` and `dom.js`.
- `api-surface.md` — Updated GUI Client description to note `err.status` is now attached on non-2xx errors. Added `GUI Utilities` section documenting `constants.js`, `dom.js`, and `normalise.js`.

### Verification Summary
- Tests run: `npm run test:gui` (100 tests), `npm test` (752 backend tests)
- Static analysis run: TypeScript compiler via `npm test` (tsc step)
- Result: **PASS** — 100 frontend tests pass, 752 backend tests pass, 0 failures

### Code Insights

- [low] (debt) ~~`gui/public/js/views/branch-switch.js`, `settings.js`, `repositories.js`, `dashboard.js`, `components/branch-quick-switch.js`: These files still use `innerHTML = ''` for DOM clearing. The pattern is now inconsistent with the `clearElement` convention established in this plan. Converting them would improve uniformity but is explicitly out-of-scope per the plan's constraints section.~~ **DONE** — Fixed in the Code Insights follow-up pass.

- [low] (improvement) `gui/public/js/views/repository-detail.js` — `doRefresh` calls `api.projects.list()` on every refresh, then `loadWorkspaceRows` also fans out across all projects. For repos that appear in many projects, a full refresh can issue many parallel requests. Acceptable for a local dev tool, but worth noting for future load testing.

- [low] (convention) ~~`gui/public/js/views/workspace-detail.open-button.test.mjs` and `workspace-detail.vscode-button.test.mjs`: Both test files reset `document.getElementById('toast-container').innerHTML = ''` in their `beforeEach`/cleanup helpers using `innerHTML = ''`. These are test files (not production code) so the risk is zero, but they technically diverge from the `clearElement` convention. Updating them would be a trivial cosmetic change.~~ **DONE** — Fixed in the Code Insights follow-up pass.

- [low] (improvement) `gui/public/js/api.js` — The `request()` function now attaches `err.status` to thrown errors. However, no other error properties (e.g. a structured `err.body` for the full JSON error object) are exposed. Should a future consumer need more than the status code and message, `request()` will need a further enhancement. No immediate action required.

### Additional Comments
- The `loadWorkspaceRows` function is re-used inside the new `doRefresh` for discovery. It internally uses `api.status.get` (the cached endpoint) for the initial status values of discovered rows; a subsequent `api.status.refresh` is called only for rows that were already in `currentRows`. This is intentional: new rows don't need a force-refresh since they were just freshly fetched. The plan's acceptance criteria ("Clicking Refresh discovers newly added projects/workspaces") is fully satisfied.

---

## Synthesis — Code Insights Follow-up

### Completion Status
- Date: 2026-04-21
- Status: COMPLETE
- Completed by: Standalone Developer Agent

### Implementation Summary
Implemented the actionable Code Insights from the previous synthesis pass:

1. **`clearElement` uniformity across remaining view and component files** — Added `import { clearElement } from '../utils/dom.js'` to `branch-switch.js`, `settings.js`, `repositories.js`, `dashboard.js`, and `components/branch-quick-switch.js`. Replaced all `innerHTML = ''` calls in those files (6 in `branch-switch.js`, 3 in `settings.js`, 2 in `repositories.js`, 2 in `dashboard.js`, 3 in `branch-quick-switch.js`).

2. **Test file cosmetic fix** — Added a local `clearElement` helper to `workspace-detail.open-button.test.mjs` and `workspace-detail.vscode-button.test.mjs` (matching the `STABLE_WS_ID` re-declaration pattern; static imports from `../utils/dom.js` cannot be resolved in the Node.js jsdom harness). Replaced the 2 `innerHTML = ''` occurrences in each test file.

### Documentation Updates
- No documentation updates required. The `clearElement` utility and its convention were already documented in `gui-frontend.md` and `api-surface.md` in the previous pass. These changes are purely mechanical consistency fixes.

### Verification Summary
- Tests run: `npm run test:gui`
- Static analysis run: none (pure JS; no tsc step for GUI)
- Result: **PASS** — 100/100 frontend tests pass, 0 failures

### Code Insights

- [low] (debt) `gui/public/js/views/project-detail.js` (lines 857, 905, 912) and `gui/public/js/router.js` (lines 157, 175): These files still use `innerHTML = ''`. They were not listed in the previous synthesis's Code Insights and fall outside the scope of this follow-up. Future cleanup could bring them in line with the `clearElement` convention.

- [low] (debt) `gui/public/js/components/repo-status-cells.test.mjs` (line 144): Uses `innerHTML = ''` in its `beforeEach` cleanup, same pattern as the two test files fixed here. Out of scope for this follow-up.

### Additional Comments
- None.
