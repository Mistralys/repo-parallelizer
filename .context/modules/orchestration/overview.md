# Orchestration - Overview
```
// Structure of documents
└── src/
    └── orchestration/
        └── README.md

```
###  Path: `/src/orchestration/README.md`

```md
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
| `project-orchestrator.ts` | Create, delete, rename projects (clones repos into STABLE workspace) |
| `repository-orchestrator.ts` | Add/remove repos from projects, delete repos globally |
| `workspace-orchestrator.ts` | Create, delete, rename workspaces (clones repos into new workspace) |
| `branch-orchestrator.ts` | Multi-repo branch switching with conflict detection |
| `vscode-workspace.ts` | Generate `.code-workspace` files for VS Code |
| `workspace-health.ts` | Side-effect-free health checks for workspaces (missing files, uncloned repos, credential errors) |

## Credential Success Logging

After a successful credential-based clone, both `WorkspaceOrchestrator.createWorkspace()` and `RepositoryOrchestrator.addRepositoryToProject()` write a `Source: 'credentials'`, `Severity: 'info'` entry to the error log. This entry is used by `checkWorkspaceHealth()` to suppress stale credential-missing health badges without deleting history.

- **`workspace-setup` operation** — written by `WorkspaceOrchestrator.createWorkspace()`.
- **`add-repository` operation** — written by `RepositoryOrchestrator.addRepositoryToProject()`.
- **SSH clones** (`credential === null`) do not produce a credentials log entry.

`checkWorkspaceHealth()` inspects the most recent `Source: 'credentials'` entry per repository: a `Severity: 'info'` entry suppresses the badge; a `Severity: 'error'` entry surfaces it. See `workspace-health.ts` `@remarks` for the full stale-badge resolution description.

## Integration Points

- **Dependencies**: `config`, `models` (ProjectManager, RepositoryManager, WorkspaceManager), `git` (clone, branch, status), `error-log` (ErrorLogManager — optional, for credential health checks).
- **Consumed by**: Server route handlers, CLI.

```
---
**File Statistics**
- **Size**: 1.67 KB
- **Lines**: 44
File: `modules/orchestration/overview.md`
