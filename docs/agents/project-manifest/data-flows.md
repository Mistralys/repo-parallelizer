# Key Data Flows

## 1. Application Startup (CLI)

```
index.ts (entry point)
  └→ loadConfig()                         # Read config.json from tool root
  └→ initializeStorage(config)            # Create storage dirs + seed files (idempotent)
  └→ Instantiate managers:
       RepositoryManager(config)
       ProjectManager(config, repoManager)
       WorkspaceManager(projectManager)
       ErrorLogManager(config)
  └→ Instantiate orchestrators:
       WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager)
       ProjectOrchestrator(config, projectManager, workspaceOrch)
       RepositoryOrchestrator(config, projectManager, repoManager)
       BranchOrchestrator(config, projectManager, workspaceManager)
  └→ Interactive CLI menu loop
```

## 2. Application Startup (GUI Server)

```
startServer(serverConfig)
  └→ Instantiate managers (same as CLI, including ErrorLogManager(config))
  └→ Instantiate Router
  └→ Register all REST routes via register*Routes() helpers
  └→ PollingManager.start(intervalSeconds)    # Begin periodic git status polling
  └→ http.createServer() → Router.handle() + serveStatic()
  └→ Listen on serverPort (default 4200)
```

## 3. Create a Project

```
User → POST /api/projects { name, repositoryIds, description?, id? }
  └→ ProjectManager.create()                  # Validate IDs, write project JSON + index
       └→ Auto-creates STABLE workspace entry with current timestamp
  └→ Return persisted ProjectData record
```

> **Filesystem setup is separate:** `POST /api/projects` only persists the project record — it does not clone repositories or write workspace files. Call `POST /api/projects/:id/workspaces/:wid/setup` afterward to initialize the workspace on disk.

## 4. Add a Repository to a Project

```
User → POST /api/projects/:id/repositories { repositoryId }
  └→ ProjectManager.addRepository()           # Append repo ID to project data
  └→ Return updated ProjectData record
```

> **No clone or workspace regeneration here:** `POST .../repositories` only appends the repository ID to the project's data record. Cloning and artefact-set regeneration (`.code-workspace` plus the three generated index files, via `WorkspaceArtifactsOrchestrator.regenerateProject()`) are performed by `RepositoryOrchestrator.addRepositoryToProject()`, which is invoked by a separate orchestration path (not by this REST endpoint) and is not yet wired into any live route as of this WP.  
> To clone the newly-added repository into existing workspaces after adding it, use the workspace setup endpoint for each workspace.

## 5. Create a Workspace

```
User → POST /api/projects/:id/workspaces { workspaceId, description? }
  └→ WorkspaceManager.create()                # Validate ID, add workspace entry
  └→ Return persisted WorkspaceInfo record
```

> **Filesystem setup is separate:** `POST /api/projects/:id/workspaces` only persists the workspace record. Call `POST /api/projects/:id/workspaces/:wid/setup` to clone repositories and generate the on-disk artefact set. That endpoint invokes `WorkspaceOrchestrator.createWorkspace()`, which runs the clones and then calls the injected `WorkspaceArtifactsOrchestrator.regenerateWorkspace()` — producing the `.code-workspace` file and the three generated index files (`README.md`, `AGENTS.md`, `CLAUDE.md`) together, rather than the `.code-workspace` file alone.

## 6. Branch Switch (Multi-Repository)

```
User → POST /api/projects/:id/workspaces/:wid/branches/switch { assignments: { repoId: branchName } }
  └→ BranchOrchestrator.switchBranches()
       └→ For each repoId in assignments (concurrent via Promise.all):
            branchExists(repoPath, branchName)?
              ├→ yes: switchBranch(repoPath, branchName)   # git checkout
              └→ no:  createBranch(repoPath, branchName)   # git checkout -b
            └→ On failure: scan stderr for conflict patterns
       └→ WorkspaceManager.update() → set DateModified  (only when at least one switch succeeded)
       └→ Return BranchSwitchResult { results: { [repoId]: { success, conflict, error? } } }
```

## 7. Git Status Polling

```
PollingManager.start(intervalSeconds)
  └→ setInterval:
       └→ For each project in ProjectManager.list():
            For each workspace in WorkspaceManager.list():
              For each repository in project.Repositories:
                fetchAndGetStatus(repoPath)    # git fetch + status snapshot
                └→ Store result in internal Map keyed by repoPath
       └→ persistLastActivity()               # post-sweep: compute max lastActivity per
                                              # project and call updateLastActivity(); no-ops
                                              # for projects with all-null lastActivity values
```

`refreshWorkspace()` (on-demand polling) also calls `persistLastActivity()` after its fetch sweep so that `ProjectData.LastActivity` stays current after any single-workspace refresh.

> **Timestamp comparison note:** `persistLastActivity()` finds the maximum `lastActivity` via lexicographic string comparison, which is correct only when all ISO 8601 timestamps share a consistent timezone offset (always `Z` for git commit timestamps normalised by the git layer). Do not mix timezone offsets without updating this method.

```
User → GET /api/projects/:id/workspaces/:wid/status
  └→ For each repository in project:
       pollingManager.getStatus(repoPath)      # Return cached GitStatusInfo or null
  └→ Response: { [repoId]: GitStatusInfo | null }
```

## 8. GUI SPA Navigation

```
Browser → hash change (e.g. #/projects/my-app)
  └→ Router._resolve(hash)
       └→ Match against registered patterns
       └→ Extract named params (e.g. { id: "my-app" })
       └→ Router._render(viewFn, params)
            └→ Call previous view's cleanup function (if any)
            └→ Clear #app container
            └→ viewFn(container, params)        # View builds DOM + fetches API data
            └→ Store returned cleanup function (if any)
```

## 9. Credential-Bearing Git Operation (Private Repository)

```
Orchestrator receives a repo URL (e.g. https://github.com/org/private.git)
  └→ resolveCredential(url, config.gitCredentials, repo.credentialId)?
       │  # Looks up GitCredentialEntry[] by credentialId, or auto-selects
       │  # the sole entry whose host matches extractHost(url)
       ├→ found: injectCredentialToken(url, credential.token)
       │         # Returns https://ghp_token@github.com/org/private.git
       │         # Token injected via WHATWG URL API (percent-encoded, not string concat)
       └→ absent: pass original URL (auth will fail fast — GIT_ASKPASS=echo)
  └→ cloneRepository(injectedUrl, destination, options)
       └→ runGit(['clone', injectedUrl, ...])
            └→ spawn() env: { GIT_TERMINAL_PROMPT:'0', GIT_ASKPASS:'echo' }
  └→ On error (result.stderr contains 'auth'):
       └→ stripEmbeddedCredentials(result.stderr)  ← REQUIRED before surfacing
            # Removes ghp_token from error string before logging / API response
```

**Credential injection rules (standing constraints):**
- `injectCredentialToken()` must only be called immediately before a git subprocess call — never stored or passed through API boundaries.
- `stripEmbeddedCredentials()` must be applied to any `GitResult.stderr` and `Error.message` before the string is logged or returned in an API response.
- **`hasEmbeddedCredentials()` pre-check requirement (constraint, not yet enforced):** When the URL may already carry embedded credentials (e.g. from user input), callers should invoke `hasEmbeddedCredentials(url)` before calling `resolveCredential()` + `injectCredentialToken()` and decide explicitly whether to strip and re-inject or reject. The active clone orchestrators (`WorkspaceOrchestrator`, `RepositoryOrchestrator`) currently skip this check and proceed directly to `resolveCredential()`.

---

## 10. Workspace Setup — Clone Failure Error Propagation

```
WorkspaceOrchestrator.createWorkspace() on clone failure:
  └→ cloneRepository() → GitResult.stderr  (e.g. "fatal: Authentication failed for https://...")
       └→ [FUTURE WP — MANDATORY] stripEmbeddedCredentials(gitResult.stderr)
            # Must be applied before assigning to OrchestrationRepoResult.error
            # Prevents PAT exposure when credential injection is active
       └→ OrchestrationRepoResult.error = (sanitised) stderr string
  └→ API response: { failures: [{ repositoryId, error }] }
  └→ Browser (project-detail.js):
       for (const failure of failures):
         showToast(`Failed to clone "${failure.repositoryId}": ${failure.error}`, 'error', 8000)
         # message set via textContent — NOT innerHTML — so server-controlled strings are XSS-safe
```

**Standing security rule:** Once credential injection is active, `stripEmbeddedCredentials()` (from
`src/git/git-credentials.ts`) **must** be applied to `gitResult.stderr` in
`workspace-orchestrator.ts` and `repository-orchestrator.ts` before the string is assigned to
`OrchestrationRepoResult.error` / `WorkspaceCloneResult.error`. This is a blocking prerequisite for
the credential injection WP — without it, PATs will appear in API JSON responses and the browser
toast UI.

---

## 11. Storage File Layout

```
{storageFolder}/
  ├── repositories.json              # { Repositories: [...], SchemaVersion: 1 }
  ├── projects-index.json            # { Projects: [{ Id, Name }], SchemaVersion: 1 }
  ├── error-log.json                 # { Entries: [...], SchemaVersion: 1 }
  ├── projects/
  │    └── {project-id}.json         # Full ProjectData (workspaces embedded)
  ├── repository-files/              # Created lazily, one store per repository with ≥1 custom file
  │    └── {repo-id}.json            # { Files: [...], SchemaVersion: 1 } — RepositoryFileManager, Milestone 2
  └── repositories/                  # Created lazily, only for repositories with InfoSync.Enabled
       └── {repo-id}/                # Managed main folder — a partial, sparse-checkout clone
            └── .workspace/
                 ├── info.json       # RepositoryInfoFile — see §16
                 ├── README.md       # Generated, not data — see §16
                 └── files/          # Committed-to-git file tree — see §17 (Milestone 2)
                      └── {path}     # One entry per RepositoryFile.Path, write-only-if-changed

{projectsFolder}/
  └── {project-id}/
       ├── {project-id}-STABLE.code-workspace    # VS Code workspace file
       ├── {project-id}-DEV.code-workspace       # (per workspace)
       └── STABLE/
            ├── README.md                         # Generated index (marker-fenced — see api-surface.md)
            ├── AGENTS.md                         # Generated index + agent-directives block
            ├── CLAUDE.md                         # Generated "@AGENTS.md" pointer
            ├── {repo-slug}/                      # Git clone
            └── ...
       └── DEV/
            ├── README.md / AGENTS.md / CLAUDE.md # Same three generated files (per workspace)
            ├── {repo-slug}/                      # Git clone
            └── ...
```

> **Generated index files:** as of `WorkspaceOrchestrator.createWorkspace()`'s migration onto `WorkspaceArtifactsOrchestrator` (the production-reachable path via `POST .../setup`), the three files above are written alongside the `.code-workspace` file for every workspace whose folder exists on disk. They are absent for a workspace that has not yet been set up. See the Orchestration section of `api-surface.md` (`workspace-index.ts`, `workspace-artifacts.ts`) for the rendering/merge/write-guard contract, and §12 below for how their status feeds into the health check.

> **Repository custom files store:** `{storageFolder}/repository-files/{repo-id}.json` is `RepositoryFileManager`'s per-repository data document (Milestone 2) — the repository-level counterpart to project custom files, which live inline in `projects/{project-id}.json` (`CustomFiles`) instead of their own per-aggregate file. Keeping it as a separate per-repository JSON document, rather than embedding `Files` in `repositories.json`, keeps the frequently re-read `repositories.json` small. `repositories.json` itself is never read or written by this manager. See `api-surface.md`'s `repository-file.ts` / `repository-file.manager.ts` entries for the model and CRUD contract.

> **Managed main folder:** unlike every path above, `{storageFolder}/repositories/{repo-id}/` is **not** a per-workspace artefact — it is a single, repository-level clone shared across every project/workspace that contains the repository (or none at all). It exists only while `Repository.InfoSync.Enabled` is `true` for that repository, and is removed when sync is disabled, the managed clone is recreated, or the repository itself is deleted (§15). See §16 for its full lifecycle.

---

## 12. Workspace Health Check

```
User → GET /api/projects/:id/workspaces/:wid/health
  └→ projectManager.getById(projectId)          # 404 if project unknown
  └→ workspaceManager.getById(projectId, wid)   # 404 if workspace unknown
  └→ fs.existsSync(workspaceFolder)?
       ├→ false (uninitialized): sendJson 200 { healthy: true, issues: [] }
       └→ true (initialized):
            checkWorkspaceHealth(projectId, workspaceId, projectsFolder, repositoryIds,
                                 errorLogManager)
              └→ Check 1: fs.existsSync(getWorkspaceFilePath(...))
                   └→ absent → issue { type: 'workspace-file-missing', severity: 'warning',
                                        fixAction: 'regenerate-workspace-file' }
              └→ Check 2: for each repoId in repositoryIds:
                   fs.existsSync(path.join(projectsFolder, projectId, wid, repoId, '.git'))
                   └→ absent → issue { type: 'repository-not-cloned', severity: 'warning',
                                        fixAction: 'setup-workspace', repositoryId }
              └→ Check 3: checkIndexFileStatus(projectsFolder, projectId, workspaceId)
                   (read-only probe from workspace-index.ts — see §5/Orchestration docs;
                    already returns empty arrays for an uninitialized workspace)
                   ├→ missing.length > 0    → issue { type: 'workspace-index-missing',
                   │                                   severity: 'warning',
                   │                                   fixAction: 'regenerate-workspace-file' }
                   └→ unmanaged.length > 0  → issue { type: 'workspace-index-unmanaged',
                                                       severity: 'warning', fixAction: 'none' }
              └→ Check 4 (when errorLogManager provided):
                   errorLogManager.list({ source: 'credentials' })
                   └→ Filter to entries scoped to this workspace (matching ProjectId + WorkspaceId)
                   └→ De-duplicate by RepositoryId, keeping only the most recent entry per repo
                        (list() returns entries newest-first)
                   └→ For each most-recent entry:
                        ├→ Severity: 'error'  → issue { type: 'credential-missing',
                        │                               severity: 'warning',
                        │                               fixAction: 'configure-credential',
                        │                               repositoryId }
                        └→ Severity: 'info'   → suppress (stale badge resolved — see §14)
              └→ Return WorkspaceHealthReport { healthy: issues.length === 0, issues }
            sendJson 200 WorkspaceHealthReport
```

**GUI integration:**
- `project-detail.js`: health fetched in parallel with status for all initialized workspaces via `Promise.allSettled`. Failing fetches degrade gracefully (health cell left empty).
- `workspace-detail.js`: health report fetched on initial load and every poll cycle. Unhealthy workspaces render a `.health-alert` card with per-issue rows and fix action buttons. A `workspace-file-missing` or `workspace-index-missing` issue renders a **"Regenerate Files"** button (`fixAction: 'regenerate-workspace-file'`, relabelled from "Regenerate File" — the button calls `POST .../regenerate-workspace-file`, which regenerates the full artefact set: `.code-workspace` plus all three generated index files). A `workspace-index-unmanaged` issue (`fixAction: 'none'`) renders as a message row with no button. A `credential-missing` issue renders a **"Configure"** button (`fixAction: 'configure-credential'`) that navigates to `#/repositories` (the repositories list — the affected repository ID is not preserved in the navigation).

---

## 13. Regenerate Workspace File

```
User → POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file
  └→ projectManager.getById(projectId)          # 404 if project unknown
  └→ workspaceManager.getById(projectId, wid)   # 404 if workspace unknown
  └→ fs.existsSync(workspaceFolder)?
       └→ absent → sendError 400 "Workspace folder does not exist. Run setup first."
  └→ workspaceArtifactsOrchestrator.regenerateWorkspace(projectId, workspaceId)
       ├→ generateWorkspaceFile(...)            # writes .code-workspace (unconditional)
       └→ writeWorkspaceIndexFiles(...)          # writes/merges README.md, AGENTS.md, CLAUDE.md
  └→ sendJson 200 { success: true }
```

**No git operations are performed.** This endpoint regenerates the `.code-workspace` file and the three generated index files via the `WorkspaceArtifactsOrchestrator` choke-point (see `api-surface.md`) — it performs no cloning. All repository clones remain untouched. Use `POST .../setup` to clone missing repositories.

---

## 13b. Custom Files Sync

```
Triggers: POST/PUT/DELETE /api/projects/:id/custom-files[/:fileId]
          + every existing regenerateWorkspace()/regenerateProject() caller (setup, project/workspace/repo edits, regenerate)
  └→ projectManager.add/update/removeCustomFile()     # validate + persist in projects/{id}.json (CustomFiles)
  └→ (PUT with changed Directory/FileName, or DELETE)
       workspaceArtifacts.removeCustomFileCopies(projectId, previousDefinition)
         └→ per workspace: guard chain → rm file → prune empty dirs up to the workspace root
  └→ workspaceArtifacts.regenerateProject(projectId)
       └→ per workspace: writeWorkspaceIndexFiles() (AGENTS.md "Custom Files" = ListInAgents rows)
                         writeCustomFiles()            (mkdir -p, overwrite, chmod 755 for scripts)
```

The CLI (`paralizer custom-files add|update|delete`) runs the same chain in-process: it loads `config.json`, builds the managers and the orchestrator itself (no running server needed), and calls the same `ProjectManager` + choke-point methods. Exit code 2 signals "saved, but sync failed".

The folder-must-exist rule applies: an uninitialised workspace receives nothing until it is set up (setup regenerates artefacts). Local edits to a copy are overwritten; removal is driven by the stored definition, not a separate ledger of written files.

> **Repository info sync shares the same choke-point.** Every `regenerateWorkspace()`/`regenerateProject()`/`regenerateForRepository()` call above also runs `RepositoryInfoSyncOrchestrator.syncRepository()` for each resolved repository (`regenerateForRepository()` runs it once up front, independent of project membership) — so a custom-files add/update/delete, a project/workspace/repository edit, or a manual regenerate all keep `.workspace/info.json` current as a side effect, with no separate trigger wiring. See §16.

> **Repository Files listing in `AGENTS.md` (Milestone 2):** `writeWorkspaceIndexFiles()` now also renders a "Repository Files" table into `AGENTS.md` from `WorkspaceIndexContext.repositoryFiles` — `ListInAgents` files from sync-enabled repositories only, built with no filesystem check (so it stays accurate regardless of whether a teammate has pulled the file yet). `WorkspaceArtifactsOrchestrator` takes an optional, last constructor parameter (`repositoryFileManager?: RepositoryFileManager`) to populate this; as of WP-011, `src/cli/custom-files.ts` and the new `src/cli/repo-files.ts` both pass one through their `createDefault*Deps()` factories, so the section renders for both CLI paths' regeneration calls. `src/server/index.ts` still does not pass one, so the section does not yet render for GUI-triggered regeneration. See `api-surface.md`'s `workspace-index.ts`/`WorkspaceArtifactsOrchestrator` entries.

## 14. Credential Success Log Entry and Stale Badge Suppression

When a workspace setup or repository addition completes a **credential-based clone** (i.e. a credential was resolved and injected), both `WorkspaceOrchestrator.createWorkspace()` and `RepositoryOrchestrator.addRepositoryToProject()` write a success entry to the error log. The `Operation` value differs by call site:

```
Successful credential-based clone — WorkspaceOrchestrator:
  └→ errorLogManager.append({
         Severity: 'info',
         Source:   'credentials',
         Operation: 'workspace-setup',
         Context:  { ProjectId, WorkspaceId, RepositoryId },
         Message:  'Credential used successfully for clone.',
     })

Successful credential-based clone — RepositoryOrchestrator:
  └→ errorLogManager.append({
         Severity: 'info',
         Source:   'credentials',
         Operation: 'add-repository',
         Context:  { ProjectId, WorkspaceId, RepositoryId },
         Message:  'Credential used successfully for clone.',
     })
```

This entry serves as a **badge-suppression signal** for `checkWorkspaceHealth()` (§12, Check 3). The flow from clone to badge resolution is:

```
1. User assigns credential → PUT /api/repositories/:id/credential
2. User runs setup        → POST /api/projects/:id/workspaces/:wid/setup
3. Clone succeeds with credential
     └→ Orchestrator writes Source: 'credentials', Severity: 'info' entry
4. GET /api/projects/:id/workspaces/:wid/health
     └→ checkWorkspaceHealth checks most-recent Source: 'credentials' entry per repo
          ├→ Severity: 'info'  → suppress credential-missing badge (badge cleared)
          └→ Severity: 'error' → surface credential-missing badge (badge shown)
```

**SSH clones are excluded:** when `resolveCredential()` returns `null` (e.g. SSH URL, no matching credential), no credentials log entry is written for that repository. The badge-suppression mechanism only applies to repositories that have undergone at least one credential-based clone attempt.

---

## 15. Global Repository Deletion Cascade

```
User → DELETE /api/repositories/:id
  └→ repositoryManager.getById(id)?              # 404 if unknown, checked by the route
  └→ RepositoryOrchestrator.deleteRepositoryGlobally(repositoryId)
       ├→ repositoryManager.getById(repositoryId)?          # 404 if unknown (orchestrator's own check)
       ├→ resolveRootRealPath(projectsFolder)                # resolved once, reused per project
       ├→ projectManager.list() → for each project referencing repositoryId:
       │      └→ removeRepositoryFromProject(projectId, repositoryId)
       │             ├→ project.Repositories.includes(repositoryId)?
       │             │      → throws "is not listed in project" on violation, before any delete
       │             ├→ per workspace: guard clone path, then delete
       │             │      ├→ layer 1: strict-descendant lexical check
       │             │      │      (rejects equality with projectsFolder — unlike the
       │             │      │      equality-permitting isLexicallyContained() used by
       │             │      │      the writer path — so a malformed ID can never
       │             │      │      resolve to the projects root)
       │             │      │      → throws "Security check failed" on violation, no delete
       │             │      ├→ layer 2: escapesRootViaRealpath() symlink-escape check
       │             │      │      → throws "Security check failed" on violation, no delete
       │             │      └→ fs.rmSync(clonePath, { recursive: true, force: true })  # if it passed both layers and exists
       │             ├→ projectManager.removeRepository(projectId, repositoryId)
       │             ├→ errorLogManager?.append({ Severity: 'audit', Source: 'repository-audit',
       │             │       Operation: 'unlink-repository', Context: { ProjectId, RepositoryId } })
       │             │       # emitted unconditionally once the two mutations above succeed —
       │             │       # regardless of the regeneration step's outcome below
       │             ├→ try: workspaceArtifacts.regenerateProject(projectId)
       │             │   catch: errorLogManager?.append({ Severity: 'warning', Source: 'workspace-index',
       │             │       Operation: 'unlink-repository', Context: { ProjectId, RepositoryId } })
       │             │       # logged and swallowed — does not propagate, does not erase the audit entry above
       │             affectedProjectIds.push(projectId)      # recorded by the caller loop
       ├→ repositoryManager.remove(repositoryId)              # drop the global store entry
       ├→ if repositoryInfoSync injected:
       │      try: repositoryInfoSync.removeManagedFolder(repositoryId)   # plain filesystem removal, no settings mutation
       │          managedFolderRemoved = true
       │      catch: errorLogManager?.append({ Severity: 'warning', Source: 'workspace-info',
       │          Operation: 'delete-repository-global', Context: { RepositoryId } })
       │          # logged and swallowed — the repository record is already gone, so this is best-effort cleanup
       ├→ if repositoryFileManager injected (Milestone 2):
       │      try: repositoryFileManager.removeStore(repositoryId)   # deletes repository-files/{repoId}.json; no-op if absent
       │          fileStoreRemoved = true
       │      catch: errorLogManager?.append({ Severity: 'warning', Source: 'workspace-info',
       │          Operation: 'delete-repository-global', Context: { RepositoryId } })
       │          # same best-effort shape as the managed-folder step above
       └→ errorLogManager?.append({ Severity: 'audit', Source: 'repository-audit',
              Operation: 'delete-repository-global', Context: { RepositoryId },
              Message: '... Managed main folder removed.' if managedFolderRemoved else '' +
                       ' Repository file store removed.' if fileStoreRemoved else '',
              Details: JSON.stringify(affectedProjectIds) })
              # emitted ONLY after repositoryManager.remove() succeeds
  └→ sendNoContent 204
```

**Completion boundaries:** the association check and the two path-traversal guard layers all throw *before* any mutation, so a guard failure or an unlisted repository leaves no `unlink-repository` entry behind (an incomplete project never gets a misleading "success" audit line). Once `projectManager.removeRepository()` succeeds, the audited event is complete and its `unlink-repository` entry is emitted **unconditionally** — a subsequent failure in `workspaceArtifacts.regenerateProject()` (best-effort downstream reconciliation) is caught and logged as a separate `Severity: 'warning'` entry instead of propagating, so it can no longer erase the audit record of a deletion that genuinely happened. If `repositoryManager.remove()` throws after the per-project cascade has already completed, `deleteRepositoryGlobally()` propagates the throw and writes no `delete-repository-global` summary entry — but the `unlink-repository` entries already emitted during the cascade are **not rolled back**, since they describe cascade steps that genuinely did complete. The managed-main-folder removal step and the (Milestone 2) file-store removal step both run only after `repositoryManager.remove()` has succeeded; a removal failure in either is logged as a warning (`Source: 'workspace-info'`) rather than thrown, and the summary audit entry's message gains the corresponding trailing sentence only when that step actually succeeded (or, for the file-store step, did not throw — `removeStore()` no-ops silently when no store exists, so the sentence does not strictly imply a store was present).

**Two distinct roots, same pattern as the write-guard chain (§13's sibling note in `api-surface.md`):** the lexical check compares against `path.resolve(projectsFolder)`; the realpath check compares against a separately-resolved `resolveRootRealPath(projectsFolder)`. Both checks and the shared symlink-resolution logic live in `src/utils/path-guard.ts` (see `api-surface.md`), the same module consumed by `workspace-index.ts`'s write-guard chain (§13).

**Now shared with the project-level unlink route:** the project-level "unlink one repository from one project" route (`DELETE /api/projects/:id/repositories/:repoId`) now delegates directly to this same `removeRepositoryFromProject()` method (see `rest-api.md`'s **Repository Unlink Delegation** note), so it produces the identical clone-folder deletion, data-record update, and `unlink-repository` audit entry described above — it is no longer a separate, unaudited mutation path.

---

## 16. Repository Info Sync

Opt-in, per-repository sync of `.workspace/info.json` (Id/Name/Description, plus an informational `Url`) into a Paralizer-managed main folder — a partial, sparse-checkout clone at `{storageFolder}/repositories/{repoId}/` (§11). See `api-surface.md` for `repository-info.ts`/`repository-main-folder.ts`/`repository-info-sync.ts` signatures, `rest-api.md` for the route table, and `constraints.md`'s "Repository Info Sync" section for the content/security rules.

**Trigger (filesystem-only, synchronous):**

```
WorkspaceArtifactsOrchestrator.regenerateWorkspace()/regenerateProject()/regenerateForRepository()
  └→ safeSync(repositoryId):  # per resolved repository; regenerateForRepository() also runs it
                               # once up front, independent of project membership
       try: repositoryInfoSync.syncRepository(repositoryId)
              ├→ resolve main folder; absent/not-a-git-repo → state 'disabled' or 'main-folder-unavailable', no-op
              ├→ readRepositoryInfoFile() + hashRepositoryInfoPayload() + evaluateRepositoryInfoSync()
              ├→ on 'write-required': guard chain → mkdir .workspace/ → write info.json only if bytes differ
              │      → recordInfoSyncWrite(hash)  # RepositoryManager.InfoSync.LastWrittenHash/LastSyncedAt
              ├→ independently, write .workspace/README.md only if bytes differ — EXCEPT in states
              │      'disabled' | 'main-folder-unavailable' | 'id-mismatch' | 'incoming' | 'conflict'
              └→ on 'in-sync' with a stale/missing baseline: record the hash only, no write
       catch: errorLogManager?.append({ Severity: 'warning', Source: 'workspace-info', Operation: 'sync' })
              # logged and swallowed — a sync failure never makes artefact regeneration throw
```

**Decision table** (`evaluateRepositoryInfoSync()`, driven by a hash of `[Id, Name, Description]` only — `Url` never participates):

| Folder file | Condition | State | Action |
|---|---|---|---|
| absent | — | `write-required` | write (create) — also when a previously-synced file was deleted upstream |
| invalid | — | `invalid-file` | none; health issue |
| unsupported-schema | — | `unsupported-schema` | none; health issue |
| ok | `Id` ≠ repository `Id` | `id-mismatch` | none; health issue |
| ok | folder hash = data hash | `in-sync` | none (record hash as baseline if it differs) |
| ok | no baseline (`LastWrittenHash` unset), folder ≠ data | `conflict` | none; import dialog |
| ok | folder = baseline, data ≠ baseline | `write-required` | write silently (local edit) |
| ok | folder ≠ baseline, data = baseline | `incoming` | none; "Import available" |
| ok | folder ≠ baseline, data ≠ baseline | `conflict` | none; import dialog |

A missing `.workspace/info.json` is never an error — it is simply created on the next sync (including the first sync after enabling), and a file deleted upstream after an earlier sync is recreated silently. Both show up only as a pending change, never a health issue.

**User-triggered flows (async, git-backed), all serialised per repository by an in-process mutex (`Map<repoId, Promise>`):**

```
PUT /api/repositories/:id/info-sync { enabled, discardPendingChanges? }   # saveSettings()
  ├→ enabling:  createManagedClone()  →  partial clone (--filter=blob:none) + cone sparse-checkout
  │              of .workspace/ on the default branch  →  persist { InfoSync: { Enabled: true } }
  │              → syncRepository()  # may land state 'conflict' if the clone already carries a
  │                                   # differing file — see AC-17b
  └→ disabling: refuse 409 (PendingChangesError) unless discardPendingChanges  →  removeManagedClone()
                → persist InfoSync removed (LastWrittenHash does not survive the flip either way)

POST /api/repositories/:id/info-sync/refresh                              # refresh()
  └→ re-set origin to the current authenticated URL → fetchBranch() → mergeFastForward() when
     behind and nothing pending (on-demand only — no background polling, Open Question 4)
     → syncRepository()

GET  /api/repositories/:id/info-sync/import                               # getImportPreview()
  └→ requires state 'incoming'|'conflict', file status 'ok', Id match → diffRepositoryInfo() (fields)
     + diffRepositoryFiles() joined with problem data (files, Milestone 2) → { state, fields, files }
     (route forwards the preview object as-is, `files` included — `repository-info-import-modal.js`
     renders a Files row per diff, see gui-frontend.md)

POST /api/repositories/:id/info-sync/import { fields?, files? }           # applyImport()
  └→ apply selected fields via RepositoryManager.update() (Url/CredentialId/managed clone untouched);
     resolves every files: { path, action }[] selection via resolveFileImportAction() up front (both
     parsed/forwarded by the route, Milestone 2) and applies it through RepositoryFileManager.replaceAll()
     before the merged write below
     → rewrite file, recordInfoSyncWrite()  → state becomes 'in-sync' (or 'write-required' if some
       local values were kept) → audit log entry (fields + per-file actions) → route calls
       regenerateForRepository() best-effort

POST /api/repositories/:id/info-sync/commit-push { message? }             # commitAndPush()
  └→ refuse 409 (SyncPreconditionError) when folder unavailable, remote mismatched, not on
     default branch, or state is incoming/conflict/invalid-file/id-mismatch/unsupported-schema
     → re-set origin → fetchBranch() → ff-only merge if behind and the info folder wasn't touched
       upstream (else refuse 409 — "import first")
     → stagePaths(infoFolderPathspec()) → getStagedPaths() guard (refuse 409 if anything staged lies
       outside .workspace/, Milestone 2) → getIndexModes()/setIndexExecutable() fix up the executable
       bit on staged repository files (Milestone 2 — commits the staged index, not a pathspec, so the
       chmod survives under core.filemode=false) → commitStaged(…, INFO_COMMIT_AUTHOR_NAME/EMAIL)
     → pushHead() → re-fetch → audit log entry
```

**Health issues** (`fixAction` in parentheses), surfaced only on the repository detail page and the repositories-list Sync badge — never in the per-workspace health report (Open Question 10): `info-sync-main-folder-missing` (`recreate-main-folder`), `info-sync-remote-mismatch` (`recreate-main-folder`), `info-sync-wrong-branch` (`recreate-main-folder`), `info-sync-behind-remote` (`refresh`), `info-sync-pending-changes` (`commit-push`), `info-sync-import-available` (`import`), `info-sync-conflict` (`import`), `info-sync-invalid-file` (`none`), `info-sync-id-mismatch` (`none`), `info-sync-unsupported-schema` (`none`), `info-sync-credential-missing` (`configure-credential`). Milestone 2 adds three files-folder issues, raised by a read-only sweep (`buildFilesHealthIssues()`) that runs only when the main folder is usable: `info-sync-files-unsafe-entry` (`none`) for a symlink or other non-regular entry under `files/`, `info-sync-files-invalid-incoming` (`import`) for a binary/oversized/unreadable/invalid-path incoming file, and `info-sync-files-write-skipped` (`none`) when the shared write-target guard refuses one of the repository's own files.

**Credential handling:** `resolveRemoteAuth()` (`src/orchestration/remote-auth.ts`) resolves and injects the credential; the managed clone's `origin` keeps the token-injected URL (matching every other workspace clone), re-set before every fetch/push so credential rotation takes effect. See `constraints.md`'s "Repository Info Sync" section for the full set of content/security rules (no credentials in the file, write-only-if-changed, pathspec-limited commit, default-branch-only push, the 502 convention).

---

## 17. Repository Files

Repository-level custom files (Milestone 2) — small per-repository files such as wrapper scripts — flow through the same managed main folder as Repository Info Sync (§16), but as their own committed-to-git subtree (`.workspace/files/`) rather than a single synced JSON file. Paralizer is the authority for *content and metadata*; delivery to a teammate's workspace clone happens only through git, never by Paralizer copying bytes into a workspace folder (contrast with project custom files, §13b).

**Mutation (REST `/api/repositories/:id/files*` or `paralizer repo-files`, both behind the same per-repository lock as §16's routes):**

```
POST/PUT/DELETE .../files[/:fileId]  or  paralizer repo-files add|update|delete
  └→ assertSyncEnabled(repoId)?                       # 409 / exit 1 if sync is off — no write, no CLI commit ever
  └→ validateRepositoryFileInput()                    # same rules as project custom files, plus the file-count cap
  └→ RepositoryFileManager.add()/update()/remove()    # repository-files/{repoId}.json — content + metadata, no commit
  └→ workspaceArtifacts.regenerateForRepository(repoId)   # best-effort; logs a warning on failure, does not fail the call
       └→ repositoryInfoSync.syncRepository(repoId)        # same trigger §16 uses for info.json
            ├→ evaluateRepositoryInfoSync() now hashes [Id, Name, Description, Files] (§16's table, Files tuple appended
            │      only when non-empty — hash-compatible with Milestone 1 when Files is empty)
            └→ on 'write-required': writeRepositoryFiles(mainFolder, fileManager.list())   # repository-files.ts
                 ├→ write content + POSIX executable bit for every file whose content or mode differs from disk
                 ├→ delete every regular file under files/ no longer in the data set (set-difference pass)
                 └→ symlinks / other non-regular entries under files/ are never deleted — reported via skipped
                       → surfaces later as an `info-sync-files-unsafe-entry` health issue (rest-api.md)
       └→ regenerateWorkspace()/regenerateProject() also rebuild every workspace's AGENTS.md, whose "Repository
            Files" table lists this repository's ListInAgents files from Paralizer's own data — no filesystem
            check against the workspace clone (see api-surface.md's `workspace-index.ts` note)
```

**Publish (Commit & Push, same action and route as §16 — `POST .../commit-push`):** commits whatever is staged under `.workspace/` (`info.json`, `README.md`, and `files/` together, via `commitStaged()`), fixing up the staged index's executable bit first (`getIndexModes()`/`setIndexExecutable()`) so a wrapper script's `+x` bit survives the commit under `core.filemode=false`, then pushes to the repository's default branch. There is no separate "publish files" action — one Commit & Push covers every pending change under `.workspace/`.

**Delivery (git only, outside Paralizer's control):** a teammate's workspace clone receives the new/changed/removed file only on its own next `git pull` of the repository. Paralizer never writes into a workspace clone's working tree for this feature — the managed main folder (`{storageFolder}/repositories/{repo-id}/`, §11) and every workspace clone are independent checkouts of the same remote. A project-level script in that workspace can then invoke the file (e.g. `sh .workspace/files/vendor-install.sh`) once it exists on disk; Paralizer's role ends at commit & push.

**Import (incoming/conflict states, `GET`/`POST .../info-sync/import`):** `getImportPreview()` now also returns a `files` diff (`diffRepositoryFiles()` joined with problem-file data) alongside the `fields` diff §16 already describes; `applyImport()` accepts a parallel `files: { path, action }[]` selection resolved via `resolveFileImportAction()` and applied through `RepositoryFileManager.replaceAll()` before the merged info.json rewrite. Both the preview's `files` and the apply call's `files` selections are parsed/forwarded by the REST route; `repository-info-import-modal.js` always sends the `{ fields, files }` selections shape (sending `files: []` when the preview had no file diffs) and confirms via `showConfirm()` before submitting any `discard` action — see `gui-frontend.md`'s **Repository Info Import Modal Component** section.

**Deletion cascade (§15):** `RepositoryOrchestrator.deleteRepositoryGlobally()` now also best-effort removes the repository's file store (`RepositoryFileManager.removeStore()`, `repository-files/{repoId}.json`) alongside the managed main folder, independently of whether sync was ever enabled — see §15's cascade diagram above.
