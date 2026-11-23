# Models Layer

Stateless CRUD managers backed by JSON files on disk. Each manager re-reads its backing store on every public method call, ensuring concurrent writes from other processes are always visible.

## Key Concepts

- **Stateless managers**: No in-memory caching. Every call reads fresh data from disk.
- **Repository**: A named Git remote URL. Global across all projects. Optionally carries `InfoSync` (`RepositoryInfoSyncSettings`) when the opt-in `.workspace/info.json` sync (see `src/orchestration/repository-info-sync.ts`) is enabled — `Enabled`, plus a `LastWrittenHash`/`LastSyncedAt` baseline used to detect sync direction. An optional-field addition; no `SCHEMA_VERSION` bump.
- **Project**: A named collection of repositories with one or more workspaces.
- **Workspace**: A named parallel working copy within a project. Each workspace has its own cloned copies of the project's repositories.
- **STABLE workspace**: Every project has a default `STABLE` workspace that cannot be renamed or deleted.
- **`mutate()` consolidation (`RepositoryManager`)**: single-record mutators (`update()`, `updateCredential()`, `touchRefreshTimestamp()`, `setInfoSyncSettings()`, `recordInfoSyncWrite()`) share one private `mutate(id, operationLabel, fn)` helper for the `load → findIndex → NotFoundError → produce replacement → save` sequence, instead of each repeating it inline. See `constraints.md`'s "Single-record mutator consolidation" note for when to reach for this pattern elsewhere.
- **Custom files**: small, user-managed files (mainly wrapper scripts) written into workspace folders by the orchestration layer. `CustomFile` (`project/custom-file.ts`) lives inline in a project's `CustomFiles` list — scoped to every workspace of that project. `RepositoryFile` (`repository/repository-file.ts`, Milestone 2) is the repository-scoped counterpart, stored in its own per-repository document (`repository-files/{repoId}.json`, via `RepositoryFileManager`) and delivered only through git (Commit & Push, then a pull in each workspace) rather than written directly into workspace folders. Both reuse the scope-neutral rules in `file-definition.ts` (segment validation, `Directory` normalisation, the executable/line-ending heuristics) rather than duplicating them.

## Folder Structure

| Directory | Contents |
|---|---|
| `project/` | ProjectManager, ProjectData and ProjectWorkspace types, project index, `CustomFile` (project-scoped custom files) |
| `repository/` | RepositoryManager, Repository type, repository store, `RepositoryFile`/`RepositoryFileManager` (Milestone 2 — repository-scoped custom files, `repository-files/{repoId}.json`) |
| `workspace/` | WorkspaceManager, WorkspaceInfo type, STABLE_WORKSPACE_ID constant |
| `file-definition.ts` | Scope-neutral file-definition rules (`Directory` normalisation, segment validation, `isExecutableFile()`, `applyLineEndingPolicy()`) shared by `CustomFile` and `RepositoryFile` — no filesystem access, pure functions only. |

## Integration Points

- **Dependencies**: `config` (AppConfig for storage paths), `storage` (JSON read/write primitives).
- **Consumed by**: Orchestration layer, Server route handlers.
