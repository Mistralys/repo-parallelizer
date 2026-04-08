# Plan — Phase 2: Core Data Models & Storage

## Summary

Implement the three core data models — Repositories, Projects, and Workspaces — with full CRUD operations backed by the JSON storage layer from Phase 1. This phase establishes the domain logic that all higher-level operations (Git, GUI, CLI) depend on.

## Architectural Context

Phase 1 delivers:
- `src/config/config.ts` — Config loader providing `StorageFolder` and `ProjectsFolder` paths.
- `src/storage/json-storage.ts` — Generic JSON read/write utilities.
- `src/utils/slug.ts` — Slug generation, validation, and URL inference.
- `src/utils/paths.ts` — Path resolution helpers.

The tool description specifies three data types with these storage locations:
- Repositories: `{STORAGE_FOLDER}/repositories.json`
- Project index: `{STORAGE_FOLDER}/projects-index.json`
- Project metadata: `{STORAGE_FOLDER}/projects/{PROJECT_SLUG}.json`
- Workspace metadata: Embedded within the project JSON file.

## Approach / Architecture

```
src/
├── models/
│   ├── repository/
│   │   ├── repository.types.ts      # Repository type definitions
│   │   └── repository.manager.ts    # Repository CRUD operations
│   ├── project/
│   │   ├── project.types.ts         # Project + workspace type definitions
│   │   └── project.manager.ts       # Project CRUD operations
│   └── workspace/
│       ├── workspace.types.ts       # Workspace-specific types
│       └── workspace.manager.ts     # Workspace CRUD operations (delegates to project storage)
```

Each manager is a class that receives the loaded config and provides typed CRUD methods. Managers operate on JSON files through the storage utilities. Workspace data is stored inside the project JSON, but the workspace manager provides a focused API for workspace-level operations.

## Rationale

- **Manager classes** encapsulate all data access for each entity, making them easy to consume from both the GUI API and CLI.
- **Workspace embedded in project JSON** matches the spec and avoids file proliferation, since workspaces are always scoped to a project.
- **Project index file** exists for fast lookup without reading all individual project files — the manager keeps it in sync automatically.
- **Validation at the manager boundary** ensures no invalid data reaches storage, regardless of caller (API, CLI, or orchestration code).

## Detailed Steps

### 1. Repository Model

1. **Define types** in `src/models/repository/repository.types.ts`:
   - `Repository`: `{ ID: string; Name: string; URL: string }`
   - `RepositoryStore`: `{ Repositories: Repository[]; SchemaVersion: number }`

2. **Implement RepositoryManager** in `src/models/repository/repository.manager.ts`:
   - Constructor receives config, resolves storage path (`{STORAGE_FOLDER}/repositories.json`).
   - `list(): Repository[]` — Returns all repositories.
   - `getById(id: string): Repository | undefined` — Finds by ID.
   - `add(url: string, name?: string, id?: string): Repository` — Infers ID from URL if not provided, validates the inferred ID is non-empty (throws a descriptive error if the URL cannot produce a valid slug), validates uniqueness (ID and URL), saves.
   - `update(id: string, changes: { Name?: string }): Repository` — Updates mutable fields only (Name). URL changes are out of scope per the spec.
   - `remove(id: string): void` — Removes from storage. Does NOT cascade to projects (that's Phase 4 orchestration).
   - `exists(id: string): boolean` — Quick existence check.
   - Private: `load()`, `save()` using the JSON storage utilities.

### 2. Project Model

3. **Define types** in `src/models/project/project.types.ts`:
   - `ProjectWorkspace`: `{ Description: string; DateCreated: string; DateModified: string }`
   - `ProjectData`: `{ ID: string; Name: string; Description: string; DateCreated: string; DateModified: string; Repositories: string[]; Workspaces: Record<string, ProjectWorkspace>; SchemaVersion: number }`
   - `ProjectIndexEntry`: `{ ID: string; Name: string }`
   - `ProjectIndex`: `{ Projects: ProjectIndexEntry[]; SchemaVersion: number }`

4. **Implement ProjectManager** in `src/models/project/project.manager.ts`:
   - Constructor receives config **and a reference to RepositoryManager**, resolves paths.
   - `list(): ProjectIndexEntry[]` — Returns all projects from the index.
   - `getById(id: string): ProjectData | undefined` — Reads the individual project file.
   - `create(name: string, repositoryIds: string[], description?: string, id?: string): ProjectData` — Validates inputs, generates ID from name if not provided, validates repository IDs exist, creates project file with auto-created STABLE workspace, updates index, creates project folder.
   - `update(id: string, changes: { Name?: string; Description?: string }): ProjectData` — Updates mutable fields, updates DateModified, syncs index if Name changed.
   - `rename(oldId: string, newId: string): ProjectData` — Renames the project ID. Updates the project file, index, and renames the storage file. Folder/workspace file renaming is Phase 4 (orchestration).
   - `remove(id: string): void` — Removes from index, deletes project file. Filesystem cleanup is Phase 4.
   - `addRepository(projectId: string, repositoryId: string): ProjectData` — Adds a repo ID to the project's repository list. Cloning is Phase 4.
   - `removeRepository(projectId: string, repositoryId: string): ProjectData` — Removes a repo ID from the project. Clone deletion is Phase 4.
   - Private: `loadIndex()`, `saveIndex()`, `loadProject(id)`, `saveProject(data)`.

### 3. Workspace Model

5. **Define types** in `src/models/workspace/workspace.types.ts`:
   - Re-export `ProjectWorkspace` from project types.
   - `WorkspaceInfo`: Extended type with the workspace ID and parent project ID for convenience.

6. **Implement WorkspaceManager** in `src/models/workspace/workspace.manager.ts`:
   - Constructor receives config and a reference to the ProjectManager.
   - `list(projectId: string): WorkspaceInfo[]` — Lists all workspaces for a project.
   - `getById(projectId: string, workspaceId: string): WorkspaceInfo | undefined` — Gets a specific workspace.
   - `create(projectId: string, workspaceId: string, description?: string): WorkspaceInfo` — Validates workspace ID format (2-6 uppercase A-Z), validates uniqueness within project, adds workspace entry to project data, saves. Filesystem setup and cloning is Phase 4.
   - `update(projectId: string, workspaceId: string, changes: { Description?: string }): WorkspaceInfo` — Updates mutable fields, updates DateModified.
   - `rename(projectId: string, oldId: string, newId: string): WorkspaceInfo` — Renames workspace ID within the project data. Filesystem/VS Code file changes are Phase 4.
   - `remove(projectId: string, workspaceId: string): void` — Validates not STABLE, removes from project data. Filesystem cleanup is Phase 4.
   - `isStable(workspaceId: string): boolean` — Returns true if the workspace ID is "STABLE".

### 4. Initialization & Directory Setup

7. **Implement storage initialization** in `src/storage/json-storage.ts` (extend):
   - `initializeStorage(config: AppConfig): void` — Creates the storage folder structure if it doesn't exist:
     - `{STORAGE_FOLDER}/`
     - `{STORAGE_FOLDER}/projects/`
     - `{PROJECTS_FOLDER}/`
   - Creates empty `repositories.json` and `projects-index.json` if they don't exist (with empty arrays and SchemaVersion: 1).

## Dependencies

- Phase 1 deliverables: config system, JSON storage utilities, slug utilities, path utilities.

## Required Components

- **NEW** `src/models/repository/repository.types.ts`
- **NEW** `src/models/repository/repository.manager.ts`
- **NEW** `src/models/project/project.types.ts`
- **NEW** `src/models/project/project.manager.ts`
- **NEW** `src/models/workspace/workspace.types.ts`
- **NEW** `src/models/workspace/workspace.manager.ts`
- **MODIFY** `src/storage/json-storage.ts` — Add `initializeStorage()`

## Assumptions

- All data validation happens at the manager level; callers pass raw user input.
- Workspace IDs are always uppercase 2-6 character alphabetic strings.
- The STABLE workspace is automatically created when a project is created and cannot be deleted.
- Managers do not perform filesystem operations on project/workspace folders or Git clones — that is Phase 4 (Workspace Orchestration).
- DateCreated and DateModified use ISO 8601 format with timezone.

## Constraints

- Managers must be stateless between calls (re-read from disk each time) to avoid stale data issues.
- All mutations must update DateModified on the relevant entity.
- Project index must always be kept in sync with individual project files.

## Out of Scope

- Git operations (cloning, branching, status) — Phase 3.
- Filesystem orchestration (folder creation, VS Code files, cascading deletes) — Phase 4.
- HTTP API endpoints — Phase 5.
- GUI — Phase 6.

## Acceptance Criteria

- RepositoryManager can add, list, get, update, and remove repositories with proper validation (unique ID, unique URL, valid slug).
- ProjectManager can create projects (with auto-STABLE workspace), list, get, update, rename, and remove them. Project index stays in sync.
- WorkspaceManager can create (with ID validation), list, get, update, rename, and remove workspaces. STABLE cannot be deleted.
- All managers reject invalid input with descriptive error messages.
- Storage initialization creates the required directory structure and seed files.
- All data files conform to the schemas defined in the tool description.

## Testing Strategy

- Unit tests for each manager:
  - CRUD round-trip for repositories (add → list → get → update → remove).
  - CRUD round-trip for projects with automatic STABLE workspace creation.
  - CRUD round-trip for workspaces, including STABLE deletion prevention.
  - Validation tests: duplicate IDs, duplicate URLs, invalid workspace IDs, missing required fields.
  - Index sync verification: create/rename/delete projects and verify index consistency.
- Use a temporary directory for storage during tests.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Index out of sync with project files** | Every project mutation updates the index atomically in the same save operation |
| **Concurrent reads during write** | Single-developer tool; acceptable. Managers re-read on each call to avoid stale in-memory state |
| **Schema evolution** | SchemaVersion field in every data file enables future migrations |
| **Workspace ID collisions across projects** | IDs are scoped to their project; uniqueness is only enforced within a project |
