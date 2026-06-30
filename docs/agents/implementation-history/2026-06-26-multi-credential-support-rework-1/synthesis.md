# Synthesis Report — `2026-06-26-multi-credential-support-rework-1`

**Date:** 2026-06-29  
**Status:** COMPLETE  
**Total Work Packages:** 10 / 10  
**Pipeline Health:** 10/10 WPs with all stages PASS (0 stages missing)

---

## Executive Summary

This rework cycle closed all actionable deferred items from the original `2026-06-26-multi-credential-support` project. Ten work packages delivered a full sweep of security hardening, UX polish, dead-code removal, audit logging, and test-coverage gaps across the backend credential API, GUI, and test infrastructure. The credential subsystem is now defensively validated end-to-end (host format, field length limits, host-coherence guard), fully audited (five mutation event types), and presentationally consistent (CSS badge with accessibility attributes, health-report-backed badge persistence). The final backend test count rose from 902 (project start) to **919 tests passing, 0 failures**; GUI tests reached **237 passing, 0 failures**.

---

## Work Package Summary

| WP | Title | Stages | Result |
|---|---|---|---|
| WP-001 | Credential Mutation Audit Logging | impl → qa → security-audit → code-review → docs | ✅ PASS |
| WP-002 | Health-Report-Based Credential Badge Persistence | impl → qa → code-review → docs | ✅ PASS |
| WP-003 | Fix `notes-collected.test.mjs` Infinite Hang | impl → qa → code-review → docs | ✅ PASS |
| WP-004 | Hostname Format Validation on Credential `host` Field | impl → qa → security-audit → code-review → docs | ✅ PASS |
| WP-005 | Per-Field Length Validation on Credential Fields | impl → qa → security-audit → code-review → docs | ✅ PASS |
| WP-006 | Fix Hostname Leak in Config Error Messages | impl → qa → security-audit → code-review → docs | ✅ PASS |
| WP-007 | Remove `injectCredentials()` Legacy Function | impl → qa → code-review → docs | ✅ PASS |
| WP-008 | Host/Credential Coherence Guard at REST API Layer | impl → qa → security-audit → code-review → docs | ✅ PASS |
| WP-009 | GUI Credential Badge Refactor & CREDENTIAL_MISSING_SENTINEL Relocation | impl → qa → code-review → docs | ✅ PASS |
| WP-010 | Missing Test Coverage (T2 Mixed-Toast + SSH Bypass) | impl → qa → code-review → docs | ✅ PASS |

---

## Metrics

### Test Results

| Metric | Value |
|---|---|
| Backend tests (final — WP-010) | **919 passed / 0 failed** |
| GUI tests (final — WP-010) | **237 passed / 0 failed** |
| Security issues (Critical/High) | **0** |
| Security issues (Medium — audit) | 4 medium observations recorded; all resolved via code or documentation |

### Test Count Progression

| After WP | Backend | GUI |
|---|---|---|
| WP-001 | 902 | — |
| WP-002 | 918 | 236 |
| WP-003 | — | — (19 isolated, all pass) |
| WP-004 | 918 | — |
| WP-005 | 918 | — |
| WP-006 | 918 | — |
| WP-007 | 918 | — |
| WP-008 | 918 | — |
| WP-009 | — | 236 |
| WP-010 | **919** | **237** |

### Files Modified (Key Areas)

- **Backend routes:** `src/server/routes/config.ts`, `src/server/routes/repositories.ts`
- **Backend core:** `src/config/config.ts`, `src/config/config.constants.ts`, `src/server/index.ts`
- **Orchestration:** `src/orchestration/workspace-health.ts`
- **Git utilities:** `src/git/git-credentials.ts`
- **GUI views:** `workspace-detail.js`, `repositories.js`, `project-detail.js`
- **GUI utilities:** `dom.js`, `constants.js`, `styles.css`
- **Tests:** `config.test.ts`, `repositories.test.ts`, `workspace-health.test.ts`, `repository-orchestrator.test.ts`, `notes-collected.test.mjs`, `workspace-detail.credential-error.test.mjs`, `repositories.test.mjs`
- **Docs:** `api-surface.md`, `rest-api.md`, `constraints.md`, `gui-frontend.md`, `data-flows.md`, `config/README.md`, `src/git/README.md`, `src/server/README.md`, `README.md`, `.context/**`

---

## What Was Built

### 1. Credential Mutation Audit Logging (WP-001)
`ErrorLogManager` is now wired into both `config.ts` and `repositories.ts` route handlers. Five credential mutation events are audit-logged with `Source: 'credential-audit'` and `Severity: 'warning'`:

| Operation | Source | Trigger |
|---|---|---|
| `create-credential` | PUT /api/config/credentials (new) | credential-audit |
| `update-credential` | PUT /api/config/credentials (update) | credential-audit |
| `delete-credential` | DELETE /api/config/credentials/:id | credential-audit |
| `assign-credential` | PUT /api/repositories/:id/credential (set) | credential-audit |
| `clear-credential` | PUT /api/repositories/:id/credential (null) | credential-audit |

Token values are **never** included in audit log entries — only `id`, `label`, and `host`. Verified by a dedicated token-absence test in `config.test.ts`.

### 2. Health-Report-Based Credential Badge Persistence (WP-002)
`checkWorkspaceHealth()` now accepts an optional `errorLogManager` parameter and surfaces `credential-missing` health issues (with `repositoryId`) for repositories that have recent `Source: 'credentials'` log entries. The GUI `workspace-detail.js` seeds `credentialErrorRepoIds` from the initial health report on page load, making the amber credential badge **persist across page reloads** rather than living only in in-memory state.

### 3. Fix `notes-collected.test.mjs` Infinite Hang (WP-003)
Three root causes fixed: (1) `api.config.notesDisplay.get` stub added to prevent `Promise.all` hang, (2) `afterEach(() => { restoreTimers(); })` ensures unconditional timer restoration even on test failure, (3) `Map<number, Function>` replaces the single `_timerId` counter so `clearTimeout` correctly clears any timer ID — not just the most recent one. All 19 tests now pass in < 1 second, zero hang, zero flakiness across three consecutive isolated runs.

### 4. Hostname Format Validation (WP-004)
`PUT /api/config/credentials` now rejects any `host` value containing `/`, `\`, null bytes, or whitespace with HTTP 400. The validation fires on the raw (pre-trim) host value, ensuring whitespace-embedded hosts are caught even if not entirely whitespace. Documented in `constraints.md § Hostname Format`.

### 5. Per-Field Length Validation (WP-005)
Four named constants extracted to `config.constants.ts` (`MAX_CREDENTIAL_ID_LENGTH=100`, `MAX_CREDENTIAL_LABEL_LENGTH=200`, `MAX_CREDENTIAL_HOST_LENGTH=253`, `MAX_CREDENTIAL_TOKEN_LENGTH=500`) and applied to both the route handler and `parseGitCredentials()`. Both enforcement points now share the same source of truth, eliminating prior magic-number duplication. The RFC 1035 host limit (253) is documented.

### 6. Hostname Leak Fix in Config Error Messages (WP-006)
`parseGitCredentials()` legacy-format error messages no longer interpolate the raw hostname key. Messages now use a 1-based positional index (`entry #${index + 1} (legacy format)`), preventing infrastructure hostnames from leaking into thrown errors or server logs. Documented in `src/config/README.md`.

### 7. Remove `injectCredentials()` Legacy Function (WP-007)
The `@deprecated` `injectCredentials()` function and its 7 test cases were removed from `src/git/git-credentials.ts` and `src/tests/git-credentials.test.ts`. Surrounding documentation (`api-surface.md`, `data-flows.md`, `.context/` module files, `constraints.md`) was cleaned of residual references. The `repo.credentialId` → `repo.CredentialId` casing error in the module-level JSDoc was corrected by the Reviewer.

### 8. Host/Credential Coherence Guard (WP-008)
`PUT /api/repositories/:id/credential` now rejects credential assignments where `credential.host` does not match the repository URL's hostname, returning HTTP 400 with an actionable error message naming both the credential host and the repository host. The guard is skipped for SSH URLs (where `extractHost()` returns `null`) and for `null` credentialId (clear operations). The pre-existing "Known limitation" note was removed from `rest-api.md`.

### 9. GUI Credential Badge Refactor (WP-009)
Duplicated credential badge DOM construction (previously verbatim-copied between `repositories.js` and `project-detail.js`) was consolidated into a single `buildCredentialBadge()` function in `gui/public/js/utils/dom.js`. Emoji rendering (`🔑` / `—`) was replaced with a CSS-styled `<span>` using BEM modifier classes (`.credential-badge--set` / `.credential-badge--none`) and `aria-label` attributes for accessibility. `CREDENTIAL_MISSING_SENTINEL` was relocated from a module-scoped `const` in `workspace-detail.js` to `gui/public/js/utils/constants.js`. CSS rules use existing design-token variables.

### 10. Missing Test Coverage (WP-010)
Two additive test cases added, purely non-breaking:
- **T2 mixed-toast test** (`workspace-detail.credential-error.test.mjs`): verifies that when setup failures include both credential-missing and non-credential clone failures, the toast message correctly segments them into "Missing credentials for: ..." and "Failed to clone: ..." clauses.
- **SSH bypass integration test** (`repository-orchestrator.test.ts`): confirms that credential tokens are not injected into `git@` SSH URLs even when `gitCredentials` are configured for the matching hostname.

---

## Security Findings Summary

All medium-severity observations from prior audits and this cycle were resolved:

| Finding | WP | Resolution |
|---|---|---|
| Hostname leaked in config error messages | WP-006 | Replaced with positional index |
| No hostname format validation on `host` field | WP-004 | Regex guard added, HTTP 400 on violation |
| No host/credential coherence check at assignment | WP-008 | Guard added to PUT route |
| No audit logging for credential mutations | WP-001 | Five mutation events now logged |
| Token trimming side-effect undocumented | WP-005 | Documented in `constraints.md` |
| Plaintext tokens on Windows (no file permissions) | WP-001 | Accepted; documented as known architectural gap |
| `Source: 'credential-audit'` using `Severity: 'warning'` (not a dedicated `audit` level) | WP-001 | Accepted; documented as improvement opportunity |
| Error message echoes internal `credentialId`/`credential.host` | WP-008 | Accepted for local-tool scope; documented |

**0 Critical, 0 High** security issues across all security-audit pipelines.

---

## Strategic Recommendations ("Gold Nuggets")

### 1. Add a Dedicated `audit` Severity to `ErrorSeverity`
Currently `ErrorSeverity` only supports `'error' | 'warning'`. Credential-audit entries use `Severity: 'warning'`, which means they co-mingle with operational warnings in the Error Log GUI. A dedicated `'audit'` severity level would enable clean GUI filtering and let security event surfaces be separated from operational noise without relying on `Source`-string filtering. This is the single highest-leverage improvement for the audit logging feature.

### 2. `CREDENTIAL_MISSING_SENTINEL` Relocation Pattern → Apply to Other Sentinel Constants
The pattern of moving module-scoped sentinel values to the shared `constants.js` was successful for `CREDENTIAL_MISSING_SENTINEL`. Audit other view modules for similar locally-scoped constants that could benefit from shared location — particularly any sentinel values used across multiple views.

### 3. Shared `MockErrorLogManager` Test Helper
`MockErrorLogManager` (the `appendedEntries`/`append()` stub) is duplicated verbatim between `config.test.ts` and `repositories.test.ts`. A shared test helper in `src/server/__tests__/helpers/mock-error-log-manager.ts` would eliminate duplication and keep the stub in sync as `ErrorLogManager` evolves. Low-effort, high payoff for test maintainability.

### 4. Stale Credential Badge Edge Case (Health-Report Design Limitation)
`checkWorkspaceHealth()` surfaces `credential-missing` issues based on the most recent `Source: 'credentials'` log entry per repository. If a repo later clones successfully (credential fixed), no new success log entry is written, so the badge persists until the log entry is cleared or superseded. The `@remarks` JSDoc now documents this. A future improvement: write a `Source: 'credentials'`, `Severity: 'info'` entry on successful credential use to allow the health check to suppress stale badges.

### 5. Windows File-Permission Gap for Stored Tokens
`saveConfigField()` applies `chmod 600` on POSIX but provides no equivalent protection on Windows. For a localhost developer tool this is an accepted risk, but a future improvement could integrate the Windows Credential Manager (via `wincred` or similar) for token storage on Windows, aligning security posture across platforms.

### 6. `buildHealthAlertSection()` Does Not Render a Button for `configure-credential`
`workspace-detail.js`'s `buildHealthAlertSection()` renders `credential-missing` issues as message-only rows — there is no "Configure Credential" button. The amber badge in the workspace status table already links to repository settings, so the UX gap is acceptable. A follow-up WP could add a dedicated action button in the health alert section.

---

## Deferred & Follow-Up Items

| # | Source | Agent | Description | Type | Priority |
|---|---|---|---|---|---|
| 1 | WP-001 | Security Auditor | Plaintext token storage on Windows lacks file-permission tightening (`chmod 600` is POSIX-only). Consider Windows Credential Manager integration. | **Deferred** | Low |
| 2 | WP-001 | Security Auditor / Reviewer | Add a dedicated `'audit'` severity to `ErrorSeverity` (`error \| warning \| audit`) to allow GUI-level filtering of credential-audit events separate from operational warnings. | **Deferred** | Medium |
| 3 | WP-001 | Reviewer | `MockErrorLogManager` stub is duplicated across `config.test.ts` and `repositories.test.ts`. Extract to a shared test-helper module. | **Deferred** | Low |
| 4 | WP-001 | QA | Credential create/update/delete audit entries use `Context: {}` (empty) while assign/clear entries include `Context: {RepositoryId}`. Consider adding `ProjectId` context to config-level credential mutations for richer filtering. | **Deferred** | Low |
| 5 | WP-002 | QA / Reviewer | Stale credential-missing badges: if a repo later clones successfully, old `Source: 'credentials'` log entries are not cleared, so the badge persists until the log rotates. Future fix: write a success log entry on credential resolution to suppress the badge. | **Deferred** | Low |
| 6 | WP-002 | Developer | `buildHealthAlertSection()` in `workspace-detail.js` does not render a "Configure Credential" action button for `credential-missing` health issues. Only a message row is shown. | **Out-of-scope** | Low |
| 7 | WP-005 | Security Auditor | Token trimming side-effect: if a user pastes a token with trailing whitespace, the stored token is silently normalized. Now documented in `constraints.md`. No code change required — resolved by documentation. | **Resolved** | — |
| 8 | WP-005 | Reviewer | `parseGitCredentials()` trims field values to measure length but returns un-trimmed strings from `config.json`. Consumers must trim before use. Now documented in `constraints.md`. | **Deferred** | Low |
| 9 | WP-007 | Developer / QA | Several historical `.context/` files and standing-rule docs still contained `injectCredentials()` references as archival prose. Cleaned in the documentation pipeline; no remaining references outside removal notices. | **Resolved** | — |
| 10 | WP-008 | Security Auditor | Error message on host-coherence mismatch echoes user-supplied `credentialId` and internal `credential.host`. Acceptable for the local-tool scope; would need sanitization if the tool ever expands to a multi-tenant context. | **Accepted** | Low |
| 11 | WP-009 | Developer | CSS variable naming: `.credential-badge` reuses `--badge-clean-bg` / `--color-border-light`, while `.status-badge-credential` uses `--badge-credential` / `--badge-credential-bg`. The two credential-badge systems use different variable prefixes. CSS comment clarification was applied by Reviewer. | **Deferred** | Low |
| 12 | WP-009 | Developer | `buildHealthAlertSection()` in `workspace-detail.js` does not handle `fixAction: 'configure-credential'` with a button. | **Out-of-scope** | Low |
| 13 | Cross-cutting | Developer (WP-001) | DELETE `/api/config/credentials/:id` handler is synchronous (not `async`), unlike the PUT handler. This is by design (no request body to parse) and is commented, but may trip up future maintainers. | **Accepted** | Low |

---

## Incident Log

| Timestamp | Agent | Issue | Resolved |
|---|---|---|---|
| 2026-06-29T09:43:22Z | Developer | After completing WP-008's implementation pipeline, `ledger_get_next_action` returned `WAIT` but `ledger_get_handoff_status` showed WP-009 still READY. Attempts to claim WP-009 returned a stale active-WP lock error (`active work package is WP-008`). The orchestrator PM agent resolved this manually. | ✅ Yes (WP-009 completed normally) |
| 2026-06-29T09:50:18Z | Orchestrator | WP-008 first documentation pipeline FAIL — tool called with `comments` as a `string` instead of an `array`. Auto-cancelled; second pipeline started immediately and PASS. | ✅ Yes (auto-cancelled, no rework count impact) |

---

## Next Steps for the Planner

1. **`audit` severity in `ErrorSeverity`** — The highest-leverage single change remaining. Enables clean GUI-level filtering of credential audit events from operational warnings. Requires updating the type, all audit `append()` callsites, and the Error Log GUI filter UI.

2. **Shared `MockErrorLogManager` test helper** — Low-effort, high-ROI cleanup. Eliminates test duplication across `config.test.ts` and `repositories.test.ts`.

3. **Stale credential badge resolution** — Write a `Source: 'credentials'`, `Severity: 'info'` success log entry when credential injection succeeds, allowing `checkWorkspaceHealth()` to suppress badges for repos that have since recovered. Requires changes to `WorkspaceOrchestrator` or `RepositoryOrchestrator` and corresponding health-check logic.

4. **`buildHealthAlertSection()` configure-credential button** — Add a "Configure" action button to the health alert section for `credential-missing` issues in `workspace-detail.js`.

5. **Windows Credential Manager** — Longer-term: integrate native credential storage on Windows to close the file-permission gap for stored PATs.

6. **`parseGitCredentials()` normalization alignment** — The config parser returns un-trimmed strings while the API route normalizes (trims) on write. Consider aligning: either normalize on parse, or document explicitly that config.json is a raw source and all consumers must trim. Decision should drive a small follow-up WP.

---

*Report generated by Head of Operations (Synthesis) — 2026-06-29*
