# Plan

## Plan Audit Cycles
- Audits: 1 (Sonnet 5 ×1) — Plan Auditor v1.9.3
- Architectural Reviews: 1 (Sonnet 5 ×1) — Plan Architect Reviewer v2.3.3

## Prior Project Context

This is Synthesis Rework cycle 2, driven by `docs/agents/plans/2026-09-28-workspace-index-files-rework-1/synthesis.md`. The repository has no declared strategic vision (`ledger_get_repository_context` returns null for all three horizons), so alignment is judged against the codebase's own established conventions rather than a stated roadmap.

Insights that shaped this plan:

- **`d20f3cea-1f76-46e3-87fa-4d8c76df206a`** — `path-guard.ts`'s `isLexicallyContained()` permits equality with the root, which is the wrong contract for a delete guard. Verified still accurate. This plan touches `removeRepositoryFromProject()` and explicitly **preserves** its bespoke strict-descendant lexical check rather than substituting the shared helper.
- **`cdcc6460-d3ed-4d11-9aa7-aaaf9e8d8eab`** — *"Build shared UI primitives before their second consumer, not after."* The generalised form drove step 4: a second, weaker implementation of a lifecycle mutation already owned by an orchestrator should be routed through the orchestrator, not documented as a divergence.
- **`f13a8d1a-5b81-427b-a09b-e15a5b280adc`** / **`d205d609-44bd-4411-8b6d-94a19e4a9e2c`** — layered guard ordering (lexical → realpath → shape). Confirms the delete-path guard sequence is already correct; the association check added in step 3 is an orthogonal precondition, not a fourth guard layer.
- **`c95184f8-9da2-42d7-9a0a-bc0e182dfe79`** — router is first-match-wins, static routes before same-segment-count `:id` wildcards. Checked and **not triggered**: this plan registers no new routes and reorders none.

## Knowledge Base Reconciliation

| Insight ID | Title | What the plan overtakes | Executed by |
|------------|-------|-------------------------|-------------|
| `d20f3cea-1f76-46e3-87fa-4d8c76df206a` | path-guard.ts's isLexicallyContained() permits equality with the root — wrong contract for delete-path guards | The insight's core claim (verify a `path-guard.ts` function's boundary contract before reuse) remains correct and this plan deliberately upholds it. What the plan overtakes is the surrounding description of `removeRepositoryFromProject()`: after steps 3 and 5 that function additionally enforces a repository–project association precondition *before* any deletion, and no longer treats an artefact-regeneration failure as fatal to the audit entry. The insight should be re-scoped to the guard-contract lesson alone, with the stale behavioural description of the call site corrected. | Ledger Knowledge Curator v1.4.1 (Targeted Reconciliation) |

## Summary

This plan addresses the actionable items left open by the Workspace Index Files — Rework 1 synthesis. Its centrepiece is not one of the synthesis's own items as written: the synthesis recorded item #2 as a *"small, scoped documentation-only task"* to note that the project-level unlink route is intentionally excluded from the new audit trail. Research showed the route is not merely unaudited — `src/server/routes/projects.ts` (L394) calls `projectManager.removeRepository()` directly and therefore **never deletes the repository's clone folders from disk**, leaving orphaned clones in every workspace of the project with no UI path to reach them. The plan closes that divergence by routing the handler through the `RepositoryOrchestrator.removeRepositoryFromProject()` method that already does the complete job, resolves the resulting contract conflict over artefact-regeneration failure in favour of the codebase's established best-effort convention, and corrects the now-misleading GUI confirmation text. Alongside it, the plan hardens the workspace-artefact choke-point scan from identifier-based to module-specifier-based detection (closing namespace, dynamic, default, and `require` import bypasses in one move rather than one regex per bypass shape), hoists the repository–project association check above the destructive delete loop, adds the missing `credentialOptions(id)` GUI test-parity case, and performs the manifest documentation sweep the changes oblige.

## Architectural Context

The codebase is layered: Storage → Models → Error Log → Git → Orchestration → Server → CLI (`AGENTS.md` §5). Three conventions govern this plan:

- **Orchestrators own multi-step lifecycle mutations; routes delegate.** `src/server/routes/repositories.ts` (L397–L412) routes `DELETE /api/repositories/:id` through `repositoryOrchestrator.deleteRepositoryGlobally()` precisely so deletion also removes clone folders and regenerates artefacts. `src/server/index.ts` (L150) wires the orchestrator into that route group.
- **Artefact reconciliation is best-effort at the routes layer.** `logArtifactWarning()` exists in three route modules (`projects.ts` L55–L82, `repositories.ts` L101–L118, and `workspaces.ts`), each logging `Severity: 'warning'`, `Source: 'workspace-index'` and leaving the handler's own response unaffected. The `repositories.ts` JSDoc states the rationale: *"the artefact set going briefly stale is preferable to surfacing a 5xx for an edit that otherwise completed correctly."*
- **A single choke-point owns artefact writes.** `src/orchestration/workspace-artifacts.ts` is the only module permitted to import the four raw generator/remover functions from `src/orchestration/vscode-workspace.ts` (L56, L92) and `src/orchestration/workspace-index.ts` (L289, L375). `src/tests/workspace-artifacts-chokepoint.test.ts` enforces this by static source scan.

The project-level unlink route (`src/server/routes/projects.ts` L386–L409) is the one lifecycle mutation that violates the first convention, and it is the only reason the second and third are in tension anywhere in this plan.

## Approach / Architecture

Six independent workstreams, only two of which interact:

1. **Choke-point scan hardening** (`src/tests/workspace-artifacts-chokepoint.test.ts`) — replace identifier-inside-named-import-clause detection with **module-specifier detection**. Any production file outside the choke point that references `workspace-index.js` or `vscode-workspace.js` in *any* import form is an offender. Identifier-level detail is retained for the offender message, but the specifier match is what gates the assertion. This is a strictly stronger guard and is bypass-shape-agnostic.

2. **Unlink-path unification** (`src/server/routes/projects.ts`, `src/server/index.ts`) — pass the existing `repositoryOrchestrator` into `registerProjectRoutes()` and have the `DELETE /api/projects/:id/repositories/:repoId` handler call `removeRepositoryFromProject()`. Preconditions (project exists, repository is linked) are checked at the route before the call, following the precedent documented at `src/server/routes/repositories.ts` L397–L405, so the route's 404 mapping stays exact and a path-guard failure maps to 500 rather than being misclassified.

3. **Regeneration-failure boundary correction** (`src/orchestration/repository-orchestrator.ts`) — the orchestrator's uncaught `workspaceArtifacts.regenerateProject()` call becomes best-effort: caught, logged at `Severity: 'warning'` / `Source: 'workspace-index'` through the already-injected `errorLogManager`, and non-fatal to the audit entry. This aligns the orchestrator with the routes-layer convention and is a prerequisite for workstream 2 (see Considered Alternatives).

4. **Association precondition hoist** (`src/orchestration/repository-orchestrator.ts`) — an explicit `project.Repositories.includes(repositoryId)` check above the delete loop, so no clone folder is removed for a repository the project does not list.

5. **GUI confirmation-text correction** (`gui/public/js/views/project-detail.js`) — the Remove-repository confirm states on-disk clone deletion, matching the wording precedent already used for workspace deletion at L523.

6. **Test-parity and documentation** — the missing `credentialOptions(id)` no-auto-match case, plus the manifest sweep obliged by `AGENTS.md` §2.

Workstreams 2 and 3 are coupled (3 must land first or with 2). Workstreams 1, 4, 5, 6 are independent of each other; 4, 5 and 6 depend on 2/3 only for their content, not their mechanism.

## Rationale

**Why unify the unlink path rather than document the divergence.** Two code paths remove a repository from a project and they behave differently: one deletes clone folders under a two-layer path guard and emits an audit entry, the other updates a JSON record. The GUI uses the weaker one. Documenting that as intentional would make a latent data-hygiene defect permanent and would mean the audit trail added by rework-1 WP-005 — whose explicit purpose was closing the OWASP A09 gap on the system's most destructive operation — never fires on the path users actually click. The orchestrator method already exists, is already tested, and is already wired into the sibling route group; using it removes code rather than adding it.

**Why the regeneration boundary must move.** Rework-1 established that no audit entry is written if `regenerateProject()` throws, so an incomplete operation never gets a misleading success line. That rule is correct in intent but attached to the wrong event. The audited event — "repository unlinked and clone folders removed" — completes at `projectManager.removeRepository()`. Artefact regeneration is downstream reconciliation that every other caller in the codebase already treats as best-effort. Under the current coupling, a transient index-file write failure **erases the audit record of a filesystem deletion that genuinely happened**, which is the worse failure mode for an audit trail by exactly the standard that motivated building it. Moving the boundary also resolves the otherwise-irreconcilable conflict with the route's tested 204-on-artefact-failure contract without a flag argument or a typed-error workaround.

**Why module-specifier detection.** The synthesis asks for dynamic-`import()` detection. Adding a regex for that shape leaves namespace imports, default imports and `require()` — the project compiles to CommonJS, so `require` is reachable — still undetected, and invites a third rework cycle for the next shape. Matching the module specifier asks the question the choke point actually cares about ("does this file reach into the guarded modules at all?") instead of enumerating syntaxes. Research confirmed zero production violations of any form today, so this is guard-strength work with no migration burden.

**Why hoist the association check.** It is currently enforced only as a side effect of `projectManager.removeRepository()`, which runs *after* the delete loop. Today the sole caller pre-filters, so it is unreachable; workstream 2 adds a second caller, which is precisely when "safe by caller discipline" stops being safe. Validating before destructive I/O is the rule the two-layer path guard already follows.

**Why correct the GUI text.** The confirm currently reads *"The repository itself is not deleted"*, which is true under both designs and silent about clone folders under either. After workstream 2 the action becomes destructive on disk; the codebase already has the right wording pattern 220 lines below it.

## Considered Alternatives

| Decision | Chosen Shape | Alternatives Considered | Trade-Off Summary |
|----------|--------------|-------------------------|-------------------|
| Project-level unlink behaviour | Route delegates to `RepositoryOrchestrator.removeRepositoryFromProject()` | (a) Document the divergence as intentional, per the synthesis's framing; (b) keep the route's own implementation and add only an audit-entry emission to it | (a) freezes orphaned clones as designed behaviour and leaves the audit trail dark on the path users click; (b) creates a third partial copy of a lifecycle mutation and still omits clone deletion and the path guards. Delegation deletes the duplicate rather than extending it. |
| Artefact-regeneration failure boundary | Best-effort inside the orchestrator: caught, `Severity: 'warning'` logged, audit entry still emitted | (a) Keep the orchestrator fail-hard and have the route catch everything, mapping artefact failure to 204 by string-matching the error; (b) add an `ArtefactRegenerationError` type the route catches selectively; (c) add a `bestEffortArtefacts: boolean` option parameter | (a) is unreliable and couples the route to error-message text; (b) works but adds a type solely to preserve a boundary that is itself mis-placed, and still loses the audit entry; (c) is a flag argument producing two behaviours from one method. Moving the boundary makes both callers agree on one semantic and matches the convention `logArtifactWarning()` already encodes three times over. |
| Choke-point scan detection strategy | Module-specifier match across all import forms | (a) Add a dynamic-`import()` regex, as the synthesis literally requests; (b) add regexes per bypass shape (namespace, default, `require`, dynamic); (c) replace regex scanning with TypeScript AST parsing via the compiler API | (a) closes one of four known bypasses; (b) is four regexes that must be kept in sync and still enumerates syntaxes; (c) is the most precise but pulls the TS compiler API into a source-scan test for a guard with zero current violations — disproportionate. Specifier matching closes all four shapes with one pattern. |
| Association precondition | Explicit `Repositories.includes()` check hoisted above the delete loop in the orchestrator | (a) Leave it to `projectManager.removeRepository()`'s post-loop throw; (b) check it only at the route | (a) deletes clone folders for an unlisted repository before throwing, and becomes genuinely reachable once a second caller exists; (b) protects one caller and leaves the orchestrator's own contract dependent on caller discipline. The route check (step 4) is for precise 404 mapping; the orchestrator check is the invariant. |
| Delete-path lexical guard | Preserve the existing bespoke strict-descendant check | Substitute the shared `isLexicallyContained()` from `src/utils/path-guard.ts` | Per insight `d20f3cea`, the shared helper permits equality with the root, which a delete guard must reject. Reuse here would reintroduce the exact hazard rework-1 documented. Left unchanged deliberately. |

## Pattern Alignment

- **Follows** — orchestrators own lifecycle mutations, routes delegate: `src/server/routes/repositories.ts` (L397–L412) and `src/server/index.ts` (L150). Step 4 makes the project route conform to the pattern its sibling already follows.
- **Follows** — route-level precondition checks so orchestrator throws are not misclassified: `src/server/routes/repositories.ts` (L397–L405), which documents exactly this reasoning for `deleteRepositoryGlobally()`'s plain-`Error` not-found throw.
- **Follows** — best-effort artefact reconciliation logged at `Severity: 'warning'` / `Source: 'workspace-index'`: `src/server/routes/projects.ts` (L55–L82), `src/server/routes/repositories.ts` (L101–L118). Step 5 extends the same convention into the orchestration layer, which was its sole holdout.
- **Follows** — guard the mechanism itself with synthetic fixtures rather than relying on a vacuous real-world case: `src/tests/workspace-artifacts-chokepoint.test.ts` (L143+), the pattern rework-1's WP-003 review flagged as a gold nugget. Step 2 extends it with one synthetic fixture per newly-detected import shape.
- **Follows** — shared helpers over duplicated regex in the choke-point scan: `extractImportBlocks()` / `importsAnyIdentifier()` (L76–L99), introduced so the main scan and the allowlist check cannot drift. Step 2 keeps both tests driven by one detection function.
- **Follows** — destructive confirmations state on-disk consequences: `gui/public/js/views/project-detail.js` (L523), the workspace-delete confirm. Step 7 brings the repository-remove confirm to the same standard.
- **Follows** — temp-file tests register `process.on('exit')` cleanup (`AGENTS.md` §4). Applies to the new synthetic fixtures in step 2.
- **Departs** — `removeRepositoryFromProject()` stops treating an artefact-regeneration failure as fatal, inverting a boundary rework-1 deliberately established and tested (`src/tests/repository-orchestrator.test.ts` L486–L517). Justified in Rationale: the audited event completes before regeneration, and preserving the record of a completed destruction outranks suppressing a success line for a cosmetic downstream failure. The existing test is **inverted, not deleted**, so the new boundary is asserted as explicitly as the old one was.

## Structural Improvements

| Structure | Observation | Decision | Reason |
|-----------|-------------|----------|--------|
| `src/server/routes/projects.ts` (L386–L409) | Implements the data-record half of a lifecycle mutation that `RepositoryOrchestrator.removeRepositoryFromProject()` owns completely; omits clone deletion, path guards, and the audit entry | Promoted to step 4 | Duplicate partial implementation of an existing orchestrator method, producing orphaned clones on the path the GUI uses. Delegation removes the duplicate. |
| `src/orchestration/repository-orchestrator.ts` (L271–L283) | Audit entry is coupled to the success of downstream artefact regeneration, so a transient index-write failure erases the record of a completed destructive operation | Promoted to step 5 | Directly inside the blast radius of step 4, and a prerequisite for it — the two layers' failure contracts are otherwise mutually exclusive. |
| `src/orchestration/repository-orchestrator.ts` (L223–L268) | Repository–project association is confirmed only after every clone folder has been deleted, via `projectManager.removeRepository()`'s post-loop throw | Promoted to step 3 | Validation on the wrong side of destructive I/O; unreachable today only by caller discipline, which step 4 ends by adding a second caller. |
| `src/tests/workspace-artifacts-chokepoint.test.ts` (L76–L99) | `extractImportBlocks()` matches static named-import clauses only; namespace, dynamic, default and `require` forms reach the guarded functions undetected | Promoted to step 2 | The guard's stated purpose is that nothing outside the choke point reaches these functions; it currently enforces that for one of four syntaxes. |
| `src/tests/workspace-artifacts-chokepoint.test.ts` (L101–L120) | Main scan re-implements the identifier loop inline rather than calling `importsAnyIdentifier()`, to produce per-identifier offender messages | Rejected | Rework-1's Reviewer assessed this as deliberate, justified duplication serving message quality. Step 2 keeps both tests on one shared detection function, which removes the drift risk without collapsing the message-formatting difference. |
| `gui/public/js/views/project-detail.js` (L283–L306) | Confirm text *"The repository itself is not deleted"* does not describe clone-folder disposition, and becomes actively misleading once step 4 makes the action destructive on disk | Promoted to step 7 | Inside the blast radius of step 4; a silent destructive change is not an acceptable end state. |
| `docs/agents/project-manifest/data-flows.md` (L345) | The "Excluded from this audit trail" paragraph documents a scope boundary of a hardening pass that has since ended, and step 4 removes the exclusion entirely | Promoted to step 9 | Obliged by `AGENTS.md` §2 (data flow changed → `data-flows.md`); the paragraph must be rewritten rather than amended. |
| `docs/agents/project-manifest/data-flows.md` (L307–L330) | The §15 cascade diagram encodes the ordering and completion rule a third time, in ASCII, independently of the L341 and L345 prose — it shows the audit entry gated on regeneration succeeding and omits the association check entirely | Promoted to step 9 | Same `AGENTS.md` §2 obligation; leaving the diagram behind would make it contradict the two paragraphs it sits between. |
| `docs/agents/project-manifest/api-surface.md` (L439–L446) | The `RepositoryOrchestrator` audit-trail note states the completion boundary step 4 inverts, and the signature/guard notes predate the association precondition step 3 adds | Promoted to step 9 | Obliged by `AGENTS.md` §2 (exported method contract changed → `api-surface.md`); scoping this file to the `registerProjectRoutes()` signature alone would leave a positively false contract statement in the manifest. |
| `gui/public/js/api.js` (L190–L201) `credentialOptions(id)` | Production code is correct and defensively coerces a missing `credentials` array; only its test set is asymmetric with `credentialOptionsForUrl` | Rejected (production change); test promoted to step 8 | No defect in the implementation — the gap is coverage only. Changing working production code for symmetry's sake would be unfunded churn. |
| `src/utils/path-guard.ts` | `isLexicallyContained()`'s equality-permitting contract differs from the delete path's strict-descendant requirement | Rejected | Per insight `d20f3cea`, this divergence is correct and deliberate. Harmonising the two contracts would either weaken the delete guard or break the writer path. Documented, not changed. |
| `src/error-log/error-log.manager.ts` (L62–L90) | `Severity: 'audit'` entries share the rolling-window trim (`maxErrorLogEntries`) with routine entries, so a burst of routine logging can evict audit records | Rejected — recorded in Deferred Items | A retention-policy decision, not an implementation gap: separate audit store, separate quota, or exempt-from-trim are materially different products. Outside the blast radius of this plan's changes. |

## Detailed Steps

1. **Extend the choke-point scan's detection to module specifiers.** In `src/tests/workspace-artifacts-chokepoint.test.ts`, add a `GUARDED_MODULE_SPECIFIERS` constant naming the two guarded modules' import specifiers (`workspace-index.js`, `vscode-workspace.js` — the `.js` extension is mandatory under Node16 ESM, per `AGENTS.md` §4). Replace `extractImportBlocks()` with a `referencesGuardedModule(content)` detection function that matches a guarded specifier inside any of: a static `import … from '…'` clause (named, namespace, default, or side-effect), a dynamic `import('…')` call, and a `require('…')` call. Keep it as a single shared function consumed by both the main scan and the allowlist-entry check, preserving the existing no-drift property. Retain the identifier-level match as a secondary pass used only to enrich the offender message (`"imports X"` where an identifier is determinable, `"references module Y"` otherwise); the specifier match alone gates the assertion. `listSourceFiles()`, `CHOKE_POINT_MODULE`, `TEMPORARY_EXCEPTIONS`, and the `__dirname`-based `src/` resolution are unchanged.

2. **Add synthetic-fixture coverage for each newly-detected import shape.** Extend the existing temp-dir fixture block (`src/tests/workspace-artifacts-chokepoint.test.ts` L143+) with one case per bypass shape — namespace import, dynamic `await import()`, default import, and `require()` — each asserting `referencesGuardedModule()` returns `true`, plus a negative case asserting a file importing an unrelated module returns `false`. Register a `process.on('exit')` cleanup handler for every temp directory created (`AGENTS.md` §4). Update the allowlist-entry validity test's failure message to speak of "references a guarded module" rather than "imports a guarded identifier".

3. **Hoist the association precondition in `removeRepositoryFromProject()`.** In `src/orchestration/repository-orchestrator.ts`, immediately after the existing project-existence check (L224–L229) and before the per-workspace delete loop, add an explicit `project.Repositories.includes(repositoryId)` check that throws with the same message wording `projectManager.removeRepository()` uses (`Repository "X" is not listed in project "Y".`), so no existing assertion on that text breaks. Leave the two-layer path guard (L244–L261) exactly as it is — in particular do not substitute `isLexicallyContained()` for the bespoke strict-descendant check, per insight `d20f3cea`. Update the method's JSDoc `@throws` list to state the precondition is now checked before any deletion.

4. **Move the artefact-regeneration failure boundary in the orchestrator.** In `src/orchestration/repository-orchestrator.ts`, wrap the `this.workspaceArtifacts.regenerateProject(projectId)` call (L271–L273) in `try/catch`. On failure, emit a `Severity: 'warning'`, `Source: 'workspace-index'`, `Operation: 'unlink-repository'` entry via the already-injected `this.errorLogManager?` carrying the project ID and the error message, and continue. The `unlink-repository` audit entry (L276–L283) is then emitted unconditionally once the data mutation has succeeded. Update the method JSDoc's completion-boundary paragraph to state the new rule: the audit entry is bound to the completion of the data and filesystem mutations, and a regeneration failure produces an additional warning entry rather than suppressing the audit entry. Verify `deleteRepositoryGlobally()` (L306+) still behaves correctly under the new boundary — its own `delete-repository-global` summary entry remains gated on `repositoryManager.remove()` succeeding.

5. **Route the project-level unlink handler through the orchestrator.** In `src/server/routes/projects.ts`, add a `repositoryOrchestrator: RepositoryOrchestrator` parameter to `registerProjectRoutes()` (with a JSDoc block matching the style of the `workspaceArtifacts` parameter's) and import its type. Rewrite the `DELETE /api/projects/:id/repositories/:repoId` handler (L386–L409) to: (a) resolve the project via `projectManager.getById()` and respond 404 when absent; (b) respond 404 when `project.Repositories` does not include `params['repoId']`, preserving the existing message wording; (c) call `repositoryOrchestrator.removeRepositoryFromProject(projectId, repoId)` inside a `try/catch` that maps any remaining throw — which after (a) and (b) can only be a path-guard failure — to **500**, not 404; (d) respond 204 on success. The route no longer calls `workspaceArtifacts.regenerateProject()` or `logArtifactWarning()` for this handler, since the orchestrator now owns both; leave `logArtifactWarning()` and its other four call sites untouched. Update the route-table JSDoc at L14–L41 to reflect the new failure column (`404, 500`) and the delegation.

6. **Update the server wiring.** In `src/server/index.ts` (L151), pass the existing `repositoryOrchestrator` (constructed at L112) to `registerProjectRoutes()`. Confirm no route registration order changes (per insight `c95184f8`, no new routes are added and none are reordered).

7. **Correct the GUI confirmation text.** In `gui/public/js/views/project-detail.js` (L287–L289), replace the Remove-repository confirm body with wording that states the on-disk consequence and that the global repository record survives — following the phrasing precedent of the workspace-delete confirm at L523. Update the file-level JSDoc at L6 and L214 if it describes the Remove button's effect.

8. **Add the `credentialOptions(id)` no-auto-match parity test.** In `gui/public/js/api.config.test.mjs`, add a test mirroring `credentialOptionsForUrl`'s existing L473 case, asserting that every returned option has `auto: false` when `autoSelected` is absent **and** when `autoSelected` names an ID not present in the returned credentials. Follow the surrounding naming convention (`api.repositories.credentialOptions(id) …`) and the `{ body: … }` fetch-stub fixture shape used at L393–L400. No production change to `gui/public/js/api.js`.

9. **Sweep the manifest documentation.** Per `AGENTS.md` §2: update `docs/agents/project-manifest/rest-api.md` — the `DELETE /api/projects/:id/repositories/:repoId` row (L153) to state clone-folder deletion, the path guards, the `unlink-repository` audit entry, and the new 500 failure code; and the `DELETE /api/repositories/:id` row (L15) to cross-reference its `delete-repository-global` audit entry. In `docs/agents/project-manifest/data-flows.md`, three passages in "## 15. Global Repository Deletion Cascade" encode the pre-change rules and must all move together, or the section will contradict itself: (a) rewrite the "Excluded from this audit trail" paragraph (L345) — the exclusion no longer exists, and the project-level route now reaches the same audit-emitting code path; (b) update the completion-boundary paragraph (L341) for the new regeneration-failure rule — a throwing `regenerateProject()` no longer aborts the `unlink-repository` entry, and the "no entry on throw" claim now covers the guard failure and the data-mutation failure only; (c) update the ASCII cascade diagram (L307–L330) itself, which independently asserts the old ordering — the `# emitted ONLY after both mutations above succeed for this project` annotation at L331 must state the new boundary, the `workspaceArtifacts.regenerateProject(projectId)` line (L328) must show it as best-effort with its `Severity: 'warning'` entry on failure, and the step-3 association-precondition check must be added to the `removeRepositoryFromProject()` branch above the per-workspace guard/delete lines (L317). Update `docs/agents/project-manifest/constraints.md` (L169) for the hoisted association precondition and the moved boundary. In `docs/agents/project-manifest/api-surface.md`, update the changed `registerProjectRoutes()` signature **and** rewrite the `RepositoryOrchestrator` entry at L439–L446, whose prose states the superseded contract: the **Audit trail** note (L446) currently reads that the `unlink-repository` entry is emitted *"only after `projectManager.removeRepository()` and `workspaceArtifacts.regenerateProject()` have both succeeded, so a guard failure or a throwing regenerator never produces a misleading 'success' entry"* — it must state the new completion boundary (the entry is bound to the data and filesystem mutations; a regeneration failure adds a `Severity: 'warning'` / `Source: 'workspace-index'` entry instead of suppressing the audit entry) and note that the project-level route now shares this path; the `removeRepositoryFromProject(): void` signature line (L439) and its **two-layer delete guard** note (L444) must additionally record the hoisted association precondition from step 3 — the method throws `Repository "X" is not listed in project "Y".` before any clone folder is deleted — since the `@throws` behaviour documented here changes. Re-run `ctx generate` for `.context/**` (generated; not hand-edited).

## Dependencies

- Step 4 must land before or with step 5 — the orchestrator's fail-hard regeneration contract is incompatible with the route's tested 204-on-artefact-failure behaviour.
- Step 5 depends on step 3 (the hoisted precondition is what makes the route's 404/500 split exact) and on step 6 for wiring.
- Step 6 depends on step 5's signature change.
- Step 7 depends on step 5 — the new confirm text describes behaviour step 5 introduces.
- Step 9 depends on steps 3–7.
- Step 2 depends on step 1.
- Steps 1–2 and step 8 are independent of everything else and of each other.

## Required Components

Existing, modified:

- `src/tests/workspace-artifacts-chokepoint.test.ts`
- `src/orchestration/repository-orchestrator.ts`
- `src/server/routes/projects.ts`
- `src/server/index.ts`
- `gui/public/js/views/project-detail.js`
- `gui/public/js/api.config.test.mjs`
- `src/tests/repository-orchestrator.test.ts`
- `src/server/__tests__/routes/projects.test.ts`
- `gui/public/js/views/project-detail.remove-repository.test.mjs` — **new file**
- `docs/agents/project-manifest/rest-api.md`, `data-flows.md`, `constraints.md`, `api-surface.md`
- `.context/**` (regenerated via `ctx generate`)

No new source files, modules, external services, or dependencies are introduced.

## Assumptions

- Deleting a repository's clone folders when it is unlinked from a project is the intended behaviour — confirmed by the user in this planning session, and consistent with `RepositoryOrchestrator.removeRepositoryFromProject()` having been written to do exactly that.
- Orphaned clone folders left on disk by the current route are not depended upon by any workflow; no migration or reclamation pass is planned for pre-existing orphans.
- `ctx generate` is runnable in the execution environment (`AGENTS.md` §2 prescribes it for `.context/**`).

## Constraints

- Node16 ESM: every relative import carries a `.js` extension — a compile *and* runtime error otherwise (`AGENTS.md` §4, MUST).
- The choke-point scan runs from `dist/tests/` and resolves `src/` by walking up from `__dirname` (CommonJS output); path logic must be preserved.
- Tests creating temp files must register a `process.on('exit')` cleanup handler (`AGENTS.md` §4, MUST).
- New exported types must be type-audited against this plan before a work package is marked complete (`AGENTS.md` §4, MUST).
- GUI tests are `.mjs` executed by the Node test runner against vanilla-JS sources — no build step.
- The full suite must remain at or above the 1110-test floor established by rework-1, with `npx tsc --noEmit` and `npm run build` clean.

## Out of Scope

- Any change to `src/utils/path-guard.ts` or to the two-layer delete guard's contract.
- Audit-log retention and durability policy (see Deferred Items).
- TOCTOU hardening of the delete path (see Deferred Items).
- A reclamation or cleanup pass for clone folders already orphaned by the current route's behaviour.
- The `credentialOptions(id)` production implementation in `gui/public/js/api.js` — test coverage only.
- Adding audit entries to any mutation path other than repository unlink and global delete.
- Replacing the choke-point scan's regex approach with TypeScript AST parsing.

## Acceptance Criteria

- AC-01: The choke-point scan detects a reference to `workspace-index.js` or `vscode-workspace.js` from a production module outside the choke point in all of: static named import, namespace import, default import, side-effect import, dynamic `import()`, and `require()`.
- AC-02: Both the main choke-point scan and the allowlist-entry validity check are driven by the same shared detection function, with no second copy of the specifier-matching logic.
- AC-03: The choke-point scan reports zero offenders against the current `src/` tree, and `TEMPORARY_EXCEPTIONS` remains empty.
- AC-04: `removeRepositoryFromProject()` throws, and deletes no clone folder, when the repository is not listed in the project — verified by a test that asserts the folder still exists after the throw.
- AC-05: `removeRepositoryFromProject()` emits its `unlink-repository` audit entry when the data and filesystem mutations succeed but `workspaceArtifacts.regenerateProject()` throws, and additionally emits a `Severity: 'warning'`, `Source: 'workspace-index'` entry describing the regeneration failure.
- AC-06: `removeRepositoryFromProject()` still emits no audit entry when the path guard rejects a clone path, and still throws in that case.
- AC-07: `DELETE /api/projects/:id/repositories/:repoId` deletes the repository's clone folders from every workspace of the project.
- AC-08: That route emits an `unlink-repository` audit entry on success.
- AC-09: That route returns 404 for an unknown project and 404 for a repository not linked to the project, with no filesystem mutation in either case.
- AC-10: That route returns 500 (not 404) when the orchestrator's path guard rejects a clone path.
- AC-11: That route returns 204 when the artefact regeneration fails after the mutations succeeded, and a `Severity: 'warning'` entry is recorded.
- AC-12: `DELETE /api/repositories/:id` (global delete) behaviour, including its `delete-repository-global` summary entry and its gating on `repositoryManager.remove()`, is unchanged.
- AC-13: The GUI Remove-repository confirmation states that the repository's cloned folders are deleted from disk and that the repository record itself is retained.
- AC-14: `api.repositories.credentialOptions(id)` marks no option as `auto` when `autoSelected` is absent, and none when `autoSelected` names an ID not present in the returned credentials.
- AC-15: `rest-api.md`, `data-flows.md`, `constraints.md`, and `api-surface.md` reflect the new unlink behaviour, the audit-entry coverage, the 500 failure code, the moved regeneration boundary, the hoisted association precondition, and the changed `registerProjectRoutes()` signature; no surviving passage in any of them asserts the superseded contract — specifically, `data-flows.md`'s §15 ASCII diagram agrees with the prose beside it, and `api-surface.md`'s `RepositoryOrchestrator` audit-trail note (L446) no longer states that the `unlink-repository` entry requires `regenerateProject()` to have succeeded; `.context/**` is regenerated.
- AC-16: `npx tsc --noEmit` and `npm run build` are clean, and the full suite passes at or above 1110 tests with zero failures.

## Testing Strategy

Four layers, each matching where the behaviour lives. Source-level static-scan tests cover the choke-point guard, exercised through synthetic temp-dir fixtures so the detection mechanism is proven to fire rather than merely running against a clean tree. Orchestration-layer integration tests cover `removeRepositoryFromProject()` against a real temp filesystem, asserting both the throw and the absence of filesystem side effects for rejected preconditions. Route-layer tests use the existing `src/server/__tests__/routes/projects.test.ts` harness with a fake `RepositoryOrchestrator` to assert status-code mapping and delegation. GUI tests run as `.mjs` under the Node test runner against the vanilla-JS sources. Two existing tests change meaning and are inverted with their new expectation asserted explicitly, not deleted.

## Test Plan

- `src/tests/workspace-artifacts-chokepoint.test.ts` — `referencesGuardedModule()` returns `true` for a synthetic file using a **namespace import** of `workspace-index.js` — AC-01
- `src/tests/workspace-artifacts-chokepoint.test.ts` — returns `true` for a synthetic file using a **dynamic `await import()`** of `vscode-workspace.js` — AC-01
- `src/tests/workspace-artifacts-chokepoint.test.ts` — returns `true` for a synthetic file using a **default import** and one using a **side-effect import** of a guarded module — AC-01
- `src/tests/workspace-artifacts-chokepoint.test.ts` — returns `true` for a synthetic file using **`require()`** of a guarded module — AC-01
- `src/tests/workspace-artifacts-chokepoint.test.ts` — returns `false` for a synthetic file importing an unrelated module (negative control, guards against a match-everything regression) — AC-01
- `src/tests/workspace-artifacts-chokepoint.test.ts` — existing `no production module outside the choke-point …` test, re-run under specifier detection, still reports zero offenders — AC-03
- `src/tests/workspace-artifacts-chokepoint.test.ts` — existing allowlist-entry validity test passes with the shared detection function and updated message — AC-02, AC-03
- `src/tests/repository-orchestrator.test.ts` — `removeRepositoryFromProject` throws and leaves clone folders intact when the repository is not listed in the project — AC-04
- `src/tests/repository-orchestrator.test.ts` — **inverted** from `suppresses the audit entry when the artefact regenerator throws` (L486) to: emits the `unlink-repository` audit entry **and** a `Severity: 'warning'` / `Source: 'workspace-index'` entry when the regenerator throws — AC-05
- `src/tests/repository-orchestrator.test.ts` — existing `suppresses the audit entry when the path guard rejects the clone path` (L455) passes unchanged — AC-06
- `src/tests/repository-orchestrator.test.ts` — existing `deleteRepositoryGlobally` cascade and summary-entry tests pass unchanged — AC-12
- `src/server/__tests__/routes/projects.test.ts` — `DELETE /api/projects/:id/repositories/:repoId` delegates to `repositoryOrchestrator.removeRepositoryFromProject()` with the correct arguments and returns 204 — AC-07, AC-08
- `src/server/__tests__/routes/projects.test.ts` — **updated** from the existing L596/L607 cases: returns 404 for an unknown project and 404 for an unlinked repository, with the orchestrator **not** called in either case — AC-09
- `src/server/__tests__/routes/projects.test.ts` — returns 500 when the fake orchestrator throws a path-guard-style error — AC-10
- `src/server/__tests__/routes/projects.test.ts` — **replaces** the existing L630 `AC-20` case: returns 204 and records a warning when regeneration fails inside the orchestrator (fake orchestrator succeeds while emitting the warning) — AC-11
- `src/server/__tests__/routes/projects.test.ts` — a multi-workspace project (via `makeProject(…, ['STABLE', 'DEV'])`, L49) unlinks from every workspace — AC-07
- `src/server/__tests__/routes/repositories.test.ts` — existing `DELETE /api/repositories/:id` tests pass unchanged — AC-12
- `gui/public/js/views/project-detail.remove-repository.test.mjs` (**new file** — verified that no `project-detail` test module exists today; name follows the established `workspace-detail.<topic>.test.mjs` convention, structure follows `repository-detail.test.mjs`) — the Remove-repository confirmation body states on-disk clone deletion and that the repository record is retained — AC-13
- `gui/public/js/api.config.test.mjs` — `api.repositories.credentialOptions(id)` marks no option as auto when `autoSelected` is absent — AC-14
- `gui/public/js/api.config.test.mjs` — `api.repositories.credentialOptions(id)` marks no option as auto when `autoSelected` names an ID absent from the returned credentials — AC-14
- Documentation verification pass (manual review against `AGENTS.md` §2's change→document mapping) — each artefact listed in Documentation Updates reflects the shipped behaviour, `rest-api.md`'s failure column for the unlink route reads `404, 500`, `data-flows.md` contains no surviving "Excluded from this audit trail" claim and its §15 diagram no longer carries the `emitted ONLY after both mutations above succeed` annotation, `api-surface.md`'s L446 audit-trail note no longer conditions the `unlink-repository` entry on `regenerateProject()` succeeding, and `ctx generate` has been re-run with `.context/**` diffs committed — AC-15
- Full-suite gate — `npx tsc --noEmit`, `npm run build`, `node --test` at or above 1110 passing, zero failures — AC-16

## Documentation Updates

- `docs/agents/project-manifest/rest-api.md` (L153) — the `DELETE /api/projects/:id/repositories/:repoId` row: clone-folder deletion, two-layer path guard, `unlink-repository` audit entry, failure column becomes `404, 500`
- `docs/agents/project-manifest/rest-api.md` (L15) — the `DELETE /api/repositories/:id` row: cross-reference the `delete-repository-global` audit entry and the per-project `unlink-repository` cascade entries
- `docs/agents/project-manifest/data-flows.md` (L345) — rewrite the "Excluded from this audit trail" paragraph; the exclusion no longer exists
- `docs/agents/project-manifest/data-flows.md` (L341) — update the completion-boundary paragraph for the moved regeneration-failure rule
- `docs/agents/project-manifest/data-flows.md` (L307–L330) — the "## 15. Global Repository Deletion Cascade" ASCII diagram, which encodes the pre-change ordering independently of the two paragraphs above: the `# emitted ONLY after both mutations above succeed` annotation (L331), the `regenerateProject(projectId)` line (L328) becoming best-effort with its warning entry, and the step-3 association-precondition check added above the per-workspace guard/delete branch (L317)
- `docs/agents/project-manifest/constraints.md` (L169) — the hoisted association precondition and the new audit-entry boundary
- `docs/agents/project-manifest/api-surface.md` — the changed `registerProjectRoutes()` signature
- `docs/agents/project-manifest/api-surface.md` (L439–L446) — the `RepositoryOrchestrator` entry: the **Audit trail** note (L446) states the superseded "only after … `regenerateProject()` … have both succeeded" contract and must be rewritten for the new completion boundary and the warning entry; the `removeRepositoryFromProject()` signature line (L439) and the **two-layer delete guard** note (L444) must record the hoisted association precondition and the `@throws` behaviour it changes — the method now raises `Repository "X" is not listed in project "Y".` before any clone folder is deleted
- `.context/**` — regenerate via `ctx generate` (generated artefacts; not hand-edited)
- `README.md` — only if it describes the repository-remove behaviour; verify before editing

## Deferred Items

| # | Deferred Item | Origin | Reason Deferred | Notes |
|---|---------------|--------|-----------------|-------|
| 1 | TOCTOU window between the realpath guard check and `fs.rmSync()` in `removeRepositoryFromProject()` | rework-1 synthesis, WP-005 / Security Auditor | Not closable without fd-based removal (`openat`-style directory handles), which Node's `fs` API does not expose portably. Mitigated in practice by Node not following leaf symlinks during recursive removal, experimentally confirmed in rework-1. | Reconsider if Node gains a portable fd-relative removal API, or if the threat model admits a local attacker racing the server process. |
| 2 | `Severity: 'audit'` entries share the rolling-window trim (`maxErrorLogEntries`) with routine entries, with no durability guarantee | rework-1 synthesis, WP-005 / Security Auditor | A retention-policy decision rather than an implementation gap — a separate audit store, a separate quota, or trim-exemption are materially different products with different operational costs. Outside this plan's blast radius. | Becomes load-bearing if compliance requirements tighten, or once audit entries cover more mutation paths than the two that emit them today. Note this plan *increases* audit-entry volume (step 4 adds the route path), which brings the eviction risk marginally closer. |
| 3 | `removeRepositoryFromProject()` validates the path guard before confirming the repository–project association | rework-1 synthesis, WP-005 / Security Auditor | **Promoted** — see step 3 and AC-04. Listed here only to record its disposition. | — |
| 4 | Choke-point scan detects static `import { … }` clauses only; dynamic-import bypass undetected | rework-1 synthesis, WP-003 / QA | **Promoted and widened** — see steps 1–2 and AC-01. Listed here only to record its disposition. | — |
| 5 | `credentialOptions(id)` lacks a no-auto-match test case | rework-1 synthesis, WP-001 / QA | **Promoted** — see step 8 and AC-14. Listed here only to record its disposition. | — |
| 6 | `rest-api.md` does not cross-reference the audit-trail asymmetry | rework-1 synthesis, WP-006 / Documentation | **Promoted and superseded** — the asymmetry is eliminated by steps 4–6 rather than documented; `rest-api.md` is updated in step 9 to describe the unified behaviour. | — |
| 7 | WP-001's acceptance criterion "`gui/public/js/api.js` is unmodified" could not be satisfied literally due to a pre-existing uncommitted working-tree diff | rework-1 synthesis, WP-001 / Developer (project comment) | Informational only — no code work exists to plan. Recorded so it is not lost. | Guidance for future plans: phrase negative acceptance criteria as "this work package makes no change to X" rather than "X is unmodified", which a pre-existing working-tree diff can falsify. |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Unlinking a repository now deletes clone folders — a behaviour change users may not expect.** Uncommitted work inside a clone would be lost. | Step 7 states the consequence in the confirmation dialog before the action, matching the workspace-delete precedent. The action was already destructive in intent (the repository disappears from the project and all generated artefacts); it simply left debris. The global repository record is untouched, so re-adding and re-cloning is a two-click recovery. |
| **Inverting the regeneration-failure boundary reverses a decision rework-1 made deliberately and had reviewed.** | The reversal is argued explicitly in Rationale and Pattern Alignment, is confined to `removeRepositoryFromProject()`, and leaves the path-guard suppression rule (AC-06) and `deleteRepositoryGlobally()`'s summary gating (AC-12) intact. The existing test is inverted with its new expectation asserted as explicitly as the old one, so the boundary remains a stated contract rather than an implicit one. |
| **Route-layer 404/500 mapping could regress**, misclassifying a path-guard failure as a not-found. | Preconditions are checked at the route before the orchestrator call (step 5a/5b), following the precedent documented at `src/server/routes/repositories.ts` L397–L405. AC-09 and AC-10 assert both sides of the split, and AC-09 additionally asserts no filesystem mutation occurs on the 404 paths. |
| **Module-specifier matching could over-match**, e.g. flagging a comment or an unrelated file whose name contains the specifier. | Detection matches specifiers only inside import/require syntactic forms, never bare text. The negative-control fixture in step 2 asserts an unrelated import returns `false`, and AC-03 requires zero offenders against the real `src/` tree — an over-matching regex fails that assertion immediately. |
| **The `projects.test.ts` harness needs a fake `RepositoryOrchestrator`**, and a poorly-shaped fake could let the route's real behaviour drift untested. | The fake asserts on call arguments (AC-07/AC-08) rather than merely absorbing the call, and the orchestrator's own behaviour is covered independently by the integration tests in `src/tests/repository-orchestrator.test.ts` against a real temp filesystem. |
| **Existing orphaned clone folders remain on disk** from the route's previous behaviour and are not reclaimed. | Explicitly out of scope and stated as such. They are inert directories; the fix stops producing new ones. A reclamation pass can be planned separately if the volume proves material. |

## Recommended Workflow

- **Workflow:** ledger
- **Rationale:** The plan spans four layers (test-infrastructure, orchestration, server routes, GUI) with a security-relevant delete path, a deliberate reversal of a previously-reviewed audit boundary, and a user-visible destructive behaviour change — all of which warrant the formal QA, security-audit, and code-review stages.
