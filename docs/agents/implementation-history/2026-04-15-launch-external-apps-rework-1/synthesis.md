# Synthesis Report — `2026-04-15-launch-external-apps-rework-1`

**Generated:** 2026-04-15  
**Status:** COMPLETE  
**Work Packages:** 4 / 4 complete  
**Pipeline health:** All 4 WPs passed all active pipeline stages (implementation → QA → code-review → documentation)

---

## Executive Summary

This session delivered three targeted follow-up improvements to the `2026-04-15-launch-external-apps` delivery:

1. **`resolveWorkspace()` server helper (WP-001):** A private helper function was extracted inside `registerWorkspaceRoutes()` in `src/server/routes/workspaces.ts`, eliminating 6 instances of a duplicated workspace-existence check pattern. The refactor is behaviour-preserving — byte-identical 404 responses, clean TypeScript compilation, and a full regression suite green.

2. **`api.workspaces.launch` sub-namespace (WP-002):** The two flat launch methods (`openVscode`, `openGithubDesktop`) were restructured into a nested `api.workspaces.launch` object (`launch.vscode`, `launch.githubDesktop`), following the existing `api.config.credentials` / `api.config.polling` sub-namespace precedent. All call sites, tests, and documentation were updated. No stale references to the old method names remain anywhere in the codebase.

3. **Toast test infrastructure (WP-004):** `#toast-container` was added to the jsdom HTML in both GUI test files (`workspace-detail.vscode-button.test.mjs`, `workspace-detail.open-button.test.mjs`), enabling direct DOM assertion of `showToast()` calls. Three new toast assertion tests were added, and a dead `toastCalls` array was removed. A misleading comment about an abandoned monkey-patch approach was rewritten to clearly state the chosen DOM-query strategy.

4. **Documentation sync (WP-003):** A dedicated review pass confirmed that `CONTRIBUTING.md` and `gui-frontend.md` — both already updated during WP-002's documentation pipeline — accurately reflect the new `api.workspaces.launch` sub-namespace. No further changes were required.

---

## Metrics

| Work Package | Tests Passed | Tests Failed | TypeScript | Stages Passed |
|---|---|---|---|---|
| WP-001 (resolveWorkspace helper) | 733 | 0 | ✅ Clean | 4/4 |
| WP-002 (launch sub-namespace) | 46 | 0 | N/A (JS) | 4/4 |
| WP-003 (docs review) | — | — | N/A | 1/1 |
| WP-004 (toast test infra) | 19 | 0 | N/A (JS) | 4/4 |
| **Total** | **798** | **0** | ✅ | **13/13** |

**Rework cycles:** 0 across all WPs — all pipelines passed on first attempt.

---

## Files Modified

| File | Changed By |
|---|---|
| `src/server/routes/workspaces.ts` | WP-001 (impl + docs) |
| `gui/public/js/api.js` | WP-002 (impl + docs) |
| `gui/public/js/views/workspace-detail.js` | WP-002 (impl) |
| `gui/public/js/api.workspaces.launch.test.mjs` | WP-002 (impl) |
| `gui/public/js/views/workspace-detail.vscode-button.test.mjs` | WP-002 + WP-004 |
| `gui/public/js/views/workspace-detail.open-button.test.mjs` | WP-002 + WP-004 |
| `CONTRIBUTING.md` | WP-002 (docs) |
| `docs/agents/project-manifest/gui-frontend.md` | WP-002 (docs) |
| `.context/**` (27 files) | WP-001, WP-002, WP-004 (ctx generate) |

---

## Strategic Recommendations

### Gold Nuggets

**1. Standardise project-first ordering across compound-check handlers**  
_(WP-001 · Developer + QA + Reviewer · low priority)_  
The `launch/github-desktop/:rid` handler in `workspaces.ts` calls `resolveWorkspace()` before `projectManager.getById()`. When both workspace and project are missing, the workspace-404 fires first — which is the inverse of the ordering used by the `health` and `regenerate-workspace-file` handlers. The behaviour is tested and intentional, but the inconsistency may surprise future contributors. Recommend a single-pass standardisation to enforce **project-check first, workspace-check second** across all compound-check handlers.

**2. Add `"type": "module"` to the GUI `package.json`**  
_(WP-002 · QA · low priority)_  
The GUI test runner emits a `MODULE_TYPELESS_PACKAGE_JSON` warning each time it reparses `api.js` as ESM. Adding `"type": "module"` to the relevant `package.json` eliminates this performance overhead and removes the warning noise from CI output. Straightforward one-line change.

**3. Enforce the `api.workspaces.launch` convention for all future external-app launchers**  
_(WP-002 · Developer · architectural decision)_  
The `workspaces` object now mixes plain data methods with a nested `launch` sub-object. This is the correct pattern, consistent with `api.config.credentials` and `api.config.polling`. Any future external-app launcher (e.g., a terminal, browser, or diff tool) **must** be added as a method on `api.workspaces.launch`, not as a flat method on `workspaces`. The convention is now documented in both `api.js` and `CONTRIBUTING.md`.

**4. Remove the now-redundant defensive guards in test spy setup**  
_(WP-002 · QA + Reviewer · low priority)_  
Both `workspace-detail.vscode-button.test.mjs` and `workspace-detail.open-button.test.mjs` include a `if (!api.workspaces.launch) api.workspaces.launch = {}` guard before patching spies. This was a reasonable safeguard during the transition, but is now redundant since `api.js` always exports the `launch` object. Remove in a future cleanup pass.

### Incident Note

A **routing guard false-positive** was observed during WP-003 processing: `ledger_claim_work_package` and `ledger_begin_work` rejected WP-003 with "active work package is WP-002" after WP-002 was auto-finalized to COMPLETE. The Documentation agent hit the violation counter limit (2/2) and stopped. The work was successfully completed in a subsequent session. This incident suggests a **stale active-WP pointer after auto-finalization** in the ledger routing guard — worth investigating at the infrastructure level.

---

## Next Steps

1. **Standardise compound-check ordering in `workspaces.ts`** — project-first across all handlers. Low-risk, single-file change.
2. **Add `"type": "module"` to GUI `package.json`** — eliminates ESM reparsing warning from CI output.
3. **Clean up defensive spy guards** in vscode-button and open-button test files.
4. **Investigate the ledger routing guard stale-pointer issue** — reproduce and fix the `active_wp` pointer retention after auto-finalization to prevent future workflow interruptions.
5. **Consider `resolveWorkspace()` as a pattern template** — if other route files (e.g., repos, branches) contain similar inline lookup+error patterns, apply the same extraction technique for consistency.
