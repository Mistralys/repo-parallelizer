# Synthesis Report — Repository Modal Form

**Project:** Repository Modal Form
**Status:** COMPLETE (8/8 work packages)
**Date:** 2026-09-08

## Executive Summary

Converted the Repositories screen's separate inline "Add Repository" form and per-row inline Name-edit toggle into a single reusable modal component (`repository-modal.js`) supporting both create and edit modes. The credential field — previously only settable from the Repository Detail page — is now available in both create and edit modes, and edit mode gained URL editing (previously only Name was editable). Repository ID remains read-only in edit mode; ID-renaming (with cascading updates across projects and cloned folders) is explicitly deferred to a future plan.

**Delivery chain:**
- **Backend** (WP-001, WP-002, WP-004): `RepositoryManager.update()` gained URL support with credential-stripping/duplicate-check mirroring `add()`; a new `GET /api/repositories/credential-options?url=` endpoint matches credentials by hostname without requiring an existing repository record; `PUT /:id` was extended to accept `url` and auto-clears a now-host-incoherent `CredentialId` with an audit-log entry.
- **Shared GUI primitives** (WP-003, WP-006): A new `modal-shell.js` extracted overlay/ARIA/focus-trap/focus-restoration/busy-gating logic; `confirm-dialog.js` was refactored onto it, gaining focus restoration for free.
- **API client** (WP-005): Added `credentialOptionsForUrl(url)` and fixed a live `updateCredential('' → null)` contract bug.
- **New component** (WP-007): `repository-modal.js`'s `showRepositoryModal({ mode, repo })` — the centerpiece — with debounced URL-triggered credential re-fetch, submit-in-flight busy guard, and priority-based credential selection.
- **View wiring** (WP-008): Removed the old inline form and inline Name-edit machinery from `views/repositories.js`, wired both to `showRepositoryModal()`, and consolidated the row-refresh callback (`onDeleted` → `onChanged`) shared by Delete and Edit-save.

One code-review bounce occurred on WP-007: a genuine out-of-order debounced-fetch race in `refreshCredentialOptions()` (a stale response could silently overwrite a fresher credential selection) was caught, fixed with a monotonic request-token guard, and re-verified through a full rework loop (implementation → QA → security-audit → code-review, all PASS on re-verification).

## Metrics

| WP | Implementation | QA | Security | Code Review | Documentation |
|---|---|---|---|---|---|
| WP-001 | PASS | PASS (953 tests) | PASS (0 issues) | PASS (0 blocking) | PASS |
| WP-002 | PASS | PASS (959 tests) | PASS (0 issues) | PASS (0 blocking) | PASS |
| WP-003 | PASS | PASS (254 tests) | — | PASS (0 blocking) | PASS |
| WP-004 | PASS | PASS (959 tests) | PASS (0 issues) | PASS (0 blocking) | PASS |
| WP-005 | PASS | PASS (268 tests) | PASS (0 issues) | PASS (0 blocking, 1 fix-forward) | PASS |
| WP-006 | PASS | PASS (268 tests) | — | PASS (0 blocking) | PASS |
| WP-007 | PASS *(1 rework)* | PASS (289 tests) *(1 rework)* | PASS (0 issues) *(1 rework)* | FAIL → PASS *(1 blocking bug fixed, re-verified)* | PASS |
| WP-008 | PASS | PASS (291 tests) | — | PASS (0 blocking) | PASS |

- Backend regression suite held steady at 953→959/959 passing throughout WP-001/002/004 (no failures introduced).
- GUI regression suite grew from 254 → 268 → 287 → 289 → 291 tests, all passing at each step — consistent incremental coverage with no regressions.
- Security audits: 0 Critical/High/Medium findings across all 5 audited WPs (001, 002, 004, 005, 007); several Low informational observations only.
- Pipeline health: 8/8 WPs with all pipeline stages passing; 0 stages missing.

### Blockers / Failures (resolved)

- **WP-007 code-review FAIL (high, logic bug):** `refreshCredentialOptions()` had no request-sequencing guard — an out-of-order debounced-fetch response could overwrite a fresher credential selection, silently attaching the wrong credential to a repository on submit. QA reproduced it, Security assessed it as non-exploitable but real, Reviewer bounced it as blocking. **Resolution:** Developer added a monotonically-incrementing `credentialRequestId` token compared at resolution time to discard stale responses, plus a regression test reproducing the exact race. Full rework loop (implementation → QA → security-audit → code-review) re-passed cleanly.

## Strategic Recommendations (Gold Nuggets)

- **Shared modal shell pays off immediately.** Extracting `modal-shell.js` (WP-003) before building `repository-modal.js` (WP-007) meant the new component got focus-trap, focus-restoration, Escape/backdrop-cancel, and busy-gating for free — and refactoring `confirm-dialog.js` onto the same primitive (WP-006) *fixed* a pre-existing focus-restoration gap in that dialog as a side effect, not a regression. This is a strong precedent for building shared primitives before their second consumer, not after.
- **Route-registration-order hazards recur in this router.** WP-002's implementation independently discovered that the new static `/credential-options` route would be silently shadowed by `GET /:id` unless registered first (same segment count, first-match-wins router) — mirroring a precedent already established in `error-log.ts`. Consider documenting this router constraint explicitly in `constraints.md` so future new-route work checks for it up front rather than rediscovering it per WP.
- **Consolidating callbacks reduces surface area.** WP-008's `onDeleted` → `onChanged` rename, shared by both Delete and Edit-save refresh paths, was called out by the Reviewer as a clean pattern worth repeating elsewhere.
- **Mock/interface drift risk flagged twice.** Both WP-002/WP-004's `MockRepositoryManager` (in `repositories.test.ts`) and the broader pattern of manually-kept-in-sync test doubles were flagged as having no compile-time-enforced shared interface with the real class they mock — worth extracting a shared `RepositoryManagerLike` type if this class of test double keeps growing.

## Code Insights

**Developer (Implementation):**
- `update()`'s URL-handling logic duplicates `add()`'s strip-then-duplicate-check pattern almost verbatim (WP-001) — acceptable now per the plan's deliberate-mirroring rationale, but extract a shared `cleanAndValidateUrl(url, excludeId?)` helper if a third URL-accepting call site appears.
- `credentialOptionsForUrl(url)` (WP-005) does not trim/validate `url` before encoding; acceptable since callers are expected to skip the fetch when empty, but flagged in case a future caller forgets that guard.
- The view no longer shows a success toast on Add/Edit, only on Delete (WP-008) — deliberate per the plan (the modal itself doesn't surface one on resolve), flagged as a low-priority consistency observation rather than fixed.

**QA:**
- `update(id, { name, url: '' })` silently persists an empty `Url` with no validation, unlike `add()`'s `inferSlugFromUrl()` empty-slug guard (WP-001, medium) — not an AC violation but worth guarding before further URL-accepting call sites land.
- Stale `CredentialId` (credential deleted from config) bypasses the host-incoherence auto-clear entirely (WP-004, medium) — confirmed non-exploitable (`resolveCredential()` already treats stale ids as null everywhere consumed) but a genuine data-integrity edge case.
- `credentialOptionsForUrl(url)` has no test for a malformed 200 response missing the `credentials` key — would throw an unhandled `TypeError` (WP-005, medium).
- Rapid double-click on Edit/Add Repository buttons opens two overlapping modal instances — no busy-guard unlike the Delete button (WP-008, medium); recommended as future hardening, not an AC violation.
- Found and reproduced the WP-007 out-of-order debounced-fetch race in `refreshCredentialOptions()` before code review bounced it — QA's repro was the basis for the Reviewer's blocking call.

**Security Auditor:**
- URL changes emit no audit-trail entry, unlike the existing credential-mutation audit pattern (WP-001, low) — candidate for a future consistency pass.
- App-wide no-auth posture and no audit-log entry on credential-options reads (WP-002, low, informational — consistent with the rest of the app's existing security model, not a new gap introduced by this plan).
- All credential-select population confirmed to use `textContent` (never `innerHTML`) across the new component (WP-007) — no XSS sink introduced.

**Reviewer:**
- `rebuildCredentialSelect()` used an inline child-removal loop instead of the project's established `clearElement()` utility (WP-007) — fixed forward during code review, verified non-behavioral via `tsc --noEmit` and the full test suite.
- Confirmed the Developer's 400-vs-500 error-surfacing convention change (WP-004) is safe: no frontend caller distinguishes status codes beyond `!response.ok`.

## Deferred & Follow-Up Items

| Source | Agent | Description | Priority / Rationale |
|---|---|---|---|
| WP-001 | Developer/Reviewer | Extract a shared `cleanAndValidateUrl(url, excludeId?)` helper if a third URL-accepting call site duplicates `add()`/`update()`'s strip-then-duplicate-check pattern. | Low — deliberate mirroring accepted for now, revisit at 3rd occurrence. |
| WP-001 | QA/Security | Guard `update()` against an empty/whitespace-only `url` silently clearing `Url` (mirroring `add()`'s empty-slug check). | Medium — data-integrity gap, non-blocking. |
| WP-001 | Security | Extend the existing credential-mutation audit-trail pattern to cover URL changes on `update()`. | Low — consistency improvement. |
| WP-002 | QA | Add a dedicated test for SSH/non-HTTPS `url=` query values on both credential-options endpoints (behavior is correct, just untested). | Low — pre-existing gap, not introduced by this WP. |
| WP-004 | QA/Security/Reviewer | Stale `CredentialId` (deleted credential) bypasses host-incoherence auto-clear silently; confirmed non-exploitable but a data-integrity edge case. | Low/Medium — informational, candidate for a future defensive guard. |
| WP-004 | Reviewer | `MockRepositoryManager` in `repositories.test.ts` has no compile-time-enforced shared interface with the real `RepositoryManager` — a future signature change could silently drift. | Low — worth a shared `RepositoryManagerLike` type if this pattern recurs. |
| WP-005 | QA | Add a test for a malformed 200 response (missing `credentials` key) in `credentialOptionsForUrl()`, which currently would throw an unhandled `TypeError`. | Medium — coverage gap. |
| WP-005 | Developer | `credentialOptionsForUrl(url)` does not trim/validate `url` before encoding — relies on callers skipping the fetch when empty. | Low — currently safe, watch for future callers. |
| WP-007 | QA | Add an explicit regression test for rapid-triple-click-on-Submit only firing one `create()` call (behavior is correct, just untested), matching the pattern used in `workspace-detail.test.mjs`. | Low — coverage gap (partially addressed during rework; verify still needed). |
| WP-008 | QA/Reviewer | Edit/Add Repository buttons lack a busy-disable guard; rapid double-click opens two overlapping modal instances (unlike the Delete button). | Medium — future hardening, not an AC violation. |
| WP-008 | QA/Reviewer | No negative-DOM-assertion test proving the old inline Name-edit markup is gone (relies on structural code removal only). | Low — coverage gap. |
| WP-008 | Developer | No success toast shown on Add/Edit (only Delete) since neither the plan nor `showRepositoryModal()` surfaces one on resolve. | Low — deliberate per plan scope, flagged for future UX consistency review. |
| Project-level | Documentation | 5 pipeline-documentation passes (WP-002, 004, 005, 006, 007) completed PASS but declared no `artifacts.files_modified` for traceability. | Low — process/ops hygiene, not a code issue. |

All items above are **deferred** (intentionally postponed, non-blocking to this plan's acceptance criteria) rather than **out-of-scope** — the plan's only explicit out-of-scope item is repository-ID renaming (cascading updates across projects/cloned folders), called out in the project summary as a separately-scoped future capability.

## Next Steps

- **Seed the next plan** with the deferred items above, prioritizing: (1) the WP-008 double-click modal-stacking guard and (2) the WP-001/WP-004 empty-URL and stale-CredentialId data-integrity guards, since both are recurring, low-effort hardening items flagged by multiple agents independently.
- Consider a small documentation-only pass updating `constraints.md` with the router registration-order hazard (static routes before `:id` wildcards) discovered independently in WP-002, to prevent future rediscovery.
- Evaluate extracting `cleanAndValidateUrl()` (backend) and a shared `RepositoryManagerLike` test-double interface if either pattern gains a third consumer.
- Repository-ID renaming (with cascading reference updates) remains the clearest candidate for a dedicated future plan, as explicitly scoped out of this one.
