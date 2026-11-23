## Project Status Report — Repository Workspace Sync M2 Files

### Outcome Summary

Milestone 2 added repository-level custom files (e.g. wrapper scripts) to Paralizer's repository workspace sync, delivered end to end across data model, sync orchestrator, git plumbing, REST, CLI and GUI, with metadata tracked in a widened `info.json` `Files` list. All 16 work packages completed across implementation, QA, security audit, code review, release engineering, and documentation stages, with one Medium path-traversal finding caught by security audit on `RepositoryFileManager.removeStore()` and remediated within the same work package before sign-off. The feature committed and delivers files to workspaces strictly through git (Commit & Push, then pull), never by direct copy, matching the existing project custom-files model while correcting an M1 commit-path bug that would have silently dropped the executable bit.

### Metrics

- **Work packages:** 16/16 COMPLETE, all pipeline stages passing (16 WPs × all active stages = 100% stage pass rate; `pipeline_health.total_stages_missing: 0`).
- **Tests:** Backend regression suite grew from 913 (WP-001) to 1607 (WP-008) passing tests over the course of the plan; GUI suite reached 525/525 passing. No failing tests at completion of any WP.
- **Security:** 1 Medium finding (CWE-22/CWE-73 path traversal via unsanitised `repoId` in `RepositoryFileManager.removeStore()`, WP-002) — found, remediated (kebab-case + lexical-containment guard), and re-verified closed in the same WP. All other security-audit stages (WP-001, WP-003, WP-005, WP-006, WP-008, WP-011) passed with 0 issues.
- **Code review:** 0 Blocking issues across all 16 WPs. A small number of Documentation-Forward items were raised and closed within the same WP or the next one (e.g. output-encoding reminder for untrusted file content, carried from WP-003 into constraints.md).
- **Rework:** Only WP-002 required a rework cycle (implementation + qa + security-audit each re-run once) to close the path-traversal finding; all other WPs passed every stage on the first attempt.
- **Release engineering:** No version bump — CHANGELOG's single `## Unreleased` heading was extended rather than duplicated; `package.json` version left unchanged per project convention.

### Strategic Recommendations

- **Required vs. optional dependency injection as a safety mechanism (WP-005):** Making `RepositoryFileManager` a *required* constructor parameter on `RepositoryInfoSyncOrchestrator` (rather than optional, as the codebase's own convention would suggest) turned a potential silent-data-loss bug (an orchestrator built without a file manager would evaluate an empty file set and delete every committed file on the next sync) into a compile-time error at all four construction sites. This is a reusable pattern: prefer a required constructor parameter over an optional one whenever omitting it would cause silent, destructive behavior rather than a merely incomplete feature.
- **Staged-index commit over pathspec commit for preserving git metadata (WP-007):** Empirically verified (git 2.56.0) that committing a pathspec after `update-index --chmod` discards the index-only executable-bit change under `core.filemode=false`, while committing the staged index directly preserves it. This is a non-obvious git behavior worth keeping in the knowledge base for any future cross-platform file-mode handling.
- **Callback-driven component extraction over a whole-section adapter (WP-013):** Extracting only the editor/table (the part with real shared complexity) as callback-driven, while leaving each view's section shell (busy/error state, confirmation, reload) un-shared, avoided an adapter component with flags for every shell-level difference between the project and repository views. This is the plan's second deliberate rejection of a "universal adapter" in favor of promoting only the parts that are genuinely scope-neutral (see also WP-001's rules extraction).
- **Hash-compatibility rules at a widened-schema boundary (WP-004):** The M1→M2 hash compatibility rule (omit the `Files` element entirely from the hash input when empty, rather than appending `[]`) let every existing M1-synced repository keep its exact baseline through the upgrade. This "omit, don't append-empty" technique generalizes to any future additive-field hash/schema widening in this codebase.

### Code Insights

**Developer (Implementation):**
- `src/models/repository/repository-file.manager.ts`: `removeStore()` deliberately skips the repository-existence check every other method performs, since the deletion cascade (WP-010) may call it before or after the repository record is removed — flagged early, later became the vector security-audit caught.
- `src/orchestration/repository-files.ts`: `RepositoryFolderFile.content` stores a latin1 decode of raw bytes for "problem" files specifically so `canonicalFilesForHash()` can reconstruct exact original bytes for raw-byte hashing; only non-problem files get a proper UTF-8 decode — a future consumer must not render a problem file's content as-is (this surfaced again as a security hardening note in WP-003).
- `src/orchestration/repository-info-sync.ts`: Added module-level helpers (`toFolderFiles()`, `buildLocalPayload()`, `withFolderFileHashes()`) so every state-evaluating method (not just `syncRepository()`) builds its hash from real file content, since `readRepositoryInfoFile()` alone always sets `ContentHash: ''`.
- `gui/public/js/components/repository-info-import-modal.js`: The client-side default-selection rule for files is state-dependent (take-incoming for `state=incoming`, keep-local for `state=conflict`), mirroring the field-row pattern, and is distinct from the server's kind-only `defaultFileImportAction()` — both exist and must stay in sync by convention, not by shared code.

**QA:**
- `writeRepositoryFiles()` (WP-003) can double-count a symlink-leaf target in its diagnostic `skipped[]` array (cosmetic only, no security/data-safety impact) — carried forward as a known, accepted issue through WP-005's handoff notes rather than fixed.
- `readRepositoryInfoFile()` (WP-004) does not reject `Files` entries whose `Path` differs only by case; such duplicates silently collapse in the lowercased-path map rather than being flagged invalid. Requires a hand-corrupted `info.json` to trigger; logged as a low-priority, non-blocking observation.
- `applyImport()` (WP-006) unconditionally calls `RepositoryFileManager.replaceAll()` whenever any action resolves, even when every resolved action is a no-op — harmless but an avoidable extra write.

**Security Auditor:**
- WP-002: Medium finding — `removeStore(repoId)` built a filesystem path from an unsanitised `repoId` with no kebab-case or containment check, unlike every other `RepositoryFileManager` method (all gated by `assertRepositoryExists()`). Remediated with `isValidKebabCase()` + `isLexicallyContained()`, both silent-no-op on failure to preserve the existing "no-op when absent" contract.
- WP-006: High-priority (non-blocking) hardening gap — `applyImport()`'s add/overwrite path bypasses `validateRepositoryFileInput()`'s count (64) and length (120/1000) caps via `RepositoryFileManager.replaceAll()`'s no-validation contract. Unreachable at the time (the REST route didn't yet forward a `files` selection) but flagged for closure before WP-008. WP-008's code-review explicitly re-checked this and confirmed the caps remain enforced on the CRUD add/update path (unaffected by the import path's own validation gap) — the gap was scoped out as a documented, still-open item for the `applyImport` path specifically, not closed.
- WP-003: Repository file `Label`/`Description`/`Content` originate from a teammate's git commit and are therefore untrusted; flagged for output-encoding at render time in all later GUI/REST/CLI consumers.

**Reviewer (Code Review):**
- WP-008: `sendMappedError()`'s `fallbackStatus` parameter cleanly shares one error-mapping function across handlers with different unmapped-error semantics — called out as a gold-nugget pattern.
- WP-015: `buildFileRow()`'s disable-not-omit pattern for a disallowed problem-row radio keeps DOM structure uniform while making an invalid selection physically unclickable — recommended as a template for future server-mirrored client validation.
- WP-014: `refreshInfoSyncSection()`'s rebuild-not-reach-in pattern for cross-module GUI refresh (rebuilding the M1-owned info-sync section rather than adding a public refresh method to it) avoided coupling a new WP's code into an existing, unrelated module.

**Documentation:**
- Found and fixed a stale `data-flows.md` claim (§16) that the info-sync import route "still only forwards `{ state, fields }}`" — that gap had actually been closed by WP-008 without the manifest catching up, discovered only during WP-016's final consistency pass.
- Found that `src/models/README.md`, `src/orchestration/README.md`, `src/server/README.md`, `src/utils/README.md`, and `gui/README.md` had never been updated for any Milestone 1 or Milestone 2 addition (only `src/git/README.md` had been kept current) — closed during WP-016's cross-cutting pass.

### Deferred & Follow-Up Items

- **Source: WP-003, Security Auditor / Reviewer — out-of-scope, carried as a follow-up WP.** `writeRepositoryFiles()`'s `skipped[]` diagnostic array can contain a duplicate path for a symlink-leaf write target (cosmetic, no security/data-safety impact). QA recommended a dedupe pass (e.g. `[...new Set(result.skipped)]`) in a future WP touching this module; never fixed within this plan.
- **Source: WP-004, QA — low priority, non-blocking.** `readRepositoryInfoFile()` does not flag a hand-corrupted `info.json` containing two `Files` entries whose `Path` differs only by case as invalid; such duplicates silently collapse. Requires external file corruption to trigger.
- **Source: WP-005, Security Auditor — hardening suggestion, non-blocking.** No audit-log entry is emitted when files-folder health issues (`info-sync-files-*`) first appear; currently surfaced only via the live health report, not persisted to the error/audit log.
- **Source: WP-006, Security Auditor — high-priority but currently unreachable, left open.** `applyImport()`'s add/overwrite resolution path bypasses `RepositoryFileManager`'s per-field validation (file count cap of 64, Label/Description length caps of 120/1000 chars) because `replaceAll()` performs no validation. Recommended fix: add the validation inside `applyImport()`'s resolved-actions loop itself (`repository-info-sync.ts`, around the resolved-actions loop) so the guarantee holds for every future caller, not just the REST route. WP-008 confirmed the CRUD add/update path is unaffected, but did not close this gap on the import path — it remains open for a future WP.
- **Source: WP-007, Reviewer / QA — PM-owned, non-code follow-up.** AC-1's literal "`exitCode: 128` / `fatal: ...`" wording does not strictly describe `getIndexModes()`/`getStagedPaths()`, which fail-quiet to an empty Map/array instead (mirroring `getPathStatus()`'s existing convention) rather than returning a `GitResult`. Flagged twice (QA and code-review) as a wording reconciliation the Project Manager should make to the acceptance-criteria text; not addressed within this plan.
- **Source: WP-008, Security Auditor — Low/Info, pre-existing design, no action planned.** No auth layer exists anywhere in the server (consistent with the local-tool threat model) and no audit trail exists for file CRUD mutations specifically. Recorded for awareness, not flagged for remediation.
- **Source: plan-level note (WP-009 description) — explicitly deferred, not built.** AGENTS.md's "Repository Files" table is sourced from Paralizer's own committed data rather than by reading each workspace clone's local `.workspace/info.json`, so it can list files "not pulled yet" without warning beyond the intro text. A clone-read fallback for non-syncing teammates was explicitly named as a documented follow-up for a later milestone, not built here.
- **Source: WP-016, Documentation — still-open gap, explicitly called out as separate from this WP's fixes.** The commit dialog's `filterFallback` info toast is shown on Commit & Push, but an equivalent notice is still missing on the Save/Recreate path. Documentation kept this gap clearly labeled as open rather than implying it was fixed.

### Next Steps

- Close the still-open `applyImport()` validation-bypass gap (WP-006 security finding) before any future WP relies on the import-selection path for untrusted or bulk file content.
- Consider a small follow-up WP to dedupe `writeRepositoryFiles()`'s `skipped[]` array and to reject case-only-duplicate `Path` entries in `readRepositoryInfoFile()` — both are small, well-understood, low-risk cleanups already scoped by QA.
- Reconcile WP-007's AC-1 wording with the actual fail-quiet contract of `getIndexModes()`/`getStagedPaths()` the next time this plan's acceptance criteria are revisited, so the documented contract matches the shipped behavior precisely.
- Evaluate the deferred clone-read fallback for the AGENTS.md "Repository Files" table (reading `.workspace/info.json` directly for non-syncing teammates) as a candidate for the next milestone's planning pass.
- Add the missing Save/Recreate `filterFallback` notice to bring GUI feedback to parity with the Commit & Push path now that WP-016 has set the precedent.
- Consider an audit-log entry for files-folder health issues (`info-sync-files-*`) as a hardening pass, per the WP-005 security observation.
