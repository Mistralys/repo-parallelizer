# Project Synthesis Report
**Plan:** `2026-06-26-multi-credential-support`
**Status:** COMPLETE — all 10 work packages delivered
**Date:** 2026-06-26
**Last updated:** 2026-06-26T14:23:03Z

---

## Executive Summary

This project extended the repo-parallelizer credential system from a single-token-per-host model (`Record<string, string>`) to a named multi-credential model (`GitCredentialEntry[]`). The change touches the full vertical stack — core types, config parsing (with backward-compatible migration), REST API, orchestrators, and the GUI — and is delivered with complete test coverage and zero regressions across the 896-test suite.

Each repository can now store a `CredentialId` reference to a specific credential entry. During clone operations, the orchestrators perform smart credential resolution: explicit ID lookup when set, single-host auto-selection when only one credential exists for the host, and a clear user-actionable error message when the situation is ambiguous or no credential is configured. The workspace detail view surfaces credential-missing errors with a distinct amber "Missing Credential" badge that links directly to the repository's settings page.

---

## Metrics

| Metric | Value |
|---|---|
| Work packages completed | 10 / 10 |
| Total pipeline stages passed | 46 / 46 (0 FAILed, 1 auto-cancelled due to API overload — re-run PASS) |
| Final test suite size | 896 server/unit tests + 199 GUI tests |
| Server/unit test result | **896 / 896 PASS** |
| GUI test result | **199 / 199 PASS** |
| TypeScript compile errors at completion | **0** |
| Security audits performed | 5 (WP-002, WP-004, WP-005, WP-006, WP-007) |
| Critical/High security findings | **0** |
| Medium security findings | 4 (all documented; no blockers) |
| Rework cycles | 0 (no WP required implementation rework) |
| CTX context regenerations | 8 (one per documentation pipeline) |

---

## Work Package Delivery Summary

| WP | Title | Pipeline Stages | Notes |
|---|---|---|---|
| WP-001 | Core Type Definitions | impl → qa → review → docs | Foundation: `GitCredentialEntry`, `AppConfig.gitCredentials[]`, `Repository.CredentialId?` |
| WP-002 | `resolveCredential()` + `injectCredentialToken()` | impl → qa → sec → review → docs | New credential resolution API in `git-credentials.ts`; legacy `injectCredentials()` retained during migration |
| WP-003 | `RepositoryManager.updateCredential()` | impl → qa → review → docs | Persist/clear `CredentialId` on repositories; clean JSON key removal on `null` |
| WP-004 | `parseGitCredentials()` migration | impl → qa → sec → review → docs | Auto-migrates old `Record<string,string>` → `GitCredentialEntry[]`; full validation + kebab-case ID generation with collision disambiguation |
| WP-005 | REST credential CRUD endpoints | impl → qa → sec → review → docs | Rewrote `GET/PUT/DELETE /api/config/credentials`; `generateUniqueId()` with suffix disambiguation; masked responses |
| WP-006 | Repository credential API routes | impl → qa → sec → review → docs | Added `PUT /api/repositories/:id/credential` and `GET /api/repositories/:id/credential-options` |
| WP-007 | Orchestrator credential integration | impl → qa → sec → review → docs | Both orchestrators migrated to `resolveCredential + injectCredentialToken`; credential-missing error with `ErrorLogManager` logging (`source: 'credentials'`) |
| WP-008 | GUI settings credential UI | impl → qa → review → docs | Rewrote settings credential table (Label/Host/Token/Actions columns); inline edit; repository-reference-aware delete confirmation |
| WP-009 | GUI repository credential selector | impl → qa → review → docs | `normaliseRepo()` maps `CredentialId`; credential dropdown in repository detail; status badge in list/project views |
| WP-010 | GUI credential-missing error display | impl → qa → review → docs | Amber "Missing Credential" badge in workspace detail; sentinel-based detection; links to repository settings |

---

## Strategic Recommendations (Gold Nuggets)

### 1. `resolveCredential()` caller-side host coherence is an open design obligation
> **Source:** WP-002 security audit (OWASP A01), WP-006 security audit, WP-007 security audit

When `credentialId` is explicitly supplied to `resolveCredential()`, the function performs only an exact ID match — it does **not** cross-validate that `credential.host` matches the URL's hostname. The current call sites (`workspace-orchestrator.ts`, `repository-orchestrator.ts`) are safe because users only set `CredentialId` via the credential-options dropdown (which pre-filters by host), but this is an implicit caller contract. A future defence-in-depth measure would add a host-coherence assertion inside the orchestrators after resolving, or gating the `PUT /api/repositories/:id/credential` route on host match.

### 2. `injectCredentials()` (legacy) is now dead code — schedule removal
> **Source:** WP-002 developer comment, WP-007 reviewer Fix-Forward

`injectCredentials(url, credentials: Record<string, string>)` was retained during migration to avoid breaking change-sets mid-cycle. Now that all orchestrator call sites use the new pipeline (`resolveCredential → injectCredentialToken`), the legacy function has no active callers. It has been formally `@deprecated` with migration guidance in its JSDoc. Removal in the next cycle will clean the public API surface of `git-credentials.ts`.

### 3. `_defaultsCoverageGuard` in `config.ts` is a valuable compile-time contract pattern
> **Source:** WP-004 reviewer observation, documented in `constraints.md`

The `_defaultsCoverageGuard` constant in `src/config/config.ts` is a `Pick<AppConfig, keyof typeof DEFAULTS>` assertion that causes a TypeScript error whenever a new `AppConfig` field is added without a corresponding entry in `DEFAULTS`. This pattern prevents silent runtime omissions and should be treated as a first-class convention. The pattern is now documented in both `src/config/README.md` and `docs/agents/project-manifest/constraints.md`.

### 4. Credential status badge is duplicated — extract `buildCredentialBadge()` helper
> **Source:** WP-009 developer comment, confirmed by reviewer

The 🔑 credential status badge DOM construction is verbatim-duplicated between `repositories.js` (`buildRepoRow`) and `project-detail.js` (`buildRepositoriesSection`). A shared `buildCredentialBadge(credentialId)` utility in `utils/dom.js` or a dedicated component would make future badge design changes (accessibility, emoji → CSS icon) a single-line update.

### 5. Credential badge state is not persisted across page reloads
> **Source:** WP-010 developer comment, confirmed by QA and code reviewer

The "Missing Credential" badge in `workspace-detail.js` is stored only in an in-memory `credentialErrorRepoIds` Set populated during explicit setup runs. If a user reloads the page, repositories that previously had credential errors revert to the generic "No data" badge. Addressing this would require either persisting the credential-error state in the workspace health report or adding a new API response field. This is the most impactful UX gap remaining after this cycle.

### 6. Optional config fields do not require a schema version bump (confirmed precedent)
> **Source:** WP-001 code reviewer, documented in `constraints.md`

`CredentialId?: string` is an optional field addition to the persisted `Repository` type. The versioning policy in `storage.types.ts` explicitly exempts optional additions from requiring a `SCHEMA_VERSION` increment. This is now documented as a concrete example in `constraints.md` for future contributors.

---

## Security Posture (Project-Level Assessment)

| Finding | Severity | Status |
|---|---|---|
| `resolveCredential()` skips host-coherence validation for explicit IDs | Medium | Documented; caller contract established; defended by route-level host filtering |
| `host` field in `PUT /api/config/credentials` has no hostname format validation | Medium | Documented; low risk given local-only deployment; recommended for future guard |
| Credential mutations (`PUT`/`DELETE`) produce no audit log entries | Medium | Documented; `ErrorLogManager` logs credential-missing events correctly; API mutation logging is a future hardening item |
| Legacy error message leaks hostname key in `config.ts` (lines 236/241) | Medium | Documented by security auditor; test assertions tie to old format; requires coordinated fix + test update |
| `http://` and `git://` URLs accepted in URL allowlist with only a `console.warn` | Low | Consistent with prior design; acceptable for local developer tool |
| No per-field length limits on credential fields | Low | Documented; `parseBody` enforces global 1 MB limit |
| Plaintext token storage in `config.json` with `chmod 0o600` (POSIX only) | Low/Info | By design; Windows caveat documented in `src/config/README.md` |

All **Critical** and **High** severity categories across all 5 security audits: **0 findings**.

---

## Deferred & Follow-Up Items

| Item | Source | Agent | Type | Priority | Description |
|---|---|---|---|---|---|
| Remove `injectCredentials()` legacy function | WP-002, WP-007 | Developer, Reviewer | **Deferred** | High | No active callers remain; `@deprecated` JSDoc added. Clean removal unblocks API surface clarity. |
| Credential-missing badge persisted on page reload | WP-010 | Developer, QA, Reviewer | **Deferred** | High | Badge state is in-memory only; lost on reload. Requires persisting credential-error status in the workspace health report or a new API field. |
| Host/credential coherence check at `PUT /api/repositories/:id/credential` | WP-006, WP-007 | Security Auditor | **Deferred** | Medium | Add `credential.host === extractHost(repo.Url)` guard before allowing association; currently optional field filtering at `credential-options` endpoint provides sufficient defence. |
| Fix hostname leak in legacy error messages (config.ts L236/241) | WP-004 | Security Auditor, Reviewer | **Deferred** | Medium | Replace `"gitCredentials[\"${host}\"]"` with positional `"entry #${index}"` in error messages; requires coordinated test update for two test assertions. |
| Add hostname format validation on `host` field in `PUT /api/config/credentials` | WP-005 | Security Auditor | **Deferred** | Medium | Reject `host` values containing slashes, null bytes, or path separators as a defence-in-depth measure for downstream shell calls. |
| Add audit logging for credential mutations (PUT/DELETE on credential routes) | WP-005, WP-006 | Security Auditor | **Deferred** | Medium | Structured log entries for credential CRUD (`Credential created: id=X`, `Credential deleted: id=X`) without logging token values. |
| Extract `buildCredentialBadge()` shared helper | WP-009 | Developer, Reviewer | **Deferred** | Low | Badge DOM block is duplicated verbatim in `repositories.js` and `project-detail.js`. Extraction to `utils/dom.js` enables one-line future badge updates. |
| Add mixed (T2) toast assertion in `workspace-detail.credential-error.test.mjs` | WP-010 | QA, Reviewer | **Deferred** | Low | The T1 (credential only) and T3 (non-credential only) toast branches are explicitly tested; the T2 (mixed) branch lacks a dedicated message assertion. |
| Per-field maximum length validation on credential fields | WP-004, WP-005 | Security Auditor | **Out-of-scope** | Low | No max-length constraints on `token`, `id`, `label`, or `host` fields beyond the global 1 MB body limit. Low risk for local tool. |
| Add SSH-URL integration test for orchestrator credential bypass | WP-007 | QA | **Deferred** | Low | SSH bypass is implicitly verified by `extractHost()` unit tests but no dedicated orchestrator-level integration test exercises an SSH URL with `gitCredentials` configured. |
| Investigate `notes-collected.test.mjs` infinite hang | WP-008 | QA | **Out-of-scope** | Low | Pre-existing; not caused by this project. Likely a dangling async handle or timer stub. |
| Move `CREDENTIAL_MISSING_SENTINEL` to `gui/public/js/utils/constants.js` | WP-010 | Developer, Reviewer | **Deferred** | Low | Currently module-scoped in `workspace-detail.js` with a JSDoc sync warning. Co-locating with `STABLE_WS_ID` / `APP_NAME_SHORT` would make the backend contract more discoverable. |
| Improve credential badge accessibility (emoji → CSS icon) | WP-008, WP-009 | Developer, QA | **Deferred** | Low | The 🔑 emoji used as the "credential set" indicator may render inconsistently across platforms. A CSS-based icon or text badge with `aria-label` would be more robust. |

---

## Next Steps for Planner / Manager

1. **Remove `injectCredentials()` (high priority):** Create a follow-up WP to delete the legacy function and its now-dead test cases from `git-credentials.ts`. This is a clean, isolated change with no user-facing impact.

2. **Persist credential-error badge state (high priority):** Design the mechanism for surfacing prior-session credential errors on workspace-detail page reload. Options: (a) add `credentialErrors?: string[]` to the workspace health API response, (b) store it in the error log and retrieve on load.

3. **Host/credential coherence guard (medium priority):** Add a validation step to `PUT /api/repositories/:id/credential` that rejects associations where `credential.host !== extractHost(repo.Url)`. This closes the OWASP A01 gap identified by three independent security audits.

4. **Fix hostname leak in config error messages (medium priority):** A focused change to `config.ts` lines 236/241 and two test assertions in `config.test.ts` to replace raw hostname interpolation with a positional index reference.

5. **Credential mutation audit logging (medium priority):** Add structured log entries to the credential CRUD routes (`PUT`/`DELETE /api/config/credentials`). No schema changes; piggybacking the existing `ErrorLogManager` or a new `AuditLogManager` are both viable.

6. **Extract `buildCredentialBadge()` (low priority):** DRY refactor; can be bundled with a badge accessibility improvement (emoji → CSS icon with `aria-label`).
