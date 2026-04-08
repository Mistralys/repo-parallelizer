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

## Integration Points

- **Dependencies**: `config`, `models` (ProjectManager, RepositoryManager, WorkspaceManager), `git` (clone, branch, status).
- **Consumed by**: Server route handlers, CLI.
