# Plan — Repository Workspace Sync, Milestone 1: Repository Info

## Plan Audit Cycles
- Audits: 2 (Sonnet 5.5 ×2) — Plan Auditor v1.13.1
- Architectural Reviews: 1 (Sonnet 5.5 ×1) — Plan Architect Reviewer v2.5.1

## Summary

Repository descriptions (and names) entered in the Paralizer GUI end up in every generated workspace `AGENTS.md`, but they live only in Paralizer's machine-local `repositories.json`, so they can't be shared through version control. This plan adds an opt-in, per-repository **workspace info sync**. Paralizer writes a versioned `info.json` (Id, Name, Description as synced fields, a credential-stripped Url for information only, plus room for future settings) into a `.workspace/` convention folder inside the repository's **main folder**: a Paralizer-managed sparse, partial clone under `{storageFolder}/repositories/{repoId}/`. The main folder is always managed; there is no user-chosen path. Paralizer is the authority. Writes happen alongside the existing artefact regeneration, and only when content actually changes. A last-written hash decides direction: a local edit is written silently, an incoming git change becomes "Import available", and both changing at once is a conflict that opens an import dialog. The GUI gets status and health issues, a per-field **Import** dialog (the only operation where Paralizer is not the authority) and a **Commit & Push** action for pending changes. Custom files stay out of scope for implementation; their agreed direction is recorded as a future phase.

## Architectural Context

- **Layering** (`docs/agents/project-manifest/tech-stack.md`): Storage → Models → Error Log → Git → Orchestration → Server → CLI. Managers are stateless and re-read JSON on every call (`src/models/repository/repository.manager.ts`).
- **Repository model** (`src/models/repository/repository.types.ts`): `Repository { Id, Name, Url, CredentialId?, Description?, LastRefreshedAt? }`. Optional additions need no `SCHEMA_VERSION` bump (`src/storage/storage.types.ts`, `constraints.md`).
- **Git layer** (`src/git/`): stateless wrappers over `runGit()` (`git-cli.ts`). `shell: false`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`. Clone via `cloneRepository()` (`git-clone.ts`, `CloneOptions { depth, branch, bare, timeoutMs }`). Default branch via `getDefaultBranch()` (`git-branch.ts`). Credentials via `resolveCredential()` + `injectCredentialToken()`, with output scrubbed by `stripEmbeddedCredentials()` (`git-credentials.ts`).
- **Credential at rest:** existing workspace clones keep the token-injected URL as `remote.origin.url` (no `set-url` anywhere in `src/`). Background polling (`src/server/pollingManager.ts`) relies on it.
- **Artefact choke-point** (`src/orchestration/workspace-artifacts.ts`): `WorkspaceArtifactsOrchestrator.regenerateWorkspace()/regenerateProject()/regenerateForRepository()`. These are synchronous and called from routes, orchestrators and the custom-files CLI. They write `.code-workspace`, `README.md`/`AGENTS.md`/`CLAUDE.md` (`workspace-index.ts`) and custom files (`custom-files.ts`). The orchestrator is instantiated in `src/server/index.ts` and in `src/cli/custom-files.ts`.
- **Path guards** (`src/utils/path-guard.ts`): `isLexicallyContained()`, `escapesRootViaRealpath()`, `resolveRootRealPath()`. Shared by the index writer and by the repository delete guard.
- **Health** (`src/orchestration/workspace-health.ts`): `WorkspaceHealthIssue { type, severity, message, fixAction, repositoryId? }`. Rendered by the private `buildHealthAlertSection()` in `gui/public/js/views/workspace-detail.js`.
- **Repository REST** (`src/server/routes/repositories.ts`): CRUD and credential routes. `PUT /:id` calls `regenerateForRepository()` best-effort and holds the inline host-incoherence auto-clear of `CredentialId`.
- **Deletion cascade** (`src/orchestration/repository-orchestrator.ts` `deleteRepositoryGlobally()`, `data-flows.md` §15).
- **GUI** (`gui/public/js/`): vanilla ES modules with no build step. `views/repository-detail.js` holds the Credential section and the workspace table. Section modules follow `views/project-custom-files.js`, and modals are built on `components/modal-shell.js`.

## Approach / Architecture

### 1. Info file (pure module)
New `src/orchestration/repository-info.ts` mirrors `workspace-index.ts`: pure functions with explicit paths and no manager access.
- Constants: `REPOSITORY_INFO_FOLDER_NAME = '.workspace'` (resolved — Open Question 1), `REPOSITORY_INFO_FILE_NAME = 'info.json'`, `REPOSITORY_INFO_SCHEMA_VERSION = 1`.
- File shape (`RepositoryInfoFile`), written with 4-space indentation and a trailing newline, like `writeJsonFile()`:
  ```json
  {
      "SchemaVersion": 1,
      "Id": "my-repo",
      "Name": "My Repo",
      "Url": "https://github.com/org/my-repo.git",
      "Description": "Short description",
      "Settings": {}
  }
  ```
  Keys are PascalCase to match every persisted Paralizer file (confirmed — Open Question 2). `Description` is always present, with an empty string when unset. `Settings` is a reserved object for future repo-level settings. On write, unknown top-level keys and unknown `Settings` keys already in the file are preserved, so an older Paralizer never strips data written by a newer one. Credentials and `CredentialId` are never written. `Url` always passes through `stripEmbeddedCredentials()`.
- **`Url` is informational only** (Open Question 12, revised after the architectural review). The registered `Url` is a per-user choice (HTTPS with a token versus SSH, or an enterprise host alias), so two colleagues sharing a repository would otherwise flip the file between their remote forms and manufacture `incoming`/`conflict` states. `Url` is therefore excluded from the hash, the diff and the import. It is written from the local repository data whenever the file is written for another reason (creation, a synced-field change, an import), but a difference in `Url` alone is never a reason to write. The file's `Url` therefore reflects the remote form of the machine that last wrote it. A missing or non-string `Url` in the file is tolerated and replaced on the next write.
- `RepositoryInfoPayload { Id; Name; Description }` is the synced field set. `hashRepositoryInfoPayload(payload)` computes the SHA-256 (`node:crypto`) of `JSON.stringify([Id, Name, Description])`. Hashing parsed fields, not file bytes, means formatting-only edits in git don't register as a change.
- `readRepositoryInfoFile(mainFolder)` returns `{ status: 'absent' | 'ok' | 'invalid' | 'unsupported-schema', payload?, raw?, error? }`. `invalid` covers unparseable JSON, a non-object, or missing/non-string synced fields (`Id`, `Name`, `Description`). `unsupported-schema` means `SchemaVersion > REPOSITORY_INFO_SCHEMA_VERSION`.
- `renderRepositoryInfoFile(payload, informationalUrl, existingRaw?)` returns the file content string.
- `evaluateRepositoryInfoSync({ dataHash, folder, lastWrittenHash, repositoryId })` returns a `RepositoryInfoSyncState` (decision table below).
- `diffRepositoryInfo(current, incoming)` returns `RepositoryInfoFieldDiff[]` for the import dialog.

**Decision table** (`evaluateRepositoryInfoSync`):

| Folder file | Condition | State | Sync action |
|---|---|---|---|
| absent | — | `write-required` | write (create), also when a previously synced file was deleted upstream |
| invalid | — | `invalid-file` | none; health issue |
| unsupported-schema | — | `unsupported-schema` | none; health issue |
| ok | `Id` ≠ repository Id | `id-mismatch` | none; health issue |
| ok | folderHash = dataHash | `in-sync` | none (record hash as baseline if it differs) |
| ok | no baseline (`LastWrittenHash` unset) | `conflict` | none; import dialog (first enable on a repo that already carries a different file) |
| ok | folder = baseline, data ≠ baseline | `write-required` | write silently (local edit) |
| ok | folder ≠ baseline, data = baseline | `incoming` | none; "Import available" |
| ok | folder ≠ baseline, data ≠ baseline | `conflict` | none; import dialog |

**A missing folder is never an error.** The convention is opt-in: with sync disabled Paralizer does not look for the folder, and with sync enabled a missing `.workspace/info.json` is simply created on the next sync. That includes the first sync after enabling (creation is automatic, no separate step) and a file that was deleted upstream after an earlier sync (recreated silently; Paralizer is the authority). No health issue is raised for absence; the creation shows up as pending changes, ready for Commit & Push.

When sync is disabled the state is `disabled`. When the main folder is missing or unusable it is `main-folder-unavailable`. Both short-circuit before evaluation.

### 2. Main folder
New `src/orchestration/repository-main-folder.ts`:
- The main folder is always the managed clone. No setting, REST body or GUI control accepts a folder path (the custom-path override was dropped; see Deferred Items).
- `resolveMainFolderPath(config, repoId)` returns `path.join(config.storageFolder, 'repositories', repoId)`. Repository IDs are kebab-case validated, so the path cannot traverse.
- `inspectMainFolder(folder, repoUrl)` is async and git-backed. It returns `MainFolderInspection { exists; isGitRepository; remoteUrl (stripped); remoteMatches; currentBranch; defaultBranch; ahead; behind; pendingChanges: string[] }`.
  - Remote matching uses the new `remoteUrlsMatch()`: strip credentials from both sides, lowercase the host, drop a trailing `/` and `.git`. Both sides derive from the registered `Url`, so a mismatch only appears after the repository's `Url` was edited locally (the repository form's PUT); the fix action recreates the clone. `Url` is never imported, so no import path changes the remote.
  - `pendingChanges` comes from `git status --porcelain -- <folderName>`.
  - Ahead/behind are counted against `refs/remotes/origin/<defaultBranch>`.
- Managed clone lifecycle:
  - `createManagedClone(config, repo, authUrl)`, in order:
    1. Guard the destination.
    2. `git clone --filter=blob:none --no-checkout <authUrl> <dest>`.
    3. Detect the `filtering not recognized by server` warning and report `filterFallback: true`.
    4. `git sparse-checkout set --cone <folderName>`.
    5. `getDefaultBranch()`.
    6. Verify that `refs/remotes/origin/<default>` exists (`git rev-parse --verify`). `getDefaultBranch()` falls back to the literal `'main'` without checking the ref (`src/git/git-branch.ts` L69–L111), so an empty remote (no commits) or a remote without that branch would otherwise fail at checkout with an opaque error. When the ref is missing, throw `MainFolderPreconditionError` ("The remote has no commits or its default branch could not be found; push an initial commit first").
    7. `git checkout <default>`.

    Any failure from step 2 onwards removes the partially created destination (same two-layer guard as `removeManagedClone()`) before the error propagates, so a failed enable leaves no folder behind and no `InfoSync` setting is persisted (`saveSettings` persists only after the clone succeeds).
  - `removeManagedClone(config, repoId)` uses a strict-descendant lexical guard plus `escapesRootViaRealpath()` against the managed root, the same two layers as `removeRepositoryFromProject()`.

### 3. Sync orchestrator
New `src/orchestration/repository-info-sync.ts`, class `RepositoryInfoSyncOrchestrator(config, repositoryManager, errorLogManager?)`:
- `syncRepository(repositoryId): RepositoryInfoSyncResult` is **synchronous and filesystem-only**, so it can run inside the synchronous artefact choke-point:
  1. Resolve the folder and short-circuit when unavailable (no `.git` entry).
  2. Read the file, hash the data, evaluate.
  3. On `write-required`, run the guard chain against the main-folder root, `mkdir` the info folder, and write **only if the rendered bytes differ** from the existing bytes.
  3b. Independently of the decision table, write the generated `.workspace/README.md` when its rendered bytes differ, **except** in the states `disabled`, `main-folder-unavailable`, `id-mismatch`, `incoming` and `conflict`. Skipping `incoming`/`conflict` keeps a README-only pending change from blocking the fast-forward in Refresh and from clashing with an upstream README; the README is written on the first sync after the import resolves the state. The README is generated, not data: it is excluded from the hash, never imported, and local edits to it are overwritten silently. It goes through the same guard chain as `info.json` (`writeRepositoryInfoReadme()`, step 6).
  4. Record `LastWrittenHash`/`LastSyncedAt` through `RepositoryManager.recordInfoSyncWrite()`.
  5. On `in-sync` with a stale or missing baseline, record the hash only. An `in-sync` file whose informational `Url` differs from the local `Url` is **not** rewritten (see §1).
- **No STABLE-clone discovery.** Paralizer reads `.workspace/` only from the main folder it maintains. Discovery of an existing upstream file happens on enable: the first sync against a differing file is the no-baseline `conflict` row, which opens the import dialog. The toggle's help text says so (step 16).
- `getStatus(repositoryId): Promise<RepositoryInfoSyncStatus>` makes no network calls. It combines `inspectMainFolder()`, the evaluated state and the derived `HealthReport`.
- `saveSettings(repositoryId, input): Promise<RepositoryInfoSyncStatus>`:
  1. Validate the input (`{ enabled, discardPendingChanges? }`).
  2. **Disabling:** refuse with a `PendingChangesError` if the managed clone has pending changes, unless `discardPendingChanges`. Otherwise remove the managed clone.
  3. **Enabling:** create the managed clone (async git).
  4. Persist: enabling stores `{ Enabled: true }` (no hash); disabling removes the `InfoSync` field via `setInfoSyncSettings(id, null)`. Either way `LastWrittenHash` does not survive a change of the enabled flag.
  5. Run `syncRepository()` and return the status.
- `refresh(repositoryId)`:
  1. Re-set `origin` to the current authenticated URL, then fetch the default branch with `--filter=blob:none`.
  2. Run `git merge --ff-only origin/<default>` when behind and nothing is pending (Open Question 4).
  3. Run `syncRepository()` and return the status.
- `getImportPreview(repositoryId)` requires state `incoming` or `conflict`, the file status `ok`, and a matching `Id`. It returns `{ state, fields: RepositoryInfoFieldDiff[] }`.
- `applyImport(repositoryId, fields: RepositoryInfoImportField[])`:
  1. Re-read and re-validate the file.
  2. Apply the selected fields (`Name`, `Description`) through `RepositoryManager.update()`. That path enforces the description limit. `Url` is not an importable field; the repository's registered `Url`, its credential and the managed clone are untouched by an import.
  3. Write the merged result through the same writer (`write-only-if-changed`, with the local `Url` as the informational value) and record the hash. After an import the folder and the data agree, so the state becomes `in-sync`, or `write-required`→written when the user kept local values.
  4. Write an audit log entry.
  5. The route then calls `regenerateForRepository()`.
- `commitAndPush(repositoryId, { message? })`:
  1. Inspect the folder. Refuse (`SyncPreconditionError`) when the folder is unavailable, the remote mismatches, the checkout is not on the default branch, or the state is `incoming`/`conflict`/`invalid-file`/`id-mismatch`/`unsupported-schema`, or when there is nothing pending.
  2. Re-set `origin` to the current authenticated URL and fetch.
  3. If behind: when `git diff --name-only HEAD..origin/<default> -- <folderName>` is non-empty, refuse ("incoming changes, import first"). Otherwise `git merge --ff-only origin/<default>`.
  4. `git add -A -- <folderName>`, then `git -c user.name=<INFO_COMMIT_AUTHOR_NAME> -c user.email=<INFO_COMMIT_AUTHOR_EMAIL> commit -m <message> -- <folderName>`. The pathspec keeps the commit limited to the info folder even if the clone was edited by hand. The commit always carries the fixed Paralizer identity (Open Question 6); the user's git config is neither read nor required.
  5. `git push origin HEAD:refs/heads/<default>`.
  6. Re-fetch to update the tracking ref.
  7. Write an audit log entry.

  Every surfaced stderr is passed through `stripEmbeddedCredentials()`. A push rejected with HTTP 403 / "permission"/"denied" gets a hint that the credential needs write access.
- `recreateManagedClone(repositoryId, { discardPendingChanges? })`: refuses with a `PendingChangesError` when the managed clone has pending changes, unless `discardPendingChanges`. Otherwise it removes the clone, re-clones it with the current authenticated URL, clears `LastWrittenHash` (the new clone is a fresh baseline-less folder, so a differing file routes through the import dialog), and runs `syncRepository()`.
- `removeManagedFolder(repositoryId)` is synchronous. It is used by the deletion cascade.
- **Per-repository async mutex** (`Map<repoId, Promise>`) serialises `saveSettings`/`refresh`/`applyImport`/`commitAndPush`/`recreateManagedClone` on the same repository, avoiding `index.lock` races between the GUI's concurrent requests.

### 4. Credential handling for the main folder
- A new shared helper `resolveRemoteAuth(repo, credentials)` in `src/orchestration/remote-auth.ts` replaces the duplicated block in the workspace and repository orchestrators. It returns `{ ok: true, url, credential }` or `{ ok: false, host, message }`.
- The managed clone follows the existing workspace-clone convention. `origin` holds the token-injected URL, which partial-clone lazy blob fetches need (see brief, Git Layer). Before every fetch or push in a managed clone, `origin` is re-set to the current authenticated URL so that credential rotation takes effect (Open Question 9).

### 5. Trigger integration
- `WorkspaceArtifactsOrchestrator` gains an optional 4th constructor parameter `repositoryInfoSync?: RepositoryInfoSyncOrchestrator` and an optional 5th `errorLogManager?: ErrorLogManager` (used to log sync warnings).
  - `regenerateWorkspace()` calls `syncRepository()` for each resolved repository.
  - `regenerateForRepository()` calls `syncRepository(repositoryId)` **once up front**, regardless of project membership. That covers repositories that are in no project.
  - Each sync call is wrapped in try/catch and logged as a warning, so a sync failure never breaks artefact regeneration.
  - Write-only-if-changed makes repeated calls in a `regenerateProject()` loop cheap: one small file read and a hash per repository per workspace.
- Both composition sites (`src/server/index.ts`, `src/cli/custom-files.ts`) construct and inject it.
- `RepositoryOrchestrator` gains an optional `repositoryInfoSync` constructor parameter. `deleteRepositoryGlobally()` calls `removeManagedFolder()` after `repositoryManager.remove()` succeeds; failures are logged, not thrown.

### 6. REST
A new route module, `src/server/routes/repository-info-sync.ts`, provides `registerRepositoryInfoSyncRoutes(router, repoManager, infoSync, workspaceArtifacts, errorLogManager?)`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/repositories/:id/info-sync` | Status + health (no network) |
| PUT | `/api/repositories/:id/info-sync` | Save settings `{ enabled, discardPendingChanges? }` |
| POST | `/api/repositories/:id/info-sync/refresh` | Fetch + fast-forward (when nothing is pending) + sync + status |
| POST | `/api/repositories/:id/info-sync/recreate-main-folder` | Remove and re-clone `{ discardPendingChanges? }`; 409 with pending changes unless discarded |
| GET | `/api/repositories/:id/info-sync/import` | Import preview (per-field diff) |
| POST | `/api/repositories/:id/info-sync/import` | Apply `{ fields: ('Name' \| 'Description')[] }` (`fields` may be empty = keep all local values; any other value, including `Url`, is a 400) |
| POST | `/api/repositories/:id/info-sync/commit-push` | Commit & push `{ message? }` |

Errors: 400 validation, 404 unknown repository, 409 precondition (`PendingChangesError`, `SyncPreconditionError`, `MainFolderPreconditionError` such as an empty remote), 502 remote git failure (fetch/push/clone), with credential-stripped messages.

### 7. GUI
- **Shared component, extracted:** `components/health-alert.js` exports `buildHealthAlert(report, { title, actions })`, where `actions` is a `fixAction → { label, onClick }` registry. `workspace-detail.js` migrates onto it; the markup and CSS classes stay the same.
- **New section module:** `views/repository-info-sync-section.js` exports `buildRepositoryInfoSyncSection(repo, { onRepositoryChanged })`. It is mounted in `repository-detail.js` below the Credential section and contains:
  - the settings form: a "Sync workspace info" toggle with an explanation of what enabling means (see step 16);
  - a status block: state label, main folder path (read-only), branch, ahead/behind, and the list of pending files;
  - a health alert with fix actions: `import` (opens the modal), `commit-push`, `refresh`, `recreate-main-folder` (confirms first when there are pending changes, then retries with `discardPendingChanges: true`) and `configure-credential` (scrolls to and focuses the Credential section of the same page);
  - Refresh / Import… / Commit & Push buttons.

  On load, a `conflict` state opens the import modal once per page visit (see "GUI Interaction & Accessibility Spec" in step 16). A cleanup function cancels in-flight work flags.

  The full interaction, feedback and accessibility rules for this section live in the **GUI Interaction & Accessibility Spec** (step 16) and the visual spec (step 18).
- **New modal:** `components/repository-info-import-modal.js` exports `showRepositoryInfoImportModal({ repoId, repoName, preview })`. It is built on `modal-shell.js`. A per-field table (`Name`, `Description`) shows the current value, the incoming value, and a radio for keep or import. Identical fields are hidden. The default choice is "import" for `incoming` and "keep" for `conflict`. `Url` is not listed, because it is informational and never imported. The modal is a single step; there is no confirmation sub-step.
- **Commit & Push confirmation:** a small modal on `modal-shell.js` with an editable message pre-filled with `status.defaultCommitMessage` (Open Question 5) and the list of pending files.
- **`views/repositories.js`:** a "Sync" column with an enabled/off badge read from `repo.infoSync?.enabled`. It makes no per-row status calls.
- **`api.js`:** `api.repositories.infoSync.{ status, saveSettings, refresh, recreateMainFolder, importPreview, applyImport, commitPush }`.

## Rationale

- **Synchronous, filesystem-only `syncRepository()`** lets the sync run inside the existing synchronous artefact choke-point (see Where sync runs, Considered Alternatives) without making every regenerate caller async. Every operation that actually needs git (clone, fetch, ff, commit, push, status inspection) sits behind explicit async endpoints.
- **Hash of the parsed synced fields** instead of file bytes means a formatting-only commit isn't reported as an incoming change. Comparing rendered bytes before writing gives the "no mtime/git-status churn" guarantee.
- **`Url` is informational, not synced.** A repository's registered remote differs legitimately between users (HTTPS with a token, SSH, host aliases). Hashing or importing it would make each colleague's write look like an incoming change or a conflict for the others. Keeping it in the file (credential-stripped) still lets agents and Milestone 2 read it, while removing the URL confirmation step, clone recreation on import and the second consumer of the credential-coherence rule.
- **Trigger stays at the artefact choke-point.** Repository data only changes through a few paths (PUT, import, settings), so most choke-point calls are no-ops. The choke-point is still kept because it gives three things the narrower trigger set would need extra wiring for: silent recreation of a deleted file on any regeneration, coverage of the custom-files CLI, and a single, already-established entry point. Write-only-if-changed keeps the redundant calls to one small read and a hash.
- **"No baseline + differs" is treated as `conflict`.** On first enable against a repository whose file came from a colleague, neither side is authoritative. Routing it through the import dialog lets the user choose per field instead of silently overwriting shared data.
- **Clearing `LastWrittenHash` on enable/disable and on clone recreation** prevents a stale baseline from an earlier clone misclassifying the direction.
- **Managed clone keeps the token in `origin`.** Partial-clone lazy blob fetches go through `origin`, so a clean `origin` breaks private HTTPS repositories. This matches how every workspace clone already works, and keeps the managed clone under Paralizer's storage folder.
- **Commit pathspec plus a default-branch check** are cheap safety nets: the managed clone should only ever hold info-folder changes on the default branch, and these guarantee it even if someone edits the clone by hand.
- **Managed main folder only.** A user-chosen path (dedicated clone or STABLE clone) would need path validation, SSH/HTTPS remote equivalence, a wrong-branch guard for feature branches, never-reconfigure rules, and writes outside Paralizer's storage. With Import and Commit & Push both working on the managed clone, the override adds little; the user dropped it for simplicity.
- **Separate route module and section module** keep `routes/repositories.ts` (576 lines) and `views/repository-detail.js` (843 lines) from absorbing a self-contained feature, following the `project-custom-files.js` precedent.

## Considered Alternatives

| Decision | Chosen Shape | Alternatives Considered | Trade-Off Summary |
|---|---|---|---|
| Where sync runs | Sync filesystem-only `syncRepository()` called from `WorkspaceArtifactsOrchestrator` | (a) Make all regenerate methods async; (b) run sync only from the repository mutation paths (PUT, import, settings) plus Refresh and a startup sweep; (c) observer hooks on `RepositoryManager` mutators | (a) touches ~15 call sites for no benefit since writing a file needs no git. (b) is narrower and avoids the optional constructor parameters, but needs its own startup sweep and CLI hook to recreate a deleted file and cover `paralizer custom-files`, which the choke-point gives for free; most choke-point calls are cheap no-ops thanks to write-only-if-changed. (c) contradicts the stateless-manager pattern. |
| Synced field set | `Id`, `Name`, `Description` hashed and importable; `Url` written for information only | (a) `Url` hashed and importable behind a confirmation; (b) `Url` hashed through a canonical form via `remoteUrlsMatch()` | (a) turns per-user remote forms (HTTPS/SSH/host alias) into false `incoming`/`conflict` states between colleagues and needs a confirmation step, clone recreation on import and a coherence helper. (b) reduces but does not remove false conflicts (SSH aliases still differ). |
| Direction detection | Hash of canonical synced fields vs `LastWrittenHash` | Git history inspection (`git log -- .workspace`), mtime comparison; a baseline snapshot of the last-written field values | Git history doesn't work for uncommitted local state and is expensive; mtime is unreliable across checkouts. A snapshot would allow per-field three-way resolution, but with only `Name` and `Description` diffable the "each side edited a different field" case is rare and the dialog already shows both values; it is additive later (Deferred Items). |
| Info settings storage | Grouped `Repository.InfoSync` object | Flat fields on `Repository` | A group keeps one optional field, one destructure to clear, and room for future machine-local sync settings. |
| Managed clone auth | Token in `origin` (existing convention), re-set before each operation | Clean `origin` + explicit URL; `-c http.extraHeader`; `GIT_CONFIG_*` env; per-command inline credential helper (`-c credential.helper='!f(){…}; f'`, token passed by environment variable) | A clean `origin` breaks lazy blob fetch. `extraHeader` is a new auth mechanism with host-specific Basic formats. `GIT_CONFIG_COUNT` needs git 2.31, above the documented 2.28 minimum. The inline helper would keep the token out of `.git/config`, but it is an unproven, shell-snippet-based mechanism that needs a Windows and macOS spike and would diverge from every existing workspace clone; it belongs to the global token-at-rest revisit (Deferred Items). |
| Generated folder README | `.workspace/README.md` written alongside `info.json` | A `Notice` key inside `info.json`; Paralizer docs only | The README is what people and agents browsing the repository in git actually find; a JSON key is far less discoverable. Its extra cost (skipping in `incoming`/`conflict`) is a single state check in the existing writer, and Milestone 2 extends it with the `files/` section. |
| Discovery of an existing upstream file | On enable, via the no-baseline `conflict` row and the toggle's help text | Scan each containing project's STABLE clone while sync is disabled and show a hint | The STABLE scan adds a second reader of user-owned clones, can lag behind the remote, and duplicates a path that already exists (enabling opens the import dialog). |
| Filter fallback | Detect the warning on a single clone | Probe the server first, or retry without `--filter` | Git already falls back to a full clone by itself, so a retry would duplicate work. |
| Health types | Generic `HealthIssue`/`HealthReport` with workspace aliases | Duplicate types for repositories | A single shape keeps the GUI component and docs uniform. The aliases keep existing imports compiling. |
| GUI health rendering | Extract `components/health-alert.js` with an action registry | Copy `buildHealthAlertSection()` into the new view | Copying duplicates markup and the if-chain grows in two places. |
| REST placement | New `routes/repository-info-sync.ts` | Add to `routes/repositories.ts` | Keeps the file focused, with independent tests. Same URL prefix, so no API visibility difference. |
| Settings entry point | Section on the repository detail page | Fields in `repository-modal.js` | Enabling triggers a long-running clone with status, errors and actions that belong next to the status block. The modal stays a quick metadata form. |
| Import scope | Main folder only | Any workspace clone | One authoritative location keeps the hash baseline meaningful (Open Question 3). |
| Main folder location | Managed clone only | Managed default plus a custom-path override (dedicated or STABLE clone) | The override brought path validation, remote equivalence, a wrong-branch guard and writes to user-owned folders. Dropped by the user; it can be added later without a schema change (Deferred Items). |

## Pattern Alignment

- **Follows** the pure-module + orchestrator split of `src/orchestration/workspace-index.ts` / `workspace-artifacts.ts` (`repository-info.ts` / `repository-info-sync.ts`).
- **Follows** stateless git wrappers returning `GitResult` (`src/git/git-branch.ts`). New files `git-remote.ts` and `git-commit.ts` sit beside them.
- **Follows** the path-guard chain from `src/utils/path-guard.ts`, used by the index writer and the repository delete guard.
- **Follows** the optional-field, no-schema-bump policy (`src/storage/storage.types.ts`).
- **Follows** credential stripping on all stderr (`constraints.md` "Git Subprocess Security") and the audit entries for destructive or remote mutations (`repository-audit` pattern in `repository-orchestrator.ts`).
- **Follows** one `register*Routes()` per file (`src/server/routes/`), section modules (`gui/public/js/views/project-custom-files.js`), modals on `components/modal-shell.js`, and API sub-namespaces (`api.workspaces.launch`).
- **Departs:** first write path that is **write-only-if-changed**, where `writeWorkspaceIndexFiles()` writes unconditionally. Justified because the info file is committed to git, and churn there is user-visible.
- **Departs:** HTTP **502** for remote git failures. Existing routes use 500 for orchestrator failures. 502 distinguishes "remote rejected/unreachable" from internal bugs so the GUI can phrase the error. It is documented in `rest-api.md`.
- **Departs:** first GUI test that reads `gui/public/css/styles.css` as text (`gui/public/js/__tests__/styles.info-sync.test.mjs`). The GUI suites are jsdom-only and no browser tooling is configured (`package.json` L51–L52), so a string-level stylesheet assertion is the only in-run check for the CSS side of AC-17d; it adds no dependency.
- **Departs:** first **in-process async mutex**. Concurrent git operations on one working copy were not possible before; it is justified by GUI double-submits and the refresh-plus-commit overlap.

## Structural Improvements

| Structure | Observation | Decision | Reason |
|---|---|---|---|
| `src/orchestration/workspace-orchestrator.ts`, `src/orchestration/repository-orchestrator.ts` | Credential resolve/inject/"requires a credential" block duplicated | Promoted to step 2 | A third consumer (clone/fetch/push for main folders) would make three copies of security-sensitive code. |
| `src/server/routes/repositories.ts` (PUT `/:id`) | Host-incoherence `CredentialId` auto-clear is inline in the handler | Rejected | Its only planned second consumer was the `Url` import, which the architectural review removed (`Url` is informational). With the PUT handler as the sole consumer, an extraction has no current consumer, and this plan no longer touches `routes/repositories.ts` otherwise, so it is outside the blast radius. Reconsider when a second `Url` mutation path appears. |
| `src/orchestration/workspace-health.ts` | Issue/report types are workspace-named but generic | Promoted to step 1 | The repository sync report reuses the shape; aliases avoid churn. |
| `gui/public/js/views/workspace-detail.js` `buildHealthAlertSection()` | Private, if-chain dispatch, not reusable | Promoted to step 14 | The second consumer arrives in this plan; the registry replaces a growing if-chain. |
| `src/models/repository/repository.manager.ts` | `load → findIndex → NotFoundError → mutate → save` repeated per mutator | Promoted to step 5 (private `mutate(id, op, fn)` helper used by new and existing mutators) | The plan adds two mutators, which would bring the repeated sequence to five copies; consolidating now keeps `NotFoundError` messages and save semantics uniform, and Milestone 2 adds further repository-level state. The architectural review weighed leaving the existing mutators alone; the migration is kept because the risk is bounded by byte-identical messages and the existing `repository.manager.test.ts` suite, and a single-style class is cheaper to extend than a mixed one. |
| `src/orchestration/workspace-artifacts.ts` `regenerateForRepository()` | Does nothing for a repository that is in no project | Promoted to step 9 | Repository-level artefacts need a project-independent trigger. |
| `src/server/index.ts` + `src/cli/custom-files.ts` | Both hand-construct `WorkspaceArtifactsOrchestrator` | Rejected (wire both sites explicitly in step 11, and add a CLI test asserting the dependency is injected) | A shared composition-root factory would also have to cover the menu CLI and the server's other orchestrators. That broader refactor is outside this plan's blast radius, and two explicit sites plus a test are enough. |
| `src/server/routes/repositories.ts` size (576 lines) | Would absorb seven handlers | Promoted to step 12 (new route module) | Keeps resource files focused. |
| `gui/public/js/views/repository-detail.js` size (843 lines) | Would absorb a large section | Promoted to step 16 (section module) | Same reasoning as `project-custom-files.js`. |
| `src/git/git-cli.ts` `runGitOrThrow()` | Includes raw stderr in error message (not stripped) | Promoted to step 3 (apply `stripEmbeddedCredentials()` to stderr in its message) | New callers pass authenticated URLs; hardening the shared helper is a one-line change inside the touched module. |

## Detailed Steps

1. **Generic health types.**
   - Create `src/orchestration/health.types.ts` (new) with `HealthIssue { type: string; severity: 'error' | 'warning'; message: string; fixAction: string; repositoryId?: string }` and `HealthReport { healthy: boolean; issues: HealthIssue[] }`.
   - In `src/orchestration/workspace-health.ts`, replace the local interfaces with `export type WorkspaceHealthIssue = HealthIssue; export type WorkspaceHealthReport = HealthReport;`.
   - Existing tests (`src/tests/workspace-health.test.ts`) must pass unchanged.
2. **Shared remote auth helper.**
   - Create `src/orchestration/remote-auth.ts` (new) with:
     ```ts
     export type RemoteAuthResolution =
         | { ok: true; url: string; credential: GitCredentialEntry | null }
         | { ok: false; host: string; message: string };
     export function resolveRemoteAuth(repo: Repository, credentials: GitCredentialEntry[]): RemoteAuthResolution
     ```
   - Behaviour and message text are identical to the current block in `workspace-orchestrator.ts` L141–L170. Document that the returned `url` must be consumed immediately by a git call and never stored or returned across an API boundary.
   - Migrate `WorkspaceOrchestrator.createWorkspace()` and `RepositoryOrchestrator.addRepositoryToProject()` onto it, keeping their log entries unchanged.
3. **Git layer.**
   - `src/git/git.types.ts`:
     - Extend `CloneOptions` with `filter?: 'blob:none'` (string-literal union, extendable) and `noCheckout?: boolean`.
     - Add `PathStatusEntry { code: string; path: string }`.
   - `src/git/git-clone.ts`:
     - Push `--filter=<f>` and `--no-checkout` in `cloneRepository()`.
     - Export a constant `FILTER_UNSUPPORTED_WARNING = 'filtering not recognized by server'`.
     - Add `setSparseCheckout(repoPath, paths: string[]): Promise<GitResult>`, which runs `sparse-checkout set --cone -- <paths>` and rejects any path starting with `-`.
   - `src/git/git-remote.ts` (new):
     - `getRemoteUrl(repoPath, remote = 'origin'): Promise<string | null>`
     - `setRemoteUrl(repoPath, remote, url): Promise<GitResult>`
     - `fetchBranch(repoPath, branch, { filter?, timeoutMs? }): Promise<GitResult>`, which fetches from `origin` with refspec `+refs/heads/<b>:refs/remotes/origin/<b>`
     - `pushHead(repoPath, branch, timeoutMs?): Promise<GitResult>`, which runs `push origin HEAD:refs/heads/<b>`
     - `mergeFastForward(repoPath, ref): Promise<GitResult>`
     - `countAheadBehind(repoPath, ref): Promise<{ ahead: number; behind: number } | null>`
     - `changedPathsBetween(repoPath, from, to, pathspec): Promise<string[]>`
     - `remoteUrlsMatch(a, b): boolean` (normalisation described in Approach §2)

     Validate that every branch argument does not start with `-` and matches a safe refname pattern (`^[A-Za-z0-9._/-]+$`, no `..`). This addresses the known gap noted in `constraints.md` for the new functions.
   - `src/git/git-commit.ts` (new):
     - `getPathStatus(repoPath, pathspec): Promise<PathStatusEntry[]>`, which runs `status --porcelain -- <pathspec>`
     - `stagePaths(repoPath, pathspec)`, which runs `add -A -- <pathspec>`
     - `commitPaths(repoPath, pathspec, message, identity: { name; email }): Promise<GitResult>`, which runs `-c user.name=<name> -c user.email=<email> commit -m <message> -- <pathspec>`, rejects an empty message and rejects an identity value containing a newline or starting with `-`.
   - `src/git/git-cli.ts`: `runGitOrThrow()` applies `stripEmbeddedCredentials()` to stderr before building its message.
   - Add a push timeout constant `PUSH_TIMEOUT_MS = 60_000` to `src/orchestration/orchestration.types.ts`. Reuse `CLONE_TIMEOUT_MS`/`FETCH_TIMEOUT_MS`.
   - Add the info-sync commit constants to `src/config/config.constants.ts` (next to `MAX_REPOSITORY_DESCRIPTION_LENGTH`, L120), so they exist before their consumers in steps 8 and 12:
     - `INFO_COMMIT_AUTHOR_NAME = 'Paralizer'`
     - `INFO_COMMIT_AUTHOR_EMAIL = 'paralizer@mistralys.eu'` (Open Question 6, Assumptions)
     - `MAX_INFO_COMMIT_MESSAGE_LENGTH = 500` (Open Question 5)

     `commitPaths()` itself stays identity-agnostic (it takes `identity` as a parameter); the orchestrator passes the constants in step 8.
4. **Repository types.**
   - In `src/models/repository/repository.types.ts` add:
     ```ts
     export interface RepositoryInfoSyncSettings {
         Enabled: boolean;
         LastWrittenHash?: string;    // sha256 hex of the canonical synced payload last written/accepted
         LastSyncedAt?: string;       // ISO 8601
     }
     // on Repository:
     InfoSync?: RepositoryInfoSyncSettings;
     ```
   - No `SCHEMA_VERSION` bump.
5. **Repository manager.**
   - In `src/models/repository/repository.manager.ts` add a private `mutate(id, operationLabel, fn)` helper and migrate `update`, `updateCredential` and `touchRefreshTimestamp` onto it. Error messages must stay byte-identical.
   - Add:
     - `setInfoSyncSettings(id, settings: RepositoryInfoSyncSettings | null): Repository`. `null` removes the field by destructuring (this is what disabling sync does).
     - `recordInfoSyncWrite(id, hash: string): Repository`, which sets `LastWrittenHash` and `LastSyncedAt` and throws an `Error` when `InfoSync` is absent.
   - Confirm `update()` preserves `InfoSync`.
6. **Info file module.** Create `src/orchestration/repository-info.ts` (new) with the constants, `RepositoryInfoFile`, `RepositoryInfoPayload`, `RepositoryInfoReadResult`, `RepositoryInfoSyncState` (`'disabled' | 'main-folder-unavailable' | 'in-sync' | 'write-required' | 'incoming' | 'conflict' | 'invalid-file' | 'id-mismatch' | 'unsupported-schema'`), `RepositoryInfoImportField = 'Name' | 'Description'` (a string-literal union, extendable when a future synced field is added), `RepositoryInfoFieldDiff { field; current; incoming }`, and the functions:
   - `buildRepositoryInfoPayload(repo)`: returns `{ Id, Name, Description }`, using `''` for an absent description.
   - `buildInformationalUrl(repo)`: the registered `Url` passed through `stripEmbeddedCredentials()`.
   - `hashRepositoryInfoPayload()`: hashes `[Id, Name, Description]` only.
   - `readRepositoryInfoFile(mainFolder)`: `Url` is not validated as a synced field; a missing or non-string `Url` does not make the file `invalid`.
   - `renderRepositoryInfoFile(payload, informationalUrl, existingRaw?)`: preserves unknown keys; `SchemaVersion` is always the current value; writes `Url` from `informationalUrl`.
   - `evaluateRepositoryInfoSync()`: the decision table, driven by the hash only, so an `Url`-only difference evaluates as `in-sync`.
   - `diffRepositoryInfo()`: compares `Name` and `Description` only.
   - `writeRepositoryInfoFile(mainFolder, content): { written: boolean }`: runs the guard chain with the main folder as root (`isLexicallyContained` → `escapesRootViaRealpath` with `resolveRootRealPath(mainFolder)` → directory-shape check on the info folder), then `mkdir` of the info folder, and writes only when the bytes differ.
   - `writeRepositoryInfoReadme(mainFolder): { written: boolean }`: same guard chain and write-only-if-changed rule as `writeRepositoryInfoFile()` (a shared private helper), writing `renderRepositoryInfoReadme()` to `README.md` in the info folder.
   - `infoFolderPathspec()`: the folder name with a trailing `/`.
   - `REPOSITORY_INFO_README_FILE_NAME = 'README.md'` and `renderRepositoryInfoReadme(): string`, a pure function with a fixed text. The README explains:
     - what the `.workspace/` folder is (repository information for multi-repository workspaces, managed by the Paralizer tool);
     - what `info.json` holds and that it is generated, so manual edits are overwritten unless made through Paralizer;
     - that credentials and machine-local settings are never stored here;
     - that changes are committed by the repository owners;
     - how to find Paralizer: no install path is written; instead it points to the `AGENTS.md` at the root of the surrounding workspace folder, which carries the Paralizer CLI section.

     The text has no machine-specific content, so it renders identically on every machine and never causes cross-machine churn. Milestone 2 extends it with the `files/` section.
7. **Main folder module.** Create `src/orchestration/repository-main-folder.ts` (new) with:
   - `MANAGED_MAIN_FOLDER_DIR = 'repositories'`
   - `getManagedMainFolderRoot(config)`
   - `resolveMainFolderPath(config, repoId)`
   - `MainFolderInspection`
   - `inspectMainFolder(folder, repoUrl): Promise<MainFolderInspection>`
   - `createManagedClone(config, repo, authUrl): Promise<{ path: string; defaultBranch: string; filterFallback: boolean }>` (throws `MainFolderGitError` carrying stripped stderr for git failures, and `MainFolderPreconditionError` when the default-branch ref does not exist after the clone, e.g. an empty remote; removes the partial destination on any failure, see Approach §2)
   - error classes `MainFolderGitError` and `MainFolderPreconditionError` (both exported; messages credential-stripped)
   - `removeManagedClone(config, repoId): boolean` (two-layer guard)
   - `deriveMainFolderIssues(inspection): HealthIssue[]`
   - `isMainFolderUsable(inspection)`

   Inspection runs git calls in parallel where independent and skips git entirely when the folder does not exist.
8. **Sync orchestrator.**
   - Create `src/orchestration/repository-info-sync.ts` (new) with `RepositoryInfoSyncOrchestrator`, implementing everything in Approach §3–§4, plus:
     - `RepositoryInfoSyncStatus { enabled; mainFolder: MainFolderInspection & { path: string } | null; state; pendingChanges: string[]; lastSyncedAt?: string; defaultCommitMessage: string; health: HealthReport }`
     - `RepositoryInfoSyncResult { state; written: boolean }`
     - `RepositoryInfoSyncSettingsInput { enabled: boolean; discardPendingChanges?: boolean }`
     - `CommitPushResult { committed: boolean; pushed: boolean; commitSha?: string; filterFallback?: boolean }`
     - error classes `SyncPreconditionError`, `PendingChangesError`, `RemoteOperationError` (message already credential-stripped)
     - `buildDefaultInfoCommitMessage(repoId)`
     - `recreateManagedClone(repositoryId, { discardPendingChanges? })`
     - the private `withRepositoryLock(repoId, fn)`
   - Health issue types emitted, with `fixAction` in parentheses:
     - `info-sync-main-folder-missing` (`recreate-main-folder`), also used when the folder exists but is not a git repository
     - `info-sync-remote-mismatch` (`recreate-main-folder`)
     - `info-sync-wrong-branch` (`recreate-main-folder`), defensive: only possible if the clone was changed by hand
     - `info-sync-behind-remote` (`refresh`)
     - `info-sync-pending-changes` (`commit-push`)
     - `info-sync-import-available` (`import`)
     - `info-sync-conflict` (`import`)
     - `info-sync-invalid-file` (`none`)
     - `info-sync-id-mismatch` (`none`)
     - `info-sync-unsupported-schema` (`none`)
     - `info-sync-credential-missing` (`configure-credential`)
   - Log entries use `Source: 'workspace-info'` with operations `sync`, `clone-main-folder`, `refresh`, `import`, `commit-push`, `remove-main-folder`. Import and commit-push are written as `Severity: 'audit'`, sync failures as `warning`, and the filter fallback as `warning`.
9. **Choke-point integration.**
    - Give `WorkspaceArtifactsOrchestrator` an optional 4th constructor param `repositoryInfoSync?: RepositoryInfoSyncOrchestrator` and an optional 5th `errorLogManager?`.
    - In `regenerateWorkspace()`, call `syncRepository()` per resolved repository.
    - In `regenerateForRepository()`, call `syncRepository(repositoryId)` first, independent of project membership.
    - Each call goes through a private `safeSync(repoId)` that catches the error and logs `Severity: 'warning'`, `Source: 'workspace-info'`, `Operation: 'sync'`.
    - Update the class docblock to state that the info file is a repository-level artefact, not a per-workspace one.
10. **Deletion cascade.**
    - Give `RepositoryOrchestrator` an optional `repositoryInfoSync` constructor param (appended after `errorLogManager`).
    - After `repositoryManager.remove()` succeeds in `deleteRepositoryGlobally()`, call `repositoryInfoSync?.removeManagedFolder(repositoryId)` inside try/catch, logging a warning on failure.
    - Record the removal in the existing `delete-repository-global` audit message (append "managed main folder removed" when applicable).
11. **Composition.**
    - `src/server/index.ts`: construct `RepositoryInfoSyncOrchestrator(config.appConfig, repoManager, errorLogManager)` before `WorkspaceArtifactsOrchestrator`, then inject it (and `errorLogManager`) into the artefact orchestrator, and inject it into `RepositoryOrchestrator` and the new route registrar.
    - `src/cli/custom-files.ts`: construct it in the deps builder (L144–L146) and inject it into `WorkspaceArtifactsOrchestrator` (no error log manager exists in the CLI, so the 5th parameter is omitted there).
12. **REST routes.**
    - Create `src/server/routes/repository-info-sync.ts` (new) with `registerRepositoryInfoSyncRoutes(router, repoManager, infoSync, workspaceArtifacts, errorLogManager?)` implementing the table in Approach §6.
    - Body validation:
      - `enabled` and `discardPendingChanges`, when present, must be booleans.
      - `fields` must be an array whose values are `'Name'` or `'Description'` (`Url` or any other value → 400). An empty array is valid and means "keep all local values": it rewrites the file from Paralizer data and resolves the `incoming`/`conflict` state, matching the modal's empty selection.
      - `message`, when present, must be a string with trimmed length 1–`MAX_INFO_COMMIT_MESSAGE_LENGTH` (500; the constant is added to `src/config/config.constants.ts` in step 3).
    - Error class mapping: validation failures → 400, `PendingChangesError`/`SyncPreconditionError`/`MainFolderPreconditionError` → 409, `RemoteOperationError`/`MainFolderGitError` → 502, `NotFoundError` → 404, anything else → 500 with a generic message.
    - After a successful import, call `workspaceArtifacts.regenerateForRepository(id)` best-effort, with a logged warning on failure, like `logArtifactWarning()`.
    - Register it in `src/server/index.ts` after `registerRepositoryRoutes()`.
13. **GUI API client.**
    - In `gui/public/js/api.js`, add the `api.repositories.infoSync` sub-namespace: `status(id)`, `saveSettings(id, data)`, `refresh(id)`, `recreateMainFolder(id, discardPendingChanges?)`, `importPreview(id)`, `applyImport(id, fields)`, `commitPush(id, message?)`. Path params go through `encodeURIComponent`.
    - Add JSDoc typedefs for the status shape.
    - `utils/normalise.js` `normaliseRepo()` is a whitelist mapper that drops unknown keys, so add `infoSync: repo.InfoSync ? { enabled, lastSyncedAt } : undefined`. Leave `LastWrittenHash` out, because the GUI has no use for it.
14. **Shared health alert component.**
    - Create `gui/public/js/components/health-alert.js` (new) exporting `buildHealthAlert(report, { title, actions })`, which returns `HTMLElement | null`. `actions` maps `fixAction` to `{ label, onClick(issue) }`; an unknown or `none` action renders a message-only row. Markup and classes are identical to today's.
    - Migrate `views/workspace-detail.js` `buildHealthAlertSection()` onto it (the existing three actions become registry entries). Existing tests in `workspace-detail.index-health.test.mjs` and `workspace-detail.credential-error.test.mjs` must pass unchanged.
15. **Import modal + commit dialog.**
    - Create `gui/public/js/components/repository-info-import-modal.js` (new). `showRepositoryInfoImportModal({ repoId, repoName, preview })` returns `Promise<{ applied: boolean }>`. It is built on `createModalShell` with `className: 'modal--form'`:
      - one row per differing field: label, current value, incoming value, and radios Keep / Import;
      - an explanatory line for the `conflict` state;
      - only `Name` and `Description` rows; `Url` is never offered (it is informational);
      - "Apply" calls `api.repositories.infoSync.applyImport()` with the selected fields. Selecting no fields is valid and means "keep all"; it re-writes the file from Paralizer data and resolves the conflict.
      - The modal uses `setBusy()` during the request, and server errors are shown inline in a `role="alert"` region inside the modal.
      - **Radio grouping:** each field row is a `<fieldset>` with a `<legend>` naming the field ("Name", "Description"); the Keep/Import radios share a `name` per field and are reachable with arrow keys. Current and incoming values are shown in labelled, wrapping blocks (`overflow-wrap: anywhere`, multi-line descriptions preserved with `white-space: pre-wrap`); an empty value is rendered as an explicit "(empty)" placeholder.
      - **Single step, no modal stacking.** The modal has one step and opens no further overlay (`createModalShell` supports one overlay at a time).
      - The initial focus target is the first field's currently selected radio; on close, focus returns to the control that opened the modal (the shell's focus restoration, with the Import… button as the fallback when the opener was removed by a re-render).
    - Create `gui/public/js/components/info-commit-dialog.js` (new). `showInfoCommitDialog({ pendingFiles, defaultMessage })` returns `Promise<string | null>`.
      - The message is a labelled `<textarea>` or input with a visible character counter. Inline validation (`aria-invalid`, error text tied with `aria-describedby`) enforces a trimmed length of 1–500 characters (the same limit as the route), and the Commit button is disabled while invalid.
      - The pending-files list is a scrollable `<ul>` with a bounded max height; long paths wrap.
      - Initial focus is on the message field. The modal uses `setBusy()` while the request runs and shows server errors (409, 502 with the write-access hint) inline in a `role="alert"` region.
16. **Repository detail section.**
    - Create `gui/public/js/views/repository-info-sync-section.js` (new) exporting `buildRepositoryInfoSyncSection(repo, { onRepositoryChanged })`, which returns `{ element, cleanup }`, as described in Approach §7. State labels:
      - in-sync: "Up to date"
      - write-required: "Will be written on next sync"
      - incoming: "Import available"
      - conflict: "Conflict"
      - disabled: "Off"
      - main-folder-unavailable: "Main folder unavailable"
      - invalid-file: "Invalid info file"
      - id-mismatch: "Id mismatch"
      - unsupported-schema: "Unsupported file version"
    - Next to the toggle, a short explanation states what enabling does: Paralizer creates a managed sparse clone of the repository, creates or updates `.workspace/info.json` in it with the repository's name and description (plus its URL for information), keeps that file in sync from then on (recreating it if it is deleted), and leaves committing to the user via Commit & Push. If the repository already contains workspace info that differs from Paralizer's data, enabling offers it for import. Credentials are never written. The text is plain help text tied to the toggle with `aria-describedby`.
    - The main folder path is shown read-only. Saving shows a busy state, since cloning can take up to `CLONE_TIMEOUT_MS`.
    - Disabling while there are pending changes triggers a `showConfirm()` warning and then retries with `discardPendingChanges: true`.
    - The `filterFallback: true` result shows an info toast.
    - Mount it in `views/repository-detail.js` after the Credential section, and include its cleanup in the view's returned cleanup.

    **GUI Interaction & Accessibility Spec** (applies to the section, the modals and the list badge):

    *a) Toggle and save behaviour*
    - The "Sync workspace info" control is a checkbox with `role="switch"` and a visible `<label>`. **Flipping it does not save.** It only changes a pending form value; an explicit **Save** button (disabled until the value differs from the persisted one) performs `saveSettings`. This avoids launching a long clone from a single accidental click.
    - While saving, the toggle, Save and all action buttons are disabled, the Save button shows a busy label ("Cloning repository…" when enabling, "Removing clone…" when disabling) and the section sets `aria-busy="true"`. A text note states that cloning can take a while.
    - On failure (400/409/502) the toggle reverts to the persisted value and the error is shown inline in the section (`role="alert"`) with the credential-stripped message. Failed enable attempts leave no half-state in the UI (the server removes a partial clone; the status is re-fetched after any failure).
    - Disabling with pending changes: `showConfirm()` lists the pending files and states they will be discarded; confirming retries with `discardPendingChanges: true`.

    *b) Button enablement matrix* (all buttons also disabled while any request of this section is in flight, which prevents double submits in addition to the server mutex):

    | State | Refresh | Import… | Commit & Push |
    |---|---|---|---|
    | disabled | hidden | hidden | hidden |
    | main-folder-unavailable | hidden (fix action `recreate-main-folder` shown instead) | disabled | disabled |
    | in-sync, no pending files | enabled | disabled | disabled |
    | write-required / in-sync with pending files | enabled | disabled | enabled |
    | incoming | enabled | enabled (primary) | disabled |
    | conflict | enabled | enabled (primary) | disabled |
    | invalid-file / id-mismatch / unsupported-schema | enabled | disabled | disabled |

    A disabled button carries a short reason in its `title` and in visually-hidden text tied via `aria-describedby` (for example "Nothing to commit", "Resolve the import first").

    *c) Loading, error and success feedback*
    - Initial load: the section renders immediately with a "Loading sync status…" placeholder (`aria-busy="true"`); no layout jump on arrival.
    - A failed `GET info-sync` shows an inline error with a **Retry** button; the rest of the repository page stays usable. A 404 (repository deleted meanwhile) follows the page's existing not-found handling.
    - Success feedback via the existing `toast.js`: refresh ("Already up to date" / "Fetched and fast-forwarded" / "Incoming changes found — import available"), import ("Import applied"), Commit & Push ("Pushed {short sha} to {default branch}"), enable ("Sync enabled"), and the `filterFallback` info toast. Toasts are already announced politely (`toast.js` sets `role="status"` and `aria-live="polite"` on each toast), so `toast.js` is not changed.
    - The state label and the status block live in a single `role="status"` / `aria-live="polite"` region, so a state change after Refresh, Import or Commit & Push is announced without moving focus.
    - Errors from Commit & Push and Import surface inside their modal; errors from Refresh and Save surface in the section's inline alert. 409 messages are shown as-is. 502 messages are shown credential-stripped, plus the write-access hint when present.

    *d) Conflict prompt and focus management*
    - The `conflict` state always renders a prominent health alert with an **Import…** button, so the dialog is reachable even when it was dismissed.
    - The import modal auto-opens **once per page visit per repository** (a module-level `Set` of repository IDs, not a per-render flag), so re-renders after `onRepositoryChanged`, Refresh or Save do not reopen it. A cancelled auto-open does not reopen. It never auto-opens while another modal is active or while a request of the section is in flight.
    - After any modal closes, focus returns to the opener; after an Apply that removes or replaces the opener, focus moves to the section heading (`tabindex="-1"`).
    - `fix action` buttons in the health alert are real `<button>` elements in DOM order after the message; `configure-credential` moves focus to the Credential section's heading after scrolling.

    *e) Post-action refresh*
    - After a successful Import (any fields) the section calls `onRepositoryChanged(updatedRepo)`; `repository-detail.js` re-renders the header, Description and the workspace table from the returned repository without a full navigation, then re-fetches the sync status. After Save, Refresh and Commit & Push only the section's status is re-fetched.

    *f) Accessibility floor for new controls*
    - Every interactive control is a native element (`button`, `input`, `fieldset`) reachable by Tab in visual order, with the existing focus-visible style (no outline removal).
    - State is never conveyed by colour alone: the state pill carries its text label plus an icon or glyph with a text alternative; the list badge shows the text "On" / "Off" in addition to the `aria-label`.
    - Colours come only from the existing custom properties (light `:root` and `:root[data-theme="dark"]`, `gui/public/css/styles.css` L91), so the new controls inherit the contrast of the existing status tokens in both themes. The target is at least 3:1 for non-text (pill border, toggle, radios, focus ring) and at least 4.5:1 for text; measuring it needs a real browser, which the run does not have, so the measurement is Human Action 4.
    - Any spinner or animation is disabled under the existing `prefers-reduced-motion: reduce` block (static "…" text remains).
    - Input and textarea font size is at least 16px at mobile widths.
17. **Repositories list badge.** In `gui/public/js/views/repositories.js`, add a "Sync" column header in `buildTableHead()` and a cell in `buildRepoRow()` with a `.sync-badge.sync-badge--on` / `.sync-badge--off` span and `aria-label`s "Workspace info sync enabled" / "Workspace info sync off". The badge also shows the visible text "On" / "Off". On narrow widths the column follows the table's existing overflow behaviour (horizontal scroll or column hiding as the other columns do); it is never the column that causes the page to overflow.
18. **Styles and visual spec.** In `gui/public/css/styles.css`, add rules for the sync section layout, the state pill, the pending-files list, the import diff table and the sync badge. Reuse the existing `.health-alert*` rules, section/card classes of the Credential section and custom properties for colours (no hard-coded colour literals in the new rules, which a static stylesheet test asserts; see Test Plan).
    - **Section order (top to bottom):** heading "Workspace info sync" → toggle row with Save and the help text → status block (state pill, main folder path, branch, ahead/behind, last synced) → pending-files list (only when non-empty) → health alert → action row (Refresh / Import… / Commit & Push). The primary button is Import… for `incoming`/`conflict`, Commit & Push for pending changes, otherwise none.
    - **State pill colours:** success for `in-sync`; info/neutral for `disabled` and `write-required`; warning for `incoming`, `conflict` and `main-folder-unavailable`; error for `invalid-file`, `id-mismatch` and `unsupported-schema`. Each uses an existing status token, plus the text label.
    - **Status block:** a definition list (`dl`) with `grid-template-columns` of label and value; the main folder path uses `overflow-wrap: anywhere` and a monospace token, and never force horizontal scroll.
    - **Import diff table:** at widths below the existing tablet breakpoint, each field row stacks (Current / Incoming / choice vertically) instead of using columns; values wrap.
    - **Action row:** `flex-wrap` so buttons wrap rather than overflow at narrow widths and at 200% zoom; touch targets at least 44px high at mobile widths.
    - **Reflow:** the section, both modals and the badge column are built so they reflow at 320px width and at 200% zoom without clipped content or two-dimensional scroll (modal body scrolls vertically, the footer actions stay visible). The rules that produce this (`flex-wrap`, `overflow-wrap: anywhere`, the stacked diff rows and the 16px input font inside the existing `@media (max-width: 768px)` blocks, L1141/L1353) are asserted by the static stylesheet test; the visual check in a real browser is Human Action 4.
    - **Motion:** no new animations or keyframes. A busy indicator is static text. If a spinner is added anyway, its selector is added to the existing `@media (prefers-reduced-motion: reduce)` block (L921), which the static stylesheet test asserts.
19. **Documentation.** Apply every entry in "Documentation Updates" below, then run `ctx generate` to refresh `.context/project-folder-structure.md`.

## Dependencies

- Step 1 → steps 7, 8 (`HealthIssue`).
- Step 2 → steps 8, 10 (auth helper; orchestrator migrations are independent of later steps).
- Step 3 → steps 7, 8, 12 (git wrappers; the `INFO_COMMIT_AUTHOR_NAME`, `INFO_COMMIT_AUTHOR_EMAIL` and `MAX_INFO_COMMIT_MESSAGE_LENGTH` constants consumed by `commitAndPush` in step 8 and the body validation in step 12).
- Steps 4 → 5 → 6 → 7 → 8 (types → manager → info module → main folder → orchestrator).
- Step 8 → steps 9, 10, 11, 12.
- Step 12 → step 13 → steps 15, 16, 17.
- Step 14 → step 16. Step 15 → step 16.
- Step 18 (styles) follows 15–17.
- Step 19 runs last.
- No new runtime npm dependencies. `node:crypto` is built in.

## Required Components

- New: `src/orchestration/health.types.ts`
- New: `src/orchestration/remote-auth.ts`
- New: `src/git/git-remote.ts`
- New: `src/git/git-commit.ts`
- New: `src/orchestration/repository-info.ts`
- New: `src/orchestration/repository-main-folder.ts`
- New: `src/orchestration/repository-info-sync.ts`
- New: `src/server/routes/repository-info-sync.ts`
- New: `gui/public/js/components/health-alert.js`
- New: `gui/public/js/components/repository-info-import-modal.js`
- New: `gui/public/js/components/info-commit-dialog.js`
- New: `gui/public/js/views/repository-info-sync-section.js`
- Modified: `src/orchestration/workspace-health.ts`, `src/orchestration/workspace-orchestrator.ts`, `src/orchestration/repository-orchestrator.ts`, `src/orchestration/workspace-artifacts.ts`, `src/orchestration/orchestration.types.ts`, `src/git/git.types.ts`, `src/git/git-clone.ts`, `src/git/git-cli.ts`, `src/models/repository/repository.types.ts`, `src/models/repository/repository.manager.ts`, `src/config/config.constants.ts`, `src/server/index.ts`, `src/cli/custom-files.ts`, `gui/public/js/api.js`, `gui/public/js/utils/normalise.js`, `gui/public/js/views/workspace-detail.js`, `gui/public/js/views/repository-detail.js`, `gui/public/js/views/repositories.js`, `gui/public/css/styles.css`
- Storage: new directory `{storageFolder}/repositories/{repoId}/` (created lazily; `initializeStorage()` unchanged)
- External: git ≥ 2.28 (already required; `sparse-checkout --cone` needs ≥ 2.25)

## Assumptions

- The repository's remote has at least one commit on its default branch. An empty remote, or one whose resolved default branch does not exist, is refused on enable with a 409 and a clear message (Approach §2, Risks).
- A credential that can clone can also fetch. Push needs write scope; this is reported, not pre-validated.
- Commits use the fixed Paralizer identity from `INFO_COMMIT_AUTHOR_NAME` / `INFO_COMMIT_AUTHOR_EMAIL` in `src/config/config.constants.ts` (Open Question 6). The email is `paralizer@mistralys.eu`, which the maintainer has added to their GitHub account, so commits are attributed to that account (the address must stay verified there).
- Branch protection on default branches is not a concern for the user's repositories (see Deferred Item 1).
- Only one Paralizer server process mutates a given main folder at a time. The CLI only reaches `syncRepository()` (a filesystem write) and never the git operations.

## Constraints

- `syncRepository()` must stay synchronous and spawn no subprocess.
- No token or `CredentialId` ever reaches `info.json`, API responses, or log messages. All git stderr is stripped.
- The main folder is always the managed clone at `{storageFolder}/repositories/{repoId}/`. No input path is ever accepted, and writes are limited to `<mainFolder>/<infoFolder>/info.json` behind the guard chain.
- Writes happen only when the bytes change. Hash bookkeeping writes `repositories.json` only when the hash actually differs.
- Relative imports use `.js` extensions. Tests that create temp files register `process.on('exit')` cleanup.

## Out of Scope

- Repository-level files in `.workspace/files/` (Milestone 2, see "Next Milestone" below). Project custom files are unchanged.
- Branch-protection-aware flows (pull requests instead of direct push) — Deferred Items.
- CLI commands for info sync (Open Question 8).
- Background polling of main folders (Open Question 4 resolved to on-demand only).
- Surfacing repository sync issues in the workspace health report or project views (Open Question 10).
- Importing from arbitrary workspace clones (Open Question 3).
- A user-chosen main folder path (dedicated clone or STABLE clone) — dropped by the user; see Deferred Items.

### Next Milestone — Repository Files

Project custom files stay as they are: they serve projects, which have no repository of their own. Milestone 2 (`docs/agents/plans/2026-11-19-repository-workspace-sync-m2-files/`) adds **repository-level custom files**, stored by Paralizer and written into `.workspace/files/` of the managed clone, reaching workspace clones through git. It reuses this milestone's main folder, hash baseline, import dialog and Commit & Push, and extends the generated README.

## Human Actions

| # | Action | When | Why an agent cannot do it |
|---|--------|------|---------------------------|
| 1 | Keep `paralizer@mistralys.eu` verified on the GitHub account that should receive attribution, and check that "Block command line pushes that expose my email" is off for the account whose token pushes (otherwise pushes with this author email can be rejected) | Before the run | Account settings only the user controls |
| 2 | Smoke-test enable → edit description → Commit & Push against a real private repository using a credential with write access, and a second machine/clone performing Import | After the run | Needs real remote access and write credentials the agent does not hold |
| 3 | Release (version bump, tag, publish) | After the run | Releases are performed by the user |
| 4 | Browser walkthrough of the sync GUI against a local server and a local bare-origin fixture: enable → Save → edit description → Commit & Push, an `incoming` import, a `conflict` import (including an upstream `Url`-only difference staying `in-sync`), disabling with pending changes, a failed push, and enabling against an empty remote. Each flow keyboard-only (Tab order, focus return, Escape, arrow keys in radio groups), at 320px, tablet and desktop widths, at 200% zoom, with `prefers-reduced-motion: reduce`, and in both themes; measure text (4.5:1) and non-text (3:1) contrast of the new controls with the browser's contrast tooling. Defects found become a follow-up fix | After the run | The run has only `npm test` and the jsdom `npm run test:gui` suite (`package.json` L51–L52); no browser, zoom, contrast or screen-reader tooling is configured, and judging visual reflow needs a person |

## Acceptance Criteria

- AC-01: `Repository.InfoSync` (`RepositoryInfoSyncSettings`) exists with the exact property names, types and optionality in step 4. Existing `repositories.json` files without it load unchanged, and no `SCHEMA_VERSION` bump happens. Type audit: exported types match this plan.
- AC-02: `info.json` contains `SchemaVersion`, `Id`, `Name`, `Url` (credential-stripped), `Description` and `Settings`. It never contains a token, `CredentialId`, or any machine-local setting. Unknown keys already in the file are preserved on rewrite.
- AC-02b: `Url` is informational only: it is excluded from the sync hash, the import preview and the import request. A file that differs from Paralizer's data only in `Url` evaluates as `in-sync` and is not rewritten; when the file is written for another reason, `Url` carries the local credential-stripped value.
- AC-02a: Every sync (sync enabled, folder usable, `Id` not mismatched, state not `incoming` or `conflict`) writes `.workspace/README.md` only when its bytes differ. The README contains no absolute path or install location, refers readers to the workspace `AGENTS.md` for Paralizer, is excluded from the sync hash and the import dialog, and is identical on every machine.
- AC-03: Enabling sync creates `{storageFolder}/repositories/{repoId}/` as a partial clone (`--filter=blob:none`) with cone sparse checkout of the info folder on the default branch, then writes the info file. A server without filter support produces a full clone, a `warning` log entry and `filterFallback: true`. Enabling against an empty remote (no commits) or one whose resolved default branch does not exist fails with 409 and a clear message, leaves no folder under `{storageFolder}/repositories/`, and persists no `InfoSync` setting; any other clone failure likewise removes the partial folder.
- AC-04: The main folder is always `{storageFolder}/repositories/{repoId}/`. `RepositoryInfoSyncSettings` has no path or mode field, and no REST body or GUI control accepts a folder path.
- AC-05: Sync runs whenever the artefact choke-point regenerates (`regenerateWorkspace`, `regenerateProject`, `regenerateForRepository`), including for repositories in no project. A sync failure never makes regeneration throw.
- AC-06: The info file is written only when its rendered bytes differ. A second sync with unchanged data leaves the file's mtime unchanged and `git status --porcelain` clean.
- AC-07: The decision table is honoured: a local edit is written; an incoming change yields state `incoming` with an `info-sync-import-available` issue and no write; both changed yields `conflict` and no write. A file with no baseline that differs is `conflict`; one that matches records the baseline.
- AC-07b: A repository without `.workspace/info.json` raises no health issue. Enabling sync creates the file on the first sync, a file deleted upstream after an earlier sync is recreated silently, and both cases show as pending changes. The sync toggle carries help text explaining this behaviour.
- AC-08: Invalid JSON, an unsupported `SchemaVersion` and an `Id` mismatch each block writing and surface their own health issue.
- AC-09: The status endpoint reports pending changes (porcelain limited to the info folder), behind-remote, main-folder-missing (including not a git repository), remote-mismatch and wrong-branch issues, each with the `fixAction` from step 8.
- AC-10: Import is only allowed when the file's `Id` matches. The preview lists only differing fields. Only `Name` and `Description` are importable; a request naming `Url` (or any other field) is refused with 400. Applying selected fields updates the repository through `RepositoryManager.update()` without touching its `Url`, credential or managed clone, rewrites the file, records the baseline (state becomes `in-sync`), regenerates workspace artefacts, and writes an audit entry. An empty selection is accepted by both the modal and the route; it keeps all local values, rewrites the file and resolves the state.
- AC-11: Commit & Push commits only paths under the info folder, refuses when not on the default branch, refuses when upstream changed the info folder, fast-forwards otherwise, and pushes `HEAD` to the default branch. It writes an audit entry.
- AC-12: Every error message from clone/fetch/push/commit that reaches an API response or log is credential-stripped. A permission-denied push includes a "credential needs write access" hint. Commits are authored with the fixed Paralizer identity regardless of the machine's git config (a test runs with an empty `HOME` and no global identity).
- AC-13: Disabling sync removes the managed clone, guarded, and clears `LastWrittenHash`. With pending changes it returns 409 unless `discardPendingChanges: true`. Deleting the repository removes its managed clone. Recreating the clone refuses with 409 when changes are pending unless `discardPendingChanges: true`, and clears `LastWrittenHash`.
- AC-14: Concurrent git-backed operations on the same repository are serialised.
- AC-15: The workspace and repository orchestrators use `resolveRemoteAuth()`, with identical observable behaviour (existing tests pass unchanged).
- AC-16: `workspace-detail.js` renders its health alert through `components/health-alert.js` with unchanged markup and behaviour (existing GUI tests pass unchanged).
- AC-17: The repository detail page shows the sync section (toggle, read-only main folder path, status, issues, Refresh / Import… / Commit & Push). A `conflict` opens the import modal automatically once. The repositories list shows a Sync badge.
- AC-17b: Enabling sync on a repository whose default branch already carries a `.workspace/info.json` that differs from Paralizer's data results in state `conflict` and opens the import dialog. Paralizer reads `.workspace/` from no location other than the main folder, and the toggle's help text states that existing workspace info is offered for import on enable.
- AC-17c: GUI interaction contract (step 16 spec): the sync toggle does not save until Save is pressed and reverts on failure; buttons follow the enablement matrix and are all disabled while a request is in flight; initial load, load failure (with Retry), save/refresh/import/commit feedback and the state label are announced through live regions; the conflict modal auto-opens once per page visit per repository and is always reachable via the alert's Import… button; focus returns to the opener after every modal; after an import the repository page header and table reflect the new values.
- AC-17d: GUI accessibility and responsive floor, limited to what the run's jsdom and static checks can verify: all new controls are native elements in DOM order with no focus-outline removal; field choices are grouped in `fieldset`/`legend`; the import modal is a single step and opens no stacked overlay; state is never colour-only (state pill and badge carry text labels); the new stylesheet rules use only existing colour custom properties (no colour literals), use `flex-wrap` on the action row and `overflow-wrap: anywhere` on paths and values, stack the import diff rows and set input/textarea font size to at least 16px inside the existing `max-width: 768px` media blocks, and add no animation outside the `prefers-reduced-motion: reduce` block. Measured contrast, visual reflow at 320px and 200% zoom, and real keyboard flows are verified after the run (Human Action 4), not by this criterion.
- AC-18: The CLI's `WorkspaceArtifactsOrchestrator` is constructed with the sync orchestrator, so `paralizer custom-files` regeneration also syncs info files.
- AC-19: All manifest documents, module READMEs and `CHANGELOG.md` listed under Documentation Updates are updated, and `.context/project-folder-structure.md` is regenerated.

## Testing Strategy

- **Pure unit tests** for `repository-info.ts`: render, parse, hash, evaluate, diff, and preserving unknown keys. Every row of the decision table is covered.
- **Real-git integration tests** with local fixtures:
  - a bare origin with `uploadpack.allowFilter=true`, cloned via `file://` URLs so `--filter` is honoured;
  - sparse checkout, fetch/ff, commit/push into the bare origin;
  - a second clone that simulates the incoming change.
- **Fake-git tests** (`setupFakeGit()`) for argument construction where authenticated URLs must appear (push/fetch by URL) and for stderr stripping.
- **Route tests** with `mock-http.ts` helpers and a stubbed `RepositoryInfoSyncOrchestrator`, covering status codes and body validation.
- **GUI jsdom tests** for the new component, section, modal and badge, plus the unchanged health-alert behaviour in `workspace-detail`.
- **Static stylesheet test** for the CSS-side accessibility floor (AC-17d): the test reads `gui/public/css/styles.css` as text and asserts properties of the new sync selectors. It is a new kind of GUI test (no existing test reads the stylesheet); it is the only automated way to hold the CSS rules of AC-17d with the configured tooling, and it stays string-level (no CSS parser dependency).
- **Browser verification is not part of the run.** No browser tooling is configured, so the real-browser walkthrough (keyboard flows, reflow at 320px/200% zoom, reduced motion, both themes, measured contrast) is Human Action 4, after the run.
- **Regression:** the full `npm test` and `npm run test:gui` suites.

## Test Plan

- `src/tests/repository-info.test.ts` (new):
  - `buildInformationalUrl` strips Url credentials; the payload has no `Url`;
  - hash is stable and ignores formatting, and two files differing only in `Url` hash identically;
  - render preserves unknown keys and `Settings`, and writes the given informational `Url`;
  - read classifies absent / invalid / unsupported-schema / ok, and a file with a missing or non-string `Url` is still `ok`;
  - `evaluateRepositoryInfoSync` covers all nine table rows, plus an `Url`-only difference evaluating as `in-sync`;
  - diff lists only differing fields and never lists `Url`;
  - writer is write-only-if-changed (mtime unchanged on the second call);
  - writer refuses a symlinked info folder that escapes the main folder;
  - README render is deterministic, contains no absolute path, mentions the workspace `AGENTS.md`; a hand-edited README is restored, README changes never alter the hash, and the README is not written in `incoming`/`conflict` (AC-02a).
  - Covers AC-02, AC-02a, AC-02b, AC-06, AC-07, AC-08.
- `src/tests/repository-main-folder.test.ts` (new):
  - `inspectMainFolder` on a missing folder, a non-git folder, a remote mismatch, the wrong branch, behind/ahead, and pending changes limited to the info folder;
  - `createManagedClone` over `file://` yields a partial clone (`git config remote.origin.partialclonefilter` = `blob:none`) whose sparse checkout contains only the info folder plus top-level files;
  - `removeManagedClone` refuses paths outside the managed root, including through a symlink.
  - `createManagedClone` against an empty bare origin (`git init --bare`, no commits) throws `MainFolderPreconditionError` and leaves no destination folder; a clone failure (unreachable `file://` path) throws `MainFolderGitError` and leaves no destination folder.
  - Covers AC-03, AC-04, AC-09, AC-13.
- `src/tests/repository-info-sync.test.ts` (new), against real git fixtures:
  - enable managed → file written and baseline recorded;
  - repository without the folder: no health issue, file created on enable; file deleted upstream after a sync → recreated silently on the next sync (AC-07b);
  - edit description → silent write;
  - push a change from a second clone → refresh → state `incoming`, no write;
  - change both → `conflict`;
  - import of selected fields → state `in-sync` and audit entry;
  - a second clone pushes a file whose only change is `Url` → refresh → state `in-sync`, no write, no pending change; a later local description edit rewrites the file with the local `Url`;
  - import never changes the repository's `Url`, `CredentialId` or managed clone;
  - commit authorship is the fixed Paralizer identity with no global git identity configured;
  - commit & push lands in the bare origin with only info folder paths, while a hand-staged file outside the info folder stays uncommitted;
  - commit refused on the wrong branch and when upstream touched the info folder;
  - disable with pending changes → `PendingChangesError`, with `discard` → clone removed and hash cleared;
  - re-enabling after a disable starts without a baseline;
  - enabling against a bare origin whose default branch already carries a differing `.workspace/info.json` → state `conflict` with an `info-sync-conflict` issue and no write (AC-17b);
  - enabling against an empty bare origin → `MainFolderPreconditionError`, no managed folder, `InfoSync` not persisted (AC-03);
  - mutex serialises two concurrent `commitAndPush` calls;
  - filter fallback flagged when the stub reports the warning (fake-git).
  - `recreateManagedClone` refuses with pending changes, and with `discardPendingChanges` clears the baseline.
  - Covers AC-02b, AC-03, AC-07, AC-07b, AC-10, AC-11, AC-13, AC-14, AC-17b.
- `src/tests/git-remote.test.ts` (new):
  - `remoteUrlsMatch` matrix (https vs `.git` suffix, trailing slash, host case, embedded credentials);
  - branch-name guards reject `-x` and `a..b`;
  - `fetchBranch`/`pushHead` argument construction via fake-git;
  - `countAheadBehind` and `changedPathsBetween` on fixtures.
  - Covers AC-09, AC-11, AC-12.
- `src/tests/git-commit.test.ts` (new): `getPathStatus` limited to the pathspec; `commitPaths` commits only the pathspec; empty message rejected. Covers AC-11.
- `src/tests/git-clone.test.ts` (extended): `filter`/`noCheckout` arguments; `setSparseCheckout` rejects a `-` prefix. Covers AC-03.
- `src/tests/git-cli.test.ts` (extended): `runGitOrThrow` error message strips an embedded token from stderr. Covers AC-12.
- `src/tests/remote-auth.test.ts` (new): HTTPS + credential → injected URL; HTTPS without credential → `ok: false` with the exact legacy message; SSH → original URL with `credential: null`. Covers AC-15.
- `src/tests/repository.manager.test.ts` (extended): `setInfoSyncSettings` set/clear; `recordInfoSyncWrite`; `update()` preserves `InfoSync`; existing error messages unchanged after the `mutate` refactor. Covers AC-01.
- `src/tests/workspace-artifacts.test.ts` (extended): `regenerateWorkspace`/`regenerateForRepository` invoke sync (including for a repository in no project); a throwing sync is logged and does not propagate; the constructor without the sync dependency still works. Covers AC-05.
- `src/tests/repository-orchestrator.test.ts` (extended): `deleteRepositoryGlobally` removes the managed clone; a removal failure is logged and not thrown. Existing `resolveRemoteAuth` migration tests pass. Covers AC-13, AC-15.
- `src/tests/workspace-health.test.ts` (unchanged, must pass): type alias compatibility. Covers AC-15.
- `src/tests/cli-custom-files.test.ts` (extended): the deps builder injects `RepositoryInfoSyncOrchestrator` into the artefact orchestrator; an add/update writes the info file for a sync-enabled repository with an existing main folder. Covers AC-18.
- `src/server/__tests__/routes/repository-info-sync.test.ts` (new):
  - each endpoint's success shape;
  - 404 for an unknown repository;
  - 400 validation matrix (enabled, fields — including `['Url']` rejected — and message length); an empty `fields` array is accepted and resolves the state;
  - 409 for pending changes or preconditions, including `MainFolderPreconditionError` from an enable against an empty remote;
  - 502 for remote failures, with a token-free message;
  - import triggers `regenerateForRepository` best-effort.
  - Covers AC-02b, AC-04, AC-09, AC-10, AC-11, AC-12, AC-13.
- `gui/public/js/components/health-alert.test.mjs` (new): renders title and rows; the registry maps a `fixAction` to a button and calls `onClick(issue)`; `none` and unknown actions render message-only; returns `null` when healthy; no `innerHTML`. Covers AC-16.
- `gui/public/js/views/workspace-detail.index-health.test.mjs`, `workspace-detail.credential-error.test.mjs` (unchanged, must pass). Covers AC-16.
- `gui/public/js/components/repository-info-import-modal.test.mjs` (new): only differing fields shown; defaults (import for incoming, keep for conflict); Apply sends the selected fields; empty selection allowed; server error shown inline in a `role="alert"` region; busy state; each field is a `fieldset` with a `legend`; no `Url` row is rendered even when the preview's file `Url` differs; no second overlay is opened; empty values render "(empty)". Covers AC-02b, AC-10, AC-17, AC-17d.
- `gui/public/js/components/info-commit-dialog.test.mjs` (new): pre-filled message; empty or over-500 message sets `aria-invalid` and disables Commit; resolves with the trimmed message or `null` on cancel; busy state and inline error. Covers AC-11, AC-17c.
- `gui/public/js/views/repository-info-sync-section.test.mjs` (new): renders the toggle (`role="switch"`) and the read-only main folder path; flipping the toggle does not call `saveSettings` until Save is pressed, and a failed save reverts the toggle and shows an alert; the toggle's help text mentions that existing workspace info is offered for import on enable (AC-17b); the pending-changes confirm retries with `discardPendingChanges`; status labels per state; the button-enablement matrix per state, with reason text on disabled buttons; all buttons disabled while a request is in flight; loading placeholder and failed-load Retry; the state region is `aria-live="polite"`; fix actions wired; conflict auto-opens the modal once per page visit per repository (not again after a re-render or a cancel) while the alert's Import… button still opens it; focus returns to the opener; Commit & Push goes through the dialog; import triggers `onRepositoryChanged`. Covers AC-17, AC-17c.
- `gui/public/js/views/repository-detail.test.mjs` addition: after `onRepositoryChanged`, the header and Description reflect the updated repository. Covers AC-17c.
- `gui/public/js/__tests__/normalise.test.mjs` (extended): `normaliseRepo()` maps `InfoSync` to `infoSync` and omits `LastWrittenHash`. Covers AC-17.
- `gui/public/js/views/repositories.test.mjs` (extended): Sync column header and on/off badges with `aria-label`s and visible "On"/"Off" text. Covers AC-17, AC-17d.
- `gui/public/js/views/repository-detail.test.mjs` (extended): the section is mounted after the Credential section and its cleanup is invoked on navigation. Covers AC-17.
- `gui/public/js/__tests__/styles.info-sync.test.mjs` (new): reads `gui/public/css/styles.css` as text; within the new sync-related rule blocks (`.repository-info-sync*`, `.sync-badge*`, the import diff table and commit dialog selectors) asserts no hex/`rgb(`/`hsl(` colour literals (only `var(--…)`), no `outline: none`/`outline: 0`, `flex-wrap: wrap` on the action row, `overflow-wrap: anywhere` on the main folder path and diff values; within a `@media (max-width: 768px)` block asserts the stacked diff-row rule and an input/textarea `font-size` of at least 16px; asserts that any new `animation`/`@keyframes` selector also appears in the `prefers-reduced-motion: reduce` block. Covers AC-17d.
- `gui/public/js/api.infoSync.test.mjs` (new): each `api.repositories.infoSync` method hits the correct method and path with `encodeURIComponent`. Covers AC-17.
- Documentation check (manual review step in the QA WP): every file listed under Documentation Updates has been changed, and `.context/project-folder-structure.md` lists the new files. Covers AC-19.

## Documentation Updates

- `docs/agents/project-manifest/api-surface.md`:
  - new sections for `health.types.ts`, `remote-auth.ts`, `repository-info.ts`, `repository-main-folder.ts`, `repository-info-sync.ts`, `git-remote.ts`, `git-commit.ts`;
  - extend `CloneOptions`, `git-clone.ts` (`setSparseCheckout`, `FILTER_UNSUPPORTED_WARNING`) and `orchestration.types.ts` (`PUSH_TIMEOUT_MS`);
  - extend `Repository` types and the manager methods;
  - the `WorkspaceArtifactsOrchestrator` and `RepositoryOrchestrator` constructor changes;
  - `registerRepositoryInfoSyncRoutes`;
  - `api.repositories.infoSync`, `buildHealthAlert`, `showRepositoryInfoImportModal`, `showInfoCommitDialog`, `buildRepositoryInfoSyncSection`;
  - `MAX_INFO_COMMIT_MESSAGE_LENGTH`, `INFO_COMMIT_AUTHOR_NAME`, `INFO_COMMIT_AUTHOR_EMAIL`.
- `docs/agents/project-manifest/rest-api.md`: the new endpoint table under Repositories, request/response shapes, error codes including the 502 convention, and a new "Repository Info Sync Issue Types" table. The import request documents `fields` as `'Name' | 'Description'` and states that `Url` is informational and not importable.
- `docs/agents/project-manifest/data-flows.md`:
  - §11 storage layout adds `{storageFolder}/repositories/{repoId}/` and the info file in main folders;
  - new §16 "Repository Info Sync": the trigger, the decision table, refresh, import, commit & push and the auth handling;
  - §15 deletion cascade adds the managed clone removal;
  - §13b notes that sync also runs on regeneration.
- `docs/agents/project-manifest/constraints.md`: a new "Repository Info Sync" section covering the info file content rules (no credentials, PascalCase, unknown-key preservation, schema version policy for the info file, `Url` informational only and never hashed or imported), write-only-if-changed, the managed-only main folder rule, the managed clone token-at-rest convention, the pathspec-limited commit, the default-branch-only push, refname validation for the new git functions, and the 502 convention. Update "Known Input Validation Gaps" to note that the new functions validate refnames.
- `docs/agents/project-manifest/gui-frontend.md`: the GUI interaction conventions introduced here (save-on-button toggle, button-enablement rule, live-region status, no stacked modal overlays, once-per-visit auto-open, and the static stylesheet test `__tests__/styles.info-sync.test.mjs` as the in-run check for CSS accessibility rules), the `#/repositories/:id` route description (sync section), the `#/repositories` route (Sync column), the `workspace-detail.js` note (health alert via the shared component), the API client list (`api.repositories.infoSync`), and the Reusable Components table (Health Alert, Repository Info Import Modal, Info Commit Dialog).
- `docs/agents/project-manifest/tech-stack.md`: note under External Tools that partial clone + cone sparse checkout rely on git ≥ 2.25 (covered by the existing ≥ 2.28 minimum). No dependency changes.
- `src/git/README.md`, `src/orchestration/README.md`, `src/models/README.md`, `src/server/README.md`, `gui/README.md`: list the new modules and responsibilities.
- `README.md` (project root): short user-facing feature description of workspace info sync.
- `CHANGELOG.md`: a new `## Unreleased - Repository Workspace Info Sync` section in house style (bold summary, then `- Area: change.` bullets).
- `.context/project-folder-structure.md`: regenerate via `ctx generate`.

## Deferred Items

| # | Deferred Item | Origin | Reason Deferred | Notes |
|---|---------------|--------|-----------------|-------|
| 1 | Branch-protection-aware Commit & Push (push to a branch + open a PR) | Agreed during plan review | User's repositories don't use branch protection | Reconsider if a push is rejected by protection rules in practice |
| 2 | Repository-level files in `.workspace/files/` | User decision during plan review | Planned as Milestone 2 | See "Next Milestone — Repository Files" |
| 3 | CLI counterpart (`paralizer info-sync status|refresh|import|commit-push`) | Open Question 8 | Parity rule is custom-files-specific; no current CLI consumer | Reconsider when agents need to trigger pushes |
| 4 | Background polling of main folders | Open Question 4 | Adds a network call per enabled repository per interval | Reconsider if "Import available" is missed in practice |
| 5 | User-chosen main folder path (dedicated clone or STABLE clone) | User decision during plan review | Managed clone covers Import and Commit & Push; the override was the largest source of complexity | Additive: a mode field on `RepositoryInfoSyncSettings`, no schema bump |
| 6 | Baseline snapshot of the last-written field values (per-field three-way resolution in the import dialog) | Architectural review, Decision 6 | With only `Name` and `Description` synced, "each side edited a different field" conflicts are rare and the dialog already shows both values | Additive: an optional `LastWrittenFields` on `RepositoryInfoSyncSettings`, no schema bump. Reconsider if Milestone 2 needs per-file base content or conflicts prove frequent |
| 7 | Keep the token out of the managed clone's `.git/config` via a per-command inline credential helper | Architectural review, Decision 5 | Unproven `-c credential.helper` shell-snippet mechanism needing a Windows and macOS spike; would diverge from every existing workspace clone | Belongs to a global token-at-rest revisit covering all clones (Open Question 9) |
| 8 | Discovery hint for repositories that already carry `.workspace/info.json` while sync is off | Architectural review, Decision 11 | Removed: duplicates the enable-time import path and would read user-owned STABLE clones | If a nudge is wanted later, derive it from the main folder after an opt-in Refresh rather than from workspace clones |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Token leakage via git stderr from fetch/push by URL** | Every surfaced stderr goes through `stripEmbeddedCredentials()`; `runGitOrThrow()` hardened; fake-git tests assert token-free messages. |
| **Recreating the clone discards unpushed edits** | `recreateManagedClone` refuses with `PendingChangesError` unless `discardPendingChanges`; the GUI confirms first. |
| **Pushing a non-default branch** | Commit & Push refuses unless `currentBranch === defaultBranch`; `info-sync-wrong-branch` health issue. |
| **Partial clone lazy fetch failing for private repos** | Managed `origin` holds the authenticated URL (existing convention), re-set before each operation for credential rotation. |
| **Enabling sync on an empty remote, or one whose default branch cannot be resolved** (`getDefaultBranch()` falls back to `'main'` without checking the ref) | `createManagedClone` verifies `refs/remotes/origin/<default>` before checkout and throws `MainFolderPreconditionError` (409, "push an initial commit first"); every clone failure removes the partial destination, and `saveSettings` persists nothing, so the user can retry once the remote has content. Covered by empty-bare-origin fixture tests. |
| **Server without `--filter` support** | Git falls back automatically; the warning is detected, logged and surfaced as `filterFallback`. |
| **Stale baseline misclassifying direction** | Baseline cleared on enable/disable and clone recreation; no-baseline divergence routed to the import dialog rather than overwritten. |
| **Regeneration slowed or broken by sync** | Sync is filesystem-only, write-only-if-changed, and wrapped in try/catch with warning logs. |
| **Concurrent git operations corrupting index (`index.lock`)** | Per-repository async mutex in the orchestrator. |
| **Commits rejected by org rules requiring signed commits or a verified author email** | Accepted limitation: the fixed identity commits are unsigned. Pushes to such repositories fail with the remote's message (502); revisit with a configurable identity if it occurs (Open Question 6). |
| **A malicious or mistaken `Url` committed to `info.json`** | `Url` is informational only: it is never imported, never hashed and never used as a remote, so a hostile value in the file cannot redirect the repository's token or clones (Open Question 12). |
| **Colleagues with different remote forms flipping the file's `Url`** | `Url` alone is never a reason to write; it only changes when the file is written for a synced-field change, so it cannot cause churn or false conflicts on its own. |
| **Refactors (auth helper, manager `mutate`, health alert) changing behaviour** | Byte-identical messages required; existing test suites must pass unchanged. |

---

## Open Questions

Each question lists the options and a recommended answer. The plan is written against the recommendations, so changing an answer means revising the referenced steps.

1. **Final convention folder name.**
   - Options: (a) `.workspace/`; (b) `.paralizer/`; (c) something else, e.g. `.repo-info/`.
   - **Resolved: (a) `.workspace/`.** The user chose it because the name declares the folder's intent to agents and humans alike. The name remains a single constant (`REPOSITORY_INFO_FOLDER_NAME`, step 6).
2. **Key casing inside `info.json`.**
   - Options: (a) PascalCase like all Paralizer stores (`SchemaVersion`, `Id`, …); (b) camelCase (`schemaVersion`, `id`, …), which is more conventional for a file humans and other tools read.
   - **Resolved: (a) PascalCase**, confirmed by the user. It is consistent with `repositories.json` and the project files, and no mapping layer is needed.
3. **Import source.**
   - Options: (a) main folder only; (b) the main folder plus a picker for any existing workspace clone of the repository.
   - **Resolved: (a) main folder only.** Paralizer reads the info folder from the main folder it maintains itself (the managed clone), so there is no folder browsing or clone picker. The hash baseline stays tied to that one folder.
4. **Fetch cadence and pulling.**
   - Options:
     - (a) fetch on the manual Refresh button and before Commit & Push only (page load shows the last known state without a network call);
     - (b) additionally include main folders in the background `PollingManager` sweep;
     - (c) fetch on every health/status request.

     Pull options: (i) auto fast-forward the managed clone when nothing is pending; (ii) never pull automatically.
   - **Resolved: (a) + (i)**, confirmed by the user, with the manual **Refresh** button in the sync section (step 16) as the only user-triggered fetch. The managed clone is Paralizer-owned and only contains the info folder, so fast-forwarding it is safe when nothing is pending. On-demand fetching avoids a network call per enabled repository per poll interval. Before writing, Paralizer does **not** pull: sync is filesystem-only, and Commit & Push fast-forwards before committing.
5. **Commit message format.**
   - Options: (a) fixed message; (b) fixed default, editable in the confirmation dialog; (c) a generated message listing the changed fields.
   - **Recommendation: (b)**, with the default `Paralizer: Update repository info for "{repoId}"`, built by `buildDefaultInfoCommitMessage(repoId)` and returned as `defaultCommitMessage` in the sync status so the dialog can pre-fill it. Max 500 characters.
6. **Commit identity.**
   - Options: (a) the user's global git identity, failing clearly if it is unset; (b) a fixed Paralizer identity via `-c user.name/-c user.email`; (c) a configurable identity in settings.
   - **Resolved: (b), decided by the user.** Commits are authored as `INFO_COMMIT_AUTHOR_NAME` / `INFO_COMMIT_AUTHOR_EMAIL` (constants in `src/config/config.constants.ts`), independent of any machine's git config, so Commit & Push never fails for a missing identity. The identity is only commit text; push permission still comes from the repository's credential. GitHub attributes commits to an account when the author email is a verified address of that account, so pointing the email at a dedicated Paralizer GitHub account (its noreply address works) gives linked commits. Commits are unsigned, which org rules requiring signed commits would reject (see Risks).
7. **Managed clone lifecycle on disable or delete.**
   - Options: (a) delete on disable and on repository delete, refusing with a confirm when changes are pending; (b) keep on disable, delete on repository delete only; (c) never delete automatically, with a manual "Remove clone" action.
   - **Recommendation: (a).** The clone is cheap to recreate (sparse + partial), and leftovers under storage are invisible clutter. The pending-changes guard prevents losing unpushed edits.
8. **CLI counterpart.**
   - Options: (a) none in this plan; (b) read-only `paralizer info-sync status`; (c) full parity (settings, refresh, import, commit-push).
   - **Recommendation: (a), recorded as Deferred Item 3.** The CLI/REST parity rule in `constraints.md` is specific to custom files. The custom-files CLI still triggers info sync through the shared choke-point (AC-18), so agents editing via the CLI keep the file current.
9. **Credential at rest in the managed clone.**
   - Options: (a) keep the token-injected URL in the managed clone's `origin`, like every workspace clone today, re-set before each operation; (b) keep `origin` clean and pass auth per command, which breaks partial-clone lazy blob fetches for private HTTPS repositories unless a full clone is used; (c) use `GIT_CONFIG_COUNT` env-based `http.extraHeader`, which needs git ≥ 2.31 and is a new auth mechanism; (d) a per-command inline credential helper (`-c credential.helper='!f(){…}; f'`) fed the token by environment variable, which would keep the token out of `.git/config` while still serving lazy fetches inside commands Paralizer runs (raised by the architectural review; unproven, needs a Windows and macOS spike).
   - **Recommendation: (a).** It matches the existing convention and the file lives under Paralizer's own storage folder. Option (d) is recorded as Deferred Item 7 for a global token-at-rest revisit covering all clones.
10. **Should repository sync issues also appear outside the repository detail page?**
    - Options: (a) repository detail page plus a Sync on/off badge in the repositories list only; (b) also add an "Import available"/"Conflict" issue to the workspace health report of every workspace containing the repository; (c) also show a badge on the project's repository table.
    - **Recommendation: (a) for this plan.** Workspace health is filesystem-only and per-workspace. Repository-level git state does not fit it, and duplicating the alert across workspaces would be noisy. Revisit after usage.
11. **Equivalence of SSH and HTTPS remotes in the remote-match check.**
    - Options: (a) treat `git@host:org/repo.git` and `https://host/org/repo.git` as matching; (b) require the same scheme.
    - **Resolved: no longer applicable.** With the custom path removed, the managed clone's `origin` always derives from the registered `Url`, so remote matching compares like with like.
12. **Is `Url` importable at all?**
    - Options: (a) yes, with the modal warning and the credential-coherence rule; (b) no — `Url` is written to the file for information only, and only `Name`/`Description` are importable.
    - **Revised to (b) after the architectural review** (earlier resolution: (a), importable behind a confirmation). The registered `Url` is per-user in practice (HTTPS with a token versus SSH, enterprise host aliases), so hashing and importing it would turn every colleague's write into an `incoming` change or a `conflict` for the others. `Url` is now written to the file credential-stripped for information only, excluded from the hash, diff and import, and never itself a reason to write. This also removes the URL confirmation step, `confirmUrlChange`, clone recreation on import and the credential-coherence extraction. A local `Url` edit via the repository form still surfaces `info-sync-remote-mismatch`, whose fix action recreates the managed clone. **Confirmed by the user (2026-11-20).**
