# Plan

## Summary

Three follow-up improvements to the `2026-04-15-launch-external-apps` delivery: (1) extract the duplicated workspace-existence check in `src/server/routes/workspaces.ts` into a private helper, (2) move the two launch methods in `gui/public/js/api.js` into a nested `api.workspaces.launch` sub-namespace (matching the `api.config.credentials` / `api.config.polling` precedent), and (3) establish toast test coverage infrastructure so `showToast()` calls in GUI tests are directly asserted via DOM inspection rather than inferred from side-effects.

## Architectural Context

### Workspace-existence check duplication (`workspaces.ts`)

`src/server/routes/workspaces.ts` contains **6 instances** of the following pattern across the `setup`, `regenerate-workspace-file`, `health`, `launch/vscode`, and `launch/github-desktop/:rid` handlers (the GET-single handler has a structural variation):

```ts
try {
    const ws = workspaceManager.getById(projectId, workspaceId);
    if (ws === undefined) {
        sendError(res, 404, `Workspace "${workspaceId}" not found in project "${projectId}".`);
        return;
    }
} catch (err) {
    sendError(res, 404, err instanceof Error ? err.message : 'Not found.');
    return;
}
```

The pattern exists because `workspaceManager.getById()` can both _return `undefined`_ (workspace not found within an existing project) and _throw a `NotFoundError`_ (project itself not found). Both cases must send a 404 and short-circuit.

### API namespace structure (`api.js`)

The `api.workspaces` namespace currently has **11 flat methods**: `list`, `get`, `create`, `update`, `rename`, `delete`, `setup`, `health`, `regenerateFile`, `openVscode`, `openGithubDesktop`. The last two are launch-type methods added by the previous plan. The existing sub-namespace precedent is `api.config.credentials` and `api.config.polling`.

`CONTRIBUTING.md` (lines 98–108) already documents the architectural recommendation to group these into `api.workspaces.launch`. The note should be updated after the refactoring is complete.

### Toast test gap (GUI tests)

`gui/public/js/components/toast.js` renders toast notifications by looking up `#toast-container` via `document.getElementById()`. The existing GUI test files (`workspace-detail.vscode-button.test.mjs` and `workspace-detail.open-button.test.mjs`) initialise jsdom with `<div id="app">` only — no `#toast-container`. This causes `showToast()` to return `null` (silent no-op), making toast assertions impossible. Tests currently validate behaviour indirectly by checking button re-enable state.

The `showToast()` function itself is imported at module load time by `workspace-detail.js`. Because `getContainer()` performs a lazy DOM lookup (`document.getElementById('toast-container')`) on every call, adding the element to the jsdom's document before test execution is sufficient — no module-level patching is needed.

## Approach / Architecture

### Part A — `resolveWorkspace()` helper

Add a private function inside `registerWorkspaceRoutes()` that encapsulates the `getById` + 404 logic:

```ts
function resolveWorkspace(
    res: ServerResponse,
    projectId: string,
    workspaceId: string,
): WorkspaceInfo | undefined {
    try {
        const ws = workspaceManager.getById(projectId, workspaceId);
        if (ws === undefined) {
            sendError(res, 404, `Workspace "${workspaceId}" not found in project "${projectId}".`);
            return undefined;
        }
        return ws;
    } catch (err) {
        sendError(res, 404, err instanceof Error ? err.message : 'Not found.');
        return undefined;
    }
}
```

Callers then become: `const ws = resolveWorkspace(res, projectId, workspaceId); if (!ws) return;`

The GET single-workspace handler uses a slightly different structure (it calls `sendJson` inside the try block on success). It can still use `resolveWorkspace()` by extracting the success logic:

```ts
const workspace = resolveWorkspace(res, params['id'], params['wid']);
if (!workspace) return;
sendJson(res, 200, withInitialized(workspace));
```

### Part B — `api.workspaces.launch` sub-namespace

Restructure `api.js` so that `openVscode` and `openGithubDesktop` move from flat methods on `workspaces` to a nested `launch` sub-object:

```js
const workspaces = {
    // ... existing 9 methods ...

    launch: {
        vscode(projectId, wid) { /* ... */ },
        githubDesktop(projectId, wid, repoId) { /* ... */ },
    },
};
```

This requires updating all call sites:
- `gui/public/js/views/workspace-detail.js` — `api.workspaces.openVscode(...)` → `api.workspaces.launch.vscode(...)`; `api.workspaces.openGithubDesktop(...)` → `api.workspaces.launch.githubDesktop(...)`
- `gui/public/js/api.workspaces.launch.test.mjs` — spy assignments and assertions
- `gui/public/js/views/workspace-detail.vscode-button.test.mjs` — spy assignments
- `gui/public/js/views/workspace-detail.open-button.test.mjs` — spy assignments

### Part C — Toast test infrastructure

Add `#toast-container` to the jsdom HTML in each GUI test file that exercises `showToast()`. The element must appear in the initial `new JSDOM(...)` HTML string:

```js
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="toast-container"></div><div id="app"></div></body></html>', { ... });
```

Then add toast assertion helpers and new test cases that verify:
- After a successful VS Code launch → a success toast with `'VS Code launched for this workspace.'` appears.
- After a failed VS Code launch → an error toast with the error message appears.
- After a failed GitHub Desktop launch → an error toast with the error message appears.

Toast elements are `<div class="toast toast-success">` (or `toast-error`) containing a `<span class="toast-message">` with `textContent` set to the message. Tests can query `#toast-container` for these elements.

**Timer consideration:** `showToast()` schedules auto-dismiss via `setTimeout`. Since the jsdom tests don't use real timers (they poll microtask queues), auto-dismiss timers won't fire during the test. No timer mocking is needed — the toast element will persist in the DOM for the duration of each test, making assertions trivial. The `#toast-container` should be cleared in `beforeEach` to avoid toast leakage between tests.

## Rationale

- **Part A:** 6 copy-pasted blocks is a maintenance liability — a change to the 404 message or error handling would require 6 edits. A helper makes the intent immediately clear and reduces the risk of divergence.
- **Part B:** The `CONTRIBUTING.md` note anticipated this change. Two methods already form a logical group. Doing this now (at 11 methods) prevents the need to update callers later when more launch methods are added (e.g. "Open in Terminal"). The sub-namespace also improves code readability: `api.workspaces.launch.vscode()` is more descriptive than `api.workspaces.openVscode()`.
- **Part C:** Toast assertions were deferred during the initial implementation because the test infrastructure didn't support them. Adding `#toast-container` to jsdom is a zero-cost change that unlocks direct assertion on user-visible feedback, which is the primary acceptance signal for launch button interactions.

## Detailed Steps

### Step 1 — Add `resolveWorkspace()` helper in `workspaces.ts`

1. Add an explicit type import for `WorkspaceInfo` at the top of `workspaces.ts` — it is **not** currently imported (the `withInitialized` helper uses a generic constraint instead). Add:
   ```ts
   import type { WorkspaceInfo } from '../../models/workspace/workspace.types.js';
   ```
   Verify the import path resolves correctly (the type is defined in `src/models/workspace/workspace.types.ts`).
2. Inside `registerWorkspaceRoutes()`, after the existing `withInitialized()` helper, add the `resolveWorkspace()` function as described in the Approach section.

### Step 2 — Replace all workspace-existence check blocks

Replace the duplicated pattern in these 6 handlers with `resolveWorkspace()`:

1. **GET `/api/projects/:id/workspaces/:wid`** — replace the try/catch block; move `sendJson(res, 200, withInitialized(workspace))` after the `if (!ws) return;` guard.
2. **POST `/api/projects/:id/workspaces/:wid/setup`** — replace, keeping subsequent orchestrator logic unchanged.
3. **POST `/api/projects/:id/workspaces/:wid/regenerate-workspace-file`** — replace, keeping subsequent file regeneration logic unchanged.
4. **GET `/api/projects/:id/workspaces/:wid/health`** — replace, keeping subsequent health check logic unchanged.
5. **POST `/api/projects/:id/workspaces/:wid/launch/vscode`** — replace, keeping subsequent launch logic unchanged.
6. **POST `/api/projects/:id/workspaces/:wid/launch/github-desktop/:rid`** — replace, keeping subsequent launch logic unchanged.

### Step 3 — Move launch methods to `api.workspaces.launch` sub-namespace in `api.js`

1. Remove `openVscode` and `openGithubDesktop` from the flat `workspaces` object.
2. Add a `launch` property to the `workspaces` object containing `vscode(projectId, wid)` and `githubDesktop(projectId, wid, repoId)`.
3. Update JSDoc on each method (rename references from `openVscode` → `launch.vscode`, etc.).

### Step 4 — Update call sites in `workspace-detail.js`

1. Replace `api.workspaces.openVscode(projectId, wid)` → `api.workspaces.launch.vscode(projectId, wid)`.
2. Replace `api.workspaces.openGithubDesktop(projectId, wid, repoId)` → `api.workspaces.launch.githubDesktop(projectId, wid, repoId)`.

### Step 5 — Update API test spies in GUI test files

1. **`api.workspaces.launch.test.mjs`** — update references from `api.workspaces.openVscode` and `api.workspaces.openGithubDesktop` to `api.workspaces.launch.vscode` and `api.workspaces.launch.githubDesktop`.
2. **`workspace-detail.vscode-button.test.mjs`** — update spy from `api.workspaces.openVscode = ...` to `api.workspaces.launch.vscode = ...`.
3. **`workspace-detail.open-button.test.mjs`** — update spy from `api.workspaces.openGithubDesktop = ...` to `api.workspaces.launch.githubDesktop = ...`.

### Step 6 — Add `#toast-container` to GUI test jsdom setup

In **both** `workspace-detail.vscode-button.test.mjs` and `workspace-detail.open-button.test.mjs`:

1. Modify the `JSDOM` constructor HTML to include `<div id="toast-container"></div>` before `<div id="app">`.
2. Add a `beforeEach` step (or extend the existing one) to clear `document.getElementById('toast-container').innerHTML = ''`.
3. In `workspace-detail.vscode-button.test.mjs`: remove the vestigial `toastCalls` array and its comment block (lines 55–59). This array was declared but is **never populated or asserted against** anywhere in the file. The new DOM-based toast assertions (Step 7) replace the originally intended spy approach, making `toastCalls` permanently dead code.

### Step 7 — Add direct toast assertion tests

**In `workspace-detail.vscode-button.test.mjs`:**

1. Add a test for AC3 variant: after a successful `openVscode` call, verify that `#toast-container` contains a `.toast-success` element with `.toast-message` text `'VS Code launched for this workspace.'`.
2. Add a test for AC4 variant: after a failed `openVscode` call, verify that `#toast-container` contains a `.toast-error` element with `.toast-message` text matching the error message (e.g. `'VS Code not installed'`).

**In `workspace-detail.open-button.test.mjs`:**

3. Add a test: after a failed `openGithubDesktop` call, verify that `#toast-container` contains a `.toast-error` element with `.toast-message` text matching the error message.

### Step 8 — Update `CONTRIBUTING.md`

Replace the `api.workspaces namespace growth` section (lines 98–108) to reflect that the sub-namespace has been implemented and describe the actual structure. The note about "consider introducing" should become a statement of fact.

### Step 9 — Update manifest documents

1. **`docs/agents/project-manifest/gui-frontend.md`:**
   - Update the `api.workspaces` method list to show `api.workspaces.launch.vscode(pid, wid)` and `api.workspaces.launch.githubDesktop(pid, wid, rid)` instead of `openVscode` and `openGithubDesktop`.
   - Update the Launch Methods table headers and method names.
   - Update the workspace-detail view description to reference `api.workspaces.launch.githubDesktop()` instead of `api.workspaces.openGithubDesktop()`.

2. **`docs/agents/project-manifest/api-surface.md`:**
   - Update the `registerWorkspaceRoutes()` JSDoc or surrounding text if it references the workspace-existence pattern.
   - Ensure the route registration signature still reflects the current parameter list (no change needed — `resolveWorkspace` is a private helper).

3. **`docs/agents/project-manifest/rest-api.md`:**
   - No changes needed — the REST endpoints themselves have not changed, only the client-side method names.

### Step 10 — Run full test suite and verify

1. Run `npx tsc --noEmit` to verify TypeScript compilation.
2. Run `npm test` to verify all server-side tests pass (the workspace route tests exercise the same 404 paths, so the `resolveWorkspace()` refactor must produce identical HTTP responses).
3. Run `node --test gui/public/js/**/*.test.mjs` to verify all GUI tests pass, including the new toast assertion tests.

## Dependencies

- The `WorkspaceInfo` type — **not** currently imported in `workspaces.ts` (the `withInitialized` helper sidesteps it via a generic constraint). An explicit import must be added for the `resolveWorkspace` return type (see Step 1).
- No new npm dependencies.

## Required Components

### Modified files
- `src/server/routes/workspaces.ts` — add `resolveWorkspace()` helper, replace 6 duplicated blocks
- `gui/public/js/api.js` — restructure `workspaces` to include `launch` sub-namespace
- `gui/public/js/views/workspace-detail.js` — update 2 call sites to use new sub-namespace
- `gui/public/js/api.workspaces.launch.test.mjs` — update spy names
- `gui/public/js/views/workspace-detail.vscode-button.test.mjs` — update spy, add `#toast-container`, add toast tests
- `gui/public/js/views/workspace-detail.open-button.test.mjs` — update spy, add `#toast-container`, add toast test
- `CONTRIBUTING.md` — update namespace growth note
- `docs/agents/project-manifest/gui-frontend.md` — update api method names and launch table
- `docs/agents/project-manifest/api-surface.md` — verify only; no changes expected (the `resolveWorkspace()` helper is closure-scoped and not exported, so the API surface does not change)

### No new files

## Assumptions

- The `resolveWorkspace()` helper is private to `registerWorkspaceRoutes()` (closure-scoped), not exported. Tests verify behaviour through HTTP-level assertions, not direct calls.
- Toast auto-dismiss timers will not fire during jsdom microtask-based test execution, so toast elements persist in the DOM for the full test duration.
- The `#toast-container` element in the jsdom has no CSS transitions, so `dismissToast()` will still attempt to set `dataset.dismissing` and add the `.removing` class, but the `setTimeout` for DOM removal won't fire.

## Constraints

- Relative imports must use `.js` extensions (Node16 ESM).
- No build step for the GUI frontend.
- All existing tests must continue to pass with identical assertions (the refactoring is behaviour-preserving).
- The `resolveWorkspace()` helper must produce byte-identical 404 responses to the current inline code.

## Out of Scope

- Path boundary assertions (synthesis recommendation #1) — security hardening, separate concern.
- Windows CI for `shell:true` branch (synthesis recommendation #4) — CI infrastructure, separate concern.
- Refactoring other route files (e.g., `projects.ts`) to use a similar helper — scope limited to `workspaces.ts`.
- Adding new launch endpoints (e.g. "Open in Terminal") — this plan prepares the sub-namespace but does not add new functionality.

## Acceptance Criteria

- The `resolveWorkspace()` helper exists inside `registerWorkspaceRoutes()` and is used by all 6 handlers that previously had the inline pattern.
- All existing workspace route tests pass without modification (behaviour-preserving refactor).
- `api.workspaces.launch.vscode(pid, wid)` and `api.workspaces.launch.githubDesktop(pid, wid, rid)` are the public API names; `api.workspaces.openVscode` and `api.workspaces.openGithubDesktop` no longer exist.
- All GUI test files that reference the launch methods use the new sub-namespace names.
- `workspace-detail.vscode-button.test.mjs` includes at least 2 new tests asserting on rendered toast DOM elements (success and error cases).
- `workspace-detail.open-button.test.mjs` includes at least 1 new test asserting on a rendered error toast DOM element.
- `CONTRIBUTING.md` reflects the implemented sub-namespace (not a future recommendation).
- `gui-frontend.md` references the new method names.
- TypeScript compilation passes cleanly (`npx tsc --noEmit`).
- Full test suite passes (server + GUI).

## Testing Strategy

- **Server-side:** Existing test suite in `src/server/__tests__/routes/workspaces.test.ts` and `workspaces-launch.test.ts` provides full coverage of the 404/400/500 response codes. The `resolveWorkspace()` refactor is purely structural — it must not change any HTTP response. All existing tests must pass without modification.
- **GUI API tests:** `api.workspaces.launch.test.mjs` tests the `request()` calls. After renaming, the test assertions should verify the same URLs are called via the new method names.
- **GUI view tests:** The existing button interaction tests in both test files continue to verify click → API call → button re-enable. The new toast tests add direct DOM assertions on `#toast-container` children.
- **Regression gate:** `npx tsc --noEmit && npm test && node --test gui/public/js/**/*.test.mjs` must all exit with code 0.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **`resolveWorkspace()` produces subtly different error messages** | The helper uses the exact same string templates as the inline blocks. Existing tests act as a regression gate for exact message content. |
| **GUI test spy wiring breaks after sub-namespace change** | Step 5 explicitly enumerates every test file and spy assignment that must be updated. Mechanical find-and-replace. |
| **Toast elements not created in jsdom due to missing CSS or `setTimeout` issues** | `showToast()` does not depend on CSS — it creates DOM elements directly. `setTimeout` for auto-dismiss won't fire in test, which is beneficial (elements persist for assertion). |
| **`WorkspaceInfo` import missing for `resolveWorkspace` return type** | Verify the import exists at Step 1; add it if absent. The type is already defined in `src/models/workspace/workspace.types.ts`. |
