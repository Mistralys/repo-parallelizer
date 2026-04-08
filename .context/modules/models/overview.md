# Models - Overview
```
// Structure of documents
└── src/
    └── models/
        └── README.md

```
###  Path: `/src/models/README.md`

```md
# Models Layer

Stateless CRUD managers backed by JSON files on disk. Each manager re-reads its backing store on every public method call, ensuring concurrent writes from other processes are always visible.

## Key Concepts

- **Stateless managers**: No in-memory caching. Every call reads fresh data from disk.
- **Repository**: A named Git remote URL. Global across all projects.
- **Project**: A named collection of repositories with one or more workspaces.
- **Workspace**: A named parallel working copy within a project. Each workspace has its own cloned copies of the project's repositories.
- **STABLE workspace**: Every project has a default `STABLE` workspace that cannot be renamed or deleted.

## Folder Structure

| Directory | Contents |
|---|---|
| `project/` | ProjectManager, ProjectData and ProjectWorkspace types, project index |
| `repository/` | RepositoryManager, Repository type, repository store |
| `workspace/` | WorkspaceManager, WorkspaceInfo type, STABLE_WORKSPACE_ID constant |

## Integration Points

- **Dependencies**: `config` (AppConfig for storage paths), `storage` (JSON read/write primitives).
- **Consumed by**: Orchestration layer, Server route handlers.

```
---
**File Statistics**
- **Size**: 1.42 KB
- **Lines**: 43
File: `modules/models/overview.md`
