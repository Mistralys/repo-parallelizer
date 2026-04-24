# Research Report

## Problem Statement

Audit the proposed plan for adding filtering and sorting to the dashboard project list. Evaluate whether persisting `LastActivity` on `ProjectWorkspace` via the `PollingManager` is the best approach for tracking activity, or whether an alternative design would be superior.

## Problem Decomposition

1. **Activity data sourcing** — Where does `lastActivity` originate, and what is the most appropriate place to persist or expose it?
2. **Write-site selection** — Which component should be responsible for updating the activity timestamp?
3. **`runSweep()` grouping challenge** — The sweep iterates repos as a flat list; the plan needs per-workspace grouping to write `LastActivity`.
4. **Domain model purity** — Does adding an operational metric (`LastActivity`) to `ProjectWorkspace` violate separation of concerns?
5. **Disk I/O cost** — Is per-sweep disk writing acceptable, and what are the alternatives?

## Context & Constraints

- **Stateless managers**: Every `ProjectManager` method re-reads from disk. Writing `LastActivity` means a full project JSON read-modify-write cycle.
- **Small dataset**: Typical installation has tens of projects, not thousands. Client-side filtering/sorting is appropriate.
- **Polling interval**: Default 30 seconds. With 10 projects × 3 workspaces × 5 repos, that's up to 150 repo fetches per sweep plus up to 30 project file read-modify-writes.
- **`DateModified` semantics**: Reserved for user-initiated metadata changes. `LastActivity` must not touch it.
- **No existing activity endpoint**: The status endpoint (`GET .../status`) returns per-repo `GitStatusInfo` with `lastActivity`, but only for a specific workspace — not aggregated across all workspaces of all projects.
- **Dashboard data flow**: Already calls `api.projects.get(id)` per project, so any field on `ProjectData` is "free" from the frontend perspective.

## Prior Art & Known Patterns

### Pattern 1: Persist on Domain Model (The Plan's Approach)

- **Description:** Add `LastActivity?: string` to `ProjectWorkspace`. `PollingManager` writes it after each refresh/sweep. Dashboard reads it from the existing `ProjectData` response.
- **Where used:** Common in monolithic apps where the data model doubles as the view model. The existing `DateCreated`/`DateModified` fields on `ProjectWorkspace` follow this pattern.
- **Strengths:**
  - Zero new API endpoints — `LastActivity` rides on the existing `GET /api/projects/:id` response.
  - Data survives server restarts.
  - Single source of truth — no cache/persistence divergence.
  - Frontend needs no extra fetch calls.
- **Weaknesses:**
  - Mixes operational telemetry (git commit timestamps) with domain metadata (workspace description, creation date).
  - Requires a dedicated `updateWorkspaceLastActivity()` method to avoid modifying `DateModified` — a workaround for a design tension.
  - Disk I/O on every poll sweep (mitigated by only-write-if-changed, but still a read on every sweep to check).
  - `runSweep()` refactor needed to track per-workspace grouping.
- **Fit:** Good pragmatic fit. The domain impurity is a real concern but the operational benefits are strong.

### Pattern 2: Expose from In-Memory Cache via New Endpoint

- **Description:** Add a lightweight `GET /api/activity` endpoint that reads `PollingManager.cache`, groups entries by project/workspace using `extractContext()`, and returns max `lastActivity` per project. No persistence.
- **Where used:** Common in monitoring dashboards, metrics systems, real-time status pages.
- **Strengths:**
  - Zero disk I/O — purely reads the existing in-memory cache.
  - No schema change to `ProjectWorkspace` — clean domain model.
  - No `runSweep()` refactor needed — grouping is computed on read, not write.
  - Trivially simple implementation: iterate cache, group by project, take max timestamp.
- **Weaknesses:**
  - Activity data is lost on server restart (cache is empty until first sweep completes).
  - Dashboard needs an additional fetch call on load.
  - New endpoint to maintain and document.
  - Sorting is unavailable for ~30 seconds after startup (until first sweep populates the cache).
- **Fit:** Strong fit if restart-data-loss is acceptable (the dashboard defaults to alphabetical sorting — this is merely a UX degradation, not a failure).

### Pattern 3: Separate Activity Cache File

- **Description:** Maintain a dedicated `{storageFolder}/activity-cache.json` file with structure `{ projects: { [projectId]: { [workspaceId]: timestamp } } }`. Written by `PollingManager` as a single batch at the end of each sweep.
- **Where used:** Common for telemetry/metrics caches — e.g., build timestamp caches, CI artifact metadata.
- **Strengths:**
  - Clean separation: domain data in project files, operational data in a dedicated file.
  - Single file write per sweep (batch) instead of N per-project writes.
  - Data survives restarts.
  - Can be regenerated/deleted without affecting project data.
- **Weaknesses:**
  - Dashboard needs either a new API endpoint to serve this file, or the server must merge it into `ProjectData` responses.
  - Additional file to manage, back up, and potentially migrate.
  - Adds an `ActivityCacheManager` or similar — more code than Pattern 1 or Pattern 2.
  - `runSweep()` still needs grouping logic for the batch write (though it's simpler since it's all-at-once).
- **Fit:** Over-engineered for this use case. The separation of concerns benefit doesn't justify the added complexity for a single optional timestamp field.

## Alternative & Creative Approaches

### Hybrid: In-Memory Cache + Lazy Persist

- **Approach:** Use Pattern 2 (in-memory endpoint) as the primary data source, but *also* persist the activity map to a single cache file periodically (e.g., every 5th sweep or on server shutdown). On startup, seed the in-memory cache from the file.
- **Rationale:** Gets the best of both worlds — no per-sweep disk I/O, survives restarts, clean domain model.
- **Risk:** Shutdown persistence is unreliable (process may be killed without cleanup). Adds complexity for a marginal benefit (30-second startup gap vs. stale-but-present data).

### Compute on Demand from Status Endpoint

- **Approach:** The dashboard itself computes `LastActivity` by calling `GET /api/projects/:id/workspaces/:wid/status` for every workspace on every project, extracting `lastActivity` from the per-repo status entries, and computing the max.
- **Rationale:** No backend changes at all. Pure frontend solution.
- **Risk:** For 10 projects × 3 workspaces, that's 30 additional API calls on dashboard load. Unacceptable — this is the N+1 query problem applied to a frontend.

## Comparative Evaluation

| Criterion              | Pattern 1: Persist on Domain | Pattern 2: In-Memory Endpoint | Pattern 3: Separate File | Hybrid |
|------------------------|------------------------------|-------------------------------|--------------------------|--------|
| **Complexity**         | Medium (new method + sweep refactor) | Low (new endpoint, ~30 lines) | High (new manager + endpoint) | Medium-High |
| **Disk I/O**           | Per-sweep read-check-write per workspace | None | Single batch write per sweep | Occasional batch write |
| **Data on restart**    | Immediately available | Unavailable for ~30s | Immediately available | Available (may be stale) |
| **Domain model purity**| Impure — mixes telemetry into domain type | Pure | Pure | Pure |
| **Frontend changes**   | Minimal — field already in response | One extra fetch call | One extra fetch call or server-side merge | One extra fetch call |
| **`runSweep()` change**| Required — must group by workspace | Not required | Required — must group for batch write | Not required |
| **New API surface**    | None | 1 endpoint | 1 endpoint | 1 endpoint |
| **Time to implement**  | Medium | Low | High | Medium |

## Recommendation

**Pattern 2 (In-Memory Endpoint) is the strongest option**, but Pattern 1 (the plan's approach) is a defensible choice with one significant simplification.

### Why Pattern 2 is superior for this use case

1. **`runSweep()` stays untouched.** The plan itself identifies the sweep refactor as the primary risk. Pattern 2 eliminates it entirely — the grouping is computed on read, not write.
2. **No domain model pollution.** `ProjectWorkspace` stays focused on workspace metadata. No need for a `updateWorkspaceLastActivity()` method that exists solely to avoid a side effect of `updateWorkspace()`.
3. **Dramatically less code.** A ~30-line endpoint handler that iterates `pollingManager.cache`, calls `extractContext()` on each key, groups by project, and returns max timestamps. Zero backend model changes.
4. **The restart-gap is negligible.** After a server restart, the dashboard shows projects sorted alphabetically for ~30 seconds until the first sweep completes. This is the existing behaviour today — users see alphabetical order. Adding a "Last Activity" sort option that gracefully degrades to alphabetical during the initial sweep is perfectly acceptable.

### If you prefer the plan's approach (Pattern 1), simplify the sweep logic

If persistence across restarts is a hard requirement, the plan's approach is sound with one key simplification:

**Don't refactor `runSweep()`.** Instead, after `fetchWithStagger()` completes in `runSweep()`, iterate the cache entries, use `extractContext()` to group them by project/workspace, compute the max `lastActivity` per workspace, and call `updateWorkspaceLastActivity()` for each. This avoids restructuring the fetch loop entirely — the grouping is a post-processing step, not an inline concern.

Additionally, `updateWorkspaceLastActivity()` should short-circuit before reading the project file if the `lastActivity` value is `null` — no point reading a JSON file just to confirm there's nothing to write.

### Proof-of-Concept Outline (Pattern 2)

1. Add a public method to `PollingManager`: `getActivityMap(): Map<string, string>` — iterates cache, groups by project ID (using `extractContext()`), returns a map of `projectId → maxLastActivityTimestamp`.
2. Register `GET /api/activity` in the router, handler calls `pollingManager.getActivityMap()`, returns JSON `{ [projectId]: timestamp }`.
3. In `dashboard.js`, fetch `/api/activity` in parallel with the project list. Pass the activity map to `applyFiltersAndSort()`. Sort by `activityMap[project.Id]` when "Last Activity" is selected.
4. No changes to `ProjectWorkspace`, `ProjectManager`, `PollingManager.runSweep()`, or any backend model files.

## Open Questions

- **Per-workspace vs. per-project granularity**: The plan persists `LastActivity` per workspace for future use in workspace views. Pattern 2 can do the same (return `{ [projectId]: { [workspaceId]: timestamp } }`) — the question is whether that granularity is needed now or is speculative.
- **Should the dashboard card display the last activity timestamp?** The plan explicitly puts this out of scope ("activity is used for sorting only, not displayed on the card"), but showing it would be a natural UX enhancement. If it is displayed, the restart-gap in Pattern 2 would show as a missing value rather than a stale value.
- **Should `LastActivity` track commit timestamps or poll timestamps?** The plan uses `GitStatusInfo.lastActivity` (the latest commit timestamp). An alternative is "when was this workspace last successfully polled?" — a different metric with different semantics.

## References

- Current `PollingManager` implementation: `src/server/pollingManager.ts`
- `extractContext()` helper already exists at the bottom of `pollingManager.ts` — groups repo paths by project/workspace/repo ID
- `ProjectWorkspace` type: `src/models/project/project.types.ts`
- Dashboard view: `gui/public/js/views/dashboard.js`
- Error-log filter bar (CSS pattern to reuse): `gui/public/css/styles.css` line 650
- Status response shape: `GET /api/projects/:id/workspaces/:wid/status` in `rest-api.md`
