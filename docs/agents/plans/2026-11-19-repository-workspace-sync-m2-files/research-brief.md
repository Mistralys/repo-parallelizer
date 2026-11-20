# Research Brief — Repository Workspace Sync, Milestone 2: Repository Files

## Scope Sketch

- Milestone 1 sync modules (planned, not yet implemented): `src/orchestration/repository-info.ts`, `src/orchestration/repository-info-sync.ts`, `src/orchestration/repository-main-folder.ts`, `src/server/routes/repository-info-sync.ts`, GUI section and import modal. Type of change: modification of M1-planned code (M1 lands first).
- Repository file model and storage: `src/models/repository/`. Type of change: new code.
- Shared file-definition rules: `src/models/project/custom-file.ts`. Type of change: modification (extraction).
- Artefact choke-point and workspace index: `src/orchestration/workspace-artifacts.ts`, `src/orchestration/workspace-index.ts`. Type of change: modification.
- REST: `src/server/routes/`. Type of change: new route module and wiring in `src/server/index.ts`.
- CLI: `src/cli/custom-files.ts`, `src/index.ts`. Type of change: new command group plus helper extraction.
- GUI: `gui/public/js/views/project-custom-files.js`, `gui/public/js/views/repository-detail.js`, `gui/public/js/api.js`, `gui/public/js/utils/normalise.js`. Type of change: new section, shared editor extraction.
- Deletion cascade: `src/orchestration/repository-orchestrator.ts`. Type of change: modification.
- Documentation: `docs/agents/project-manifest/*`, module READMEs, `CHANGELOG.md`.

## Area: Milestone 1 (planned)

### Verified References
- `docs/agents/plans/2026-11-19-repository-workspace-sync-m1-info/plan.md`:
  - L26–L45: `repository-info.ts` constants (`REPOSITORY_INFO_FOLDER_NAME = '.workspace'`, `REPOSITORY_INFO_FILE_NAME`, `REPOSITORY_INFO_SCHEMA_VERSION = 1`), `RepositoryInfoPayload { Id; Name; Description }`, `hashRepositoryInfoPayload()` = SHA-256 of `JSON.stringify([Id, Name, Description])`, unknown-key preservation on render. `Url` is written credential-stripped for information only and is excluded from the payload, hash, diff and import (M1 Open Question 12).
  - L43–L55: decision table (`write-required`, `in-sync`, `incoming`, `conflict`, `invalid-file`, `unsupported-schema`, `id-mismatch`).
  - L74: cone sparse checkout of the info folder (covers `.workspace/files/`).
  - L81–L87: synchronous filesystem-only `syncRepository()`; README written independently of the hash.
  - L100–L107: `getImportPreview()` / `applyImport(repositoryId, fields)`.
  - L108–L116: `commitAndPush()` with pathspec `<folderName>`; `git add -A -- <folderName>` then commit.
  - L125–L131: choke-point integration; `regenerateForRepository()` runs `syncRepository()` first.
  - L152: `POST /api/repositories/:id/info-sync/import` body `{ fields: ('Name'|'Description')[] }` (`Url` is a 400).
  - L257–L260: `src/git/git-commit.ts` (`getPathStatus`, `stagePaths`, `commitPaths`).
  - L288: `writeRepositoryInfoFile()` guard chain with the main folder as root.
  - L290–L297: `renderRepositoryInfoReadme()` is fixed text; "Milestone 2 extends it with the `files/` section".
  - L345–L346: composition in `src/server/index.ts` and `src/cli/custom-files.ts`.
  - L363–L370: `showRepositoryInfoImportModal()`, `showInfoCommitDialog()`.
  - L371–L383: `views/repository-info-sync-section.js` mounted after the Credential section.
  - L446–L448: "Next Milestone — Repository Files".

### Established Patterns
- Pure module + orchestrator split — `src/orchestration/workspace-index.ts` / `workspace-artifacts.ts` (adopted by M1).

### Structural Observations
- M1 `RepositoryInfoPayload` and its hash are fixed to three fields (`Id`, `Name`, `Description`); files need a widened payload whose hash stays identical for repositories without files, so M1 baselines remain valid.
- M1 `applyImport(repositoryId, fields)` signature and route body only know info fields.
- M1 route validation says `fields` must be a non-empty array, while the M1 modal allows an empty selection ("keep all"). M2 must reconcile this when the body gains `files`.

### Constraints
- M2 must not modify the M1 plan document.
- `syncRepository()` must stay synchronous and spawn no subprocess.

## Area: Project custom files (reference for mirroring)

### Verified References
- `src/models/project/custom-file.ts` (L1–L219): pure module. `CUSTOM_FILE_MAX_CONTENT_BYTES = 256 * 1024`, `CUSTOM_FILE_MAX_LABEL_LENGTH = 120`, `CUSTOM_FILE_MAX_DESCRIPTION_LENGTH = 1000`, `RESERVED_ROOT_FILE_NAMES`, `CustomFile { Id; Directory; FileName; Label; Description; Content; ListInAgents; DateModified }`, `CustomFileInput`, private `checkSegment()` / `INVALID_SEGMENT_CHARS` / `WINDOWS_RESERVED`, `normaliseDirectory()`, `customFileRelativePath()`, `validateCustomFileInput(input, repositoryIds, others)`, `isExecutableFile(fileName, content)`, `applyLineEndingPolicy(fileName, content)`.
- `src/orchestration/custom-files.ts` (L1–L161): `CustomFilesResult { written; skipped }`, private `guardedTarget()` (lexical → realpath → directory-shape, re-checked after mkdir), `writeCustomFiles()` (overwrites unconditionally, chmod 755/644 on POSIX), `removeCustomFileCopy()` (rm + prune empty parents).
- `src/models/project/project.manager.ts` L350–L435: `listCustomFiles`, `addCustomFile` (UUID via `randomUUID()`), `updateCustomFile` returning `{ previous, updated }`, `removeCustomFile`.
- `src/models/project/project.types.ts` L56: `CustomFiles?: CustomFile[]` inline in `projects/{id}.json`.
- `src/server/routes/projects.ts` L360–L500: custom-files routes, `readCustomFileBody()`, purge previous copies on move/rename/delete, then `regenerateProject()`.
- `src/cli/custom-files.ts` (L1–L394): `EXIT_OK/EXIT_ERROR/EXIT_SYNC_FAILED`, `CustomFilesCliDeps`, `CUSTOM_FILES_HELP`, `runCustomFilesCommand()`, `createDefaultCustomFilesDeps()` (L142–L154), `UsageError`, `FIELD_OPTIONS`, `parse()`; file resolution by ID prefix (≥ 4 chars) or path.
- `src/index.ts` L13, L58, L130–L155, L163–L170: dispatch of `custom-files`, `runCustomFilesCliCommand()`, `printFullHelp()` appends `CUSTOM_FILES_HELP`, `printUsage()`.
- `src/orchestration/workspace-index.ts` L57–L66 `WorkspaceIndexCustomFileRow { path; label; description }`; L103 `customFiles?`; L220–L245 `renderWorkspaceAgents()` and `renderCliSection()` (installation path + `paralizer help`, custom-files pointer line); L253–L270 `renderCustomFilesSection()` with `escapeMarkdownCell()`.
- `src/orchestration/workspace-artifacts.ts` L139–L178: builds `WorkspaceIndexContext` (incl. `customFiles` filtered by `ListInAgents`), calls `writeWorkspaceIndexFiles()` then `writeCustomFiles()`; L189–L199 `removeCustomFileCopies()`.
- `gui/public/js/views/project-custom-files.js` (L1–L459): exports `normaliseCustomFile`, `formatCustomFilePath`, `isExecutableHint`, `buildCustomFilesSection(projectId, rawFiles, onRefresh)`; private `buildFileTable()`, `buildEditorForm(projectId, file, cb)`. Test: `gui/public/js/views/project-custom-files.test.mjs`.
- `gui/public/js/api.js` L341–L390: `api.projects.customFiles` namespace.
- `docs/agents/project-manifest/constraints.md` "Custom Files" section; `docs/agents/project-manifest/data-flows.md` §13b.
- Tests: `src/tests/custom-files.test.ts`, `src/tests/cli-custom-files.test.ts`, `src/tests/project.manager.test.ts`, `src/server/__tests__/routes/projects.test.ts`.

### Established Patterns
- Definition is the single source of truth; copies are overwritten — `src/orchestration/custom-files.ts`.
- CLI/REST parity: same manager validation, then the choke-point — `constraints.md` "Custom Files".
- Agent pointer, not docs, in generated `AGENTS.md` — `workspace-index.ts` `renderCliSection()`.
- Optional-field addition without `SCHEMA_VERSION` bump — `constraints.md`.

### Structural Observations
- `src/models/project/custom-file.ts`: path-segment rules, directory normalisation, size/NUL checks, executable heuristic and line-ending policy are generic but live in a project-named module and are partly private (`checkSegment`).
- `src/orchestration/custom-files.ts`: `guardedTarget()` and the empty-parent pruning are private; a second writer would duplicate them.
- `src/cli/custom-files.ts`: argument parsing, content-source reading (`--content-file`, `--stdin`, `--content`) and ID-prefix/path resolution are private; a second command group would duplicate them.
- `gui/public/js/views/project-custom-files.js`: the editor form and table are private and bound to `projectId` and `api.projects.customFiles`.
- `workspace-artifacts.ts` writes custom files unconditionally (no write-only-if-changed).

### Constraints
- Text only (UTF-8, no NUL, ≤ 256 KB); executable bit POSIX only; Windows reserved names rejected; case-insensitive path uniqueness.
- Project custom files must stay unchanged (user decision 1).

## Area: Storage

### Verified References
- `docs/agents/project-manifest/data-flows.md` §11: `{storageFolder}/repositories.json`, `projects-index.json`, `error-log.json`, `projects/{project-id}.json`.
- `src/storage/json-storage.ts`: `readJsonFile<T>()`, `writeJsonFile<T>()`, `ensureDirectory()`, `initializeStorage()`, `FileNotFoundError`.
- `src/storage/storage.types.ts`: `SchemaVersion`, `BaseStore`.

### Established Patterns
- One JSON document per aggregate with `SchemaVersion` — `projects/{id}.json`.

### Structural Observations
- `repositories.json` holds every repository and is re-read on every manager call; inlining up to 256 KB per file there would inflate every repository read.

### Constraints
- Stateless managers re-read JSON on every call — `src/models/repository/repository.manager.ts`.

## Area: GUI

### Verified References
- `gui/public/js/components/`: `modal-shell.js`, `confirm-dialog.js`, `form-helpers.js`, `toast.js` exist.
- `gui/public/js/views/repository-detail.js` and test `repository-detail.test.mjs` exist.

### Structural Observations
- See `project-custom-files.js` above.

### Constraints
- Vanilla ES modules, no build step, no `innerHTML` for user data (`gui-frontend.md`).

## Area: Path guard and git helpers (current tree)
- [verify] `src/utils/path-guard.ts` exports: `isLexicallyContained` (L29), `MAX_SYMLINK_RESOLUTION_DEPTH` (L54), `bestEffortRealpath` (L86), `resolveRootRealPath` (L116), `escapesRootViaRealpath` (L132), `isDirectoryShaped` (L149). No `guardedFileTarget` export exists yet. [added by: Refiner]
- [arch] `src/git/` currently contains `git-branch.ts`, `git-cli.ts`, `git-clone.ts`, `git-credentials.ts`, `git-status.ts`, `git.types.ts`; `src/git/git-commit.ts` does not exist in the working tree (introduced by M1, which is planned). [added by: Refiner]

## Area: Review additions
- [added by: Plan Architect Reviewer, verified by Planner 2026-11-20] `src/models/project/project.manager.ts` L350–L435: each custom-file operation is ~10 lines of find/replace around `loadProject`/`saveProject`; error messages embed scope and IDs (`Cannot add custom file: project with ID "..." does not exist.`, `Custom file "..." does not exist in project "...".`). `addCustomFile` uses `randomUUID()` and `this.now()`; `updateCustomFile` returns `{ previous, updated }`; `removeCustomFile` returns the removed definition.
- [added by: Plan Architect Reviewer, unverified] `src/cli/custom-files.ts` is 394 lines; `src/orchestration/custom-files.ts` 161; `src/models/project/custom-file.ts` 219; `gui/public/js/views/project-custom-files.js` 459; `src/utils/path-guard.ts` 155.
- [added by: Plan Architect Reviewer, unverified] `src/models/project/project.types.ts` L56: `CustomFiles?: CustomFile[]` inline in the project document.

## Area: Design review integration (verified by Planner, 2026-11-20)

### Verified References
- `src/cli/custom-files.ts`:
  - L32–L35: exported `EXIT_OK = 0`, `EXIT_ERROR = 1`, `EXIT_SYNC_FAILED = 2`.
  - L106 `runCustomFilesCommand(args, deps)` and L189–L271 `handleList/handleShow/handleAdd/handleUpdate/handleDelete`: the dispatch is a short switch over private handlers bound to `CustomFilesCliDeps`.
  - L161 private `class UsageError extends Error`.
  - L163–L173 private `FIELD_OPTIONS` (`file-name`, `label`, `directory`, `description`, `list-in-agents`, `no-list-in-agents`, `content-file`, `stdin`, `content`).
  - L175 private `parse(args, options)` wraps `parseArgs` (strict, positionals) and rethrows as `UsageError` with "(see 'paralizer help')".
  - L183 private `requirePositionals(positionals, count, usage)`; its message embeds `paralizer custom-files`.
  - L294 `MIN_ID_PREFIX = 4`; L302 private `resolveFile(files, ref)`: exact ID, then case-insensitive path via `customFileRelativePath()`, then unique ID prefix; its messages embed "custom file(s)" and `paralizer custom-files list <project-id>`.
  - L322 private `readContent(values, deps)`: exactly one of `--content-file` (with `-` = stdin), `--stdin`, `--content`.
  - L348 private `readListFlag(values)`: `--list-in-agents` / `--no-list-in-agents` pair.
  - L363 `syncProject()`, L373 `describe()`, L378 `report()`: scope-specific (project wording "All workspaces are in sync.").
  - L388 private `readStdin()`.
- `gui/public/js/views/project-custom-files.js`: exports `normaliseCustomFile` (L40), `formatCustomFilePath` (L59), `isExecutableHint` (L73), `buildCustomFilesSection(projectId, rawFiles, onRefresh)` (L86); private `buildFileTable(projectId, files, openEditor, onRefresh)` (L152) and `buildEditorForm(projectId, file, cb)` (L258).
- `gui/public/js/components/confirm-dialog.js` L41: `export function showConfirm(title, message)`; test `confirm-dialog.test.mjs` exists.

### Established Patterns
- Command modules take an injected deps object and keep their own dispatch (`src/cli/custom-files.ts`); shared logic is reused as plain functions, not through a template runner.
- Small focused GUI building blocks in `gui/public/js/components/` (`modal-shell.js`, `confirm-dialog.js`, `form-helpers.js`); views own their section shell.

### Structural Observations
- The CLI's parsing, content-source reading, flag-pair reading and reference resolution are scope-neutral apart from their message nouns; dispatch, help, sync hook and report wording are scope-specific.
- The project manager's collection edits are short and their error messages are scope-specific; the only generic part is find-by-id/replace.

## Area: Plan Auditor additions (2026-11-20)
- [added by: Plan Auditor, verified by Planner 2026-11-20] `src/orchestration/repository-orchestrator.ts` L42–L48: constructor `(config, projectManager, repositoryManager, workspaceArtifacts, errorLogManager?)`; `deleteRepositoryGlobally()` is synchronous (L337) and ends with `repositoryManager.remove(id)` then an `errorLogManager?.append()` audit entry (L363–L370).
- [verified by Planner 2026-11-20] `RepositoryOrchestrator` construction sites: `src/server/index.ts` L112 (5 arguments, after `RepositoryManager` L95 and `WorkspaceArtifactsOrchestrator` L99); `src/tests/repository-orchestrator.test.ts` (4- and 5-argument forms); `src/server/__tests__/routes/projects.test.ts` L62 `FakeRepositoryOrchestrator` and `src/server/__tests__/routes/repositories.test.ts` L50 `MockRepositoryOrchestrator` are standalone fakes, not subclasses.
- [verified by Planner 2026-11-20] `src/storage/json-storage.ts`: `readJsonFile` (L33), `writeJsonFile` (L56), `ensureDirectory` (L67) are all synchronous.
- [verified by Planner 2026-11-20] M1 plan `buildDefaultInfoCommitMessage(repoId)` (M1 step 8, Open Question 5): default `Paralizer: Update repository info for "{repoId}"`, exposed as `defaultCommitMessage` in `RepositoryInfoSyncStatus`, alongside `pendingChanges: string[]`.
- [added by: Plan Auditor, unverified] `src/orchestration/workspace-artifacts.ts` L62–L66: constructor `(config, projectManager, repositoryManager)`; `regenerateForRepository()` (L226) currently only loops projects containing the repository (M1 step 9 adds the project-independent sync call).
- [added by: Plan Auditor, verified by Planner 2026-11-20] `src/models/project/project.manager.ts` L16–L17: storage names are module-local constants (`INDEX_FILE`, `PROJECTS_SUBDIR`); `src/config/config.constants.ts` holds only limits/bounds constants. `src/storage/json-storage.ts` L94 `ensureDirectory(.../projects)`.
- [added by: Plan Auditor, unverified] `src/errors.ts` L6 `NotFoundError`; `src/server/__tests__/helpers/mock-http.ts` exists; `src/cli/` has no README; `src/orchestration/custom-files.ts` L48 private `guardedTarget(workspaceFolder, file)`, L126 `removeCustomFileCopy`, L154 `fs.rmdirSync` prune loop.
