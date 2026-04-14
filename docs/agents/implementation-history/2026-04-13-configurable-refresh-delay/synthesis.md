# Project Synthesis Report

**Plan:** 2026-04-13-configurable-refresh-delay  
**Date:** 2026-04-13  
**Status:** COMPLETE  

---

## Executive Summary

This session delivered two independent features for **repo-parallelizer-STABLE**:

1. **Configurable Refresh Delay (Change Set A):** The `gitPollingIntervalSeconds` setting is now user-editable at runtime. A new `PollingManager.restart()` method, two REST endpoints (`GET`/`PUT /api/config/polling`), a frontend `api.config.polling` namespace, and a "Repositories Refresh Delay" section in the Settings view were added end-to-end. Changes persist to `config.json`, update the in-memory config, and hot-restart the polling loop without a server restart.

2. **Relocate VS Code Workspace Files (Change Set B):** `.code-workspace` files are now stored inside per-project subdirectories (`{projectsFolder}/{slug}/`) instead of flat in `projectsFolder`. A one-time `migrateWorkspaceFiles()` utility runs on server startup to relocate any existing flat-layout files. All three orchestrators pick up the new path with zero caller changes.

Both change sets were fully implemented, QA-verified, security-audited, code-reviewed, and documented. All documentation artefacts (README, manifest docs, `.context/` generated files) were regenerated.

---

## Metrics

| Metric | Value |
|---|---|
| **Work Packages** | 2 (1 COMPLETE, 1 CANCELLED → completed via rework) |
| **Total Tests (final)** | 697 (693 pre-existing + 4 new migration tests) |
| **Tests Failed** | 0 |
| **TypeScript Errors** | 0 |
| **Security Issues (Critical/High)** | 0 |
| **Security Issues (Medium)** | 1 (unbounded upper limit on polling interval — tracked) |
| **Security Issues (Low)** | 13 (all PASS findings — no action required) |
| **Files Modified (WP-001)** | 5 source + 8 doc/context files |
| **Files Modified (WP-002)** | 8 source + 7 doc/context files |
| **Pipeline Duration (WP-001)** | ~10 min total across all stages |
| **Pipeline Duration (WP-002)** | ~45 min total across all stages (incl. rework cycles) |

### Test Suite Growth

| Stage | Tests Passing |
|---|---|
| Pre-session baseline | 693 |
| After WP-001 implementation | 693 (+17 new: 3 PollingManager unit + 14 config-route) |
| After WP-002 Change Set B | 697 (+4 new: migration tests) |

---

## Rework Summary

**WP-002 experienced a turbulent pipeline** due to a scope split that went undetected until the first documentation audit:

- The initial implementation and QA passes covered **only Change Set A** (frontend polling UI), leaving Change Set B (workspace file relocation) entirely unimplemented.
- The documentation pipeline correctly caught this gap (FAIL) and flagged the 7 unmet ACs.
- A second implementation pass delivered Change Set B, after which 4 additional rework QA cycles were triggered by the ledger's REWORK mechanism before the work package reached COMPLETE.
- **Net outcome:** All 14 ACs are met; 697/697 tests pass.

**Root cause:** The WP-002 spec contained two fully independent change sets. The implementation agent scoped to Change Set A without explicitly deferring Change Set B. Future WPs covering multiple independent change sets should be split into separate work packages to prevent this class of pipeline rework.

---

## Deliverables

### WP-001 — Backend + Settings UI (Configurable Refresh Delay)

| File | Change |
|---|---|
| `src/server/pollingManager.ts` | Added `restart(intervalSeconds)` method |
| `src/server/routes/config.ts` | Added `GET`/`PUT /api/config/polling` endpoints; extracted `MIN_POLLING_INTERVAL_SECONDS = 10` constant (Reviewer fix-forward) |
| `src/server/index.ts` | Wired `pollingManager` as 4th arg to `registerConfigRoutes` |
| `src/server/__tests__/pollingManager.test.ts` | 3 new `restart()` unit tests |
| `src/server/__tests__/routes/config.test.ts` | 14 new polling-route tests |
| `README.md` | Updated setup wizard constraint; added runtime-configurable note; new `api.config` section |
| `docs/agents/project-manifest/api-surface.md` | Updated `registerConfigRoutes` signature; new polling endpoints table |
| `docs/agents/project-manifest/gui-frontend.md` | Added `api.config.polling` namespace entry |
| `.context/` (5 files) | Regenerated |

### WP-002 — Frontend API Client + Settings Section + Workspace File Relocation

| File | Change |
|---|---|
| `gui/public/js/api.js` | Added `api.config.polling.get()` and `api.config.polling.set(seconds)` |
| `gui/public/js/views/settings.js` | Added `buildRefreshDelaySection()` with on-mount population, validation, toasts |
| `src/orchestration/vscode-workspace.ts` | Nested path formula in `getWorkspaceFilePath()`; new `migrateWorkspaceFiles()` utility |
| `src/server/index.ts` | Server-startup migration call |
| `src/tests/vscode-workspace.test.ts` | Updated path assertions; 4 new migration tests |
| `src/tests/workspace-orchestrator.test.ts` | Updated path assertions |
| `src/tests/project-orchestrator.test.ts` | Updated path assertions |
| `src/tests/repository-orchestrator.test.ts` | Updated path assertions |
| `docs/agents/project-manifest/rest-api.md` | New polling endpoints reference section |
| `docs/agents/project-manifest/gui-frontend.md` | Settings route updated; `api.config.polling` reference table |
| `.context/` (5 files) | Regenerated |

---

## Security Highlights

The security audit (WP-001) covered all OWASP Top 10 categories and issued a **PASS** with:

- **0 Critical / 0 High findings**
- **1 Medium finding:** No upper bound on `gitPollingIntervalSeconds` — `Number.MAX_SAFE_INTEGER` passes all guards and would effectively disable polling for the process lifetime. Recommendation: enforce a maximum of 86,400 seconds (24 hours). *(tracked below)*
- All endpoints are loopback-only (`127.0.0.1`) — no external attack surface
- `config.json` is `chmod 0o600` after every write
- No new dependencies introduced

---

## Strategic Recommendations ("Gold Nuggets")

### 1. Add an Upper Bound to Polling Interval Validation (Medium Priority)
**Where:** `src/server/routes/config.ts` — `PUT /api/config/polling` handler  
**What:** Add a maximum value guard (e.g. `value > 86400`) alongside the existing `>= 10` minimum.  
**Why:** `Number.MAX_SAFE_INTEGER` currently passes all guards, effectively disabling polling. A 24-hour cap with a clear error message closes this gap cleanly.

### 2. Migrate `registerConfigRoutes` to Named-Options Signature (Low Priority)
**Where:** `src/server/routes/config.ts` + `src/server/index.ts`  
**What:** Replace the positional `(router, appConfig, configPath?, pollingManager?)` signature with a named-options object `{ router, appConfig, configPath, pollingManager }`.  
**Why:** The current `registerConfigRoutes(router, config.appConfig, undefined, pollingManager)` positional `undefined` gap is a DX hazard flagged independently by the Developer, QA, and Reviewer agents. A named-options migration eliminates the gap and makes future parameter additions safe. Scope: cross-cutting, affects all callers.

### 3. Extract `MIN_POLLING_INTERVAL_SECONDS` to a Shared Config Constants Module (Low Priority)
**Where:** `src/server/routes/config.ts` (currently module-level), `src/config/config.ts`  
**What:** Move the constant to a shared config-level constants file so it can be imported in tests and referenced from the client-side validation in `settings.js`.  
**Why:** The client-side guard (`value < 10`) and the server-side guard (`value < MIN_POLLING_INTERVAL_SECONDS`) are currently independent. A single source of truth eliminates future drift.

### 4. Split Multi-Change-Set WPs into Separate Work Packages (Process)
**Why:** WP-002 contained two fully independent change sets (frontend polling UI + workspace file relocation). The implementation agent scoped to one, the documentation audit caught the gap, and 4 additional rework cycles followed. Future plans should decompose multi-change-set work into one WP per change set to prevent unnecessary pipeline rework and improve parallelism.

### 5. Add CSS Layout Rule for Refresh Delay Input Row (Low Priority)
**Where:** `gui/public/styles.css` — add `.refresh-delay-input-row { display: flex; align-items: center; gap: 0.5rem; }`  
**Why:** The `refresh-delay-input-row` container relies on browser defaults for alignment between the number input, "seconds" label, and Save button. This is functional but visually inconsistent with the credentials form, which uses explicit flex layout. A 3-line CSS addition resolves it.

### 6. Add `api.config.polling` Unit Test File (Low Priority)
**Where:** `gui/public/js/__tests__/` (new file `api.config.test.mjs`)  
**What:** Mirror the pattern of `api.errorLog.test.mjs` to cover `api.config.polling.get()` and `api.config.polling.set()`.  
**Why:** The API methods were verified via inline QA scripts, not persistent test files. A dedicated test file locks in the behaviour and prevents future regressions.

---

## Next Steps for Planner / Manager

1. **Immediate:** Track the Medium security finding (unbounded upper poll interval) — a single-line guard addition in `PUT /api/config/polling`.
2. **Short-term:** Deliver the workspace-detail view dynamic interval fetch (originally planned as part of Change Set A but absent from WP-001 scope) — `workspace-detail.js` still uses the hardcoded `POLL_INTERVAL_MS = 10_000` constant and does not consult `GET /api/config/polling`.
3. **Short-term:** Add the `.refresh-delay-input-row` CSS rule for layout polish.
4. **Medium-term:** Migrate `registerConfigRoutes` to named-options signature (low risk, high DX payoff).
5. **Process:** For any future plan containing multiple independent change sets, create one WP per change set.
