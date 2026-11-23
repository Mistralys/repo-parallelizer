# Orchestration Layer

High-level composite operations that coordinate models and Git commands to implement multi-step workflows. Each orchestrator handles a specific domain: projects, repositories, workspaces, or branches.

## Key Concepts

- **Orchestrator pattern**: Each orchestrator receives its dependencies via constructor injection and composes lower-layer calls into transactional-style operations.
- **OrchestrationResult**: Standardized result type reporting per-repository success/failure.
- **VS Code workspace files**: The `vscode-workspace.ts` module generates `.code-workspace` files so users can open parallel workspaces directly in VS Code.

## Files

| File | Responsibility |
|---|---|
| `orchestration.types.ts` | Shared result types and timeout constants |
| `health.types.ts` | Generic `HealthIssue`/`HealthReport` shape shared across health-check producers in this layer |
| `remote-auth.ts` | `resolveRemoteAuth()` — shared credential resolve/inject/explain helper for turning a repository's configured URL into a git-ready remote URL |
| `repository-info.ts` | Pure, filesystem-only module for the per-repository `.workspace/info.json` sync file and its companion `README.md`: render/parse/hash/diff and sync-state evaluation. Mirrors `workspace-index.ts`'s pure-module pattern — no manager or git access |
| `repository-main-folder.ts` | Resolves and git-inspects the Paralizer-managed main folder clone (`{storageFolder}/repositories/{repoId}/`) — the only location Paralizer ever reads or writes `.workspace/` from — and creates/removes that partial/sparse clone. `createManagedClone()` and `removeManagedClone()` share one private destination guard (`guardedManagedFolderDestination()` — strict-descendant lexical check, then a realpath symlink-escape check) so a planted symlink or a traversal-shaped `repoId` can redirect neither a clone destination nor a deletion target outside the managed root; `createManagedClone()` throws `MainFolderPreconditionError` on refusal, `removeManagedClone()` keeps its `false`-on-refusal contract. |
| `repository-info-sync.ts` | `RepositoryInfoSyncOrchestrator` — ties `repository-info.ts`, `repository-main-folder.ts`, and (Milestone 2) `repository-files.ts`/`RepositoryFileManager` together: a synchronous, filesystem-only `syncRepository()` for the artefact choke-point, plus async `getStatus`/`saveSettings`/`refresh`/`getImportPreview`/`applyImport`/`commitAndPush`/`recreateManagedClone`, each serialised per repository via a private mutex. `repositoryFileManager` is a required constructor parameter — the orchestrator cannot compute the files-folder write/delete pass without it. `saveSettings()` (on enable), `refresh()` and `recreateManagedClone()` return `RepositoryInfoSyncRemoteStatus` (`RepositoryInfoSyncStatus` plus an optional `filterFallback`), surfacing the partial-clone filter fallback each already detects internally to log its existing warning — mirrors the `CommitPushResult.filterFallback` precedent. `getStatus()`/`applyImport()` keep returning the plain `RepositoryInfoSyncStatus`, since neither performs a clone or fetch of its own. **Atomicity (WP-004):** `applyImport()` computes `filesMutated` (an `add`/`overwrite`/`delete` resolved action) and gates both `validateRepositoryFileSet()` and `RepositoryFileManager.replaceAll()` on it, running that validation before the `Name`/`Description` field update — a rejected resulting file set leaves fields, the file store, the managed clone and the recorded hash all untouched, and a field-only import never validates or rewrites the file store at all. The private `logFilesWriteOutcome(repositoryId, result, operation)` logs a `writeRepositoryFiles()` result's non-empty `skipped`/`removed` lists (`warning`/`info` respectively) from both `syncRepository()` (`operation: 'sync-files'`) and `applyImport()` (`operation: 'import'`); it is a no-op when both lists are empty or no `errorLogManager` was injected. |
| `repository-files.ts` | Pure, filesystem-only module (Milestone 2) that reads and writes the managed main folder's `.workspace/files/` tree — the committed-to-git counterpart of `RepositoryFileManager`'s data layer. Write-only-if-changed; deletes by set difference against the data set; never touches a symlink or other non-regular entry. Each `RepositoryFolderFile` carries a `contentKind: 'text' \| 'raw' \| 'unreadable'` recording how `content` was decoded, independent of `problem` — `canonicalFilesForHash()` branches on `contentKind`, not on `problem`, so a `'text'` file that also fails a metadata or case-collision check (the reader's two extra problem sources, beyond path/size/binary/unreadable) still hashes identically to the same file without that problem. `writeRepositoryFiles()`'s `skipped` list is de-duplicated. |
| `custom-files.ts` | Writer/remover for a project's custom files inside one workspace folder — the workspace-folder counterpart of `repository-files.ts`, sharing the same guard chain (`path-guard.ts`) but rooted at the workspace folder rather than the managed main folder. |
| `project-orchestrator.ts` | Create, delete, rename projects (clones repos into STABLE workspace) |
| `repository-orchestrator.ts` | Add/remove repos from projects, delete repos globally (including, since Milestone 2, best-effort removal of a repository's file store via `RepositoryFileManager.removeStore()`) |
| `workspace-orchestrator.ts` | Create, delete, rename workspaces (clones repos into new workspace) |
| `workspace-index.ts` | Pure renderer for the generated `README.md`/`AGENTS.md`/`CLAUDE.md` index files and their shared write-guard chain (lexical containment → realpath symlink-escape → directory-shape); `AGENTS.md`'s "Repository Files" table (Milestone 2) is built from `RepositoryFileManager.list()` data only, with no filesystem check against the workspace clone. |
| `workspace-artifacts.ts` | `WorkspaceArtifactsOrchestrator` — the single choke-point every mutating route calls to keep `.code-workspace` and the three generated index files in sync (`regenerateWorkspace()`/`regenerateProject()`/`regenerateForRepository()`); takes an optional trailing `repositoryFileManager` (Milestone 2) so `regenerateForRepository()`'s callers can also drive the repository-files sync/AGENTS.md listing. |
| `branch-orchestrator.ts` | Multi-repo branch switching with conflict detection |
| `vscode-workspace.ts` | Generate `.code-workspace` files for VS Code |
| `workspace-health.ts` | Side-effect-free health checks for workspaces (missing files, uncloned repos, credential errors) |

## Credential Resolution

Both `WorkspaceOrchestrator.createWorkspace()` and `RepositoryOrchestrator.addRepositoryToProject()` resolve the git-ready remote URL for a repository through the shared `resolveRemoteAuth()` helper in `remote-auth.ts`, rather than duplicating the resolve/inject/explain sequence. The returned `url` may carry an embedded credential token and must be consumed immediately by the git call it was resolved for — never persisted, logged, or returned across an API boundary. See the `RemoteAuthResolution` JSDoc in `remote-auth.ts` for the full contract.

## Credential Success Logging

After a successful credential-based clone, both `WorkspaceOrchestrator.createWorkspace()` and `RepositoryOrchestrator.addRepositoryToProject()` write a `Source: 'credentials'`, `Severity: 'info'` entry to the error log. This entry is used by `checkWorkspaceHealth()` to suppress stale credential-missing health badges without deleting history.

- **`workspace-setup` operation** — written by `WorkspaceOrchestrator.createWorkspace()`.
- **`add-repository` operation** — written by `RepositoryOrchestrator.addRepositoryToProject()`.
- **SSH clones** (`credential === null`) do not produce a credentials log entry.

`checkWorkspaceHealth()` inspects the most recent `Source: 'credentials'` entry per repository: a `Severity: 'info'` entry suppresses the badge; a `Severity: 'error'` entry surfaces it. See `workspace-health.ts` `@remarks` for the full stale-badge resolution description.

## Integration Points

- **Dependencies**: `config`, `models` (ProjectManager, RepositoryManager, WorkspaceManager), `git` (clone, branch, status), `error-log` (ErrorLogManager — optional, for credential health checks).
- **Consumed by**: Server route handlers, CLI.
