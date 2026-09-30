# Synthesis Report — Workspace Index Files - Rework 1

### Outcome Summary

This rework cycle closed all six actionable follow-up items left open by the Workspace Index Files project: a stale GUI test fixture, a shared filesystem path-guard extraction, a stale choke-point allowlist entry, four QA-verified-but-untested edge cases converted to permanent regression tests, a hardened realpath-aware delete-path guard with a new cascade audit trail on repository deletion, and a full manifest-documentation sweep. All 6 work packages passed every stage of their pipelines (implementation, QA, security audit where applicable, code review, and documentation) with zero blocking findings and zero regressions, and the full suite finished at 1110/1110 passing tests — above the 1085-test floor carried over from the source project.

### Metrics

| Work Package | Stages Passed | Tests (final gate) | Blocking Issues | Security Issues |
|---|---|---|---|---|
| WP-001 — Repair stale `credentialOptions` GUI fixture | 4/4 (impl, qa, code-review, docs) | GUI 344/344, backend 1100/1100 | 0 | n/a |
| WP-002 — Extract shared path-guard module | 5/5 (impl, qa, security-audit, code-review, docs) | 1100/1100 | 0 | 0 |
| WP-003 — Remove stale allowlist entry, strengthen assertion | 4/4 (impl, qa, code-review, docs) | 1100/1100 | 0 | n/a |
| WP-004 — Convert 4 edge cases into regression tests | 4/4 (impl, qa, code-review, docs) | 1100/1100 (76/76 targeted) | 0 | n/a |
| WP-005 — Harden delete-path guard + audit trail | 5/5 (impl, qa, security-audit, code-review, docs) | 1110/1110 (40/40 targeted) | 0 | 0 |
| WP-006 — Manifest documentation update | 2/2 (qa, docs) | 1110/1110 | n/a | n/a |

- **Build:** `npx tsc --noEmit` clean across all WPs; `npm run build` clean at final gate.
- **Final full-suite count:** 1110/1110 passing (0 failed), exceeding the 1085-test floor required by WP-006's AC-04.
- **Security audits:** 2 performed (WP-002, WP-005) — both PASS, 0 Critical/High/Medium findings.
- **Code reviews:** 6 performed — all PASS, 0 Blocking, 0 Fix-Forward, 0 Documentation-Forward outstanding at close.

### Strategic Recommendations

- **Reusable path-guard module now exists.** `src/utils/path-guard.ts` extracts a previously module-private, twice-hardened guard chain (`isLexicallyContained`, `bestEffortRealpath`, `resolveRootRealPath`, `escapesRootViaRealpath`, `isDirectoryShaped`) into a dedicated, directly-unit-tested module with two named consumers (`workspace-index.ts`, `repository-orchestrator.ts`). Any future filesystem containment check in this codebase should reuse this module rather than re-implementing the pattern.
- **Test-the-guard-mechanism-itself pattern.** WP-003's code review flagged as a "gold nugget" the practice of testing a guard/validation mechanism with synthetic fixtures (proving it actually fails and passes) rather than relying on a real-world allowlist that happens to be empty and therefore exercises nothing. Worth propagating to other allowlist/guard-style tests in the suite.
- **Fixture-factory generalisation pays forward.** WP-004's `makeProject()` gained an optional `workspaceIds` parameter (default `['STABLE']`), fully backward-compatible, unblocking every future multi-workspace route test in `projects.test.ts` without a one-off literal.
- **Audit-trail asymmetry closed for repository deletion, but a related gap remains.** The global repository-deletion cascade (`deleteRepositoryGlobally()`) now emits `unlink-repository` and `delete-repository-global` audit entries; however, the project-level unlink route (`DELETE /api/projects/:id/repositories/:repoId`) remains explicitly outside this audit trail by design (a deliberate scope boundary, not an oversight) and is not yet cross-referenced in `rest-api.md`. See Deferred items below.

### Code Insights

**Developer**
- WP-002: `workspace-index.ts` still imports `fs`/`path` directly for its own writer logic unrelated to the guard chain — correctly left in place.
- WP-003: Extracted `extractImportBlocks()` / `importsAnyIdentifier()` as shared helpers reused by both the main choke-point scan and the new allowlist-entry validity check.
- WP-004: `makeProject()`'s default per-workspace description text changed from a literal `'Stable workspace'` to a generated `${workspaceId} workspace'` string — no existing test asserted on the literal, so this was safe.
- WP-005: Imported only `resolveRootRealPath`/`escapesRootViaRealpath` from `path-guard.ts`, deliberately not `isLexicallyContained` — its equality-permitting contract is wrong for the delete path, so the pre-existing stricter bespoke lexical check was retained instead of being replaced.
- WP-005: `deleteRepositoryGlobally()` serializes affected-project IDs into the audit entry's `Details` field since `ErrorLogContext` has no array-of-projects slot.

**QA**
- WP-001: `credentialOptions(id)` lacks a no-auto-match test case (autoSelected pointing to a non-existent ID) for parity with its sibling `credentialOptionsForUrl` — non-blocking, coverage-gap only.
- WP-003: The choke-point scan (both the main test and the new allowlist-entry check) only detects static `import { ... }` clauses; a dynamic `await import(...)` + property-access call bypasses detection entirely — pre-existing limitation, medium-priority coverage gap, not introduced by this plan.

**Security Auditor**
- WP-002: Verbatim extraction preserved the exact security-critical guard order (lexical containment → realpath symlink-escape via two deliberately separate roots → directory-shape); zero new dependencies or attack surface introduced.
- WP-005: Experimentally confirmed Node's `fs.rmSync(recursive:true)` does not follow a symlink at the removal target's own leaf — the new realpath guard layer closes the genuinely destructive case (an intermediate path component being a symlink, or a malformed ID lexically resolving to `projectsFolder` itself).
- WP-005 (low-severity, non-blocking): a TOCTOU window exists between the realpath guard check and `fs.rmSync()`, mitigated in practice by Node not following leaf symlinks recursively; `removeRepositoryFromProject()` validates path-guard/deletes before confirming `repositoryId` association with `projectId` (safe today only due to current call-site discipline); audit-severity error-log entries share the same rolling-window trim as routine entries, with no durability guarantee.

**Reviewer**
- WP-003: Deliberate, justified duplication between the main scan's inline regex loop and the new `importsAnyIdentifier()` helper, needed for per-identifier offender messages — non-blocking maintainability note.
- WP-005: Two-layer guard correctly distinguishes the lexical root (`path.resolve`) from the realpath root (`resolveRootRealPath`), preserving the symlinked-`projectsFolder`-still-works case while closing the planted-symlink escape and malformed-ID-resolves-to-root case; audit entries verified emitted strictly after all mutating side effects succeed.

**Documentation**
- WP-006: `rest-api.md`'s `DELETE /api/repositories/:id` row and the project-level unlink route are not yet cross-referenced for the audit-trail asymmetry — deferred, out of this WP's declared scope.

### Deferred & Follow-Up Items

- **Source: WP-001 | Originating agent: QA | Description:** `credentialOptions(id)` lacks a no-auto-match test case for parity with `credentialOptionsForUrl`. **Status:** deferred, low priority, non-blocking.
- **Source: WP-003 | Originating agent: QA | Description:** The choke-point scan only detects static `import` clauses; a dynamic `await import(...)` + property-access bypass is undetected. **Status:** out-of-scope for this plan (pre-existing design limitation); medium priority — consider a follow-up WP if dynamic-import bypass is a realistic threat model.
- **Source: WP-005 | Originating agent: Security Auditor | Description:** TOCTOU window between the realpath guard check and `fs.rmSync()`. **Status:** out-of-scope; low priority — mitigated in practice by Node's non-following-leaf-symlink behaviour, flagged as a hardening posture note rather than an exploitable gap.
- **Source: WP-005 | Originating agent: Security Auditor | Description:** `removeRepositoryFromProject()` validates the path guard before confirming `repositoryId`–`projectId` association; safe today only because of current call-site discipline (the sole caller pre-filters). **Status:** out-of-scope; low priority — defense-in-depth observation, not a currently reachable gap.
- **Source: WP-005 | Originating agent: Security Auditor | Description:** Audit-severity error-log entries share the same rolling-window trim as routine entries, with no durability guarantee. **Status:** out-of-scope; low priority — noted as a posture gap for future audit-retention work.
- **Source: WP-006 | Originating agent: Documentation | Description:** `rest-api.md`'s `DELETE /api/repositories/:id` row and the project-level unlink route are not cross-referenced for the new audit-trail asymmetry (the project-level unlink route is intentionally excluded from the audit trail, but this exclusion is not yet documented in `rest-api.md`). **Status:** deferred, low priority — was outside WP-006's declared Scope list (constraints.md, api-surface.md, data-flows.md, .context/**, README.md).
- **Source: WP-001 | Originating agent: Developer** (project-comment, not WP-scoped): WP-001's acceptance criterion "`gui/public/js/api.js` is unmodified" could not be satisfied literally because a pre-existing, unrelated uncommitted diff (JSDoc additions for an optional `description` field on `repositories.create`/`update`) was already present in the working tree before this plan started. WP-001's own pipeline never touched `api.js`. **Status:** informational — flagged for AC-wording clarity in future plans, not a defect.

### Next Steps

1. **Consider a follow-up WP for the dynamic-import bypass gap** in the choke-point scan (`workspace-artifacts-chokepoint.test.ts`) if dynamic `import()` usage becomes a realistic pattern in this codebase.
2. **Close the `rest-api.md` documentation gap** noting the audit-trail asymmetry between the global cascade (`deleteRepositoryGlobally()`, now audited) and the project-level unlink route (`DELETE /api/projects/:id/repositories/:repoId`, intentionally excluded) — a small, scoped documentation-only task.
3. **Evaluate audit-log durability** for `Severity: 'audit'` entries — currently subject to the same rolling-window trim as routine log entries, with no separate retention guarantee; worth a design discussion if compliance requirements tighten.
4. **Optional parity test** for `credentialOptions(id)`'s no-auto-match case, mirroring `credentialOptionsForUrl`'s existing coverage — low-cost, low-priority cleanup.
5. **No blocking work remains.** All acceptance criteria across all 6 WPs are met; the plan is fully complete and the codebase is in a clean, fully-tested state (1110/1110) ready for the next planning cycle.
