# Plan — Per-Repository Quick Branch Switch

## Summary

Add a per-repository quick branch switcher to the workspace detail view. Clicking a branch name in the "Branch" column of the status table opens an inline popover anchored below the cell, letting the user pick an existing branch or type a new name, then switch that single repository immediately — without navigating to the full 3-step branch switch wizard. The feature is restricted to non-STABLE workspaces, consistent with the existing "Switch Branches" button.

## Architectural Context

- **Workspace detail view** (`gui/public/js/views/workspace-detail.js`): Renders a status table with columns Repository | Branch | Status | Actions. The branch cell currently displays plain text (`branchCell.textContent`). Polling refreshes badge and branch text in-place via `updateStatusTable()`.
- **Branch switch wizard** (`gui/public/js/views/branch-switch.js`): 3-step wizard at `#/projects/:id/workspaces/:wid/branch-switch`. Step 1 fetches `api.branches.list()` which returns `{ branches: { [repoId]: BranchInfo[] }, suggestions: string[] }`. Step 2 lets you customise per-repo. Step 3 calls `api.branches.switch()`.
- **Branch API endpoints** (`src/server/routes/branches.ts`):
  - `GET /api/projects/:id/workspaces/:wid/branches` — returns all branches per repo + suggestions.
  - `POST /api/projects/:id/workspaces/:wid/branches/switch` — accepts `{ assignments: { [repoId]: branchName } }`. Already supports single-repo assignments (only one key in the object).
- **Status badge component** (`gui/public/js/components/status-badge.js`): Renders the colour-coded pill in the Status column. Not involved in the branch cell.
- **Confirm dialog component** (`gui/public/js/components/confirm-dialog.js`): Modal overlay pattern — builds DOM manually, appends to `document.body`, returns a Promise. Uses `.modal-overlay` / `.modal` CSS classes.
- **CSS** (`gui/public/css/styles.css`): Contains modal styles (`.modal-overlay`, `.modal`, scoped at `z-index: 1000`), status badge pill styles (`.status-badge`), form classes (`.form-input`, `.form-group`, `.form-actions`, `.form-error`), button classes (`.btn`, `.btn-primary`, `.btn-secondary`, `.btn-sm`).
- **API client** (`gui/public/js/api.js`): `api.branches.list(pid, wid)` and `api.branches.switch(pid, wid, assignments)` already exist.
- **STABLE constraint**: The "Switch Branches" button (`buildSwitchBranchesButton`) is only rendered when `!isStable`. The quick switcher should follow the same rule.

**No backend changes are required.** The existing endpoints already support single-repo branch switching.

## Approach / Architecture

### New Component: `gui/public/js/components/branch-quick-switch.js`

A self-contained popover component exported as `showBranchQuickSwitch(options)`. It:

1. Fetches branch data via `api.branches.list(projectId, wid)` (or accepts pre-fetched data).
2. Anchors an inline popover below the clicked branch cell.
3. Renders:
   - A text input pre-filled with the current branch name. Typing in the input **filters the branch list** in real-time (case-insensitive substring match), providing autocomplete-style UX for repositories with many branches.
   - A scrollable list of available branches for that specific repository (from `branchMap[repoId]`), with the current branch visually marked. The list updates as the user types.
   - A "Switch" button to execute the switch.
   - A "Cancel" button (or click-outside / Escape to dismiss).
4. On confirm, calls `api.branches.switch(pid, wid, { [repoId]: branchName })`.
5. Returns a `Promise<{ switched: boolean, newBranch?: string }>` so the caller can decide whether to trigger a refresh.

### Workspace Detail View Changes

- In `buildRepoStatusRow()`: make the branch cell clickable for non-STABLE workspaces. Add a `cursor: pointer` style hint and an `aria-label` / `role="button"` for accessibility. Pass `isStable` as a new parameter.
- On click: call `showBranchQuickSwitch({ anchorEl, projectId, wid, repoId, currentBranch })`.
- On successful switch: trigger `doRefresh()` to update the status table.
- In `updateStatusTable()`: preserve the clickable behaviour when updating branch cells (rebuild as clickable element, not plain text).

### Popover UI Mechanics

- The popover is a `<div>` appended to `document.body`, absolutely positioned below the anchor element using `getBoundingClientRect()`.
- Dismissed on: click outside, Escape key, or Cancel button click.
- The approach mirrors the existing confirm-dialog pattern (DOM creation → body append → cleanup on dismiss) but uses anchored positioning instead of centred modal.

## Rationale

- **Inline popover (not modal)**: Lighter-weight interaction — the user can see the table context while switching. Follows modern UI conventions for quick-edit actions on table cells.
- **Reusing existing API endpoints**: `api.branches.switch()` already supports single-repo assignments with one key in the `assignments` object. No backend changes are necessary.
- **Separate component file**: Keeps `workspace-detail.js` from growing further. The popover logic is self-contained and testable.
- **Non-STABLE only**: Consistent with the existing "Switch Branches" button restriction and the STABLE workspace invariant (always tracks the default remote branch).

## Detailed Steps

### Step 1 — Create the `branch-quick-switch.js` component

Create `gui/public/js/components/branch-quick-switch.js` with:

- A `showBranchQuickSwitch(options)` export that returns `Promise<{ switched: boolean, newBranch?: string }>`.
- `options` shape: `{ anchorEl: HTMLElement, projectId: string, wid: string, repoId: string, currentBranch: string }`.
- Internal flow:
  1. Build the popover DOM: a container `<div class="branch-quick-switch">` appended to `document.body`.
  2. Position it below `anchorEl` using `getBoundingClientRect()`.
  3. Show a loading spinner while calling `api.branches.list(projectId, wid)`.
  4. On success, populate:
     - A text `<input>` pre-filled with `currentBranch`, with `spellcheck="false"`, `autocomplete="off"`. Attach an `input` event listener that **filters the branch list** in real-time (case-insensitive substring match on branch name).
     - A scrollable `<ul class="branch-quick-switch-list">` of branches from `branchData.branches[repoId]`. Each `<li>` is clickable and sets the input value. The current branch gets a `(current)` suffix and a distinct style. List items are shown/hidden based on the filter input; when the input is empty, all branches are visible.
     - Action row: "Switch" (`btn btn-primary btn-sm`) and "Cancel" (`btn btn-secondary btn-sm`).
  5. "Switch" click: validate input is non-empty, show "Switching…" state, call `api.branches.switch(projectId, wid, { [repoId]: inputValue })`. The response shape is `{ results: Record<string, { success: boolean, conflict: boolean, error?: string }> }`. On success (`results[repoId].success === true`): if `conflict` is also `true`, show a warning toast (e.g., "Switched to branch X (conflicts detected)"); otherwise show a success toast. Resolve the promise with `{ switched: true, newBranch: inputValue }`. On failure (`success === false` or HTTP error): show an error toast with the `error` message and resolve with `{ switched: false }`.
  6. "Cancel" / Escape / click-outside: resolve with `{ switched: false }`.
  7. Cleanup: remove popover from DOM, remove global event listeners.

### Step 2 — Add CSS for the popover

Add styles to `gui/public/css/styles.css`:

- `.branch-quick-switch` — positioned absolutely, `z-index: 500` (below `.modal-overlay` at 1000 and `#toast-container` at 2000, so that confirm dialogs and toasts can overlay the popover), white background, border-radius, box-shadow, padding, min/max width, `animation: popoverSlideUp` (use a distinct keyframe name to avoid collision with the existing `slideUp` used by `.modal`).
- `.branch-quick-switch-list` — `max-height: 200px`, `overflow-y: auto`, list-style none.
- `.branch-quick-switch-list li` — padding, cursor pointer, hover highlight.
- `.branch-quick-switch-list li.current` — bold or checkmark prefix to mark current branch.
- `.branch-quick-switch-backdrop` — fixed overlay like `.modal-overlay` but transparent (to catch outside clicks), `z-index: 499` (just below the popover).
- `@keyframes popoverSlideUp` — new keyframe definition (distinct from the existing `slideUp` used by `.modal`): `from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); }`.
- `.branch-quick-switch .form-actions` — reuse existing form-actions pattern.
- `.repo-branch-cell.clickable` — `cursor: pointer` with hover underline/colour hint.

### Step 3 — Make branch cells clickable in `workspace-detail.js`

Modify `buildRepoStatusRow()`:
- Add two new parameters: `isStable` (boolean) and `onBranchSwitch` (callback).
- When `!isStable` and `statusInfo?.currentBranch` is present:
  - Instead of setting `branchCell.textContent`, create a `<button>` element styled as inline text (`btn-link` / unstyled button) with `role="button"`, `aria-label="Switch branch for {repoName}"`, and class `branch-switch-trigger`.
  - On click: use a **dynamic `import()`** to load `showBranchQuickSwitch` from `'../components/branch-quick-switch.js'` (avoids loading the component for STABLE workspaces and on initial page load), then call it, and on `{ switched: true }` invoke the `onBranchSwitch` callback.
- When `isStable` or no current branch: keep the current plain-text rendering.

Modify `buildStatusTableSection()`:
- This is the intermediary that calls `buildRepoStatusRow()`. Add `isStable` and `onBranchSwitch` parameters to its signature and forward them to each `buildRepoStatusRow()` call.

Modify `updateStatusTable()`:
- Add two new parameters: `isStable` (boolean) and `onBranchSwitch` (callback). When updating the branch cell, rebuild it in the same clickable/non-clickable style based on `isStable`. Both callers (`doPoll` and `doRefresh`) already have closure access to `isStable` and `doRefresh` inside `renderWorkspaceDetail`, so they can pass these values directly.

Modify `renderWorkspaceDetail()`:
- Pass `isStable` and a `doRefresh` callback to `buildStatusTableSection()` (which threads them to `buildRepoStatusRow()`).
- Pass `isStable` and `doRefresh` to all `updateStatusTable()` call sites inside `doPoll()` and `doRefresh()`.

### Step 4 — Add CSS for the clickable branch cell trigger

Add to `gui/public/css/styles.css`:
- `.branch-switch-trigger` — styled as inline text (inherits font, color) but with pointer cursor, subtle hover underline or background tint to indicate interactivity. No browser default button chrome.

### Step 5 — Update `gui-frontend.md` manifest

- Document the new `branch-quick-switch.js` component in the Reusable Components table.
- Update the workspace detail view description to mention the per-repo quick branch switch.
- Note the `showBranchQuickSwitch()` export in the API Client or Components section.

## Dependencies

- `api.branches.list()` — existing, no changes.
- `api.branches.switch()` — existing, no changes.
- `showToast()` — existing, used for success/error feedback.
- `styles.css` — new CSS classes added.

## Required Components

| Component | Status | Location |
|-----------|--------|----------|
| `branch-quick-switch.js` | **New** | `gui/public/js/components/branch-quick-switch.js` |
| `workspace-detail.js` | Modified | `gui/public/js/views/workspace-detail.js` |
| `styles.css` | Modified | `gui/public/css/styles.css` |
| `gui-frontend.md` | Modified | `docs/agents/project-manifest/gui-frontend.md` |

## Assumptions

- The `api.branches.list()` response for a workspace includes a `branches` map keyed by all repository IDs in the workspace. Verified in `src/server/routes/branches.ts`.
- `api.branches.switch()` accepts a single-entry `assignments` object (e.g., `{ "my-repo": "feature/x" }`). Verified: the endpoint validates `Object.keys(assignments).length === 0` (must not be empty) but has no upper-bound check. A single entry is valid.
- The popover does not need to survive a polling update. If a poll fires while the popover is open, the underlying branch cell text may update, but the popover's state is independent. This is acceptable because the switch action will trigger its own refresh on completion.

## Constraints

- Non-STABLE only — the quick switch trigger must not render in STABLE workspaces.
- XSS safety — all dynamic text must use `textContent`, never `innerHTML`, consistent with the codebase convention.
- No build step — the component is a vanilla JS ES module imported natively by the browser.
- Module imports — the new component uses relative paths with `.js` extensions.
- Accessibility — the trigger element must be keyboard-accessible (`<button>` or `role="button"` with `tabindex`), and the popover must support Escape to dismiss.

## Out of Scope

- Batch branch switch from the table (still use the existing wizard for that).
- Persisting branch data / caching the `api.branches.list()` response across rows.
- Adding a new backend endpoint for single-repo branch listing.
- Branch creation on the remote (new branches are created locally via `git checkout -b`).
- Modifying the status badge component itself.

## Acceptance Criteria

- In a non-STABLE workspace detail view, each branch cell that has a current branch name is visually clickable (cursor change, hover hint).
- Clicking a branch cell opens an inline popover anchored below that cell.
- The popover shows a text input (pre-filled with the current branch), a scrollable list of available branches for that repository, and Switch/Cancel buttons.
- Typing in the text input filters the branch list in real-time.
- Clicking a branch in the list populates the input field.
- Clicking "Switch" calls the API, shows a success toast (or a warning toast if conflicts are detected), closes the popover, and refreshes the status table.
- Clicking Cancel, pressing Escape, or clicking outside the popover dismisses it without action.
- The popover shows a loading indicator while fetching branch data.
- Error states (API failure) show a toast and do not crash the view.
- STABLE workspace branch cells remain plain text with no click behaviour.
- Branch cells without a current branch (`"—"`) are not clickable.
- The feature works with the existing polling — a successful switch triggers a refresh, and polling updates do not break the open popover.

## Testing Strategy

- **Manual testing:** Open a non-STABLE workspace detail view → click a branch badge → verify popover opens → select a different branch → click Switch → verify toast, popover closes, and status table refreshes. Repeat with Escape, Cancel, and click-outside dismissal. Verify STABLE workspace branch cells are not clickable.
- **Edge cases:** Open popover on a repo with only one branch (the current one). Type a new branch name that doesn't exist yet. API failure during switch (stop server, verify error toast). Trigger a poll while popover is open (verify popover survives).
- **Accessibility:** Tab to a branch cell → Enter to open → Tab through popover inputs → Escape to close. Verify `aria-label`, `role`, and focus management.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Popover positioning edge cases** (near bottom of viewport, scrolled container) | Use `getBoundingClientRect()` and flip the popover above the anchor if insufficient space below. Add `max-height` with scroll to prevent overflow. |
| **Race condition with polling** | The popover operates independently of the status table. A polling update occurring while the popover is open may update the underlying cell text, but the popover retains its own state. After a successful switch, `doRefresh()` is called, which re-fetches all status data. The `refreshInProgress` flag prevents concurrent refreshes. |
| **Stale branch list** | The `api.branches.list()` call is made fresh each time the popover opens. No caching means the data is always current at popover-open time. |
| **Large number of branches** | The branch list has a `max-height` with `overflow-y: auto`, preventing the popover from growing unbounded. The text input filters the list in real-time, making large lists navigable. |
