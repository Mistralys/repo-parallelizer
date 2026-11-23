# Plan — Repository Workspace Sync M2 Files, Rework 1: Import Hardening and Sync Feedback

## Plan Audit Cycles
- Audits: 1 (Sonnet 5.5 ×1) — Plan Auditor v1.13.1
- Architectural Reviews: 1 (Sonnet 5.5 ×1) — Plan Architect Reviewer v2.5.2

## Prior Project Context

- **M2 synthesis** (`2026-11-20-repository-workspace-sync-m2-files`, 16/16 WPs): the one open security item is the `applyImport()` validation bypass (WP-006): files added or overwritten through an import skip the 64-file cap and the 120/1000-character Label/Description caps, because `RepositoryFileManager.replaceAll()` does no validation. This plan closes it.
- **M2 Strategic Recommendations followed here:** required over optional dependencies where omission is silently destructive (WP-005), and promote only parts that are genuinely shared rather than building a universal adapter (WP-013). The filterFallback notice helper below follows the second.
- **M1 deferred items carried by M2's plan:** item 1 (Save/Recreate `filterFallback` notice) is the same gap WP-016 documented and is promoted here. Item 2 (guard `createManagedClone()` like `removeManagedClone()`) is promoted, because steps 7 and 8 change the same enable/recreate flow. The others are carried forward in Deferred Items.
- **Insight `d20f3cea-1f76-46e3-87fa-4d8c76df206a`:** clone and delete destination guards must reject equality with the root on top of `isLexicallyContained()`. Step 9 keeps that behaviour.
- **Insight `18d6e176-e110-40f6-9d06-af20adf2bb02`:** merge into the single Unreleased CHANGELOG heading and do not bump `package.json`.

## Summary

This rework plan covers the actionable items in `docs/agents/plans/2026-11-20-repository-workspace-sync-m2-files/synthesis.md`. The main item is the open import validation bypass. It is closed in three layers:
1. The folder reader flags incoming files whose metadata breaks the rules, so the import modal locks those rows.
2. `applyImport()` validates the complete resulting file set before it changes anything, whenever the import adds, overwrites or deletes a file.
3. `RepositoryFileManager.replaceAll()` validates the set itself, so every future caller gets the same guarantee.

The plan also does the small cleanups QA scoped: case-only duplicate `Files` paths make `info.json` invalid, `writeRepositoryFiles()`'s `skipped` list is deduplicated, and a no-op import no longer rewrites the store. It logs write-pass outcomes (refused writes and deleted files) to the error log. It shows the partial-clone `filterFallback` notice after Save, Refresh and Recreate, matching Commit & Push. Finally, it gives `createManagedClone()` the same destination guard as `removeManagedClone()`. User-visible behaviour does not change for valid data.

## Architectural Context

- **Model layer:** `src/models/repository/repository-file.ts` holds `validateRepositoryFileInput(input, others)`, a pure function. It builds on the shared rules in `src/models/file-definition.ts` (`validateLabel`, `validateDescription`, `checkPathSegment`, `validateFileContent`). `src/models/repository/repository-file.manager.ts` validates in `add()`/`update()`, but not in `replaceAll()`.
- **Folder side:** `src/orchestration/repository-files.ts` `readRepositoryFilesFolder()` joins disk files with `info.json` metadata and sets a `problem` on files that cannot be imported as-is. `writeRepositoryFiles()` writes through the guard chain and runs the delete pass.
- **info.json:** `src/orchestration/repository-info.ts` `readRepositoryInfoFile()` returns `ok | invalid | absent | unsupported-schema`. `resolveFileImportAction()` restricts a problem diff to its safe action.
- **Orchestrator:** `src/orchestration/repository-info-sync.ts` `RepositoryInfoSyncOrchestrator` serialises every mutator per repository through `runLocked()`. It returns `getStatus()`, except `commitAndPush()`, which returns `CommitPushResult` with `filterFallback`. The optional `errorLogManager` receives `workspace-info` entries.
- **Managed clone:** `src/orchestration/repository-main-folder.ts`: `createManagedClone()` / `removeManagedClone()`, with guards from `src/utils/path-guard.ts`.
- **REST:** `src/server/routes/repository-info-sync.ts` passes orchestrator results through. A plain `Error` from `applyImport()` becomes 400.
- **GUI:** `gui/public/js/views/repository-info-sync-section.js` (Save, Refresh, Recreate, Commit & Push handlers) and `gui/public/js/api.js` (`InfoSyncStatus` typedef).

## Approach / Architecture

### 1. Set-level file validation (model)
New `validateRepositoryFileSet(files: readonly RepositoryFile[]): RepositoryFile[]` in `repository-file.ts`. It folds `validateRepositoryFileInput()` over the list, validating each file against the files already accepted before it. This enforces the count cap, case-insensitive uniqueness, segment and reserved-name rules, label/description caps and content rules with the existing messages. Each message gets the prefix `File "<path>": `. The function returns the normalised files, keeping `Id` and `DateModified`.

`replaceAll()` calls it and stores the normalised result. Its contract changes from "caller must pre-validate" to "validates the whole set; throws `Error` on the first violation". New pure helper `repositoryFileMetadataProblem(meta: { Label: string; Description: string }): string | undefined` returns the first label/description violation message. It reuses `validateLabel`/`validateDescription` and does not copy them.

### 2. Reader: metadata and case-collision problems
`readRepositoryFilesFolder()` adds two problem sources, checked after the existing path, size and binary checks (which keep precedence):
- (a) `repositoryFileMetadataProblem()` on the joined metadata, for files that have a metadata entry. Defaulted metadata is derived from the file name and is checked by the same rule.
- (b) Folder files whose lowercased paths collide each get the problem "Another file under `files/` uses the same path with different letter case."

Both new problems are detected after the file has been decoded as utf8 text, and its `content` stays that utf8 text.

**Hash stability needs a content-kind discriminator.** Today `canonicalFilesForHash()` picks its hash branch from `problem`: any problem other than unreadable is hashed as latin1 raw bytes with no LF normalisation. That holds only because every existing problem source decodes as latin1. Left as is, a file that gains a metadata or case-collision problem would switch from "LF-normalised utf8" to "raw latin1". Its `ContentHash` would then change whenever the content has CRLF/CR line endings or characters above U+00FF. That flips the sync state (for example `in-sync` → `incoming`) and the per-file diff, breaking M2 AC-06.

The fix separates "how was the content decoded" from "can the file be imported":
- `RepositoryFolderFile` gains a required field `contentKind: 'text' | 'raw' | 'unreadable'`. The reader sets it at each existing return point: `'unreadable'` on read failure, `'raw'` for the path-segment, oversized and binary returns (latin1 content), and `'text'` for the utf8 return, including files that then get a metadata or case-collision problem.
- `canonicalFilesForHash()` branches on `contentKind` instead of `problem`: `'unreadable'` → `'unreadable'`, `'raw'` → `sha256` of the latin1 bytes, `'text'` → `sha256` of LF-normalised utf8. For every file the reader produces today, this gives exactly the current hash, because `contentKind` mirrors the old `problem` branch one-to-one. A new metadata or case-collision problem hashes exactly as the file did without it.
- `problem` keeps its single meaning, "cannot be imported as-is". Its other consumers (the diff join, the `info-sync-files-invalid-incoming` health issue, `resolveFileImportAction()`, the import modal) need no change.

So hash compatibility (M2 AC-06) is preserved for all content, not only for ASCII LF content. The import modal's existing disable-not-omit locking and `resolveFileImportAction()`'s problem rule handle the new problems with no GUI or route change.

### 3. info.json: case-only duplicate paths
`readRepositoryInfoFile()` returns `invalid` when two `Files` entries have equal lowercased `Path`. The error message names both paths. This produces the existing `invalid-file` state and its health issue.

### 4. `applyImport()` ordering and no-op write
Inside the existing lock:
1. Resolve actions (unchanged).
2. Compute `filesMutated`: true when at least one resolved action is `add`, `overwrite` or `delete`.
3. Build `resultFiles` from `localFiles` and the actions. This does not depend on the field update.
4. When `filesMutated`, run `validateRepositoryFileSet(resultFiles)` and replace `resultFiles` with its normalised output. On failure, throw before any mutation, so nothing is partly applied.
5. Then update repository fields.
6. When `filesMutated`, call `replaceAll()`.

`resultFiles` (normalised when validated, otherwise the stored list as-is) feeds the merged payload, hash and folder write. The route's plain-`Error` → 400 mapping already covers the new failure.

**Validation scope is gated on the same `filesMutated` condition as `replaceAll()`.** When no file action mutates the set, `resultFiles` equals the stored list (`keep`/`discard` leave it untouched), so validating it can only fail on rows already in the store. Such rows are possible: M2 shipped the unvalidated import this plan closes. A field-only import (Name/Description, file actions all `keep`/`discard`) therefore skips set validation and applies, even when the store holds a legacy-invalid file it does not touch. This keeps AC-06's "field imports still apply" true without exception.

**Intended consequence for mutating imports:** when `filesMutated` is true, the whole resulting set is validated, including untouched legacy-invalid rows. This is deliberate, not an oversight: `replaceAll()` validates the full set as the choke point (§1), so a narrower pre-check would only move the same failure to after the field update and break atomicity. The error names the offending path, and the user fixes it through the files section before retrying (see Risks).

### 5. `writeRepositoryFiles()` dedupe
`skipped` is collected in a `Set` and returned as an array in first-seen order. `written` and `removed` cannot contain duplicates and stay as they are.

### 6. Write-pass logging
New private `logFilesWriteOutcome(repositoryId, result, operation)` on the orchestrator. It runs after `writeRepositoryFiles()` in `syncRepository()` (`operation: 'sync-files'`) and in `applyImport()` (`operation: 'import'`), and appends:
- a `warning` entry listing `skipped` paths when the list is non-empty;
- an `info` entry listing `removed` paths when the list is non-empty.

Both use `Source: 'workspace-info'` and `Context.RepositoryId`. Writes happen only on a state change (`write-required` or an import), so the log records transitions, not every status poll. No persisted state is needed. It is synchronous (`ErrorLogManager.append()` is synchronous) and does nothing when `errorLogManager` is absent.

### 7. `filterFallback` for every clone/fetch-performing mutator
New exported type `RepositoryInfoSyncRemoteStatus = RepositoryInfoSyncStatus & { filterFallback?: boolean }`. It is returned by `saveSettings()`, `refresh()` and `recreateManagedClone()`. The flag is set to `true` only when the clone or fetch they performed fell back to a full transfer, and is otherwise absent. `getStatus()` and `applyImport()` keep returning `RepositoryInfoSyncStatus`. The REST routes already pass the result through. The JSON change is additive.

### 8. GUI notice
New module-private `notifyFilterFallback(result, transfer)` in `repository-info-sync-section.js`. `transfer` is `'clone' | 'fetch'`, and the helper shows the info toast "The remote does not support partial-clone filtering — a full {clone|fetch} was used." It is called after the success toast in:
- `handleSave()` (enable, `clone`);
- `doRefresh()` (`fetch`);
- `doRecreateMainFolder()` (`clone`);
- `doCommitPush()` (`fetch`). This replaces the inline toast; the text is unchanged.

`api.js` gains an `InfoSyncRemoteStatus` typedef for the three methods.

### 9. Guarded managed-clone destination
New module-private `guardedManagedFolderDestination(config, repoId): string | null` in `repository-main-folder.ts`. It is the strict-descendant lexical check plus `escapesRootViaRealpath()`, moved out of `removeManagedClone()` unchanged. `removeManagedClone()` uses it and keeps its `false` return on refusal. `createManagedClone()` calls it before the existence check and throws `MainFolderPreconditionError` on refusal. The orchestrator turns that into `SyncPreconditionError` (409).

## Rationale

- Validating at three points is deliberate. The reader layer gives the user per-row feedback in the modal before Apply. The `applyImport()` pre-check keeps the import atomic. The `replaceAll()` layer is the choke point that holds for any future caller. The synthesis asked for the guarantee to "hold for every future caller, not just the REST route". Putting it in the manager covers that more completely than a check in one loop.
- Moving the field update after file validation is required, not cosmetic. Without it, any validation failure would leave the name and description imported but the files not.
- Gating the `applyImport()` pre-check on a mutating file action reuses the condition that already gates `replaceAll()`, so the pre-check and the choke point always agree on when the set is validated. An import that introduces no new file data cannot introduce an invalid file, so validating it would only block unrelated field imports on legacy rows.
- Recording the content decoding in its own field (`contentKind`) makes the hash rule state what it depends on. The old rule inferred the encoding from `problem`, which coincided by accident. A required field means the compiler flags every `RepositoryFolderFile` constructor, so a future problem source cannot silently pick the wrong hash branch.
- Logging writes rather than health-issue appearance avoids persisting a "last seen issues" fingerprint. A fingerprint would be needed to detect "first appearance" across server and CLI processes. Write events are already transition-only.
- A dedicated `RepositoryInfoSyncRemoteStatus` keeps `filterFallback` out of `getStatus()`, where the flag would be meaningless. This matches how `CommitPushResult` carries the same flag.

## Considered Alternatives

| Decision | Chosen Shape | Alternatives Considered | Trade-Off Summary |
|----------|--------------|-------------------------|-------------------|
| Where to close the import validation bypass | Reader problems + `applyImport()` pre-check + validating `replaceAll()` | (a) Validation only inside `applyImport()`'s loop (the synthesis's suggestion); (b) only in `replaceAll()` | (a) leaves `replaceAll()` unsafe for the next caller; (b) fails late, after field mutation, and gives no per-row feedback. Three layers cost one shared validator. |
| Scope of the `applyImport()` pre-check | Validate the full resulting set only when an `add`/`overwrite`/`delete` action exists (same gate as `replaceAll()`) | (a) Always validate the full resulting set; (b) validate only added/overwritten entries plus set-level count and uniqueness | (a) makes a field-only import fail on a legacy-invalid file it never touches, contradicting AC-06; (b) needs a second code path beside the fold and still fails at `replaceAll()` on legacy rows. The gate is one condition and keeps pre-check and choke point aligned. |
| Set validator shape | Fold over `validateRepositoryFileInput()` | A separate set validator with its own count/uniqueness logic | Folding reuses existing messages and rules, so nothing can drift; a separate validator duplicates them. |
| Metadata problem source | Pure `repositoryFileMetadataProblem()` in the model, called by the reader | Inline `try/validateLabel` in `repository-files.ts` | The model owns the rules (M2 pattern); the orchestration module stays a consumer. |
| Keeping the hash stable when new problem sources are added | Required `contentKind: 'text' \| 'raw' \| 'unreadable'` on `RepositoryFolderFile`; `canonicalFilesForHash()` branches on it | (a) Special-case the new problem messages inside `canonicalFilesForHash()` by matching their text; (b) record the new problems on a separate field (e.g. `importProblem`) that the hash ignores | (a) couples the hash to message strings, and the next problem source repeats the bug; (b) splits "cannot be imported" across two fields, so the diff join, the health issue, `resolveFileImportAction()` and the modal would all need to read both. The discriminator names the real dependency (the decoding), and leaves `problem` with one meaning and its consumers unchanged. |
| Case-only duplicates in `info.json` | `invalid` status | Ignore the later entry; flag a warning only | `invalid` reuses the existing state, health issue and UI; silently picking one entry hides corruption. |
| Audit trail for files-folder issues | Log write-pass outcomes at write time | Log on first appearance of a health issue, with persisted fingerprints | The fingerprint needs new persisted state and still duplicates across processes; write-time logging needs none and covers refused writes and deletions. |
| `filterFallback` transport | `RepositoryInfoSyncRemoteStatus` return type | Add `filterFallback?` to `RepositoryInfoSyncStatus`; a separate polling field | Adding it to the status pollutes `getStatus()`; the intersection type is additive and mirrors `CommitPushResult`. |
| Clone destination guard | Shared private helper used by create and remove | Copy the remove guard into create | A copy is two places to keep in step for a security check; the helper keeps one. |

## Pattern Alignment

- Follows the pure-validator-in-model pattern (`src/models/repository/repository-file.ts`, used by `repository-file.manager.ts`).
- Follows the problem-file pattern: `problem` set by `readRepositoryFilesFolder()` and enforced by `resolveFileImportAction()` (`src/orchestration/repository-info.ts`), with the disable-not-omit row in `gui/public/js/components/repository-info-import-modal.js`.
- Follows `invalid` reporting for malformed `info.json` (`readRepositoryInfoFile()`).
- Follows the `CommitPushResult` precedent for carrying `filterFallback` (`src/orchestration/repository-info-sync.ts`).
- Follows the error-log convention `Source: 'workspace-info'` with an `Operation` per action. It adds the operation `sync-files`.
- Follows the equality-rejecting guard contract from insight `d20f3cea-…` (`removeManagedClone()` in `src/orchestration/repository-main-folder.ts`).
- **Departure:** `RepositoryFileManager.replaceAll()` changes from "no validation" to "validates". This is justified because it was the only unvalidated mutator and the one behind the open security gap. The only caller (`applyImport()`) already passes valid sets after step 4.

## Structural Improvements

| Structure | Observation | Decision | Reason |
|-----------|-------------|----------|--------|
| `src/models/repository/repository-file.manager.ts` `replaceAll()` | Only mutator without validation; contract pushes it onto callers | Promoted to step 1 | It is the root cause of the open WP-006 gap. |
| `src/orchestration/repository-info-sync.ts` `applyImport()` | Fields mutated before file validity is known; `replaceAll()` on all-no-op imports | Promoted to step 4 | Needed for atomicity once validation can fail; the no-op write is in the same block. |
| `src/orchestration/repository-files.ts` reader | Incoming metadata unchecked; case-colliding folder files accepted | Promoted to step 2 | Gives early per-row feedback through the existing problem mechanism. |
| `src/orchestration/repository-files.ts` `canonicalFilesForHash()` / `RepositoryFolderFile` | Hash branch inferred from `problem` presence; correct only while every problem source decodes as latin1 | Promoted to step 2 | Step 2 adds the first problem sources on utf8-decoded content; without the `contentKind` discriminator they would flip existing hashes (M2 AC-06). |
| `src/orchestration/repository-files.ts` `writeRepositoryFiles()` | `skipped` can hold duplicates | Promoted to step 5 | Step 6 logs this list; duplicates would show in the log. |
| `src/orchestration/repository-info.ts` `readRepositoryInfoFile()` | Case-only duplicate `Path` collapses silently | Promoted to step 3 | Small, same validation family. |
| `src/orchestration/repository-info-sync.ts` write callers | `writeRepositoryFiles()` result discarded | Promoted to step 6 | Closes the WP-005 audit-trail suggestion without new state. |
| `src/orchestration/repository-info-sync.ts` `saveSettings`/`refresh`/`recreateManagedClone` | `filterFallback` detected, then dropped | Promoted to step 7 | Required for the GUI notice. |
| `gui/public/js/views/repository-info-sync-section.js` | filterFallback toast inline in `doCommitPush()` | Promoted to step 8 | A fourth inline copy would follow; one helper instead. |
| `src/orchestration/repository-main-folder.ts` | Remove is guarded, create is not; guard inline | Promoted to step 9 | M1 deferred item 2 said "pair with any future change"; steps 7–8 change this flow's callers and tests. |
| Import default selection (`defaultFileImportAction()` server vs. `keepLocalAction()`/`takeIncomingAction()` in the modal) | Kept in sync by convention | Rejected | The rules mean different things (omitted-path default vs. state-aware pre-selection). The server already rejects any disallowed action, so drift cannot cause unsafe behaviour. A server-supplied default would mean a preview contract change with no safety gain. |
| `src/orchestration/repository-orchestrator.ts` `removeRepositoryFromProject()` | Same inline two-layer delete guard as `removeManagedClone()` | Rejected | Outside this plan's blast radius; the new helper stays private to `repository-main-folder.ts` rather than becoming a cross-module utility with one extra consumer. |

## Detailed Steps

1. **Model — set validation and metadata rule.** In `src/models/repository/repository-file.ts`, add `validateRepositoryFileSet(files)` and `repositoryFileMetadataProblem(meta)` as described in Approach §1, with JSDoc. In `src/models/repository/repository-file.manager.ts`, make `replaceAll()` validate through `validateRepositoryFileSet()`, store the normalised result, and update its JSDoc (`@throws {Error}` on an invalid set). Existing messages of `validateRepositoryFileInput()` are unchanged.
2. **Reader — content kind and new problem sources.** In `src/orchestration/repository-files.ts`:
   - add the required `contentKind: 'text' | 'raw' | 'unreadable'` field to `RepositoryFolderFile`. Rewrite the `content` JSDoc so it ties the encoding to `contentKind`, not to `problem`;
   - in `readRepositoryFilesFolder()`, set `contentKind` at every existing return point (`'unreadable'`, `'raw'` for the segment, size and binary returns, and `'text'` for the utf8 return);
   - add the metadata problem (via `repositoryFileMetadataProblem()`) and the case-collision problem as described in Approach §2. Apply both only to `'text'` files that have no earlier problem, and leave `content` and `contentKind` as they are;
   - change `canonicalFilesForHash()` to branch on `contentKind` instead of `problem`, and rewrite its JSDoc bullets to name `contentKind`. `PROBLEM_UNREADABLE` stays the problem text for unreadable files but is no longer used by the hash;
   - update `readRepositoryFilesFolder()`'s JSDoc;
   - update every other `RepositoryFolderFile` literal in `src/` so it compiles (`tsc` lists them).

   Depends on step 1.
3. **info.json — duplicate path rule.** In `src/orchestration/repository-info.ts` `readRepositoryInfoFile()`, return `invalid` with a message naming both colliding paths when two `Files` entries share a lowercased `Path`. Update the JSDoc list of `invalid` causes.
4. **`applyImport()` ordering, validation and no-op write.** In `src/orchestration/repository-info-sync.ts`:
   - compute `filesMutated` (at least one `add`/`overwrite`/`delete` action), replacing the current `resolvedActions.length > 0` gate;
   - build `resultFiles` before the `RepositoryManager.update()` call;
   - when `filesMutated`, run `validateRepositoryFileSet()` on `resultFiles`, letting its `Error` propagate before any mutation, and continue with its normalised output;
   - use that list for `replaceAll()`, the merged payload, the hash and the folder write;
   - call `replaceAll()` only when `filesMutated`.

   Update the method JSDoc (`@throws {Error}` for an invalid resulting set when the import adds, overwrites or deletes a file; field-only imports do not validate untouched stored files). Update the route comment in `src/server/routes/repository-info-sync.ts` (import handler `catch`) to name the new 400 cause. Depends on step 1.
5. **Dedupe `skipped`.** In `src/orchestration/repository-files.ts` `writeRepositoryFiles()`, collect `skipped` in a `Set` and return it as an array in first-seen order. Update the `WriteRepositoryFilesResult.skipped` doc to state that it is unique.
6. **Write-pass logging.** Add private `logFilesWriteOutcome()` to `RepositoryInfoSyncOrchestrator` (Approach §6). Call it with the result of `writeRepositoryFiles()` in `syncRepository()` and `applyImport()`. Depends on steps 4 and 5.
7. **`RepositoryInfoSyncRemoteStatus`.** Export the type from `src/orchestration/repository-info-sync.ts`. Change the return types of `saveSettings()`, `refresh()` and `recreateManagedClone()` and set `filterFallback: true` from the clone or fetch result they already compute. Keep the existing warning log entries. Update the JSDoc and the route file's endpoint comment table if it describes response shapes.
8. **GUI notice.** In `gui/public/js/views/repository-info-sync-section.js`, add `notifyFilterFallback(result, transfer)` and call it from `handleSave()` (only when enabling), `doRefresh()`, `doRecreateMainFolder()` and `doCommitPush()`, replacing the inline commit toast. In `gui/public/js/api.js`, add the `InfoSyncRemoteStatus` typedef and use it in the JSDoc of `saveSettings`, `refresh` and `recreateMainFolder`. Depends on step 7.
9. **Guard `createManagedClone()`.** In `src/orchestration/repository-main-folder.ts`, move `removeManagedClone()`'s two guard layers into private `guardedManagedFolderDestination()`. Use it in `removeManagedClone()` (behaviour unchanged) and at the start of `createManagedClone()`, which throws `MainFolderPreconditionError` on refusal. Update both JSDoc blocks.
10. **Tests.** Implement every entry in the Test Plan. Run `npm test` and `npm run test:gui` with no regressions.
11. **Documentation.** Apply every entry in Documentation Updates.

## Dependencies

- Step 2 and step 4 depend on step 1.
- Step 6 depends on steps 4 and 5.
- Step 8 depends on step 7.
- Steps 3, 5, 7 and 9 are independent of each other.
- Step 10 follows the steps it tests. Step 11 follows steps 1–9.

## Required Components

- `src/models/repository/repository-file.ts` (modified: two new exports)
- `src/models/repository/repository-file.manager.ts` (modified: `replaceAll()`)
- `src/orchestration/repository-files.ts` (modified: `RepositoryFolderFile.contentKind`, reader, `canonicalFilesForHash()` branch, `writeRepositoryFiles()`)
- `src/orchestration/repository-info.ts` (modified)
- `src/orchestration/repository-info-sync.ts` (modified: new exported type, `applyImport()`, logging helper)
- `src/orchestration/repository-main-folder.ts` (modified: private guard helper)
- `src/server/routes/repository-info-sync.ts` (comments only)
- `gui/public/js/views/repository-info-sync-section.js`, `gui/public/js/api.js` (modified)
- `src/tests/repository-file.test.ts` (new test file).
- No new source files and no new dependencies.

## Assumptions

- Stores written by M2's import path may hold files that break the rules. A field-only import still applies over them. An import that adds, overwrites or deletes a file fails with a message naming the offending file, by design (Approach §4). The user fixes it through the files section (see Risks).
- `FILTER_UNSUPPORTED_WARNING` detection in `refresh()` and the clone result stay as they are; this plan only surfaces them.
- The single-repository scope holds: only `paralizer` changes, so no dependency symlink switch is needed.

## Constraints

- `validateRepositoryFileInput()` messages and the project custom files behaviour stay byte-identical.
- Hash inputs for existing data are unchanged (M2 AC-06). This covers files that gain a new problem, including CRLF and non-latin1 content, and it is achieved by the `contentKind` discriminator (Approach §2).
- `syncRepository()` stays synchronous and filesystem-only.
- All relative imports keep `.js` extensions. Untrusted `Label`/`Description`/`Content` stay output-encoded in the GUI (`constraints.md`, Repository Custom Files).

## Out of Scope

- Listing repository files in AGENTS.md from a workspace clone's own `info.json` for teammates without sync (product decision, next milestone).
- An authentication layer for the server and an audit trail for file CRUD (pre-existing design, synthesis marked "no action planned").
- Any change to project custom files.

## Human Actions

| # | Action | When | Why an agent cannot do it |
|---|--------|------|---------------------------|
| 1 | Optional smoke test against a remote without partial-clone support: enable sync and recreate the main folder, and confirm the info notice appears | After the run | Needs a real remote server that rejects `--filter` |
| 2 | Release | After the run | Releases are performed by the user |

## Acceptance Criteria

- AC-01: `validateRepositoryFileSet()` rejects a set with more than 64 files, a case-insensitive path duplicate, an over-length or empty Label, an over-length Description, a reserved `.git` segment or invalid content. Each message is prefixed with the offending path and otherwise equals the `validateRepositoryFileInput()` message. Valid sets are returned normalised with `Id` and `DateModified` preserved.
- AC-02: `RepositoryFileManager.replaceAll()` throws on an invalid set and leaves the store file unchanged. For a valid set it stores the normalised files.
- AC-03: An incoming folder file whose `info.json` metadata has an over-length or empty Label or an over-length Description carries a `problem`. So do two folder files whose paths differ only by case. Such files can only be `discard`ed or `keep`-ed. They keep `contentKind: 'text'` and their utf8 content. Their `canonicalFilesForHash()` entry equals the entry the same file produced without the problem, including for CRLF line endings and characters above U+00FF. Every file kind that existed before this plan (normal, path-segment, oversized, binary, unreadable) hashes exactly as before.
- AC-04: An `info.json` with two `Files` entries whose `Path` differs only by case reads as `invalid`, with a message naming both paths, and the sync state is `invalid-file`.
- AC-05: An import whose resulting file set is invalid (for example more than 64 files after `add`) fails with 400. The repository's Name, Description and file store, the managed clone and the recorded hash are all unchanged.
- AC-06: An import whose file actions are all `keep`/`discard` does not call `replaceAll()`, does not run set validation, and does not rewrite the store file. Field imports still apply, including when the store already holds a file that breaks the rules.
- AC-07: `writeRepositoryFiles()` never returns a path twice in `skipped`, including for a symlink at a write-target leaf.
- AC-08: When a sync or import write skips or removes files, an error-log entry is appended: `warning` for skipped paths and `info` for removed paths, with `Source: 'workspace-info'`, operation `sync-files` or `import`, and the repository ID. No entry is appended when both lists are empty or when no error-log manager is injected.
- AC-09: `saveSettings()` (enable), `refresh()` and `recreateManagedClone()` return `filterFallback: true` when their clone or fetch fell back to a full transfer, and omit it otherwise. `getStatus()` never includes it.
- AC-10: The repository detail page shows the partial-clone info toast after a successful Enable, Refresh or Recreate with `filterFallback: true`, and after Commit & Push as before, through one shared helper. No toast appears without the flag or on disable.
- AC-11: `createManagedClone()` refuses a destination that is not a strict descendant of the managed root, or that escapes it through a symlink, before running git. `removeManagedClone()` behaviour is unchanged.
- AC-12: Existing tests pass unchanged, with two exceptions. First, tests that asserted the removed behaviour (`replaceAll()` accepting an invalid set). Second, `RepositoryFolderFile` literals in tests, which gain the required `contentKind` field: `'text'` in the `folderFile()` helper of `src/tests/repository-files.test.ts`, and `'raw'`/`'unreadable'` in its problem-file hash tests. These only add the field; their assertions stay the same. Every such update is named in the WP handoff.
- AC-13: Manifest documents, module READMEs and `CHANGELOG.md` reflect the changes (Documentation Updates).
- AC-14: An import with an `add`, `overwrite` or `delete` action fails with 400 when the store already holds an untouched file that breaks the rules. The message names that file's path, and nothing is mutated (same guarantees as AC-05).

## Testing Strategy

- Pure unit tests for the set validator, the metadata rule and the info.json reader.
- Filesystem tests with temp folders and symlinks for the reader, writer and managed-clone guard.
- Real-git fixtures (as in M1/M2) for `applyImport()` atomicity, the no-op write, logging and `filterFallback` propagation, with an injected mock error-log manager.
- jsdom GUI tests for the notice helper call sites.
- Full `npm test` and `npm run test:gui` regression.

## Test Plan

- `src/tests/repository-file.test.ts` (new; existing `validateRepositoryFileInput()` cases stay in `src/tests/repository-file.manager.test.ts`): `validateRepositoryFileSet` — 65 files rejected, case-only duplicate rejected, over-length/empty Label and over-length Description rejected with the path prefix, `.git` segment rejected, valid set normalised with `Id`/`DateModified` preserved; `repositoryFileMetadataProblem` returns `undefined` for valid metadata and the label/description messages otherwise. Covers AC-01, AC-03.
- `src/tests/repository-file.manager.test.ts` (extended): `replaceAll()` with an invalid set throws and leaves the store file bytes unchanged; a valid set is stored normalised. Covers AC-02, AC-12.
- `src/tests/repository-files.test.ts` (extended): reader flags an over-length Label, an empty Label and an over-length Description from metadata; flags both entries of a case-colliding pair (skipped on case-insensitive filesystems, detected via a probe); existing problem precedence kept; the reader sets `contentKind` to `'text'`, `'raw'` (segment, oversized, binary) and `'unreadable'` as specified; hash stability with a fixture whose content has CRLF line endings and a character above U+00FF (e.g. `"é → ✓\r\nzweite Zeile\r\n"`):
  - read the file once with valid `info.json` metadata and once with an over-length Label. The content-hash column (index 5) of `canonicalFilesForHash()` is identical for both reads, and equals `sha256` of the LF-normalised utf8 content;
  - on case-sensitive filesystems, each file of a case-colliding pair (same CRLF/non-latin1 content) has the same content hash as when read without its partner. The existing raw/unreadable hash tests keep their expected values after gaining `contentKind`; `writeRepositoryFiles()` with a symlink at a write-target leaf reports the path exactly once in `skipped`. Covers AC-03, AC-07, AC-12.
- `src/tests/repository-info.test.ts` (extended): `readRepositoryInfoFile()` with `Files` paths `a.sh` and `A.sh` returns `invalid` with both paths in the message; `evaluateRepositoryInfoSync()` yields `invalid-file`. Covers AC-04.
- `src/tests/repository-info-sync.test.ts` (extended, real git):
  - an import that would exceed 64 files (local 64 + one incoming `add`) throws; Name, Description, store bytes, clone files and `LastWrittenHash` are unchanged;
  - an incoming file with an over-length Label is refused for `add` as a problem file;
  - hash stability end to end: a local file and a folder file with the same CRLF and non-latin1 content, where the folder side's `info.json` gives an over-length Label. The import preview diff for that path is `changed` with `Label` as its only differing field (content not reported as changed), and the diff carries the metadata `problem`;
  - an import with only `keep`/`discard` file actions and a Name field leaves the store file's mtime and bytes unchanged and applies the Name;
  - with the store seeded directly (JSON written to the store file, bypassing `replaceAll()`) to hold a legacy file whose Label exceeds 120 characters: a field-only import (Name selected, all file actions `keep`/`discard`) succeeds and applies the Name; an import that also `add`s a valid incoming file throws with a message naming the legacy file's path, and Name, Description, store bytes, clone files and `LastWrittenHash` are unchanged;
  - `syncRepository()` that removes a file appends an `info` `sync-files` entry, and one with a refused target appends a `warning`;
  - no entry when nothing is skipped or removed, or without an error-log manager;
  - `saveSettings({ enabled: true })`, `refresh()` and `recreateManagedClone()` return `filterFallback: true` under the existing fallback fixture and omit it otherwise;
  - `getStatus()` never has the key.

  Covers AC-03, AC-05, AC-06, AC-08, AC-09, AC-14.
- `src/server/__tests__/routes/repository-info-sync.test.ts` (extended): an import body whose resulting set is invalid returns 400 with the validator message; `PUT /info-sync`, `POST /refresh` and `POST /recreate-main-folder` pass `filterFallback` through. Covers AC-05, AC-09.
- `src/tests/repository-main-folder.test.ts` (extended): `createManagedClone()` with the destination pre-planted as a symlink escaping the managed root throws `MainFolderPreconditionError` without invoking git; the existing `removeManagedClone()` guard cases pass unchanged. Covers AC-11.
- `gui/public/js/views/repository-info-sync-section.test.mjs` (extended): Enable, Refresh and Recreate show the info toast with the clone/fetch wording when `filterFallback` is `true`, and not when it is absent; Disable never shows it; the existing AC-18 Commit & Push filterFallback test passes unchanged. Covers AC-10.
- Full suites `npm test` and `npm run test:gui` pass. Covers AC-12.
- Documentation review in the QA work package. Covers AC-13.

## Documentation Updates

- `docs/agents/project-manifest/api-surface.md`:
  - `validateRepositoryFileSet()` and `repositoryFileMetadataProblem()`;
  - `replaceAll()` now validates (replace the line-418 "no per-field validation" note);
  - `RepositoryInfoSyncRemoteStatus` and the new return types of `saveSettings()`, `refresh()`, `recreateManagedClone()`;
  - `applyImport()`'s new `@throws`, ordering, and validation gated on a mutating file action;
  - `writeRepositoryFiles()` unique `skipped`;
  - `RepositoryFolderFile.contentKind`, and `canonicalFilesForHash()` branching on it rather than on `problem`;
  - `createManagedClone()` destination guard.
- `docs/agents/project-manifest/rest-api.md`: `PUT /info-sync`, `POST /refresh` and `POST /recreate-main-folder` responses may include `filterFallback`. `POST /import` returns 400 when the resulting file set breaks the file rules (`files` body-field row).
- `docs/agents/project-manifest/data-flows.md`: §16 — `filterFallback` propagation for enable, refresh and recreate, and the clone destination guard. §17 and the import paragraph — validation layers and the validate-before-mutate order (gated on a mutating file action), the no-op write rule, and write-pass logging.
- `docs/agents/project-manifest/constraints.md`, "Repository Custom Files (Milestone 2)":
  - imported files are validated like CRUD files (set-level, before any mutation) whenever the import adds, overwrites or deletes a file; a field-only import does not validate untouched stored files, while a mutating import fails on any invalid stored file and names it;
  - incoming metadata violations and case collisions are problem files;
  - case-only duplicate `Files` paths make `info.json` invalid;
  - `replaceAll()` validates.
- `docs/agents/project-manifest/gui-frontend.md`: the info-sync section shows the partial-clone notice after Enable, Refresh, Recreate and Commit & Push through one helper.
- `src/models/README.md`, `src/orchestration/README.md`, `gui/README.md`: the corresponding module notes.
- `CHANGELOG.md`: add entries under the existing single `## Unreleased - …` heading (do not add a heading or bump `package.json`):
  - "Security: Imported repository files are now validated like files added by hand.";
  - "GUI: Enable, Refresh and Recreate show an info notice when the remote lacks partial-clone filtering support.";
  - "Repositories: Sync now logs files it skipped or removed."
- `docs/agents/project-manifest/tech-stack.md`: no change. `.context/project-folder-structure.md`: re-run `ctx generate` (one new test file).

## Deferred Items

| # | Deferred Item | Origin | Reason Deferred | Notes |
|---|---------------|--------|-----------------|-------|
| 1 | List repository files in AGENTS.md from a workspace clone's own `.workspace/info.json` for teammates without sync | M2 synthesis, Deferred (WP-009 plan note); M2 plan Deferred 7 | New behaviour and a product decision for the next milestone; outside this plan's blast radius | Reconsider when teammates without sync need the listing |
| 2 | Reword M2 WP-007 AC-1 in the ledger to the fail-quiet contract of `getIndexModes()`/`getStagedPaths()` | M2 synthesis, Reviewer/QA (WP-007) | Historical text of a COMPLETE project; `src/git/README.md` and `api-surface.md` already document the shipped contract precisely | PM ledger edit only, no code |
| 3 | Managed clone `.git/config` holds the injected credential in cleartext | M1 synthesis via M2 plan Deferred 3 | Needs a cross-cutting credential-storage review | Not a regression |
| 4 | `isValidIdentityValue()` accepts a bare `\r` | M1 synthesis via M2 plan Deferred 4 | `src/git/git-commit.ts` is not touched; not exploitable (argv spawn, fixed identity constants) | Pair with any future change to `git-commit.ts` |
| 5 | User-chosen main folder path / mode field | M1 synthesis via M2 plan Deferred 5 | Dropped by the user during M1 planning | Additive via a future mode field |
| 6 | `Url` importable behind a confirmation | M1 synthesis via M2 plan Deferred 6 | Rejected during M1 planning | Reopen only on request |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **A store already holding an invalid file (from M2's unvalidated import) blocks future imports** | Scoped: only imports that add, overwrite or delete a file are blocked; field-only imports skip set validation and apply (AC-06). For mutating imports the error names the file path, and the user edits or deletes it in the files section, whose `update()` validates it normally. Documented in `constraints.md`. |
| **New problem sources change the sync hash and flip baselines** | Real risk: the current `canonicalFilesForHash()` would hash a newly flagged utf8 file as latin1 raw bytes. The hash now branches on the new `contentKind` field, which mirrors the old branch for every existing file kind and stays `'text'` for the new problems (Approach §2). Tests use CRLF and non-latin1 content at both unit level and `getStatus()` level (AC-03). |
| **Reordering `applyImport()` changes behaviour for valid imports** | Same inputs produce the same outputs; existing import tests pass unchanged (AC-12). |
| **Write-pass logging floods the error log** | Logged only on actual writes (`write-required` or import), not on status polls; empty lists log nothing. |
| **Case-collision fixture is flaky on case-insensitive filesystems (macOS default, Windows)** | The test probes case sensitivity in the temp folder and skips with a reason when it cannot create both files. The orchestrator path is also covered by AC-01's set validation. |
| **Guarding `createManagedClone()` refuses a legitimate destination** | The guard is the one `removeManagedClone()` already applies to the same path; kebab-case IDs always produce a strict descendant. |

## Recommended Workflow

- **Workflow:** ledger
- **Rationale:** The plan closes an open security finding across model, orchestration, REST and GUI layers, with an atomicity reorder and a guard extraction, so the formal QA, security-audit and review stages are worth running.
