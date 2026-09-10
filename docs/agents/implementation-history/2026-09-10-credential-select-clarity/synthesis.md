
## Synthesis

### Completion Status
- Date: 2026-09-10
- Status: COMPLETE
- Completed by: Web GUI Specialist Agent
- Archived in Ledger: 2026-09-10

### Outcome Summary

The credential-selection dropdown in the repository create/edit modal and on the repository detail page now explains itself instead of appearing broken: an explanatory hint clarifies why the select shows only "None" (non-HTTPS URL scheme vs. no host match), and the sole auto-detected credential match is labeled as a recommendation rather than silently pre-selected — resolving the reported inconsistency with the repositories list's "No credential configured" badge. As a follow-up, host matching across the credential subsystem was also made case-insensitive, closing a previously-flagged gap where a credential host typed with different casing than a repository's URL would silently never match.

### Interface Implementation Summary
- Added a dynamic hint `<span>` (`describeEmptyCredentialOptions()` / `isHttpsUrl()`) under the credential select in `components/repository-modal.js`, wired via `aria-describedby`, distinguishing the non-HTTPS-scheme case from the no-host-match case.
- Removed the auto-preselect fallback from `computeSelectedCredentialId()` in the modal, and the equivalent inline logic in `views/repository-detail.js`'s `buildCredentialSection()` — only a stored credential ID now pre-selects an option in either surface.
- The sole `auto: true` match (when present) is labeled `(recommended match)` in both surfaces' option text instead of being force-selected.
- **Backend follow-up:** added an exported `hostsEqual(a, b)` case-insensitive comparator in `git-credentials.ts`, used at all four host-comparison sites (`resolveCredential()`, `buildCredentialOptionsResponse()`, the host-incoherence auto-clear, and the `PUT /:id/credential` host-coherence guard). `host` is now also lowercased at storage time in `parseGitCredentials()` (both new- and legacy-format paths) and `PUT /api/config/credentials`, so newly-configured credentials are canonical while the case-insensitive comparison covers any already-persisted mixed-case data.

### Documentation Updates
- `docs/agents/project-manifest/gui-frontend.md`: updated the repository-modal Credential field description, the "Credential selection priority" section, the repository-detail Credential section description, and the `credentialOptions` auto-match semantics note to match the new no-auto-preselect / `(recommended match)` behavior.
- `docs/agents/project-manifest/api-surface.md`: added `hostsEqual()` to the `git-credentials.ts` export list and documented case-insensitive host matching.
- `docs/agents/project-manifest/constraints.md`: documented host lowercasing at storage time and the `hostsEqual()` defense-in-depth comparison under "Hostname Format".

### Verification Summary
- Browser checks: live-verified against the running app (`http://localhost:4200`) across the three real-world host-matching scenarios — an ambiguous two-credential host (`github.com`), a single-match host (`git.ionos.org`), and a non-HTTPS repository URL (`http://`) — plus an SSH URL typed live in create mode. Confirmed the hint text, the `(recommended match)` label, and that "None" remains selected without a stored credential.
- Accessibility and responsive audit: the new hint is linked to the select via `aria-describedby`; no new interactive controls, motion, or layout changes were introduced, so no reduced-motion or reflow impact. Not independently re-audited across the full viewport range since the change is a text/label addition within an existing, previously-audited modal layout.
- Tests run: `node --test` on `gui/public/js/components/repository-modal.test.mjs` (2 new tests added) and `gui/public/js/views/repository-detail.test.mjs` (1 existing test updated) — all pass. Full GUI suite (`public/js/**/*.test.mjs`) run once for regression coverage; the one failing test (`api.config.test.mjs`) was confirmed via `git stash` to pre-exist this session's changes. Backend: `npm test` (`tsc && node --test` across all `dist/tests` and `dist/server/__tests__` suites) — 971 tests pass, including 8 new case-insensitivity regression tests across `git-credentials.test.ts`, `config.test.ts`, and `repositories.test.ts`.
- Static analysis run: `get_errors` on all touched source/test files, plus `npx tsc --noEmit` for the backend change — no issues.
- Result: PASS — no regressions introduced; one pre-existing, unrelated GUI test failure confirmed out of scope.

### Interface Insights
- [medium] (consistency) `gui/public/js/components/repository-modal.js`: the credential select silently showed only "None" for non-HTTPS repository URLs (`extractHost()` only matches `https:`), indistinguishable from "no credential configured for this host" without inspecting network requests. Resolved this session via the new hint span.
- [medium] (ux-friction) `gui/public/js/components/repository-modal.js`: the select auto-selected the single host-matching credential even with no stored `CredentialId`, contradicting the repositories list's "No credential configured" badge — raised directly by the user as a follow-up and resolved this session (also applied to `views/repository-detail.js` at the user's request for consistency).
- [low] (improvement) `src/git/git-credentials.ts`, `src/config/config.ts`, `src/server/routes/config.ts`, `src/server/routes/repositories.ts`: **RESOLVED** — credential `host` values were only trimmed, never lowercased, while `extractHost()` lowercases via the WHATWG `URL` parser, so a credential host typed with different casing (e.g. `GitHub.com`) would silently never match. Fixed at the user's request via a new `hostsEqual()` case-insensitive comparator used at every host-comparison site, plus lowercasing `host` at both credential-storage entry points.

### Additional Comments
- This plan and its `insights.jsonl` sink were created retroactively, after the GUI implementation was already complete and verified in the browser, at the user's explicit request to formalize the session for archival. The host-casing backend fix was implemented afterward, in the same plan, as a direct follow-up request.
