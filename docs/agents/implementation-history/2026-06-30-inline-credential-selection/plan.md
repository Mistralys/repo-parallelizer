# Plan

> **Retroactive plan.** Both changes below were implemented ad hoc, directly by the user working with the Standalone Developer agent, before this plan existed. This document reconstructs the plan that would have preceded the work, verified against the shipped code, so the project folder can be archived through the normal ledger import path (Ledger Standalone Archiver v1.7.0). No further implementation is scoped by this plan — everything described here is already complete and verified in `synthesis.md`.

## Plan Audit Cycles
- Audits: none — Plan Auditor v1.9.1
- Architectural Reviews: none — Plan Architect Reviewer v2.3.1

## Prior Project Context
`ledger_get_repository_context` reports no declared strategic vision (short/mid/long-term) for this repository, so there is nothing to align against. The repository's project history shows a lineage of credential-subsystem work (`2026-06-26-multi-credential-support` and its two rework cycles) that this project's inline-selection and partial-update fix build on directly — both changes touch the same `GitCredentialEntry` model and `#/repositories` view established by that lineage. `ledger_search_insights` surfaced no insight describing the specific inline-select or partial-update pattern this work touches, so no reconciliation is required.

## Summary
Two independent, small changes were made ad hoc to the credential-management surface: (1) the `#/repositories` table's edit mode gained an inline credential `<select>` alongside the existing name edit, replacing a prior read-only badge during editing; (2) a bug in `PUT /api/config/credentials` that rejected credential label/token-only updates (because `host` and `token` were always required) was fixed so the update path only requires `label`, retaining stored `host`/`token` when omitted. Both changes are fully implemented, tested, and documented per `synthesis.md`.

## Architectural Context
The GUI is a vanilla-JS SPA (`gui/public/js/`) with no build step or bundler; every view re-fetches data on render (`docs/agents/project-manifest/gui-frontend.md`). The `#/repositories` view (`gui/public/js/views/repositories.js`) already supported inline name editing and a read-only credential badge (`buildCredentialLabel()`) before this work; the `#/repositories/:id` detail view (`repository-detail.js`) already had a live credential `<select>` with the auto-select semantics this work reuses. Server-side, `PUT /api/config/credentials` (`src/server/routes/config.ts`) manages the `gitCredentials` array in `config.json` and previously validated `host`/`token` unconditionally, with no distinction between create and update paths.

## Approach / Architecture
- **Inline credential selection:** extend the existing edit-mode toggle in `buildRepoRow` (`gui/public/js/views/repositories.js`) with a second hidden control (`repo-credential-select`) that lazily fetches `GET /api/repositories/:id/credential-options` on first edit, mirroring the auto-select logic already established in `repository-detail.js`. Save fires the existing `api.repositories.update()` alongside the existing `api.repositories.updateCredential()` in parallel; Cancel discards the in-memory select state without a network call.
- **Partial-update fix:** resolve the existing credential entry by `id` before validating required fields in the `PUT /api/config/credentials` handler, so `host`/`token` are required only when no existing entry is matched (create path), while `label` stays required on both paths. Retained values fall back to the resolved existing entry when a field is omitted.

## Rationale
Both changes close a real gap between what the GUI already supported at the detail-view level (live credential selection, host/token partial retention) and what the table's inline-edit row and the server handler actually allowed. Reusing the already-established auto-select and parallel-save patterns kept both changes small and consistent with existing conventions rather than introducing new ones.

## Considered Alternatives

| Decision | Chosen Shape | Alternatives Considered | Trade-Off Summary |
|----------|--------------|-------------------------|-------------------|
| Credential options fetch strategy (inline edit) | Lazy per-row fetch of `GET /api/repositories/:id/credential-options` on first edit, cached per row | Fetch all credentials once via `api.config.credentials.list()` and filter client-side | Per-row fetch keeps host-matching authoritative on the server (single source of truth); the all-at-once alternative would need to duplicate that matching logic client-side for a marginal reduction in round-trips. Recorded as a rejected optimization in Structural Improvements below. |
| Partial-update validation shape | Resolve existing entry by `id` first, branch required-field checks on update-vs-create | Make `host`/`token` universally optional and always merge with stored values | Universal optionality would silently accept a typo'd `id` with no existing match as a valid "update" with empty host/token; requiring both fields on the create path (no match) preserves a hard boundary between adding a new credential and editing one. |

## Pattern Alignment
- Follows the auto-select precedent in `gui/public/js/views/repository-detail.js` (`buildCredentialSection`) — single `auto: true` match pre-selected, stored `credentialId` takes priority — documented in `docs/agents/project-manifest/gui-frontend.md`.
- Follows the parallel multi-field save precedent in `gui/public/js/views/settings.js` (`Promise.all()` across independent section saves).
- Departure: none. Both changes extend patterns already established elsewhere in the same modules; no new pattern was introduced.

## Structural Improvements

| Structure | Observation | Decision | Reason |
|-----------|-------------|----------|--------|
| `gui/public/js/views/repositories.js` → `buildRepoRow` | Per-row lazy credential fetch causes N `/credential-options` calls if a user edits several rows in one session, vs. one bulk `api.config.credentials.list()` call filtered client-side | Rejected | Server-side host-matching is authoritative; duplicating that logic client-side to save round-trips is a marginal efficiency gain not worth the added client-server logic duplication. Noted as a low-priority insight in `synthesis.md`, not promoted here. |
| `gui/public/js/views/repositories.js` → `buildRepoRow` | `loadCredentialOptions` is declared between DOM cell construction and the actions cell, ahead of the file's `// Behaviour` section where the rest of the view's event wiring lives | Rejected | Purely cosmetic reordering with no functional benefit; already flagged as a low-priority convention note in `synthesis.md`. Reshaping it now is outside the blast radius of the (already-shipped) work this plan documents. |
| `src/server/routes/config.ts` → `PUT /api/config/credentials` | Handler pre-dated partial-update support; new "resolve existing entry early" pattern is now the reference shape for future partial-update endpoints | Promoted (already implemented) | The pattern is in place and documented inline (module JSDoc, L130–L145) as the precedent to follow — no further action needed; recorded here for traceability. |

## Detailed Steps
1. Add a `repo-credential-select` `<select>` to the credential cell in `buildRepoRow` (`gui/public/js/views/repositories.js`), hidden by default alongside the existing read-mode badge.
2. Implement `loadCredentialOptions()` with `credentialsLoaded`/`credentialsLoading` guards, fetching `api.repositories.credentialOptions(repo.id)` and applying the same auto-select/stored-priority semantics as `repository-detail.js`.
3. Wire the edit button to reveal the select and call `loadCredentialOptions()`; wire the cancel button to restore the badge and discard the select state.
4. Wire the save button to call `api.repositories.update()` and `api.repositories.updateCredential()` in parallel via `Promise.all`, then rebuild the badge via `buildCredentialLabel()` on success.
5. In `src/server/routes/config.ts`, resolve the existing `GitCredentialEntry` by `id` before field validation in the `PUT /api/config/credentials` handler; branch `host`/`token` required-ness on whether an existing entry was resolved (update path) or not (create path); fall back to the resolved entry's stored values when a field is omitted.
6. Correct the stale `credentials.update()` JSDoc in `gui/public/js/api.js` to accurately describe token-retention behavior.
7. Update `docs/agents/project-manifest/gui-frontend.md` (`#/repositories` entry) and `docs/agents/project-manifest/rest-api.md` (`PUT /api/config/credentials` section) to describe the new behavior.
8. Rename the create-path "missing host/token" test cases in `src/server/__tests__/routes/config.test.ts` to make explicit they apply only when `id` is absent.
9. Extend `gui/public/js/views/repositories.test.mjs` with credential edit-mode coverage (load, auto-select, save, cancel, concurrent-load guard).

## Dependencies
- `GitCredentialEntry` type and `gitCredentials` config array (established by the prior `2026-06-26-multi-credential-support` project lineage).
- `GET /api/repositories/:id/credential-options` endpoint (pre-existing, used by `repository-detail.js`).

## Required Components
- `gui/public/js/views/repositories.js` (modified)
- `gui/public/js/api.js` (modified — JSDoc only)
- `src/server/routes/config.ts` (modified)
- `gui/public/js/views/repositories.test.mjs` (modified)
- `src/server/__tests__/routes/config.test.ts` (modified)

## Assumptions
- The behavior described in `synthesis.md` matches what is currently checked into the repository — verified directly against `gui/public/js/views/repositories.js` and `src/server/routes/config.ts` during research for this retroactive plan.

## Constraints
- Host format validation (rejects `/`, `\`, null bytes, whitespace) still applies whenever `host` is explicitly supplied on an update.
- SSH/non-HTTPS repository URLs always return an empty `credential-options` list (pre-existing constraint, unaffected by this work).

## Out of Scope
- Reducing per-row `/credential-options` fetches to a single bulk call (rejected in Structural Improvements).
- Relocating `loadCredentialOptions()` to match the file's `// Behaviour` section convention (rejected in Structural Improvements).
- Unifying the token-mask format inconsistency between `/credential-options` (`"***"`) and `/api/config/credentials` (`"****" + last 4`), noted as pre-existing in `docs/agents/project-manifest/rest-api.md` — untouched by this work.

## Acceptance Criteria
- AC-01: Clicking Edit on a `#/repositories` row replaces the read-only credential badge with a `<select>` populated from `GET /api/repositories/:id/credential-options`, fetched once and cached across repeated edit/cancel cycles on the same row.
- AC-02: A single `auto: true` credential option is pre-selected when no stored `credentialId` exists; a stored `credentialId` takes priority over auto-selection.
- AC-03: Saving an edited row persists both the name and credential selection via parallel `api.repositories.update()` / `api.repositories.updateCredential()` calls, and the badge is rebuilt from the new state on success.
- AC-04: Cancelling an edit restores the original badge and discards any in-progress or completed select changes without a network call.
- AC-05: `PUT /api/config/credentials` accepts `{ id, label, token }` (no `host`) for an existing entry and retains the stored `host`; it accepts `{ id, label, host }` (no `token`) and retains the stored `token`; `label` remains required in all cases.
- AC-06: `PUT /api/config/credentials` still requires both `host` and `token` when `id` is omitted or does not match an existing entry (create path).

## Testing Strategy
Existing suites were extended in place rather than adding new test files, consistent with the project's per-module test-file convention (`docs/agents/project-manifest/constraints.md`). GUI behavior is covered by the vanilla-JS view test file for `repositories.js`; server validation behavior is covered by the existing route test file for `config.ts`.

## Test Plan
- `gui/public/js/views/repositories.test.mjs` — asserts credential select population, auto-select/stored-priority pre-selection, save persisting both name and credential, cancel discarding changes, and the `credentialsLoading` guard preventing duplicate in-flight fetches — AC-01, AC-02, AC-03, AC-04.
- `src/server/__tests__/routes/config.test.ts` — asserts label-only and token-only updates succeed and retain stored values, and that create-path requests still reject a missing `host`/`token` — AC-05, AC-06.

## Documentation Updates
- `docs/agents/project-manifest/gui-frontend.md` — `#/repositories` route entry updated to describe the credential select in edit mode, auto-select semantics, and badge replacement on save (per `AGENTS.md` manifest maintenance rule: "New GUI route, view, or component added/modified" → `gui-frontend.md`).
- `docs/agents/project-manifest/rest-api.md` — `PUT /api/config/credentials` table entry and request-body field table updated to mark `host`/`token` as required-for-create / optional-for-update, with a label-only update example (per `AGENTS.md` manifest maintenance rule: "New REST endpoint added/modified" → `rest-api.md`).
- `src/server/routes/config.ts` — inline JSDoc on the `PUT` handler documents partial-update semantics.
- `gui/public/js/api.js` — `credentials.update()` JSDoc corrected to remove the false token-retention claim.

## Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| **Retroactive plan describes behavior that has since drifted from the checked-in code** | Verified directly against `gui/public/js/views/repositories.js` and `src/server/routes/config.ts` at plan-authoring time; both match `synthesis.md` exactly. |
| **Archival import expects a plan.md that precedes the work chronologically** | This plan is explicitly labelled retroactive at the top of the document so the archived record is not misread as having gated the original ad-hoc work. |

## Recommended Workflow
- **Workflow:** standalone
- **Rationale:** Both changes are single-module, well-understood bug-fix/feature-extension work already completed in one ad-hoc session with no rework iterations, matching the standalone criteria exactly.
