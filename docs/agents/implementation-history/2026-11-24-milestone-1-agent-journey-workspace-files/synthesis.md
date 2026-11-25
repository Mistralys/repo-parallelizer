# Synthesis: Milestone 1 - Agent Journey Workspace Files

### Outcome Summary

Delivered all 18 work packages: AGENTS.md gained scoped agent directive text, CLI examples and a derived sibling-workspaces table, while README.md stayed byte-identical to its golden baseline. Owner-defined project and workspace directives plus per-repository role text are now stored in the data model and exposed through REST, the CLI (regenerate, directives, repo-roles) and the GUI, with generated-marker neutralisation protecting the generated files. The one failure in the run was a prototype-pollution defect in directive workspace lookup, caught by QA and fixed in rework; other unguarded workspace lookups in ProjectManager remain as debt.

### Metrics

- Work packages: 18 of 18 COMPLETE; every active pipeline stage passed (pipeline health: 0 missing stages).
- Rework: one cycle, on WP-010 (QA FAIL, then implementation fix, then QA PASS).
- Final test run (WP-018 QA): `npm test` 1760 tests, 1758 pass, 0 fail, 2 skipped; `npm run test:gui` 589 pass, 0 fail.
- Test growth over the project: 1657 tests at WP-001 to 1760 at WP-018.
- Security audits: 12 WPs audited, 0 security issues at sign-off (one High defect found earlier by QA on WP-010, fixed before audit).
- Code review: 0 blocking issues across all WPs; one reviewer-applied comment-only fix each on WP-004 and WP-007.
- Coverage percentage was not reported by any pipeline.
- Release state: `package.json` and `package-lock.json` at 1.8.0, CHANGELOG `v1.8.0 - WIP; UNRELEASED` covering all phases. No tagging or publishing was done.

### Failed Metrics and Blockers

- WP-010 QA FAIL (high): `resolveDirectiveScope` used an unguarded `project.Workspaces[workspaceId]` lookup, so `__proto__`, `constructor` or `toString` resolved to inherited members and polluted `Object.prototype`. Fixed with an own-property check and a regression test; re-QA and security audit passed.
- No other failures, blockers or open security findings.

### Strategic Recommendations

- Generation stays a pure function of the stored model. Model, validator and renderer are separate layers, and every new field is optional, so unchanged inputs give unchanged output. This is why the golden oracles held.
- Golden oracles worked well. Capture the baseline before any renderer change (WP-001), retire it once its text changes (AGENTS baseline in WP-004), and snapshot reviewed output after the next phase (postB). `capture-golden.ts` is table-driven, so a `postC` target costs one entry.
- Put safety rules in one shared utility (`src/utils/single-paragraph-text.ts`) instead of copying them into the renderer and validators. User text embedded in generated files must pass through `neutraliseGeneratedMarkers`.
- A required, explicit `scope` argument on directive methods turns an undefined route parameter into a validation error instead of a silent edit of project-wide rules.
- Index-only refresh (`refreshProjectIndexes`) with per-workspace isolation is the right primitive for sibling, directive and role changes. It avoids the repeated repository-info syncs and abort-on-first-failure behaviour of `regenerateProject()`.
- QA edge-case probing paid for itself: it found the prototype-pollution defect that the unit tests and acceptance criteria did not cover.

### Code Insights

**Developer**
- WP-002: the orchestrator constructor takes six positional arguments, several optional; an options object would make wiring gaps (the original missing `repositoryFileManager`) harder to introduce.
- WP-003: `GENERATED_BEGIN_MARKER` and `GENERATED_END_MARKER` are literals duplicating `GENERATED_MARKER_TOKEN`; deriving them from the token would guarantee the invariant by construction (currently test-guarded).
- WP-005, WP-015: `runCustomFilesCliCommand`, `runRepoFilesCliCommand`, `runRegenerateCliCommand` and the other runner wrappers in `src/index.ts`, plus the deps factories and sync/report helpers across CLI modules, are near-duplicates that could share one helper.
- WP-007: repository resolution is duplicated between `regenerateWorkspace` and `refreshProjectIndexes`.
- WP-008: the route-local and orchestrator refresh helpers duplicate logic; `logArtifactWarning`'s message text ("Failed to update workspace artefacts after ...") reads oddly for `refresh-siblings`.
- WP-010: other `project.Workspaces[id]` lookups (`updateWorkspace`, `renameWorkspace`, `removeWorkspace`, `getById`) remain unguarded against inherited keys.
- WP-013: duplicate single-string-field body readers in `projects.ts` and `workspaces.ts` should move to `requestUtils`.
- WP-016, WP-017: GUI API delete naming is inconsistent (`customFiles.delete` vs `files.remove` and `directives.remove`); `workspace-directives.js` imports its limit constants from the project view and duplicates loading scaffolding.
- WP-018: `normaliseProject` in the GUI drops `RepositoryRoles`, `CustomFiles` and directives, so views read the raw project object.

**QA**
- WP-001: `--check` mode of the capture script was verified manually only.
- WP-002: the T-11 wiring test is a source regex that depends on cwd being the repo root and on argument-per-line formatting.
- WP-006: rename exclusion compares workspace metadata JSON; an explicit old-ID override would be sturdier.
- WP-008: `errorLogManager.append` inside the orchestrator helper's catch could itself throw; untested.
- WP-010: update and remove are not covered for inherited IDs in the regression test.
- WP-012: a directive that starts with Markdown block syntax renders inside the bullet; harmless and unpinned by tests.
- WP-014, WP-015, WP-017, WP-018: minor coverage gaps (`--text` with `--stdin`, over-length role text, whitespace-only role clearing, workspace update/delete paths in the GUI test).

**Security Auditor**
- No Critical, High or Medium findings at any sign-off. Low observations: unguarded `Workspaces[id]` lookups in pre-existing methods, Unicode line separators in single-paragraph text, and a pre-existing unvalidated project id in `projectFilePath`.

**Reviewer**
- WP-003: `collapseToSingleLine` yields multiple spaces for blank-line runs (untested, harmless).
- WP-010: add a shared own-property getter before HTTP and CLI routes accept user-supplied IDs.
- WP-011: empty-map pruning is duplicated in `removeRepository` and `setRepositoryRole`.

**Release Engineer**
- The last git tag is 1.5.0 while the changelog lists v1.6.0 and v1.7.0 as released; confirm they were actually released and tag them.
- The changelog holds 14 releases; the curator recommends an archive session for old v0.x entries and a rewrite pass at finalisation.
- WP-018 QA noted `REST:` and `Tests:` bullet prefixes beyond the stated house style.

**Documentation**
- `gui-frontend.md` still says project detail has three tabs and its route row omits the Directives tab; the Directives tab entry lacks a cross-reference to the Workspace directives section.
- `data-flows.md` section 13 and section 5 diagrams omit index-context derivation and the sibling refresh step.
- `api-surface.md` WorkspaceOrchestrator rename/delete entries do not mention the last-step refresh; `removeRepository()` does not note the role cleanup; `repositoryFileManager` wording is easily confused between orchestrators.
- `rest-api.md` does not document the directive record response shape; the README has no short `repo-roles` example.

### Deferred & Follow-Up Items

**Deferred**
- WP-010 (Developer, QA, Reviewer; medium): harden the other unguarded `project.Workspaces[id]` lookups in `ProjectManager` with a shared own-property getter or Map storage. Reviewer said to schedule it before routes accept user IDs; REST routes (WP-013) now do, though the directive and role paths themselves are guarded.
- WP-012 (Reviewer, Documentation; low): the POSTB fixture owner header (naming T-27) must be emitted by `capture-golden.ts` because the fixture is generated; not applied.
- WP-010 (Documentation; low): `curation-log.md` was deliberately not edited because its header reserves it for the manifest curator.
- WP-001 / Release Engineer (low): confirm and tag the untagged 1.6.0 and 1.7.0 releases; finalise, tag and publish the v1.8.0 WIP entry (user action).
- Release Engineer (low): changelog archive session for old v0.x entries and a rewrite pass before release.

**Out-of-scope**
- WP-002 (Developer; low): convert the orchestrator constructor to an options object.
- WP-005, WP-015 (Developer, Reviewer; low): consolidate the CLI runner wrappers, deps factories and sync/report helpers into shared helpers.
- WP-006 (QA, Release Engineer; low): explicit old-ID override for rename exclusion instead of metadata JSON equality.
- WP-008 (Developer; low): shared refresh helper if the REST and orchestrator lifecycle paths are ever unified; refresh-specific log message.
- WP-013 (Developer, QA; low): move the duplicate body readers to `requestUtils`.
- WP-016, WP-017 (Developer, Reviewer; low): align GUI delete naming; move directive limit constants to a shared GUI module.
- WP-018 (Developer; low): carry `RepositoryRoles`, `CustomFiles` and directives through the GUI `normaliseProject`.
- WP-003 (Developer, Reviewer; low): derive the marker literals from `GENERATED_MARKER_TOKEN`.

**Follow-up test and documentation gaps (low unless noted)**
- Tests: `--check` mode automation; update/remove inherited-ID cases for directives; over-length and whitespace-only role cell tests; `--text` with `--stdin`; workspace-scope sync failure exit code; repositoryFiles rows with zero repositories.
- Docs: items listed under Documentation in Code Insights, including the stale `gui-frontend.md` tab count (medium), and a documentation entry for the `paralizer directives` and `paralizer repo-roles` CLI (added later in WP-014 and WP-015).

### Next Steps

- Schedule the `ProjectManager` own-property hardening for the remaining `Workspaces[id]` lookups as the first follow-up item, since user-supplied IDs now reach the manager through REST and CLI.
- Release v1.8.0: confirm and tag 1.6.0 and 1.7.0, review the changelog (archive old entries, rewrite long bullets, align bullet prefixes), then finalise, tag and publish.
- Run `paralizer regenerate` against existing workspaces after upgrade so they receive the new generated text.
- Plan a small consolidation pass: CLI runner and deps helpers, GUI constants and delete naming, an orchestrator options object.
- Fix the stale manifest docs (`gui-frontend.md` tab count, `data-flows.md` diagrams, `api-surface.md` cross-references).
- Milestone 2 forward compatibility: directives and roles live only inside `ProjectData` and `ProjectWorkspace`, accessed only via `ProjectManager`. Carry that rule into the new stores.
