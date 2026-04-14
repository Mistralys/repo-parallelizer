# Plan

## Summary

Improve the workspace detail view (`#/projects/:id/workspaces/:wid`) with four UX changes: trigger an immediate status refresh on load instead of showing stale cache data, add a visible countdown timer with a manual "Refresh Now" button, reactively hide the "X repositories have no data" message once polling fills in the missing data, and hide the setup button after a successful setup without depending on a router re-render.

## Architectural Context

The workspace detail view lives in `gui/public/js/views/workspace-detail.js`. It is a vanilla JS module following the SPA architecture described in `gui-frontend.md`:

- **Router lifecycle:** The router calls `renderWorkspaceDetail(container, params)` on navigation. The view returns a synchronous `cleanup` function that clears the polling interval. On same-hash navigation, `hashchange` does not fire so the router does **not** re-render (this is the root cause of bug #4).
- **Data fetching:** The view's initial `Promise.all` calls `api.status.get()` which returns **cached** data from the server's `PollingManager`. On first visit (before any poll sweep has run), this cache is empty, yielding "No data" badges.
- **Polling:** A `setInterval` at `POLL_INTERVAL_MS` (10 000 ms) calls `api.status.get()` and patches the table in-place via `updateStatusTable()`.
- **Force-refresh endpoint:** `POST /api/projects/:id/workspaces/:wid/status/refresh` (`api.status.refresh()`) runs a live git-fetch + status-poll and returns the fresh data. This already exists but is never called from the workspace view.
- **"Missing repos" row:** Built once during the initial render based on a snapshot of `statusMap`. Never re-evaluated during polling.
- **Setup button:** Rendered when `workspace.initialized === false`. After setup, the handler calls `_router.navigate()` to the same URL, which is a no-op because `location.hash` doesn't change.

Key files:

| File | Role |
|---|---|
| `gui/public/js/views/workspace-detail.js` | Workspace detail view (all four changes live here) |
| `gui/public/js/api.js` | API client — `api.status.get()` and `api.status.refresh()` |
| `gui/public/js/components/status-badge.js` | Status badge rendering |
| `gui/public/js/router.js` | Hash-based router — `navigate()` sets `location.hash` |
| `gui/public/css/styles.css` | Stylesheet — new CSS for timer/button |
| `src/server/pollingManager.ts` | Server-side cache + `refreshWorkspace()` |

## Approach / Architecture

All four changes are scoped to `gui/public/js/views/workspace-detail.js` (logic) and `gui/public/css/styles.css` (minor styling additions). No backend changes are needed — the required endpoints already exist.

### Change 1 — Immediate status refresh on load

Replace `api.status.get(projectId, wid)` with `api.status.refresh(projectId, wid)` in the initial `Promise.all`. This forces the server to run a live git-fetch before returning, giving the user fresh data immediately instead of an empty cache.

### Change 2 — Visible refresh timer with "Refresh Now" button

Add a small toolbar row between the header and the status table containing:
- A countdown label: "Next refresh in Xs" that ticks down every second from `POLL_INTERVAL_MS / 1000`.
- A "Refresh Now" button that calls `api.status.refresh()`, updates the table, and resets the countdown.

Replace the current `setInterval` approach with a more controlled pattern:
- A 1-second `setInterval` decrements the countdown display.
- When the countdown reaches 0, a poll is triggered (via `api.status.get()`) and the countdown resets.
- "Refresh Now" calls `api.status.refresh()` (force-refresh) and resets the countdown.
- The cleanup function clears both the countdown interval and any in-flight request reference.

### Change 3 — Reactively hide "X repositories have no data" message

After each polling update (both automatic and manual), re-evaluate missing repos:
- If all repos now have status data, hide (or remove) the retry row.
- If some repos are still missing, update the message text to reflect the current count.

This requires keeping a reference to the retry row DOM element and the `repos` array so the polling callback can re-check.

### Change 4 — Hide setup button after successful setup

Instead of relying on `_router.navigate()` (which is a no-op for same-hash), update the DOM in-place after a successful setup:
- Hide (remove) the setup button.
- Mark `workspace.initialized = true` in the local variable so subsequent logic uses the correct state.
- Trigger an immediate status refresh to populate the table, then start the polling interval if it wasn't already running.

## Rationale

- **`api.status.refresh()` on load**: The force-refresh endpoint already exists. Using it on initial load is the simplest fix and guarantees the user always sees current data. The extra latency (a few seconds for git fetch) is acceptable because the view already shows a loading spinner during the initial fetch.
- **1-second countdown interval**: Provides a responsive UI (countdown updates every second). The overhead of an idle 1s timer is negligible.
- **In-place DOM updates over router re-render**: Changes 3 and 4 both avoid a full re-render. This is more efficient and avoids the same-hash navigation problem entirely.
- **No backend changes**: All required API endpoints exist. The frontend simply wasn't using `api.status.refresh()`.

## Detailed Steps

### Step 1 — Use `api.status.refresh()` for initial load

In `renderWorkspaceDetail()`, change the `Promise.all` call:

```js
// Before:
api.status.get(projectId, wid),

// After:
api.status.refresh(projectId, wid),
```

This is a one-line change in `workspace-detail.js`.

### Step 2 — Build the refresh toolbar UI

Create a new helper function `buildRefreshToolbar(projectId, wid)` that returns a DOM element containing:
- A `<span>` for the countdown text (e.g. "Next refresh in 10s").
- A "Refresh Now" `<button>` (secondary/small style).

Insert this toolbar into the DOM between the header section and the status table section.

### Step 3 — Refactor polling to use countdown-based approach

Replace the existing `setInterval` (10s, calls `api.status.get`) with:
1. A `remainingSeconds` variable initialized to `POLL_INTERVAL_MS / 1000`.
2. A 1-second `setInterval` that:
   - Decrements `remainingSeconds` and updates the countdown label.
   - When `remainingSeconds` reaches 0, calls `api.status.get()`, updates the table, and resets the counter.
3. A `doRefresh()` helper that:
   - Calls `api.status.refresh()` (force-refresh).
   - Updates the table via `updateStatusTable()`.
   - Resets `remainingSeconds`.
   - Re-evaluates the missing-repos row (step 4).
4. Wire the "Refresh Now" button to call `doRefresh()`.

Update the cleanup function to clear the 1-second interval.

### Step 4 — Reactively update the missing-repos row

After each poll/refresh callback updates the table:
1. Re-evaluate which repos still have `null` status in the fresh data.
2. If `missingCount === 0`, hide/remove the retry row.
3. If `missingCount > 0` but decreased, update the text content.

This requires:
- Keeping a reference to the retry row element (assign to a variable accessible from the polling callback).
- Passing the repos list and retry row ref into the poll update logic.

### Step 5 — Hide setup button after successful setup (in-place)

Modify the setup button's click handler:
- On success, instead of calling `_router.navigate()`, remove the setup button from the DOM (or hide it).
- Update the local `workspace` object: `workspace.initialized = true`.
- Trigger an immediate status refresh and start the polling/countdown if not already running.

### Step 6 — Add CSS for the refresh toolbar

Add styles for the new refresh toolbar row in `gui/public/css/styles.css`:
- `.workspace-refresh-toolbar`: flex row with gap, aligned with existing workspace UI patterns.
- Countdown text: muted, small font.
- Button: reuses existing `.btn .btn-secondary .btn-sm` classes (no new button styles needed).

### Step 7 — Update gui-frontend.md

Update `docs/agents/project-manifest/gui-frontend.md` to document:
- The new refresh toolbar component behavior.
- The changed polling strategy (countdown-based).
- The `api.status.refresh()` call on initial load.
- The cleanup contract now clears the 1-second countdown interval.

## Dependencies

- `api.status.refresh()` — already exists in `gui/public/js/api.js`.
- `POST /api/.../status/refresh` — already exists server-side.
- No new npm packages or backend changes required.

## Required Components

| Component | Status | Action |
|---|---|---|
| `gui/public/js/views/workspace-detail.js` | Existing | Modify (all four changes) |
| `gui/public/css/styles.css` | Existing | Add refresh toolbar styles |
| `docs/agents/project-manifest/gui-frontend.md` | Existing | Update documentation |

## Assumptions

- The `api.status.refresh()` endpoint latency (git-fetch + status-poll) is acceptable for the initial page load. Users will see the loading spinner during this time.
- The server's `refreshWorkspace()` method handles the case where the workspace is not yet initialized (returns empty map or handles gracefully).
- The 1-second countdown interval will not cause performance issues (negligible overhead for a single DOM text update).

## Constraints

- No build step — all changes are in vanilla JS (ESM) and plain CSS.
- XSS safety — all dynamic text set via `textContent`, never `innerHTML`.
- Cleanup contract — the returned cleanup function must clear the 1-second interval.
- Router injection pattern — no direct import of `router.js` from the view.
- STABLE workspace protections remain unchanged (rename/delete disabled).

## Out of Scope

- Changing the polling interval duration (remains 10s).
- Server-side changes to the status refresh endpoint.
- Changes to other views or components.
- Persistent polling preferences or user-configurable refresh rates.
- WebSocket-based push updates (the polling approach is retained).

## Acceptance Criteria

- On first load of a workspace view, repository statuses appear immediately (not "No data"), even if the polling cache was empty.
- A visible countdown ("Next refresh in Xs") is displayed, counting down from 10 to 0.
- A "Refresh Now" button triggers an immediate status refresh and resets the countdown.
- When polling fills in status for previously-missing repos, the "X repositories have no data" message hides automatically.
- After a successful workspace setup, the setup button disappears without requiring manual page refresh or navigation.
- The cleanup function properly clears the countdown interval on navigation away.
- No regressions in existing functionality (rename, delete, branch switch, breadcrumb navigation).

## Testing Strategy

Manual testing of the four scenarios:
1. Navigate to an uninitialized workspace → verify status refresh is triggered, no false "no data" messages.
2. Observe the countdown timer counting down, clicking "Refresh Now" resets it and updates statuses.
3. Set up a workspace with a temporarily failing repo, then fix it → verify the "no data" message disappears on next poll.
4. Click "Setup Workspace" → verify button disappears after success without page reload.

Verify cleanup by navigating away mid-countdown and confirming no stale intervals continue running (check browser devtools).

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **`api.status.refresh()` takes longer than `api.status.get()`** on initial load, increasing perceived load time. | The loading spinner is already shown. The latency is bounded by git-fetch time per repo (typically 1–3s). This is a worthwhile trade-off for accurate data. |
| **Same-hash navigation no-op** may affect other views relying on self-navigation. | Change 4 avoids `navigate()` entirely, using in-place DOM updates instead. No router changes needed. |
| **Countdown interval leak** if cleanup is not called. | The cleanup function already handles interval clearing. The 1s interval replaces the existing 10s interval using the same pattern. |
| **Race condition** between manual refresh and automatic poll. | Use a `refreshInProgress` flag to skip the automatic poll tick if a manual refresh is already in flight. |
