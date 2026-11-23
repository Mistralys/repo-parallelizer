# Plan — Repository Workspace Sync, Milestone 2: Repository Files

## Plan Audit Cycles
- Audits: 1 (Sonnet 5.5 ×1) — Plan Auditor v1.13.1
- Architectural Reviews: 1 (Sonnet 5.5 ×1) — Plan Architect Reviewer v2.5.2

## Prior Project Context

- **M1 synthesis** (`2026-11-20-repository-workspace-sync-m1-info`, 15/15 WPs, no rework): recommends treating M1's `.workspace/info.json` + managed clone + sync orchestrator as the template for this milestone, which this plan does.
- **Patterns adopted from M1:** the `mutate(id, operationLabel, fn)` manager helper (`docs/agents/project-manifest/constraints.md` "Single-record mutator consolidation"), git argument pre-validation with literal `--` separators (`src/git/README.md`), and the `info-sync-*` health-issue vocabulary rendered through the `fixAction` action registry.
- **M1 follow-ups promoted into this plan** (each touches code this plan already changes): the commit-success toast with SHA and branch (step 20), the defensive `.catch()` in `health-alert.js` (step 20), the import-modal and info-sync-section coverage gaps (Test Plan), and the `Settings` null/array read test (Test Plan). The remaining follow-ups are listed in Deferred Items.
- **Verified M1 divergence:** M1's `commitPaths()` commits with a pathspec, which under `core.filemode=false` records an `update-index --chmod=+x` as `100644` (Planner check with git 2.56.0, recorded in `research-brief.md`). Step 8 replaces it with an index commit.
- **Insight `18d6e176-e110-40f6-9d06-af20adf2bb02`:** the CHANGELOG keeps one Unreleased heading, and `package.json` does not track it (Documentation Updates).

## Summary

Milestone 2 adds **repository-level custom files**: small files, mainly wrapper scripts such as `vendor-install.sh`, that belong to one repository and that a project-level script calls in each repository when present (`sh .workspace/files/vendor-install.sh`). Paralizer stores the files and is the authority, as it is for `info.json`. While workspace info sync is enabled, it writes them into `.workspace/files/` of the repository's managed main folder (Milestone 1), write-only-if-changed. They reach workspace clones **only through git**: Commit & Push from the managed clone, then a pull in each workspace. Each file's metadata (path, label, description, executable flag, list-in-AGENTS.md flag) is shared through a new `Files` list in `info.json`. M1's hash baseline is widened to cover the file set, so a teammate's added, changed or removed wrapper shows up as incoming, and the import dialog gains per-file choices. The workspace `AGENTS.md` lists flagged repository files. The generated `.workspace/README.md` gains a `files/` section. A `paralizer repo-files` CLI group mirrors `paralizer custom-files`, and the repository detail page gains a files section. Project custom files are unchanged.

This plan builds on Milestone 1, which is implemented (ledger project `2026-11-20-repository-workspace-sync-m1-info`, commit `d7f272e`; its plan and synthesis are archived in the ledger store). It extends M1's modules as they shipped. The plan was revised on 2026-11-20 against the shipped M1 code and the M1 synthesis: it corrects the places where the shipped code differs from the M1 plan, fixes an M1 commit behaviour that would silently drop the executable bit, and folds in the M1 follow-ups that fall inside this plan's blast radius (Prior Project Context, Deferred Items).

## Architectural Context

- **M1 (implemented)** provides:
  - the managed sparse partial clone at `{storageFolder}/repositories/{repoId}/`, with cone sparse checkout of `.workspace/` (`src/orchestration/repository-main-folder.ts`: `resolveMainFolderPath()`, `inspectMainFolder()`, `createManagedClone()`, `removeManagedClone()`);
  - the pure info module `src/orchestration/repository-info.ts`: `RepositoryInfoPayload { Id; Name; Description }`, `buildRepositoryInfoPayload(repo)`, `hashRepositoryInfoPayload()`, `readRepositoryInfoFile()`, `renderRepositoryInfoFile(payload, url, raw?)` (preserves keys outside the private `KNOWN_TOP_LEVEL_KEYS`), `evaluateRepositoryInfoSync()`, `diffRepositoryInfo()`, `writeRepositoryInfoFile()`, `writeRepositoryInfoReadme()`, `renderRepositoryInfoReadme()`, `infoFolderPathspec()`;
  - `RepositoryInfoSyncOrchestrator` (`src/orchestration/repository-info-sync.ts`), constructed as `(config, repositoryManager, errorLogManager?)`: synchronous `syncRepository()`, `getStatus()`, `getImportPreview()` → `{ state, fields }`, `applyImport(repositoryId, fields)`, `commitAndPush(repositoryId, { message? })` (stages and commits with pathspec `.workspace`), `removeManagedFolder()`, and the private per-repository mutex `withRepositoryLock(repositoryId, fn)`. Its health issues all use the `info-sync-*` prefix. `buildDefaultInfoCommitMessage(repoId)` returns `Update .workspace for "{repoId}" via Paralizer`;
  - `src/git/git-commit.ts`: `getPathStatus()`, `stagePaths()`, `commitPaths()`;
  - routes in `src/server/routes/repository-info-sync.ts`; the GUI section `gui/public/js/views/repository-info-sync-section.js`, `components/repository-info-import-modal.js`, `components/info-commit-dialog.js` (`showInfoCommitDialog()` performs the commit and resolves with the message) and the shared `components/health-alert.js`;
  - wiring: `WorkspaceArtifactsOrchestrator(config, projectManager, repositoryManager, repositoryInfoSync?, errorLogManager?)` runs `syncRepository()` from the choke-point, and `RepositoryOrchestrator(..., errorLogManager?, repositoryInfoSync?)` removes the managed folder in `deleteRepositoryGlobally()`.
- **Project custom files** (reference for mirroring):
  - pure rules in `src/models/project/custom-file.ts`;
  - writer `src/orchestration/custom-files.ts`;
  - manager methods in `src/models/project/project.manager.ts` L350–L435;
  - REST in `src/server/routes/projects.ts` L360–L500;
  - CLI `src/cli/custom-files.ts` dispatched from `src/index.ts`;
  - GUI `gui/public/js/views/project-custom-files.js`;
  - AGENTS.md rendering in `src/orchestration/workspace-index.ts` (`renderCustomFilesSection()`, `renderCliSection()`), with context built in `src/orchestration/workspace-artifacts.ts` L139–L178.
- **User decisions cited in this plan** (numbered as in the planning conversation):
  - Decision 1: project custom files stay unchanged.
  - Decision 5: sync deletes files under `files/` that are not in the data set.
  - Decision 6: file set and metadata are part of the hashed payload.
  - Decision 7: `Executable` is an explicit per-file flag.
  - Decision 8: the executable bit is committed through the git index (`update-index --chmod`).
- **Storage** (`data-flows.md` §11): `repositories.json` (all repositories, re-read on every call) and `projects/{id}.json`, both through `src/storage/json-storage.ts`.

## Approach / Architecture

### 1. Shared file-definition rules (extraction)
New `src/models/file-definition.ts` (new) takes the generic rules out of `custom-file.ts`:
- `checkPathSegment()` (today's private `checkSegment`);
- `normaliseDirectory()`, `joinRelativePath(directory, fileName)`;
- `validateFileContent(content, maxBytes)`, which covers the size and NUL checks;
- `validateLabel()`, `validateDescription()`;
- `isExecutableFile()`, `applyLineEndingPolicy()`;
- the shared limits.

`custom-file.ts` re-exports the moved symbols under their existing names and keeps `validateCustomFileInput()` with byte-identical messages.

Beyond the rules, two sets of **plain helper functions** are shared, so that the parts of the flow that must not drift (parsing, content sources, reference resolution, the editor form) exist once. Each scope keeps its own dispatch, storage, collection edits, messages and post-mutation side effects; no adapter contract or template runner is introduced:
- **CLI helpers** — new `src/cli/file-command-helpers.ts`, made from the private functions of `src/cli/custom-files.ts`:
  - `EXIT_OK`, `EXIT_ERROR`, `EXIT_SYNC_FAILED` (moved; `custom-files.ts` re-exports them under the same names);
  - `UsageError`;
  - `parseCommandArgs(args, options)` (today's `parse()`);
  - `requirePositionals(positionals, count, usage, commandName)`;
  - `FILE_FIELD_OPTIONS` (today's `FIELD_OPTIONS`);
  - `readContentSource(values, readStdin)` (today's `readContent()`);
  - `readFlagPair(values, name)` (generalises `readListFlag()`; used for `list-in-agents` and, in `repo-files`, `executable`);
  - `resolveFileReference(files, ref, { relativePath, noun, listHint })` (today's `resolveFile()`, with the scope-specific nouns and list hint passed in so the project messages stay byte-identical);
  - `readStdin()`.

  `src/cli/custom-files.ts` keeps its dispatch switch, handlers, help, `CustomFilesCliDeps`, `syncProject()`, `describe()` and `report()`, and imports the helpers. Its output and exit codes stay byte-identical. The new `src/cli/repo-files.ts` has its own short dispatch over the same helpers, calls `assertSyncEnabled()` before each mutation and `regenerateForRepository()` after it. CLI/REST parity comes from both paths using the same manager validation and the same choke-point, as for project files today.
- **GUI editor and table** — new `gui/public/js/components/file-definition-editor.js`, made from the private `buildFileTable()` and `buildEditorForm()` of `views/project-custom-files.js`, with the scope binding (`projectId`, `api.projects.customFiles`) replaced by callbacks: `buildFileDefinitionTable({ files, formatPath, onEdit, onDelete })` and `buildFileDefinitionEditor({ file, showExecutable, pathPrefixLabel, onSave, onDelete, onClose })`. Each view keeps its own section shell: intro text, busy and error state, delete confirmation through `components/confirm-dialog.js` `showConfirm()`, reload and cleanup. `views/project-custom-files.js` keeps its exported API (`normaliseCustomFile`, `formatCustomFilePath`, `isExecutableHint`, `buildCustomFilesSection`) and swaps only its private table and form for the shared ones.

Not shared, deliberately:
- the collection edits (find by ID, validate, spread, timestamp): about ten lines per operation with scope-specific error messages, so `RepositoryFileManager` writes its own and `ProjectManager` stays untouched (Structural Improvements);
- the section shells, because the repository section differs (read-only state, status refresh hook, git-only intro);
- the REST handlers (short, and their side effects differ — repository lock + sync vs project-wide regeneration);
- the writers (repository files are write-only-if-changed because they are committed; project copies are rewritten on every regeneration and stay untouched).

### 2. Repository file model and storage
New pure module `src/models/repository/repository-file.ts`:
```ts
export interface RepositoryFile {
    Id: string;            // UUID, machine-local, never written to info.json
    Directory: string;     // relative to `.workspace/files/`, '' = files/ root
    FileName: string;
    Label: string;
    Description: string;
    Content: string;       // UTF-8 text
    Executable: boolean;   // explicit; defaults from isExecutableFile() when omitted in input
    ListInAgents: boolean;
    DateModified: string;  // machine-local, not hashed
}
export interface RepositoryFileInput { Directory; FileName; Label; Description; Content; Executable?: boolean; ListInAgents }
```
- `validateRepositoryFileInput(input, others)` builds on `file-definition.ts`:
  - the path is relative to `files/`, with the same segment rules;
  - the segment `.git` is reserved, compared case-insensitively;
  - paths are unique case-insensitively;
  - content is text only, with a 256 KB maximum;
  - a repository holds at most `REPOSITORY_FILE_MAX_COUNT = 64` files (Open Question 3).
- `repositoryFileRelativePath()`.

**Storage** (Open Question 1, recommendation (b)): one document per repository at `{storageFolder}/repository-files/{repoId}.json` with the shape `{ SchemaVersion: 1, Files: RepositoryFile[] }`. This mirrors the project custom files layout, where files sit inline in a per-aggregate document (`projects/{id}.json`). It also keeps `repositories.json`, which every manager call re-reads, free of file content. New `RepositoryFileManager(config, repositoryManager)` in `src/models/repository/repository-file.manager.ts` provides:
- `list`, `get`, `add`, `update`, `remove`;
- `replaceAll(repoId, files)`, used by import;
- `removeStore(repoId)`, used by the deletion cascade.

It is stateless, re-reads the store on every call, throws `NotFoundError` for an unknown repository, and creates the folder lazily. `update` and `remove` share a private `mutate(repoId, fileId, operationLabel, fn: (existing, store) => RepositoryFile | null)` helper, following the `mutate()` convention in `constraints.md` (`RepositoryManager.mutate()` is the reference); `fn` receives the store so the case-insensitive path-uniqueness check runs inside the same load/save.

### 3. Folder-side files module
New `src/orchestration/repository-files.ts` mirrors `custom-files.ts`, but its root is `<mainFolder>/.workspace/files/`:
- `REPOSITORY_FILES_FOLDER_NAME = 'files'`.
- `readRepositoryFilesFolder(mainFolder, metadata)` returns `RepositoryFolderFile[] { path, content, metadata, problem? }`:
  - It walks `files/` without following symlinks (any symlink entry is not read and is reported in `unsafeEntries`).
  - It joins each file with its `info.json` `Files` entry by case-insensitive path. A file on disk without metadata gets defaults: `Label` = file name, empty description, `Executable` from the heuristic, `ListInAgents: false`.
  - Metadata entries without a file on disk are ignored.
  - Regular files that break the model rules (binary, too large, invalid segment) or cannot be read are returned with a `problem`, so import can refuse them.
  - The result separates two groups: `files` (every regular file, with or without a `problem`) and `unsafeEntries` (symlinks and any other non-regular entry, by path).
- `writeRepositoryFiles(mainFolder, files): { written; removed; skipped }`:
  - It runs the guard chain (lexical → realpath → directory-shape, re-checked after `mkdir`). The guard helpers come from the extracted `src/utils/path-guard.ts` function `guardedFileTarget(root, relPath)` (Structural Improvements).
  - Bytes, after the line-ending policy, are written only when they differ.
  - The mode is set only when it differs, on POSIX only.
  - The delete pass (decision 5) removes every **regular file** under `files/` that is not in the data set, checked with `lstat` immediately before removal, and prunes empty parents up to `files/`. It never removes a symlink, a non-regular entry, or an entry it cannot `lstat`; such entries are reported in `skipped` and left for a person to remove through git.
- `canonicalFilesForHash(files)` returns `[path, Label, Description, Executable, ListInAgents, sha256(LF-normalised content)]` sorted by lowercased path. Normalising line endings means a Windows `core.autocrlf` checkout never looks like an incoming change.
- **Folder-side hash participation** (what keeps the set-difference delete safe):
  - Every regular file under `files/` counts toward the folder-side hash, **including files with a `problem`**. A problem file contributes `sha256` of its raw bytes (no line-ending normalisation), and an unreadable file contributes a fixed `unreadable` marker in place of the content hash. A teammate's committed binary, oversized or unreadable file therefore changes the folder hash and surfaces as `incoming` (or `conflict`); it is never in a `write-required` folder and so never reaches the delete pass without an import decision.
  - Symlinks and non-regular entries do not count toward the hash (they cannot be represented as data), are never deleted by sync, and are reported through `info-sync-files-unsafe-entry` on every status read until removed in git. Excluding them from the hash avoids a permanent `incoming` state that no import action could resolve.
  - This makes the invariant explicit: in the `write-required` state the regular-file set on disk equals the baseline, so the regular files the delete pass removes are exactly the ones Paralizer wrote earlier.

### 4. Widened payload, hash and info.json
These changes go into M1's `repository-info.ts`:
- `RepositoryInfoPayload` gains `Files: RepositoryInfoFileEntry[]`. Each entry is `{ Path, Label, Description, Executable, ListInAgents, ContentHash }`, where `ContentHash` is in memory only, not written to the file, and is the `sha256(LF-normalised content)` element produced by `canonicalFilesForHash()` (the single place that computes it).
- **Hash compatibility rule:** when `Files` is empty, the hash is exactly M1's `JSON.stringify([Id, Name, Description])`. Otherwise `canonicalFilesForHash` output is appended as a fourth element. `Url` stays informational only, as in M1: it is not part of the payload, the hash or the import. A repository with no files keeps its M1 baseline, so the upgrade causes no spurious conflict.
- `info.json` gains `"Files": [{ "Path", "Label", "Description", "Executable", "ListInAgents" }]`, sorted by path. When no files exist the key is written as an empty array. Content never goes into `info.json`; it lives in `files/`. `SchemaVersion` stays `1` (Open Question 5): `Files` is additive, M1 readers already keep unknown keys, and a bump would make M1 installations report `unsupported-schema` and stop syncing.
- `Files` is added to the private `KNOWN_TOP_LEVEL_KEYS` set, so it is rendered from the payload and never carried over as an unknown key.
- Folder-side payload: `info.json` fields plus `readRepositoryFilesFolder()`. A malformed `Files` value (not an array, or bad entry types) makes the file `invalid`.
- The decision table is unchanged; it now covers the whole payload.
- In `syncRepository()`, a `write-required` state writes `info.json` and then calls `writeRepositoryFiles()`. Both are write-only-if-changed. A write guard that skips a file raises the `info-sync-files-write-skipped` warning. M1's README gating is unchanged.
- **The file source is mandatory.** `RepositoryInfoSyncOrchestrator` gets `repositoryFileManager` as a **required** constructor parameter: `(config, repositoryManager, repositoryFileManager, errorLogManager?)`. An orchestrator built without it would compute an empty file set for a repository that has files, evaluate `write-required`, and the delete pass would remove every committed file from the managed clone. Making it required lets the compiler find every construction site (Pattern Alignment).

### 5. Import
- `diffRepositoryFiles(local, folder)` returns `RepositoryFileDiff[]`, where each entry is `{ path, kind: 'incoming-only' | 'local-only' | 'changed', changes: ('content' | 'metadata')[], problem? }`. Identical files are omitted.
- `getImportPreview()` returns `{ state, fields, files }`.
- `applyImport(repositoryId, { fields, files: { path, action }[] })` takes these actions:

  | Diff kind | Allowed actions | Default for `incoming` | Default for `conflict` |
  |---|---|---|---|
  | `incoming-only` | `add` / `discard` | `add` | `discard` |
  | `local-only` | `keep` / `delete` | `delete` | `keep` |
  | `changed` | `overwrite` / `keep` | `overwrite` | `keep` |

  - The action on an incoming-only file is named `discard`, not `skip`, because its outcome is destructive: the merged write that follows the import removes the file from the managed clone, and the next Commit & Push removes it from the repository.
  - A file with a `problem` can only be discarded (incoming-only) or kept (changed).
  - The "Default" columns are the modal's pre-selections only. At the API level, a diff omitted from the request is treated as the `discard` or `keep` side, so Paralizer's data wins. This matches M1, where an omitted field keeps the local value; the confirmation below makes the destructive case visible in the GUI.
  - **Confirmation:** when the selection contains at least one `discard`, the modal's Apply button first opens `components/confirm-dialog.js` `showConfirm()`, listing the paths that will be removed from the clone and, after Commit & Push, from the repository. Cancelling returns to the modal with the selection intact. A selection without `discard` applies without a confirmation.
  - The action is applied through `RepositoryFileManager` (under the lock), followed by the same merged write and hash record as M1.
- The route body is now `{ fields?: string[]; files?: { path; action }[] }`. Both are optional and may be empty, so "keep everything" is valid (M1 already accepts an empty `fields` array). An unknown path or a disallowed action returns 400.

### 6. Commit & Push and executable bit
- M1's pathspec already covers `files/` for staging.
- After staging, `commitAndPush()` runs `git update-index --chmod=+x|-x -- <path>` for each file whose index mode differs from `Executable`, using the new `setIndexExecutable()` in `src/git/git-commit.ts` (decision 8).
- **The commit must take the staged index, not a pathspec.** M1's `commitPaths()` runs `git commit -m <msg> -- .workspace`. A pathspec commit rebuilds the listed entries from the working tree, so under `core.filemode=false` (Windows) the index-only `--chmod=+x` is lost and the file lands as `100644`; committing the staged index records `100755` (Planner check, `research-brief.md`). M2 therefore adds `commitStaged(repoPath, message, identity)` (plain `git commit -m`) and `getStagedPaths(repoPath)` (`diff --cached --name-only -z`) to `src/git/git-commit.ts`. `commitAndPush()` checks that every staged path lies under `.workspace/` and throws `SyncPreconditionError` otherwise (the managed clone is Paralizer's, so anything else staged there is unexpected), then commits with `commitStaged()`. `commitPaths()` stays exported for compatibility but `commitAndPush()` no longer uses it.
- The default commit message lists the changed areas. M1's `buildDefaultInfoCommitMessage(repoId)` becomes `buildDefaultInfoCommitMessage(repoId, pendingChanges: string[] = [])`. A new pure helper, `describeInfoChangeAreas(pendingChanges)`, maps the pending paths to areas in a fixed order: `info.json` for `.workspace/info.json`, `README` for `.workspace/README.md`, and `files` for any path under `.workspace/files/`. With no areas, the message is exactly M1's `Update .workspace for "{repoId}" via Paralizer`. Otherwise the areas are appended in parentheses, e.g. `Update .workspace for "{repoId}" via Paralizer (info.json, files)`. The status's `defaultCommitMessage` is built from the same `pendingChanges` list it already reports.
- **Commit feedback** (M1 follow-up): `showInfoCommitDialog()` resolves with `{ message, result }`, where `result` is the `CommitPushResult` it already receives, instead of the bare message (`null` on cancel is unchanged). The section's toast becomes `Pushed {shortSha} to {defaultBranch}.` when `commitSha` is present and stays `Committed and pushed.` otherwise; when `result.filterFallback` is true it also shows the info toast M1 planned. `defaultBranch` comes from the status the section already holds (`status.mainFolder.defaultBranch`), so `CommitPushResult` is unchanged.

### 7. Workspace AGENTS.md and README
- `WorkspaceIndexContext` gains `repositoryFiles?: WorkspaceIndexRepositoryFileRow[]` (`{ repositoryId, path, label, description }`; `Executable` is not needed, because the table does not show it and the intro states `sh <path>` for all files).
- `renderRepositoryFilesSection()` renders a "Repository Files" table: Repository | Path | Label | Description. The path is the workspace-relative path `{repoId}/.workspace/files/{path}`. The intro states:
  - the files are delivered through git and present once the repository's default branch is pulled;
  - they are invoked with `sh <path>`;
  - they are edited with `paralizer repo-files` or in the GUI, never in the clone.
- Rows come from Paralizer data for repositories whose sync is **enabled**, and only for files with `ListInAgents`. There is no filesystem check (Open Question 4). AGENTS.md is therefore deterministic and costs no per-regeneration I/O.
- `renderCliSection()` gains one pointer line for `paralizer repo-files` when at least one repository row is present.
- `renderRepositoryInfoReadme()` gains a fixed `files/` section covering:
  - the purpose (per-repository helper files such as wrapper scripts that workspace tooling calls when present);
  - delivery through git only;
  - that the files are maintained by Paralizer and local edits are overwritten;
  - invocation with `sh .workspace/files/<name>.sh`, because the executable bit is unreliable on Windows;
  - that metadata lives in `info.json` `Files`.

  The text has no paths or machine data and keeps the existing pointer to the workspace `AGENTS.md`.

### 8. Management surfaces
- **Enabled-only rule** (Open Question 2, recommendation (a)): add, update and delete return 409 `SyncPreconditionError` while sync is disabled. Listing and showing always work. Stored definitions are kept when sync is disabled and are written again on re-enable. With no baseline, a differing remote becomes the M1 `conflict` and goes through the import dialog.
- **REST** in the new `src/server/routes/repository-files.ts`, `registerRepositoryFileRoutes(router, repoManager, fileManager, infoSync, workspaceArtifacts, errorLogManager?)`:

  | Method | Path | Success | Errors |
  |---|---|---|---|
  | GET | `/api/repositories/:id/files` | 200 `RepositoryFile[]` | 404 |
  | POST | `/api/repositories/:id/files` | 201 | 400/404/409 |
  | PUT | `/api/repositories/:id/files/:fileId` | 200 | 400/404/409 |
  | DELETE | `/api/repositories/:id/files/:fileId` | 204 | 404/409 |

  Every mutation runs inside the repository lock, then calls `workspaceArtifacts.regenerateForRepository(id)`. That call runs `syncRepository()` (writing and deleting in the clone) and regenerates AGENTS.md. It is best-effort, with a logged warning. No separate "remove copies" call is needed, because the sync deletes files that are not in the data.
- **CLI** in the new `src/cli/repo-files.ts`: `paralizer repo-files list|show|add|update|delete --repo <id> [file]`. Options mirror `custom-files`, plus `--executable` / `--no-executable`. It has the same exit codes (`2` = saved but sync failed), uses `RepositoryFileManager` for validation, and then calls `regenerateForRepository()`. It never commits or pushes; its help text and success output say "Commit & Push in the Paralizer GUI to publish". `REPO_FILES_HELP` is appended in `printFullHelp()`.
- **GUI** in the new `views/repository-files-section.js`, `buildRepositoryFilesSection(repo, status, { onChanged })`, mounted below the info sync section:
  - The intro text states the git-only contract: "Files are written to the repository's `.workspace/files/` folder and reach workspaces only after Commit & Push and a pull. Paralizer never copies them into workspaces."
  - With sync disabled, the list is read-only with an enable hint.
  - It has a table and an editor (shared component) with an Executable checkbox (pre-checked from the heuristic) and a "Run with `sh .workspace/files/<path>`" hint for executable files.
  - After a save, the section asks the info sync section to refresh its status, so pending changes and the Commit & Push button update.
- The **import modal** gains a Files table with radios per the action table. The **repositories list** is unchanged.

### 9. Health issues
New issue types, reported in the M1 sync status and named with M1's `info-sync-*` prefix so that one report uses one vocabulary:
- `info-sync-files-write-skipped` (warning, `none`): a guard refused a target.
- `info-sync-files-invalid-incoming` (warning, `import`): an incoming file is binary, too large, unreadable or has an invalid path. It cannot be imported, only discarded or kept.
- `info-sync-files-unsafe-entry` (warning, `none`): a symlink or a non-file entry under `files/`. It is excluded from the hash, never deleted by sync, and stays reported until it is removed in git.

The `import` fix action now opens a longer chain (import modal → `discard` confirmation → apply). `components/health-alert.js`'s click handler awaits `onClick()` inside `try/finally` with no `catch`, so a rejection from that chain would become an unhandled promise rejection. The handler gains a `catch` that reports the error with `console.error` (the component stays free of imports, as today), so the button resets and no rejection escapes (M1 follow-up). Current callers already catch internally and are unaffected.

## Rationale

- **Per-repository store file** keeps `repositories.json` small and follows the per-aggregate pattern of `projects/{id}.json`. Up to 64 × 256 KB of content would otherwise be parsed on every repository lookup.
- **Metadata in `info.json`, content in `files/`**: the files stay real, runnable files in git, and teammates get labels, flags and descriptions without a second metadata file.
- **The hash compatibility rule** means repositories already synced under M1 with no files keep a valid baseline.
- **LF-normalised content hashing plus metadata-sourced `Executable`** makes the direction detection independent of `autocrlf` and `core.filemode`, which differ across machines.
- **`update-index --chmod`** is the only cross-platform way to commit the executable bit.
- **Data-driven AGENTS.md listing** keeps regeneration filesystem-free and deterministic, and the intro line covers the "not pulled yet" case.
- **Enabled-only mutations** keep the "files go through git" contract obvious: nothing can be saved that will not be written.

## Considered Alternatives

| Decision | Chosen Shape | Alternatives Considered | Trade-Off Summary |
|---|---|---|---|
| Content storage | `{storageFolder}/repository-files/{repoId}.json` | Inline `Repository.Files` in `repositories.json`; one raw file per entry under `{storageFolder}/repository-files/{repoId}/files/` | Inline bloats the hot `repositories.json`. Raw files need a separate metadata store and a two-phase write. One JSON document per aggregate matches projects. |
| Metadata transport | `Files` list in `info.json` | Sidecar `files.json`; front-matter in each file | `info.json` is already hashed, imported and owned by Paralizer. Front-matter would break scripts. |
| Executable source | Explicit `Executable` flag, defaulted from the heuristic | Heuristic only (as for project files); git file mode | Decision 7 asks for a flag. Git mode is unreliable on Windows. |
| Hash of files | Canonical metadata plus LF-normalised content hash, appended only when files exist | Hash raw bytes; always append an empty list | Raw bytes break under `autocrlf`. Always appending invalidates every M1 baseline. |
| Deleting removed files | Sync deletes regular files under `files/` not in the data; every regular file (problem files included) counts toward the folder hash; symlinks and non-regular entries are excluded from the hash and never deleted | Delete every entry not in the data; track a written-files ledger | Counting every regular file in the hash keeps the invariant true: in `write-required` the regular-file set equals the baseline, so the deleted files are exactly the ones Paralizer wrote. Deleting symlinks blindly could remove a teammate's commit without a decision. A ledger adds state for no gain. |
| Import action on incoming-only files | `discard`, with a confirmation listing the affected paths | `skip` without confirmation; keep incoming-only files on disk until resolved | "Skip" hid a destructive outcome. Keeping foreign files needs a "pending" state that contradicts decision 5. Renaming plus one confirmation costs almost nothing. |
| AGENTS.md source | Paralizer data (sync enabled) | Read each workspace clone's `.workspace/info.json` | A clone read adds I/O per regeneration and makes the output depend on pull state. Covered in Open Question 4. |
| Code reuse | Extract shared rules and guard helpers (`file-definition.ts`, `path-guard.ts`), CLI helper functions (`file-command-helpers.ts`) and a GUI editor/table component; each scope keeps its own dispatch, collection edits and section shell | Copy project custom files code; a CLI runner with a `FileCommandAdapter`, a shared collection module and a whole-section GUI adapter | Copying duplicates security-relevant path validation and the drift-prone parsing. The adapter layers encoded the differences between exactly two scopes as knobs (precondition, hook, read-only, executable) and forced rewrites of shipped, tested project modules; plain helpers capture the shared bulk with a smaller regression surface. |
| Commit mechanism for the executable bit | Commit the staged index (`commitStaged()`), guarded by `getStagedPaths()` | Keep M1's pathspec commit (`commitPaths()`); a temporary `GIT_INDEX_FILE` | The pathspec commit drops the index-only mode under `core.filemode=false` (verified). A temporary index adds env plumbing to `runGit` for no gain over a guarded index commit in a clone only Paralizer touches. |
| File source for the sync orchestrator | Required constructor parameter | Optional trailing parameter (repository convention); a lazily constructed internal manager | Optional lets a construction site silently delete committed files. An internal manager hides a dependency and breaks test injection. A compile error at four sites is the cheaper failure. |
| Writer location | New `repository-files.ts` beside `custom-files.ts` | Generalise `custom-files.ts` into one writer | The roots, deletion semantics (set-based vs per-file) and write-only-if-changed rules differ. A shared guard helper captures the common part. |

## Pattern Alignment

- **Follows** the pure model + manager + orchestration writer split of project custom files (`src/models/project/custom-file.ts`, `project.manager.ts`, `src/orchestration/custom-files.ts`).
- **Follows** one JSON document per aggregate with `SchemaVersion` (`projects/{id}.json`, `src/storage/json-storage.ts`).
- **Follows** module-local storage-name constants beside the manager that uses them (`INDEX_FILE`, `PROJECTS_SUBDIR` in `src/models/project/project.manager.ts`) for `REPOSITORY_FILES_SUBDIR`; `src/config/config.constants.ts` stays reserved for limits and bounds.
- **Follows** optional trailing constructor dependencies (`errorLogManager?`, `repositoryInfoSync?` on `RepositoryOrchestrator` and `WorkspaceArtifactsOrchestrator`) for the new `repositoryFileManager?` parameter on those two classes, where omitting it only skips the store cascade or the AGENTS.md listing.
- **Departs:** on `RepositoryInfoSyncOrchestrator`, `repositoryFileManager` is a **required** third parameter, inserted before the optional `errorLogManager`. Omitting it would make sync delete every committed repository file (Approach §4), so a compile error at each of the four construction sites is the intended outcome.
- **Follows** the `mutate()` manager convention (`constraints.md`, `RepositoryManager.mutate()`) inside `RepositoryFileManager`.
- **Follows** M1's `info-sync-*` health-issue vocabulary for the new issue types, and the `src/git/README.md` pre-validation contract (`exitCode: 128` with a `fatal: ...` message, literal `--` separators) for the new git functions.
- **Follows** the CLI/REST parity rule and the "agent pointer, not docs" rule (`constraints.md` "Custom Files"), and exit code `2` (`src/cli/custom-files.ts`).
- **Follows** M1's write-only-if-changed rule, the 409/502 conventions, the per-repository lock and the section-module pattern.
- **Follows** the deps-injected command module with its own dispatch (`src/cli/custom-files.ts`), reusing shared logic as plain functions (`src/cli/file-command-helpers.ts`) rather than a template runner.
- **Follows** the small-building-block component folder (`gui/public/js/components/modal-shell.js`, `confirm-dialog.js`, `form-helpers.js`) for the shared editor and table; views keep their own section shell.
- **Follows** the destructive-action confirmation through `components/confirm-dialog.js` `showConfirm()` for `discard` in the import modal.
- **Departs:** `RepositoryFile.Executable` is an explicit field where project files use only the heuristic. This is justified by decision 7 and Windows commits. The heuristic is still the default.
- **Departs:** the writer deletes by set difference instead of by previous definition (`removeCustomFileCopies`). This is justified because the M1 baseline, with every regular file under `files/` counted in the folder hash, guarantees the regular-file set equals the last write whenever Paralizer writes; symlinks and non-regular entries are never deleted.

## Structural Improvements

| Structure | Observation | Decision | Reason |
|---|---|---|---|
| `src/models/project/custom-file.ts` | Generic path, content, executable and line-ending rules sit in a project module, and `checkSegment` is private | Promoted to step 1 | The second consumer arrives now, and duplicated path validation is a security risk. |
| `src/orchestration/custom-files.ts` `guardedTarget()` + prune loop | Private guard and pruning logic | Promoted to step 2 (`guardedFileTarget()`, `pruneEmptyParents()` in `src/utils/path-guard.ts`) | Both writers need the identical guard chain. |
| `src/cli/custom-files.ts` private helpers (`parse`, `requirePositionals`, `FIELD_OPTIONS`, `readContent`, `readListFlag`, `resolveFile`, `readStdin`, exit codes) | Scope-neutral apart from message nouns, but private | Promoted to step 12 (`src/cli/file-command-helpers.ts`) | Parsing, content sources and resolution are the bulk of the module and the part that must not drift between scopes. |
| `src/cli/custom-files.ts` dispatch, handlers, help, deps, `syncProject`/`describe`/`report` | Bound to projects | Rejected (a shared runner with a `FileCommandAdapter`) | The dispatch is a short switch; an adapter would encode the two scopes' differences as knobs and force a rewrite of a shipped, tested module under a byte-identical constraint (design review, Decision 1). |
| `ProjectManager` add/update/remove custom file | Collection logic (UUID, `DateModified`, find/NotFound, replace) inline, ~10 lines per operation | Rejected | The logic is trivial and its error messages are scope-specific, so a shared module with an injected noun risks changing project messages for little gain (design review, Decision 2). `RepositoryFileManager` writes its own operations; the security-relevant shared part is already covered by step 1. |
| `gui/public/js/views/project-custom-files.js` private `buildFileTable()` / `buildEditorForm()` | Bound to `projectId` and `api.projects.customFiles` | Promoted to step 15 (`components/file-definition-editor.js`, callback-driven) | The editor form is where the complexity lives; the second consumer arrives now. Existing tests must pass unchanged. |
| `gui/public/js/views/project-custom-files.js` section shell (busy/error, delete confirm, reload) | Bound to the project view | Rejected (a whole-section adapter component) | The repository section differs mainly in the shell (read-only state, status refresh, git-only intro); an adapter would add flags for exactly those differences (design review, Decision 3). Each view keeps its own shell. |
| `workspace-artifacts.ts` unconditional `writeCustomFiles()` | Project copies are rewritten every regeneration | Rejected | Workspace copies are not committed, so the churn is invisible. Project files are out of scope (decision 1). |
| M1 `RepositoryInfoPayload` / hash | Fixed three-field payload (`Id`, `Name`, `Description`; `Url` informational only) | Promoted to step 6 | Required by decision 6, using the compatibility rule. |
| `src/git/git-commit.ts` `commitPaths()` used by M1 `commitAndPush()` | Pathspec commit discards an index-only `--chmod` under `core.filemode=false` (verified) | Promoted to step 8 (`commitStaged()` + `getStagedPaths()` guard) | Decision 8 cannot work without it; the change is local to one call site. |
| `RepositoryInfoSyncOrchestrator` constructor | Takes no file source; an optional one would let a construction site silently delete files | Promoted to step 7 (required parameter) | Data-loss guard enforced by the compiler. |
| `gui/public/js/components/info-commit-dialog.js` resolve value | Resolves only the message, so the toast cannot name the pushed commit (M1 synthesis) | Promoted to step 20 | The dialog commits the M2 file changes; widening the resolve value is a few lines. |
| `gui/public/js/components/health-alert.js` click handler | No `catch` around the awaited `onClick()` (M1 synthesis) | Promoted to step 20 | M2 lengthens the `import` action chain that runs through this handler. |
| `RepositoryInfoSyncStatus` lacks `filterFallback` for Save/Recreate (M1 synthesis) | Planned info toast never fires after Save/Recreate | Rejected (Deferred Items) | `saveSettings()` and `recreateManagedClone()` are not touched by this plan; outside the blast radius. |
| `src/orchestration/repository-main-folder.ts` `createManagedClone()` destination guard | `fs.existsSync` only, unlike `removeManagedClone()`'s lexical + realpath guard (M1 synthesis, Low) | Rejected (Deferred Items) | This plan does not change clone creation; M2's own writer has its own guard chain rooted at `.workspace/files/`. |

## Detailed Steps

1. **Extract shared file rules.**
   - Create `src/models/file-definition.ts` (new) with `checkPathSegment`, `normaliseDirectory`, `joinRelativePath`, `validateFileContent`, `validateLabel`, `validateDescription`, `isExecutableFile`, `applyLineEndingPolicy` and the limit constants.
   - `src/models/project/custom-file.ts` imports these and re-exports the previously public names. `validateCustomFileInput()` messages stay byte-identical.
2. **Extract the guard and prune helpers.**
   - Add `guardedFileTarget(root, relPath): string | null` and `pruneEmptyParents(dir, stopAt)` to `src/utils/path-guard.ts`.
   - Migrate `src/orchestration/custom-files.ts` onto them.
3. **Repository file model.** Create `src/models/repository/repository-file.ts` (new) with `RepositoryFile`, `RepositoryFileInput`, `REPOSITORY_FILE_MAX_COUNT`, `RESERVED_REPOSITORY_FILE_SEGMENTS = ['.git']`, `validateRepositoryFileInput()` and `repositoryFileRelativePath()`. Path messages refer to "the `.workspace/files/` folder".
4. **Repository file manager.**
   - Create `src/models/repository/repository-file.manager.ts` (new) with `RepositoryFileStore { SchemaVersion: 1; Files: RepositoryFile[] }` and the methods `list`, `get`, `add`, `update` (returns `{ previous, updated }`), `remove`, `replaceAll` and `removeStore`.
   - The store path is `path.join(config.storageFolder, REPOSITORY_FILES_SUBDIR, `${repoId}.json`)`, with the directory created lazily.
   - Define `REPOSITORY_FILES_SUBDIR = 'repository-files'` as a module-local (non-exported) constant at the top of `repository-file.manager.ts`, following the storage-name convention of `src/models/project/project.manager.ts` (`INDEX_FILE`, `PROJECTS_SUBDIR`). `src/config/config.constants.ts` holds only limits and bounds and is not changed.
   - All methods are synchronous, like `src/storage/json-storage.ts`. `removeStore(repoId)` deletes the store file if present and is a no-op when it is absent.
   - `add`/`update`/`remove`/`get` implement their own collection edits, mirroring `ProjectManager.addCustomFile/updateCustomFile/removeCustomFile` (`randomUUID()`, injected clock, find by ID, `NotFoundError` with repository-specific messages). `update` and `remove` go through a private `mutate(repoId, fileId, operationLabel, fn)` helper per the `constraints.md` convention, with `fn` receiving `(existing, store)` for the uniqueness check. `ProjectManager` is not changed.
5. **Folder files module.** Create `src/orchestration/repository-files.ts` (new) with `REPOSITORY_FILES_FOLDER_NAME`, `RepositoryFolderFile`, `readRepositoryFilesFolder()` (returning `files` and `unsafeEntries`), `writeRepositoryFiles()` and `canonicalFilesForHash()`, as in Approach §3. In particular:
   - the folder-side hash input includes every regular file, problem files with their raw-byte hash and unreadable files with the `unreadable` marker;
   - symlinks and non-regular entries are excluded from the hash and listed in `unsafeEntries`;
   - the delete pass removes only regular files (re-checked with `lstat` right before removal) and never a symlink, non-regular or un-`lstat`-able entry.
6. **Widen the M1 info module** (`src/orchestration/repository-info.ts`):
   - add `RepositoryInfoFileEntry` and `Files` on the payload;
   - add `Files` to the private `KNOWN_TOP_LEVEL_KEYS`;
   - `buildRepositoryInfoPayload(repo, files)`;
   - the hash compatibility rule;
   - render the `Files` array sorted by path;
   - validate `Files` on read (`invalid` when malformed);
   - `diffRepositoryFiles()`;
   - extend `renderRepositoryInfoReadme()` with the `files/` section (Approach §7).
7. **Widen the M1 sync orchestrator** (`src/orchestration/repository-info-sync.ts`):
   - the constructor becomes `(config, repositoryManager, repositoryFileManager, errorLogManager?)`, with the file manager **required** (Approach §4). Construct `RepositoryFileManager` in `src/server/index.ts` right after `RepositoryManager` (L97), so every later orchestrator can receive it (steps 10, 11, 13). Update all four construction sites: `src/server/index.ts` (L101), `src/cli/custom-files.ts` `createDefaultCustomFilesDeps()` (L147), `src/tests/repository-info-sync.test.ts` (L132) and `src/tests/cli-custom-files.test.ts` (L258). Existing M1 tests keep their assertions; they only pass a `RepositoryFileManager` on the same temp storage folder;
   - `syncRepository()` builds the payload with files, reads the folder files, and writes the files after `info.json`;
   - add the new `info-sync-files-*` health issues in `buildHealthReport()`;
   - `getImportPreview()` returns `files`;
   - `applyImport(repoId, { fields, files })` applies per-file actions through the manager;
   - add `assertSyncEnabled(repoId)`, used by the mutation routes and the CLI;
   - expose the private `withRepositoryLock` for the file routes as a public `runLocked(repoId, fn)` with the same `fn: () => Promise<T>` contract;
   - the import audit entry (`Severity: 'audit'`, `Source: 'workspace-info'`) also lists the per-file actions;
   - add the pure helper `describeInfoChangeAreas(pendingChanges)` and extend M1's `buildDefaultInfoCommitMessage(repoId, pendingChanges = [])` so the default commit message lists the changed areas, as in Approach §6 (e.g. `(info.json, files)`). With no pending changes the output is byte-identical to M1's `Update .workspace for "{repoId}" via Paralizer`. Commits keep M1's fixed Paralizer identity.
8. **Git: executable bit.**
   - Add to `src/git/git-commit.ts`:
     - `getIndexModes(repoPath, pathspec): Promise<Map<string, string>>` (`ls-files -s -z -- <pathspec>`);
     - `setIndexExecutable(repoPath, paths, executable)` (`update-index --chmod=±x -- <paths>`);
     - `getStagedPaths(repoPath): Promise<string[]>` (`diff --cached --name-only -z`);
     - `commitStaged(repoPath, message, identity)` (`commit -m <message>` with M1's identity handling and `isValidIdentityValue()` checks, no pathspec).

     Each follows the `src/git/README.md` pre-validation contract: a pathspec or path starting with `-` resolves with `exitCode: 128` and a `fatal: ...` message without spawning git.
   - In `commitAndPush()` (`src/orchestration/repository-info-sync.ts`), after `stagePaths()`: read the index modes for `.workspace/files`, call `setIndexExecutable()` for the files whose mode differs from `Executable`, then call `getStagedPaths()` and throw `SyncPreconditionError` if any staged path lies outside `.workspace/`, then commit with `commitStaged()` instead of `commitPaths()`. M1's existing `commitAndPush()` tests must pass unchanged. `commitPaths()` stays exported.
9. **Import route.** In `src/server/routes/repository-info-sync.ts`, widen `validateFieldsInput()` (today `fields` is required) to accept `{ fields?, files? }`, with both optional and allowed to be empty. Validate the actions against the allowed set; an unknown path returns 400.
10. **Repository files routes.**
    - Create `src/server/routes/repository-files.ts` (new) per Approach §8.
    - Register it in `src/server/index.ts` after the info sync routes (L161), passing the `RepositoryFileManager` instance constructed in step 7.
11. **Workspace index.**
    - In `src/orchestration/workspace-index.ts`, add `WorkspaceIndexRepositoryFileRow`, `repositoryFiles?` on the context, `renderRepositoryFilesSection()` (escaped like the custom files table), and the CLI pointer line.
    - In `src/orchestration/workspace-artifacts.ts`, add an optional trailing `repositoryFileManager?` after `errorLogManager?` (constructor becomes `(config, projectManager, repositoryManager, repositoryInfoSync?, errorLogManager?, repositoryFileManager?)`) and fill `repositoryFiles` for sync-enabled repositories in `project.Repositories` order.
12. **CLI.**
    - Create `src/cli/file-command-helpers.ts` (new) with the helpers listed in Approach §1 (`EXIT_*`, `UsageError`, `parseCommandArgs`, `requirePositionals`, `FILE_FIELD_OPTIONS`, `readContentSource`, `readFlagPair`, `resolveFileReference`, `readStdin`), moved from `src/cli/custom-files.ts`. Scope-specific wording (command name, nouns, list hint) is passed in by the caller.
    - Update `src/cli/custom-files.ts` to import them. It keeps its dispatch, handlers, `CustomFilesCliDeps`, `syncProject()`, `describe()` and `report()`, and re-exports `EXIT_OK`, `EXIT_ERROR` and `EXIT_SYNC_FAILED`. `runCustomFilesCommand()`, `createDefaultCustomFilesDeps()`, `CUSTOM_FILES_HELP` and all output and exit codes stay unchanged; `cli-custom-files.test.ts` must pass unchanged.
    - Create `src/cli/repo-files.ts` (new) with `REPO_FILES_HELP`, `RepoFilesCliDeps`, `runRepoFilesCommand(args, deps)` (its own dispatch over `list|show|add|update|delete`, using the helpers, with `--executable` / `--no-executable` read through `readFlagPair`) and `createDefaultRepoFilesDeps()`. The deps wire `RepositoryInfoSyncOrchestrator`, `RepositoryFileManager` and `WorkspaceArtifactsOrchestrator`. Each mutation calls `assertSyncEnabled()` first (failure → exit 1, nothing written) and `regenerateForRepository()` after the save (failure → exit 2).
    - Dispatch `repo-files` in `src/index.ts`, and update `printUsage()` and `printFullHelp()`.
    - Also inject `RepositoryFileManager` in `createDefaultCustomFilesDeps()` into both the `RepositoryInfoSyncOrchestrator` (required, step 7) and the `WorkspaceArtifactsOrchestrator`, so a regeneration run from the custom-files CLI neither deletes repository files nor drops the AGENTS.md listing.
13. **Deletion cascade.**
    - Add `repositoryFileManager?: RepositoryFileManager` to the `RepositoryOrchestrator` constructor in `src/orchestration/repository-orchestrator.ts` as a **new optional trailing parameter**, after the existing optional `repositoryInfoSync` (M1). Every existing construction site (`src/tests/repository-orchestrator.test.ts` and the fakes in `src/server/__tests__/routes/`) keeps compiling and passing unchanged.
    - Pass it in `src/server/index.ts` (L121 construction), using the instance built in step 7.
    - In `deleteRepositoryGlobally()` (synchronous), call `this.repositoryFileManager?.removeStore(repositoryId)` next to M1's best-effort `removeManagedFolder()` block: after `this.repositoryManager.remove(repositoryId)` succeeds and before the audit entry. A thrown error is caught, logged through `errorLogManager?.append()` as a warning in the same shape as the managed-folder warning, and not rethrown, so the global deletion and its audit entry still complete. The audit message gains " Repository file store removed." when a store existed and was removed, mirroring " Managed main folder removed.". When no manager is injected, the cascade is a no-op.
14. **GUI API.**
    - Add `api.repositories.files.{ list, create, update, remove }` to `gui/public/js/api.js`.
    - Extend `api.repositories.infoSync.applyImport(id, { fields, files })`.
    - Add `normaliseRepositoryFile()` to `gui/public/js/utils/normalise.js`.
15. **Shared GUI editor and table.**
    - Create `gui/public/js/components/file-definition-editor.js` (new) exporting `buildFileDefinitionTable({ files, formatPath, onEdit, onDelete })` and `buildFileDefinitionEditor({ file, showExecutable, pathPrefixLabel, onSave, onDelete, onClose })`, made from the private `buildFileTable()` and `buildEditorForm()` of `views/project-custom-files.js` with the project binding replaced by callbacks.
    - Update `views/project-custom-files.js` to use them in place of its private table and form. It keeps its section shell (busy/error, delete confirmation, reload) and its exported API (`normaliseCustomFile`, `formatCustomFilePath`, `isExecutableHint`, `buildCustomFilesSection`). `project-custom-files.test.mjs` must pass unchanged.
16. **Repository files section.**
    - Create `gui/public/js/views/repository-files-section.js` (new) per Approach §8, with its own section shell (git-only intro, busy/error, delete confirmation through `showConfirm()`, read-only state with the enable hint while sync is disabled) around the shared table and editor (`showExecutable: true`).
    - Mount it in `views/repository-detail.js` below the info sync section and include it in cleanup.
    - Wire a status refresh between the two sections.
17. **Import modal.** Extend `components/repository-info-import-modal.js` with a Files table (kind, path, changes, radios with the `add`/`discard`, `keep`/`delete`, `overwrite`/`keep` labels, problem text). When the selection contains a `discard`, Apply opens `showConfirm()` listing the affected paths before sending; cancelling keeps the modal and selection. It sends `files` with the selected actions.
18. **Styles.** Add the files section and import files table rules to `gui/public/css/styles.css`, reusing the custom files classes where possible.
19. **Documentation.** Apply every entry under Documentation Updates, then run `ctx generate`.
20. **Commit feedback and action safety (M1 follow-ups).**
    - `gui/public/js/components/info-commit-dialog.js`: `showInfoCommitDialog()` resolves with `{ message, result }` (the `CommitPushResult` from `api.repositories.infoSync.commitPush()`), or `null` on cancel as today.
    - `gui/public/js/views/repository-info-sync-section.js` `doCommitPush()`: toast `Pushed {first 7 chars of commitSha} to {status.mainFolder.defaultBranch}.` when both are present, else `Committed and pushed.`; an additional info toast when `result.filterFallback` is true.
    - `gui/public/js/components/health-alert.js` `buildActionCell()`: add a `catch` around `await action.onClick(issue)` that calls `console.error` and lets the `finally` reset the button.

## Dependencies

- Milestone 1 is implemented (commit `d7f272e`); steps 6–10, 14, 16, 17 and 20 modify its modules.
- Step 1 → step 3. Step 2 → step 5.
- Step 3 → 4 → 5 → 6 → 7 → 8 → 9, 10, 11, 13.
- Step 12 needs step 4 (`RepositoryFileManager`) and step 7 (`assertSyncEnabled`, `regenerateForRepository` wiring). The helper extraction inside step 12 has no dependency on other steps.
- Step 7 (construction of `RepositoryFileManager` in `src/server/index.ts`) → steps 10, 11 and 13 (server wiring). Step 10 → step 14 → steps 16 and 17. Step 9 → step 17. Step 15 → step 16 (step 15 has no code dependency on the TypeScript steps).
- Step 20 needs step 8 (commit path) and step 17 (import chain through `health-alert.js`); it has no other dependency.
- Step 19 runs last. No new npm dependencies.

## Required Components

- New: `src/models/file-definition.ts`, `src/models/repository/repository-file.ts`, `src/models/repository/repository-file.manager.ts`, `src/orchestration/repository-files.ts`, `src/server/routes/repository-files.ts`, `src/cli/file-command-helpers.ts`, `src/cli/repo-files.ts`, `gui/public/js/components/file-definition-editor.js`, `gui/public/js/views/repository-files-section.js`.
- Modified (existing): `src/models/project/custom-file.ts`, `src/utils/path-guard.ts`, `src/orchestration/custom-files.ts`, `src/orchestration/workspace-index.ts`, `src/orchestration/workspace-artifacts.ts`, `src/orchestration/repository-orchestrator.ts`, `src/cli/custom-files.ts`, `src/index.ts`, `src/server/index.ts`, `gui/public/js/api.js`, `gui/public/js/utils/normalise.js`, `gui/public/js/views/project-custom-files.js`, `gui/public/js/views/repository-detail.js`, `gui/public/css/styles.css`.
- Modified (created by M1): `src/orchestration/repository-info.ts`, `src/orchestration/repository-info-sync.ts`, `src/git/git-commit.ts`, `src/server/routes/repository-info-sync.ts`, `gui/public/js/components/repository-info-import-modal.js`, `gui/public/js/components/info-commit-dialog.js`, `gui/public/js/components/health-alert.js`, `gui/public/js/views/repository-info-sync-section.js`, `src/tests/repository-info-sync.test.ts`, `src/tests/cli-custom-files.test.ts` (construction sites only).
- Storage: new `{storageFolder}/repository-files/{repoId}.json` (lazy).

## Assumptions

- M1 is implemented as verified in `research-brief.md` ("Milestone 1 as implemented"); where the shipped code differs from the M1 plan, this plan follows the code.
- Repository IDs are immutable, so the store file name is stable.
- Wrapper scripts are small text files. Binary content is not needed.

## Constraints

- `syncRepository()` stays synchronous and spawns no subprocess.
- Paralizer never writes repository files into workspace clones.
- No CLI path commits or pushes.
- Every write goes through the guard chain rooted at `.workspace/files/`.
- Relative imports use `.js` extensions, and tests that create temp files register `process.on('exit')` cleanup.

## Out of Scope

- Any change to project custom files behaviour (the extraction refactors are behaviour-preserving).
- Copying repository files into workspaces, and pulling workspace clones.
- Binary files.
- Listing repository files from workspace clones when sync is disabled (Open Question 4).

## Human Actions

| # | Action | When | Why an agent cannot do it |
|---|--------|------|---------------------------|
| 1 | Review the resolved Open Questions below and flag any you want reopened | Before the run | Product decisions reserved by the user |
| 2 | Smoke-test: add `vendor-install.sh`, Commit & Push, pull in a workspace, run `sh .workspace/files/vendor-install.sh`; on a second machine, verify "Import available" and the per-file import | After the run | Needs real remotes and write credentials |
| 3 | Release | After the run | Releases are performed by the user |

## Acceptance Criteria

- AC-01: `RepositoryFile`, `RepositoryFileInput` and `RepositoryFileStore` match step 3 and step 4. Files are stored in `{storageFolder}/repository-files/{repoId}.json`, and `repositories.json` is unchanged. Type audit passes.
- AC-02: Validation enforces the shared segment rules, the reserved `.git` segment, case-insensitive uniqueness, text only, 256 KB per file and 64 files. Project custom file validation messages are byte-identical (existing tests unchanged).
- AC-03: With sync enabled, a mutation (REST or CLI) writes the file to `.workspace/files/<path>` in the managed clone, with the executable mode on POSIX. `info.json` `Files` carries `Path`, `Label`, `Description`, `Executable` and `ListInAgents`, sorted, with no content and no `Id`. A second sync leaves the bytes and mtimes unchanged.
- AC-04: Deleting or renaming a file removes the old path from the clone and prunes empty folders. Nothing outside `.workspace/files/` is touched, and a symlinked escape is refused. The sync delete pass never removes a symlink or non-regular entry under `files/`, and a regular file with a `problem` (binary, oversized, unreadable, invalid path) committed by a teammate changes the folder hash, so it surfaces as `incoming` or `conflict` and is removed only after an explicit `discard` in the import.
- AC-05: With sync disabled, add, update and delete return 409 (CLI exit 1) and nothing is written. List and show work.
- AC-06: A repository with no files hashes identically to M1, and an existing baseline stays `in-sync` after the upgrade. `SchemaVersion` stays 1.
- AC-07: A file added, changed (content or metadata) or removed by a teammate yields `incoming`. A concurrent local change yields `conflict`. A CRLF-only or file-mode-only difference yields no change.
- AC-08: The import preview lists files by kind, with identical files hidden. Each action in the table behaves as specified; the incoming-only actions are `add` and `discard` (no `skip`). Files with a `problem` cannot be added or overwritten. An empty selection is valid. In the modal, a selection containing `discard` requires a confirmation that lists the affected paths, and cancelling it sends nothing. After an import the state is `in-sync`.
- AC-09: Commit & Push records the executable mode for executable files in the pushed commit (`100755`), including on systems with `core.filemode=false`, by committing the staged index; a staged path outside `.workspace/` aborts the commit with a precondition error. The default commit message lists the changed areas (`info.json`, `README`, `files`) and is byte-identical to M1's `Update .workspace for "{repoId}" via Paralizer` when no changes are pending.
- AC-10: The workspace `AGENTS.md` shows a "Repository Files" table for sync-enabled repositories' `ListInAgents` files, with workspace-relative paths, the git-delivery and `sh` invocation note, and the `paralizer repo-files` pointer. It is absent when there are no rows.
- AC-11: The generated `.workspace/README.md` contains the `files/` section, contains no absolute path, and is identical across machines.
- AC-12: `paralizer repo-files list|show|add|update|delete --repo <id>` follows the same validation and sync path as REST, returns exit codes 0/1/2, never commits or pushes, and points to Commit & Push in the GUI.
- AC-13: The repository detail page shows the files section with the git-only delivery explanation, a read-only state while disabled, the Executable checkbox and the `sh` hint. A save refreshes the sync status. The import modal shows per-file choices.
- AC-14: Deleting a repository removes its file store; a store-removal failure is logged and does not block the deletion or its audit entry.
- AC-17: Every `RepositoryInfoSyncOrchestrator` construction site passes a `RepositoryFileManager` (required parameter), and a regeneration run from `paralizer custom-files` leaves a repository's committed files in the managed clone untouched.
- AC-18: After Commit & Push the toast names the short commit SHA and the default branch when both are known, and a `filterFallback` result shows an info toast. A rejected `onClick()` in `health-alert.js` resets the button and raises no unhandled rejection.
- AC-15: The shared extractions (`file-definition.ts`, `path-guard.ts` additions, `file-command-helpers.ts`, `file-definition-editor.js`) leave the project custom files behaviour unchanged (REST, CLI output and exit codes, GUI), and all existing tests pass unchanged. `ProjectManager` is not modified. `custom-files.ts` (CLI) and `repo-files.ts` contain no copies of the extracted parsing, content-source or reference-resolution logic, and `project-custom-files.js` and `repository-files-section.js` contain no copy of the editor form or table.
- AC-16: Manifest documents, module READMEs and `CHANGELOG.md` are updated, and `.context/project-folder-structure.md` is regenerated.

## Testing Strategy

- Pure unit tests for the model, the shared rules, the hash canonicalisation and the diff.
- Filesystem tests for the folder reader and writer with temp folders and symlinks.
- Real-git fixtures (as in M1) for sync, incoming detection, import and commit with mode bits.
- Route tests with `mock-http.ts`.
- CLI tests with injected deps.
- jsdom GUI tests.
- Full `npm test` and `npm run test:gui` regression.

## Test Plan

- `src/tests/file-definition.test.ts` (new): segment rules, normalisation, content checks, executable heuristic, line endings. Covers AC-02, AC-15.
- `src/tests/custom-files.test.ts`, `src/tests/project.manager.test.ts`, `src/tests/cli-custom-files.test.ts`, `src/server/__tests__/routes/projects.test.ts` (unchanged, must pass; this covers the project-side regression for the shared rules, the guard migration and the CLI helper extraction, and confirms `ProjectManager` behaviour is untouched). Covers AC-15.
- `src/tests/path-guard.test.ts` (extended): `guardedFileTarget` refuses `..` and symlink escapes; `pruneEmptyParents` stops at the root. Covers AC-04.
- `src/tests/repository-file.test.ts` (new): validation matrix including `.git`, case-insensitive duplicates, size, NUL, count limit, and the executable default. Covers AC-01, AC-02.
- `src/tests/repository-file.manager.test.ts` (new): CRUD, `replaceAll`, `removeStore`, unknown repository → `NotFoundError`, unknown file ID → `NotFoundError` through `mutate()` with the operation label in the message, a rename onto an existing path (different case) rejected inside the same load/save, lazy directory, `repositories.json` untouched. Covers AC-01, AC-02, AC-14.
- `src/tests/repository-files.test.ts` (new): reader joins metadata and defaults unlisted files, flags problems, returns symlinks and non-regular entries in `unsafeEntries`; writer is write-only-if-changed (mtime), sets modes, deletes extra regular files and prunes, refuses escapes; the delete pass leaves a symlink (to a file and to a directory) under `files/` in place and reports it in `skipped`; canonical hash ignores CRLF; the folder-side hash input changes when a binary, oversized or unreadable regular file is added and does not change when only a symlink is added. Covers AC-03, AC-04, AC-07.
- `src/tests/repository-info.test.ts` (extended): hash compatibility with no files; `Files` render, sort and validation; `Files` rendered once from the payload and not duplicated as an unknown key on rewrite; README `files/` section deterministic with no absolute path; `diffRepositoryFiles` kinds; an `info.json` whose `Settings` is `null` or an array reads as `ok` and renders `Settings: {}` (M1 follow-up). Covers AC-03, AC-06, AC-08, AC-11.
- `src/tests/repository-info-sync.test.ts` (extended, real git): enabled write of files; teammate add, change and remove → `incoming`; concurrent → `conflict`; each import action, including `discard` removing the incoming-only file from the clone and an omitted diff behaving as `discard`/`keep`; a teammate-committed binary file → `incoming`, not deleted by `syncRepository()`, refused for `add`, removed after `discard`; a committed symlink under `files/` → state unaffected, never deleted, `info-sync-files-unsafe-entry` raised; `skip` rejected as an unknown action; problem files refused; disabled → `assertSyncEnabled` throws; the health issues `info-sync-files-write-skipped` (guard refuses a target), `info-sync-files-invalid-incoming` and `info-sync-files-unsafe-entry` (symlink under `files/`) are each raised. Covers AC-03, AC-05, AC-07, AC-08.
- `src/tests/git-commit.test.ts` (extended): `setIndexExecutable` sets the mode with `core.filemode=false`; `-` prefix rejected with `exitCode: 128` and no spawn; `commitStaged()` after `--chmod=+x` under `core.filemode=false` records `100755` in `HEAD` (regression for the pathspec-commit behaviour, which records `100644`); `commitStaged()` rejects an invalid identity like `commitPaths()`; `getStagedPaths()` lists staged paths including ones outside the given folder. `getIndexModes` returns `100644`/`100755` per path for a `.workspace/` pathspec (including a file inside a `files/` subdirectory), returns an empty map for a pathspec with no tracked files, and rejects a pathspec starting with `-` without spawning git. Covers AC-09.
- `src/tests/repository-info-sync.test.ts` (extended, real git, commit): with `core.filemode=false` in the managed clone, Commit & Push of an executable repository file lands `100755` in the bare origin; a path staged outside `.workspace/` makes `commitAndPush()` throw `SyncPreconditionError` and creates no commit; M1's existing commit-and-push cases pass unchanged. Covers AC-09.
- `src/tests/repository-info-sync.test.ts` (extended, file source): a repository with committed files, synced through an orchestrator built as `createDefaultCustomFilesDeps()` builds it, keeps every file in the managed clone. Covers AC-17.
- `src/tests/cli-custom-files.test.ts` (construction site updated only; assertions unchanged). Covers AC-15, AC-17.
- `src/tests/repository-info-sync.test.ts` (extended, pure part): `describeInfoChangeAreas` maps `.workspace/info.json`, `.workspace/README.md` and paths under `.workspace/files/` to `info.json`, `README` and `files` in fixed order without duplicates; `buildDefaultInfoCommitMessage(repoId)` and `buildDefaultInfoCommitMessage(repoId, [])` are byte-identical to the M1 message `Update .workspace for "{repoId}" via Paralizer`; with info.json and two file paths pending the message ends with ` (info.json, files)`; the sync status's `defaultCommitMessage` reflects pending file changes. Covers AC-09.
- `src/tests/workspace-index.test.ts` (extended): Repository Files table, escaping, intro note, CLI pointer line, absent when empty. Covers AC-10.
- `src/tests/workspace-artifacts.test.ts` (extended): rows only for sync-enabled repositories and `ListInAgents` files, in project order. Covers AC-10.
- `src/tests/repository-orchestrator.test.ts` (extended): with a `RepositoryFileManager` injected, deletion removes the store and the audit message ends with " Repository file store removed."; a `removeStore` failure is logged and the deletion and its audit entry still complete; without the manager (the existing 4-, 5- and 6-argument constructions) deletion behaves exactly as before. Existing cases unchanged. Covers AC-14, AC-15.
- `src/tests/cli-repo-files.test.ts` (new): each subcommand, `--repo` required, content sources, `--executable` / `--no-executable`, exit codes 0/1/2 (sync hook failure → 2), disabled → 1 with nothing saved, no git calls, help text mentions Commit & Push. Covers AC-05, AC-12.
- `src/server/__tests__/routes/repository-files.test.ts` (new): status codes 200/201/204/400/404/409, regeneration called, lock used. Covers AC-03, AC-05.
- `src/server/__tests__/routes/repository-info-sync.test.ts` (extended): import body with `files`, empty selection, `discard` accepted, invalid action (including `skip`) → 400. Covers AC-08.
- `gui/public/js/components/file-definition-editor.test.mjs` (new): editor renders fields, Executable checkbox only when `showExecutable`, save/delete/close callbacks; table renders rows through `formatPath` and calls `onEdit`/`onDelete`; no `innerHTML`. Covers AC-13, AC-15.
- `gui/public/js/views/project-custom-files.test.mjs` (unchanged, must pass). Covers AC-15.
- `src/tests/file-command-helpers.test.ts` (new): `parseCommandArgs` rethrows as `UsageError`; `requirePositionals` message uses the supplied command name; `readContentSource` accepts exactly one source and `-` as stdin; `readFlagPair` rejects both flags and returns `undefined` when neither is given; `resolveFileReference` matches exact ID, then case-insensitive path, then unique prefix of at least 4 characters, and its messages use the supplied noun and list hint. Covers AC-12, AC-15.
- `gui/public/js/views/repository-files-section.test.mjs` (new): intro contract text, read-only when disabled, CRUD calls, delete confirmation, `sh` hint, status refresh callback, cleanup. Covers AC-13.
- `gui/public/js/components/repository-info-import-modal.test.mjs` (extended): files table, defaults per state (`discard` pre-selected for incoming-only in `conflict`), problem rows restricted, a selection with `discard` opens the confirmation listing the paths and sends nothing on cancel, a selection without `discard` applies directly, payload shape; a rapid double-click on Apply sends one request; a preview with an empty `fields` array and only file diffs renders and applies (M1 follow-ups). Covers AC-08, AC-13.
- `gui/public/js/components/info-commit-dialog.test.mjs` (extended): resolves `{ message, result }` after a successful commit, `null` on cancel. Covers AC-18.
- `gui/public/js/views/repository-info-sync-section.test.mjs` (extended): commit toast names the short SHA and branch, falls back to the generic text without a SHA, shows the `filterFallback` info toast; the button matrix for `main-folder-unavailable`, `invalid-file`, `id-mismatch` and `unsupported-schema` (M1 follow-up); the new `info-sync-files-*` issues render with their fix action. Covers AC-13, AC-18.
- `gui/public/js/components/health-alert.test.mjs` (extended): an `onClick` that rejects re-enables the button, restores the label and raises no unhandled rejection. Covers AC-18.
- `gui/public/js/views/repository-detail.test.mjs` (extended): files section mounted and cleaned up. Covers AC-13.
- `gui/public/js/api.repositoryFiles.test.mjs` (new): paths and methods with `encodeURIComponent`; `normaliseRepositoryFile()` fills defaults and drops unknown keys. Covers AC-13.
- Documentation review in the QA work package. Covers AC-16.

## Documentation Updates

- `docs/agents/project-manifest/api-surface.md`: the required `repositoryFileManager` parameter of `RepositoryInfoSyncOrchestrator`, `commitStaged()`, `getStagedPaths()`, the `showInfoCommitDialog()` resolve value, the new modules (`file-definition.ts`, `repository-file.ts`, `repository-file.manager.ts`, `repository-files.ts`, `repository-files` routes, `file-command-helpers.ts`, `repo-files` CLI, `file-definition-editor.js`, `repository-files-section.js`), the `path-guard.ts` additions, the M1 module extensions (payload, `applyImport` signature, `setIndexExecutable`), `WorkspaceIndexContext.repositoryFiles`, the constructor changes (optional trailing `repositoryFileManager` on `RepositoryOrchestrator` and `WorkspaceArtifactsOrchestrator`), `describeInfoChangeAreas()` and the widened `buildDefaultInfoCommitMessage(repoId, pendingChanges?)`, and `getIndexModes()`.
- `docs/agents/project-manifest/rest-api.md`: the repository files endpoints, the import body extension and the new `info-sync-files-*` health issue types.
- `docs/agents/project-manifest/data-flows.md`: §11 storage (`repository-files/`, `.workspace/files/`), a new §17 "Repository Files" (mutation → sync → Commit & Push → pull), §16 hash and import extension plus the index commit (`commitStaged()` with the staged-path guard) in Commit & Push, and the §15 cascade.
- `docs/agents/project-manifest/constraints.md`: a new "Repository Files" section covering git-only delivery, enabled-only mutations, CLI/REST parity, no commit from the CLI, the `.git` reserved segment, limits, the hash compatibility rule, the info.json `Files` rules (no content, no Id, `SchemaVersion` unchanged), the `sh` invocation recommendation, the folder-sync deletion rules (only regular files are deleted; problem files count toward the hash; symlinks and non-regular entries are never deleted), the `discard` import action and its confirmation, the shared rule modules, and the shared CLI helper functions with per-scope dispatch (`src/cli` has no README, so it is documented here and in `api-surface.md`).
- `docs/agents/project-manifest/gui-frontend.md`: the `#/repositories/:id` files section, the shared editor and table component (callback contract; views own their section shell), the import modal's `discard` confirmation, and the API namespace.
- `docs/agents/project-manifest/tech-stack.md`: no change (no new dependencies or tooling).
- `src/models/README.md`, `src/orchestration/README.md`, `src/server/README.md`, `src/utils/README.md`, `gui/README.md`, `src/git/README.md` (index commit and the new pre-validated functions), `README.md` (root, user-facing feature and `paralizer repo-files`), `CHANGELOG.md`: merge into the existing single `## Unreleased - Custom Files CLI & Repository Workspace Info Sync` heading (extend its title with "& Repository Files"; do not open a second Unreleased heading), replace the sentence "Custom files for repositories (as opposed to projects) are not part of this change yet.", and leave `package.json`'s version unchanged (insight `18d6e176-e110-40f6-9d06-af20adf2bb02`).
- `.context/project-folder-structure.md`: regenerate via `ctx generate`.

## Deferred Items

M1 synthesis follow-ups not promoted into this plan:

| # | Deferred Item | Origin | Reason Deferred | Notes |
|---|---------------|--------|-----------------|-------|
| 1 | Add `filterFallback` to `RepositoryInfoSyncStatus` so Save and Recreate show the planned info toast | M1 synthesis, Deferred (WP-013) | `saveSettings()` and `recreateManagedClone()` are outside this plan's blast radius; Commit & Push's toast is covered by step 20 | Small standalone fast-follow |
| 2 | Align `createManagedClone()`'s destination guard with `removeManagedClone()`'s lexical + realpath guard | M1 synthesis, Security Auditor (WP-006), Low | Clone creation is not touched; not exploitable given kebab-case IDs | Pair with any future change to `repository-main-folder.ts` |
| 3 | Managed clone `.git/config` holds the injected credential in cleartext | M1 synthesis, Security Auditor (WP-006/WP-009), Low | Matches existing precedent; needs a cross-cutting credential-storage review | Not a regression |
| 4 | `isValidIdentityValue()` accepts a bare `\r` | M1 synthesis, QA (WP-003) | Not exploitable (argv spawn); identity values are fixed constants | `commitStaged()` reuses the same check |
| 5 | User-chosen main folder path / mode field for the sync destination | M1 synthesis, Deferred Item 5 | Dropped by the user during M1 planning; M2 does not need it | Additive via a future mode field |
| 6 | `Url` importable behind a confirmation step | M1 synthesis, Deferred Item 6 | Rejected during M1 planning; unchanged by repository files | Reopen only on request |
| 7 | Listing repository files for teammates without sync, from the workspace clone's `info.json` | Open Question 4, option (c) | Deterministic data-driven listing chosen for this milestone | Natural follow-up |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Upgrade from M1 invalidates baselines** | Hash compatibility rule plus a test (AC-06). |
| **Spurious incoming from `autocrlf` or file modes** | LF-normalised content hash; `Executable` taken from metadata, not the disk mode. |
| **Deleting a teammate's file unintentionally** | Deletion happens only in the `write-required` state, and every regular file (problem files included) counts toward the folder hash, so any foreign regular file makes the state `incoming` or `conflict` instead. Symlinks and non-regular entries are never deleted. Incoming-only files are removed only through the explicitly named `discard` action, which the modal confirms with the list of affected paths. |
| **Path escape inside the repository** | Shared guard chain rooted at `files/`, reserved `.git`, symlinks skipped by the reader. |
| **Users expecting immediate delivery to workspaces** | Contract text in the GUI section, README, AGENTS.md and CLI output. |
| **Refactors altering project custom files** | Byte-identical messages; existing suites unchanged. |
| **Large stores slowing sync** | 64-file and 256 KB limits; per-repository store read only for that repository. |
| **Executable bit lost on Windows commits** | Commit & Push commits the staged index (`commitStaged()`), verified against the pathspec behaviour; regression tests under `core.filemode=false` (AC-09). |
| **A construction site without a file source deletes committed files** | `repositoryFileManager` is a required constructor parameter of `RepositoryInfoSyncOrchestrator`; test AC-17. |
| **Index commit picks up unrelated staged changes** | `getStagedPaths()` guard aborts when anything outside `.workspace/` is staged. |
| **CLI mutations are not serialised with a running GUI server** | The M1 mutex is in-process, so `paralizer repo-files` (a separate process) can run its sync write while the GUI server is mid-`commitAndPush` on the same clone. Accepted, as for M1's existing `regenerateForRepository()` callers (the custom-files CLI already runs it out of process): sync writes are write-only-if-changed, and a git failure caused by contention surfaces as an error the user can retry. No cross-process lock is added in this milestone. |

## Recommended Workflow

- **Workflow:** ledger
- **Rationale:** Twenty steps across models, orchestration, git, REST, CLI and GUI, with a security-relevant writer and delete pass and a correction to shipped M1 commit behaviour, benefit from the formal QA, security-audit and review stages that M1 ran through.

---

## Open Questions

**All resolved:** the user accepted every recommendation below (2026-11-19).

1. **Where Paralizer stores file content.**
   - Options: (a) inline `Repository.Files` in `repositories.json`; (b) one store per repository at `{storageFolder}/repository-files/{repoId}.json` (metadata and content); (c) raw files under `{storageFolder}/repository-files/{repoId}/` plus a metadata JSON.
   - **Recommendation: (b).** It mirrors project custom files (inline in the per-aggregate `projects/{id}.json`) and keeps the frequently re-read `repositories.json` small. (c) needs a two-phase write with no gain. Affects steps 4 and 13.
2. **Managing files while sync is disabled.**
   - Options: (a) mutations only while enabled, with definitions kept and read-only while disabled; (b) allow editing while disabled, stored but not written.
   - **Recommendation: (a).** It keeps the git-only contract obvious, and (b) invites edits that silently go nowhere. Affects steps 7, 10, 12 and 16.
3. **Naming rules, limits and binary files.**
   - Options: (a) project custom file segment rules plus reserved `.git`, 256 KB per file, 64 files, text only; (b) the same plus a total cap (e.g. 2 MB); (c) also allow binary files (base64 storage).
   - **Recommendation: (a).** Wrappers are small text scripts. A total cap is implied by 64 × 256 KB. Binary support can be added later with a `Encoding` field. Affects step 3.
4. **Does the AGENTS.md listing require the file to exist in the workspace clone?**
   - Options: (a) list from Paralizer data (sync-enabled repositories only), with a note that the file is present once pulled; (b) list only when the file exists in the clone (filesystem check per regeneration); (c) (a) plus, for repositories without sync, list from the workspace clone's own `.workspace/info.json` `Files`, so teammates without sync enabled also get the listing.
   - **Recommendation: (a)** for this milestone. It is deterministic and filesystem-free. (c) is the natural follow-up if teammates who don't enable sync need the listing. Affects step 11.
5. **Does `Files` in info.json need a `SchemaVersion` bump?**
   - Options: (a) no bump: additive key, absent means none, and M1 readers already preserve unknown keys; (b) bump to 2, which makes M1 installations report `unsupported-schema` and stop syncing.
   - **Recommendation: (a).** Reserve bumps for breaking changes to existing keys. Affects step 6.
6. **Subdirectories inside `files/`.**
   - Options: (a) allowed via `Directory`, as for project files; (b) flat `files/` only.
   - **Recommendation: (a)** for parity with project custom files and the shared editor. A flat layout remains the documented convention for wrappers.
7. **Default import choices in the `conflict` state.**
   - Options: (a) keep local for every file (discard, keep, keep; named `skip` before the 2026-11-20 design review renamed the action); (b) same defaults as `incoming`.
   - **Recommendation: (a)**, consistent with M1's "keep" default for conflicting fields. Affects step 17.
8. **Should the files section offer a "Commit & Push" shortcut?**
   - Options: (a) no, the info sync section's Commit & Push is the single action and the files section refreshes it; (b) a duplicate button in the files section.
   - **Recommendation: (a).** One action covers the whole `.workspace/` folder.
