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

> **No clone or workspace regeneration here:** `POST .../repositories` only appends the repository ID to the project's data record. Cloning and workspace-file regeneration are performed by `RepositoryOrchestrator.addRepositoryToProject()`, which is invoked by a separate orchestration path (not by this REST endpoint).  
> To clone the newly-added repository into existing workspaces after adding it, use the workspace setup endpoint for each workspace.

## 5. Create a Workspace

```
User → POST /api/projects/:id/workspaces { workspaceId, description? }
  └→ WorkspaceManager.create()                # Validate ID, add workspace entry
  └→ Return persisted WorkspaceInfo record
```

> **Filesystem setup is separate:** `POST /api/projects/:id/workspaces` only persists the workspace record. Call `POST /api/projects/:id/workspaces/:wid/setup` to clone repositories and generate the `.code-workspace` file on disk. That endpoint invokes `WorkspaceOrchestrator.createWorkspace()`, which runs the clones and generates the file.

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
  └── projects/
       └── {project-id}.json         # Full ProjectData (workspaces embedded)

{projectsFolder}/
  └── {project-id}/
       ├── {project-id}-STABLE.code-workspace    # VS Code workspace file
       ├── {project-id}-DEV.code-workspace       # (per workspace)
       └── STABLE/
            ├── {repo-slug}/                      # Git clone
            └── ...
       └── DEV/
            ├── {repo-slug}/                      # Git clone
            └── ...
```

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
              └→ Check 3 (when errorLogManager provided):
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
- `workspace-detail.js`: health report fetched on initial load and every poll cycle. Unhealthy workspaces render a `.health-alert` card with per-issue rows and fix action buttons. A `credential-missing` issue renders a **"Configure"** button (`fixAction: 'configure-credential'`) that navigates to `#/repositories` (the repositories list — the affected repository ID is not preserved in the navigation).

---

## 13. Regenerate Workspace File

```
User → POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file
  └→ projectManager.getById(projectId)          # 404 if project unknown
  └→ workspaceManager.getById(projectId, wid)   # 404 if workspace unknown
  └→ fs.existsSync(workspaceFolder)?
       └→ absent → sendError 400 "Workspace folder does not exist. Run setup first."
  └→ Build repoPaths: project.Repositories.map(repoId → { slug: repoId, path: ... })
  └→ getWorkspaceFilePath(projectsFolder, projectId, workspaceId) → wsFilePath
  └→ generateWorkspaceFile(workspaceId, repoPaths, wsFilePath)   # writes .code-workspace
  └→ sendJson 200 { success: true }
```

**No git operations are performed.** This endpoint only writes the `.code-workspace` JSON file. All repository clones remain untouched. Use `POST .../setup` to clone missing repositories.

---

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
