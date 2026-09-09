
# Curation Log

Why this manifest looks the way it does, and when it was last verified.
Read freely — Standing Decisions explains the deliberate gaps and conventions.
Written by the manifest curator and reviewer only; no other agent edits this file.

## Standing Decisions

| Date | Decision | Rationale |
|---|---|---|

## History

### 2026-09-09 · Update · Manifest Curator v3.4.0

**Scope:** All six manifest section documents (`tech-stack.md`, `constraints.md`, `data-flows.md`, `api-surface.md`, `rest-api.md`, `gui-frontend.md`), the manifest index (`README.md`), and the out-of-manifest `AGENTS.md` (dispatched to AGENTS.md Curator v2.1.0).
**Commit:** `ddacee5` (branch `feature-repo-dialog`; working tree held the two finding-sink artefacts as uncommitted files — no source changes since the review passes)
**Baselines:** Commit `ddacee5`; every manifest document was treated as fully verified prose from the preceding Manifest Reviewer passes. This pass made no new discovery — it drew solely on the reconciled finding sinks.
**Coverage:** All 31 findings across both finding sinks reconciled and applied. No new claim verification was attempted beyond re-reading each finding's cited evidence pointer before editing. Cross-document propagation checked for each corrected subject (configure-credential nav, Operation labels, storage layout, negative-limit semantics). `constraints.md`, `api-surface.md`, `rest-api.md`, and `gui-frontend.md` sections not touched by a finding were not re-verified this pass.
**Changes:** `tech-stack.md` — corrected `files` field row to the curated per-subdirectory list; removed the stale `.npmignore` checklist item (findings 1, 2). `constraints.md` — added `MIN/MAX_CLONE_DEPTH` and `MIN/MAX_SERVER_PORT` rows to the Config Validation Constants table (finding 3). `data-flows.md` — rewrote flows 3, 4, 5 to remove false orchestrator invocations from plain HTTP endpoints; amended flow 6 DateModified condition; documented the missing `hasEmbeddedCredentials()` pre-check gap in flow 9; added `error-log.json` to the storage layout (flow 11); corrected credential success-log Operation labels in flow 14; fixed `configure-credential` navigation note in §12 (findings 7–13, 30 propagation). `api-surface.md` — corrected `ErrorLogListOptions.limit` negative-value semantics; added `PollingManager.restart()`; added `migrateWorkspaceFiles()`; fixed `ProjectWorkspace` re-export declaration; fixed `_promptPath`/`_promptNumber` parameter optionality; added `registerErrorLogRoutes`, `registerNotesRoutes`, `registerVersionRoute`; expanded GUI client section to document all namespaces including `api.version.get()` and `api.errorLog.sources()` (findings 14–20). `rest-api.md` — corrected polling upper-bound note; corrected negative-limit semantics; added `POST /api/repositories/:id/refresh-timestamp`; corrected workspace-create body field (`workspaceId`); added 400 to `PUT /api/projects/:id`; removed false filesystem-cleanup claim from `DELETE /api/projects/:id`; corrected `DELETE /api/projects/:id/workspaces/:wid` error codes; removed nonexistent 400 from workspace setup endpoint; added `GET /api/version` section (findings 5, 6, 21–27). `gui-frontend.md` — qualified "full re-render" claim; removed hardcoded API group count; corrected `configure-credential` navigation; added `api.errorLog.sources()` and `api.version.get()` to the client inventory (findings 28–31). `README.md` (manifest index) — removed stale `Last generated` date; added `curation-log.md` link (finding 6). `AGENTS.md` — dispatched to AGENTS.md Curator v2.1.0; "Architecture" Project Stats row corrected to include Error Log layer and separate Server/CLI (finding 4). Finding sinks `findings-gpt-terra.md` and `findings-claude-sonnet-5.md` retained — not deleted, as the user did not instruct deletion.
**Findings:** 7 high, 21 medium, 1 low — all 31 reconciled from the two external sinks. No findings rejected on re-verification (claude-sonnet-5 Pass 2 confirmed all gpt-terra findings held). Headline findings reconciled: false orchestrator flows in project/repository/workspace creation (7–9); credential guard gap (11); wrong credential-success operation labels (12); missing storage file (13); negative-limit semantics wrong in both `api-surface.md` and `rest-api.md` (14, 6); polling missing upper bound (5); multiple REST endpoint omissions and wrong error codes (21–27); GUI architecture overstated; configure-credential loses repo context (30).
**Notes:** Conditional Standing Decisions check: no conditional decisions exist — check declined. Finding sinks not deleted per instruction omission; curator will delete them on the user's instruction. `AGENTS.md` edit confirmed by dispatched agent.

### 2026-09-09 · Review · Manifest Reviewer v5.2.0

**Scope:** Continuation of the resolved manifest scope, focused on all `gui-frontend.md` architecture, router, route, API client, reusable component, utility, theme, lifecycle, title, and view-behavior claims against their JavaScript owners.
**Commit:** `ddacee5` (branch `feature-repo-dialog`; working tree had uncommitted CTX output and review artefacts)
**Baselines:** Commit `ddacee5`; `gui-frontend.md` contained partly verified unread prose from earlier passes, and this pass verified the remaining document against `gui/public/js/`. No commits exist in `ddacee5..HEAD`.
**Coverage:** Complete frontend-claim coverage for `gui-frontend.md`. Remaining work: `constraints.md`, cross-document contradiction/register/omission checks, class-naming documents, and root-document scope-drift checks.
**Changes:** none — review only.
**Findings:** 1 high, 2 medium, 1 low — 4 originated, 0 confirmed. Headline findings: `configure-credential` opens the repository list instead of the affected repository; the architecture falsely states all mutations re-render; the API group count is wrong; and live `sources`/`version` client methods are omitted.
**Notes:** Conditional Standing Decisions remain declined by the user; none exist. This source-review pass did not change application code.

### 2026-09-09 · Review · Manifest Reviewer v5.2.0

**Scope:** Continuation of the resolved manifest scope, focused on `rest-api.md`: every endpoint table, detailed request/response branch, and registered route across repositories, projects, workspaces, launch, branches, status, error log, credentials, polling, webserver URL, notes display, notes, and version.
**Commit:** `ddacee5` (branch `feature-repo-dialog`; working tree had uncommitted CTX output and review artefacts)
**Baselines:** Commit `ddacee5`; `rest-api.md` was previously partly reviewed and this pass verified its remaining claims against all source route statements. No commits exist in `ddacee5..HEAD`.
**Coverage:** Complete REST endpoint/table and described-branch coverage for `rest-api.md`. GUI behavioral claims, remaining constraints, class-naming documents, and cross-document register/omission/contradiction audits remain uncovered.
**Changes:** none — review only.
**Findings:** 1 high, 6 medium, 0 low — 7 originated, 0 confirmed. Headline findings: refresh-timestamp and version endpoints are omitted; workspace create uses `workspaceId`, not `id`; project deletion does not clean workspace files; and multiple endpoint table error-code lists do not match their handlers.
**Notes:** Conditional Standing Decisions remain declined by the user; none exist. This source-review pass did not change application code.

### 2026-09-09 · Review · Manifest Reviewer v5.2.0

**Scope:** Continuation of the resolved manifest scope, focused on the complete exported declaration inventory in `api-surface.md`: configuration, Git, Error Log, models, orchestration, storage, utilities, CLI, server, route registration, and GUI client.
**Commit:** `ddacee5` (branch `feature-repo-dialog`; working tree had uncommitted CTX output and review artefacts)
**Baselines:** Commit `ddacee5`; `api-surface.md` was partly verified in the prior passes and this pass checked its remaining declaration claims against their owning exported statements. No commits exist in `ddacee5..HEAD`.
**Coverage:** Complete declaration and signature coverage for `api-surface.md`. Deep behavioral verification, the cross-document contradiction sweep, source-wide register/omission checks, and remaining `rest-api.md`/`gui-frontend.md`/`constraints.md` claims remain uncovered.
**Changes:** none — review only.
**Findings:** 0 high, 7 medium, 0 low — 7 originated, 0 confirmed. Headline findings: ErrorLog negative-limit behavior is wrong; public polling restart and workspace migration APIs are omitted; workspace type re-export and setup helper optionality are misdocumented; route registrations and most GUI client APIs are omitted.
**Notes:** Conditional Standing Decisions remain declined by the user; none exist. This declaration-focused pass did not run a code-mutating command.

### 2026-09-09 · Review · Manifest Reviewer v5.2.0

**Scope:** Continuation of the resolved manifest scope, focused on fully verifying all 14 flows in `data-flows.md` against their owning CLI, server, route, orchestration, git, storage, model, and GUI statements.
**Commit:** `ddacee5` (branch `feature-repo-dialog`; working tree had uncommitted CTX output and review artefacts)
**Baselines:** Commit `ddacee5`; `data-flows.md` was previously explicitly unverified. No commits exist in `ddacee5..HEAD`.
**Coverage:** All `data-flows.md` endpoint, control-flow, branch, literal, and storage-layout claims were verified. The broader Pass 1 gaps in `api-surface.md`, `rest-api.md`, `gui-frontend.md`, `constraints.md`, class-naming documents, register, omission, and contradiction audits remain.
**Changes:** none — review only.
**Findings:** 4 high, 3 medium, 0 low — 7 originated, 0 confirmed. Headline findings: the project/repository/workspace creation flows incorrectly claim their ordinary HTTP endpoints invoke filesystem orchestrators; credential injection is active but its documented guard is absent; the branch timestamp and credential success-operation claims are wrong; and the storage layout omits `error-log.json`.
**Notes:** Conditional Standing Decisions remain declined by the user; none exist. `npm test` passed during this continuation.

### 2026-09-08 · Review · Manifest Reviewer v5.2.0

**Scope:** Resolved: manifest documents `README.md`, `tech-stack.md`, `api-surface.md`, `data-flows.md`, `constraints.md`, `rest-api.md`, and `gui-frontend.md`; routed `AGENTS.md`, `CLAUDE.md`, and `.context/project-folder-structure.md`; class-naming documentation candidates under `docs/agents/implementation-history/`; no diagrams found. Covered: the manifest index, packaging, config-validation, polling, credential-options, routing, architecture-stat, CTX, and limited unread-prose claims. Uncovered documents and categories are stated in the report.
**Commit:** `ddacee5` (branch `feature-repo-dialog`; working tree had uncommitted CTX output and review artefacts)
**Baselines:** Commit `ddacee5`; unread prose established by `git diff main...HEAD -- docs/agents/project-manifest`: `api-surface.md`, `gui-frontend.md`, and `rest-api.md` were new relative to `main` and received targeted checks. Other manifest prose was not treated as unread solely because an earlier pass exists.
**Coverage:** Partial. Claim inventory and targeted source verification covered `README.md`, `tech-stack.md`, `constraints.md`, `rest-api.md`, parts of `api-surface.md`/`gui-frontend.md`, and `AGENTS.md`; `data-flows.md`, the remaining claim categories, contradiction comparison, and class-naming history documents were not reached.
**Changes:** none — review only.
**Findings:** 4 high, 1 medium, 1 low — 2 originated, 4 confirmed from the independent `claude-sonnet-5` finding sink. Headline findings: the documented npm `files` field and `.npmignore` checklist are stale; `AGENTS.md` omits the Error Log architecture layer; config validation bounds are omitted; polling's documented missing maximum contradicts the route; and the manifest index retains superseded date metadata.
**Notes:** Conditional Standing Decisions were declined by the user; no conditional decisions exist. `ddacee5..HEAD` contains zero commits, so the preceding review's commit baseline was not invalidated; no reverted-decision leads appeared in `main..HEAD`.

### 2026-09-08 · Review · Manifest Reviewer v5.2.0

**Scope:** Resolved scope: the manifest directory (all 7 documents plus this log, which did not yet exist), the change set since `main` (`api-surface.md`, `gui-frontend.md`, `rest-api.md`), and routed documents (`AGENTS.md`/`CLAUDE.md`). No diagrams or other class-naming documents were found. Covered in full: `tech-stack.md`, `AGENTS.md`. Covered in part: `constraints.md`, `api-surface.md`, `rest-api.md`, `gui-frontend.md`, `README.md` (link/existence check only). Not covered: `data-flows.md`.
**Commit:** ddacee5 (branch `feature-repo-dialog`; working tree had uncommitted changes limited to `.context/`-generated files, not manifest source)
**Baselines:** Commit `ddacee5`. Unread prose established by diffing the manifest against `main` (merge-base `11ff152`): `api-surface.md`, `gui-frontend.md`, and `rest-api.md` carry genuinely new, never-reviewed prose; `tech-stack.md`, `constraints.md`, `data-flows.md`, and `README.md` were unchanged since `main` but treated as fully unread in this pass since no prior `curation-log.md` entry existed to certify otherwise.
**Changes:** none — review only.
**Findings:** 3 high, 1 medium, 0 low — 4 originated, 0 confirmed. Headline findings: (1) `tech-stack.md`'s `files`-field table row no longer matches `package.json` — the actual field is a curated per-subdirectory list that already excludes compiled test artefacts; (2) `tech-stack.md`'s pre-publish checklist tells an agent to add a `.npmignore` that already exists with the exact content requested; (3) `constraints.md`'s Config Validation Constants table omits the `MIN`/`MAX_CLONE_DEPTH` and `MIN`/`MAX_SERVER_PORT` constants that gate `cloneDepth`/`serverPort` in `loadConfig()`; (4) `AGENTS.md`'s Project Stats "Architecture" row drops the Error Log layer that `tech-stack.md`'s own Layered Architecture section lists as the 3rd of 7 layers.
**Notes:** First pass — no prior `curation-log.md` existed, so this entry establishes the baseline for future passes. Conditional Standing Decisions: none exist yet, so the pre-pass check was not applicable (nothing to ask about). `data-flows.md` (all 14 flows) was not verified against source and remains the largest coverage gap for a follow-up pass. The report and this pass's finding sink (`findings-claude-sonnet-5.md`) are scaffolding for the user to dispatch fixes from and delete afterward — nothing in the manifest depends on either.
