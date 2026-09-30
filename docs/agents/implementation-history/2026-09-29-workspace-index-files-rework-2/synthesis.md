# Synthesis Report — Workspace Index Files - Rework 2

### Outcome Summary

This rework cycle closed an audit-trail and clone-deletion gap between the two repository-removal code paths: the project-level unlink route now delegates to `RepositoryOrchestrator.removeRepositoryFromProject()`, so it deletes the repository's clone folders under the existing path guards and emits an `unlink-repository` audit entry, matching the behavior the global-delete route already had. The orchestrator itself was hardened with a pre-loop repository-project association check and a redrawn completion boundary so a transient artefact-regeneration failure can no longer erase the audit record of a completed deletion, the workspace-artefact choke-point scan was strengthened to detect every import form (not just named imports) that could reach a guarded module, a missing GUI test-parity case was added, the Remove-repository confirmation text was corrected to reflect the new on-disk deletion behavior, and the affected project manifest documents were swept for consistency. All six work packages completed with full pipelines passing (implementation, QA, security audit, code review, documentation where applicable); one WP (WP-006) required a single QA rework cycle to fix a missed parameter in manifest documentation, which was then verified clean.

### Metrics

| WP | Stages Passed | Tests (final) | Security Issues | Blocking Review Issues |
|---|---|---|---|---|
| WP-001 — Choke-point scan hardening | 5/5 | 1118 passed | 0 | 0 |
| WP-002 — Orchestrator hardening | 5/5 | 1118 passed | 0 | 0 |
| WP-003 — `credentialOptions(id)` test parity | 2/2 | 346 passed | — | 0 |
| WP-004 — Route delegation to orchestrator | 5/5 | 1467 passed (backend 1121 + GUI 346) | 0 | 0 |
| WP-005 — GUI confirmation text correction | 4/4 | 348 passed | — | 0 |
| WP-006 — Manifest documentation sweep | 2/2 (1 QA rework cycle) | 1469 passed (backend 1121 + GUI 348) | — | — |

- Full test suite ended at 1469 total tests passing (1121 backend + 348 GUI), zero failures, at or above the 1110-test floor required by WP-006's acceptance criteria.
- `npx tsc --noEmit` and `npm run build` remained clean across all WPs.
- No security findings (Critical/High/Medium) were raised in any of the three security-audited WPs (WP-001, WP-002, WP-004).
- WP-006 rework count: 1 (QA self-fix of a missed `repositoryOrchestrator` parameter in `api-surface.md`'s `registerProjectRoutes()` signature block).

### Blockers & Failures (Aggregated)

- No unresolved blockers or failures remain. The single FAIL in this cycle (WP-006's first QA pass, flagging that `api-surface.md` documented only 4 of `registerProjectRoutes()`'s 5 parameters) was self-fixed in the same WP's rework cycle and re-verified PASS.

### Strategic Recommendations

- **Gold nugget (WP-002, code-review):** The audit-entry/regeneration-failure boundary redraw in `removeRepositoryFromProject()` is a clean, reusable pattern for separating "what happened" (audited, unconditional once mutations succeed) from "best-effort downstream reconciliation" (caught, logged as a warning, never suppresses the audit record). The JSDoc states the rule inline with the code, making the boundary self-documenting. Worth citing as a reference pattern anywhere else in the codebase couples an audit trail to a downstream best-effort step.
- **Reusable test pattern (WP-001, code-review → documentation):** The identifier-vs-specifier dual-gating detection strategy in `referencesGuardedModule()` (gate named imports on identifier presence; gate opaque import forms — namespace/default/side-effect/dynamic `import()`/`require()` — on module-specifier match alone, since those forms have no statically visible identifier to filter on) is now documented in `constraints.md`'s Test Conventions as a template for future choke-point guards protecting other orchestrators.
- **Precondition-before-destructive-I/O discipline (WP-002):** Hoisting the repository-project association check above the delete loop — rather than relying on a post-loop throw made safe only by caller discipline — is the same discipline the two-layer path guard already follows. This becomes load-bearing the moment a second caller of `removeRepositoryFromProject()` exists, and is worth treating as a standing rule for any future orchestrator method with a validate-then-mutate shape.
- **Route-delegation over route-local reimplementation (WP-004):** Where an orchestrator method already implements a hardened lifecycle mutation (path guards, audit trail), route handlers should delegate to it rather than maintaining a second, weaker copy of the same mutation. This WP is a concrete precedent for auditing sibling routes that perform similar-looking but divergent operations.

### Code Insights

**Developer**
- WP-001: Fixed a latent fixture defect in the allowlist-entry check test — it previously imported the choke-point module itself rather than a guarded module, so the old assertion passed only by textual coincidence.
- WP-001: Pure specifier-level matching produced false positives against files that legitimately named-import non-guarded exports from the same module files (`workspace-health.ts`, `server/index.ts`, `server/routes/workspaces.ts`); resolved via the identifier-vs-specifier dual-gating split.
- WP-002: Two pre-existing regression tests needed their malformed-ID fixtures placed into the project's persisted `Repositories` array (bypassing the normal validator, matching an existing hand-edited-storage pattern) so they kept exercising the path-traversal guard rather than tripping the newly hoisted association check first.
- WP-004: Placed the new `repositoryOrchestrator` parameter after `workspaceArtifacts` in `registerProjectRoutes()`, matching call-site ordering in `server/index.ts` and the equivalent parameter ordering in `registerRepositoryRoutes()`.
- WP-005: Confirm text was written to positively state record retention ("is retained and can be re-added later") rather than a bare negative, matching the declarative style of the existing workspace-delete confirm precedent.

**QA**
- WP-001: Edge-case stress testing surfaced two out-of-scope bypass shapes not caught by the new detection — barrel re-exports (`export { x } from '...'`, `export * from '...'`) and computed/template-literal dynamic `import()` specifiers — recorded as a medium-priority coverage gap for potential future hardening.
- WP-002: The combination of no `errorLogManager` injected plus a throwing `regenerateProject()` is untested (behaves correctly by code inspection but not directly exercised) — low-priority optional future addition.
- WP-004: `mock-error-log-manager.ts`'s JSDoc Consumers list didn't mention `projects.test.ts` despite it now being a consumer — cosmetic doc-drift, addressed in the WP's own documentation stage.
- WP-006: Caught that `api-surface.md`'s `registerProjectRoutes()` signature block documented only 4 of the real 5 parameters, missing `repositoryOrchestrator` — filed as a high-priority bug and self-fixed in the rework cycle.

**Reviewer**
- WP-001: Flagged (documentation-forward) that the specifier-vs-identifier dual detection strategy wasn't captured in `constraints.md`'s test-pattern conventions — addressed in WP-001's documentation stage.
- WP-004: Flagged (documentation-forward) the same `mock-error-log-manager.ts` Consumers-list gap QA had already noted — addressed in WP-004's documentation stage.

**Documentation**
- WP-001: While updating `constraints.md`, found and fixed a stale passage in `api-surface.md` still describing the allowlist-entry check as requiring "a named import of at least one guarded identifier."
- WP-002: Found two high-priority stale passages contradicting the new intentional behavior — `data-flows.md` §15's completion-boundary description and `api-surface.md`'s `RepositoryOrchestrator` audit-trail note, both previously stating the audit entry was emitted "only after" regeneration succeeded.
- WP-004: Found two more high-priority stale passages — `rest-api.md`'s route table still described the project-level unlink as data-only with no clone deletion/audit entry/500 case, and `data-flows.md`'s "Excluded from this audit trail" note explicitly (and now falsely) said the route "is not audited today."

### Deferred & Follow-Up Items

- **Out-of-scope (WP-001, QA):** Barrel re-export syntax (`export { x } from 'guarded.js'`, `export * from 'guarded.js'`) and computed/template-literal dynamic `import()` specifiers both evade `referencesGuardedModule()` detection. Not part of this WP's acceptance criteria; worth a follow-up WP if barrel re-exports of the guarded modules become a real risk. Priority: medium.
- **Deferred (WP-002, QA):** The combination of no `errorLogManager` injected plus a throwing `regenerateProject()` is untested, though verified correct by code inspection (silently swallowed, no crash). Priority: low, optional future test addition.
- **Deferred (WP-006, project-level, from prior synthesis cycle context now closed):** This entire plan originated as Synthesis Rework cycle 2 of the Workspace Index Files project and fully addressed its source items (audit-trail/clone-deletion gap, choke-point hardening, GUI test parity, confirmation text). No items from this cycle's own scope remain open; the two coverage gaps above are the only carry-forward items for a future cycle.

### Next Steps

- Consider a follow-up WP to close the two known choke-point-scan bypass shapes (barrel re-exports, computed/template-literal dynamic import specifiers) if the risk profile changes — currently zero production instances exist, so this remains optional hardening rather than an active defect.
- Consider adding the low-priority missing test combination for `RepositoryOrchestrator` (no `errorLogManager` + throwing `regenerateProject()`) during any future touch of that file, for completeness rather than urgency.
- No other unfinished work packages remain; the plan is fully COMPLETE and ready for archival.
