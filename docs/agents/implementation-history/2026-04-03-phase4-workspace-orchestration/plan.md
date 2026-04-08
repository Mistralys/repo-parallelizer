# Plan — Phase 4: Workspace Orchestration & VS Code Integration

## Summary

Implement the orchestration layer that ties data models (Phase 2) and Git operations (Phase 3) together into high-level workflows: creating workspaces with automatic repository cloning, managing VS Code workspace files, branch switching across multiple repositories, cascading project/workspace renames and deletions, and adding/removing repositories with proper side effects.

## Architectural Context

Phase 2 provides managers that handle data persistence (repositories.json, project files, project index). They intentionally do NOT touch the filesystem (folders, clones, VS Code files).

Phase 3 provides stateless Git functions (clone, branch, status) that operate on a given directory.

This phase bridges the gap: it composes data mutations with filesystem operations and Git commands to implement the full user-facing workflows described in the tool description.

## Approach / Architecture

```
src/
├── orchestration/
│   ├── workspace-orchestrator.ts   # Workspace lifecycle (create, delete, rename)
│   ├── project-orchestrator.ts     # Project lifecycle (create, delete, rename)
│   ├── repository-orchestrator.ts  # Repository lifecycle (add/remove from project, global delete)
│   ├── branch-orchestrator.ts      # Multi-repo branch switching workflow
│   └── vscode-workspace.ts         # VS Code workspace file management
```

Orchestrators are the top-level coordination layer. They call managers for data changes and Git/filesystem functions for side effects. The GUI API (Phase 5) calls orchestrators, never managers directly (for operations that have side effects).

## Rationale

- **Separate orchestration from data and Git layers** keeps each layer testable in isolation and avoids circular dependencies.
- **VS Code workspace file management** is isolated in its own module because the file format requires careful handling (preserve user settings, update only `folders`).
- **Orchestrators return structured results** (success/failure per repository) to support partial-failure UIs in the frontend.

## Detailed Steps

### 1. VS Code Workspace File Manager

1. **Implement `src/orchestration/vscode-workspace.ts`**:
   - `generateWorkspaceFile(projectName: string, workspaceId: string, repoPaths: { slug: string; path: string }[], filePath: string): void`
     - If the file does NOT exist: create it with the `folders` array and empty `settings`.
     - If the file DOES exist: read it, parse JSON, replace only the `folders` property, preserve all other properties (settings, extensions, etc.), write back.
     - Each folder entry: `{ "path": "<absolute-path>", "name": "<PROJECT_NAME> (<WORKSPACE_ID>)" }`.
   - `removeWorkspaceFile(filePath: string): void` — Deletes the VS Code workspace file.
   - `getWorkspaceFilePath(projectsFolder: string, projectSlug: string, workspaceId: string): string` — Returns `{PROJECTS_FOLDER}/{PROJECT_SLUG}-{WORKSPACE_ID}.code-workspace`.

### 2. Workspace Orchestrator

2. **Implement `src/orchestration/workspace-orchestrator.ts`**:
   - **`createWorkspace(projectId, workspaceId, description?)`**:
     1. Call `WorkspaceManager.create()` to add workspace data.
     2. Create workspace folder: `{PROJECTS_FOLDER}/{PROJECT_SLUG}/{WORKSPACE_ID}/`.
     3. For each repository in the project:
        - Clone into `{PROJECTS_FOLDER}/{PROJECT_SLUG}/{WORKSPACE_ID}/{REPO_SLUG}/` using `cloneRepository()` from `src/git/git-clone.ts`.
        - Use the remote's default branch.
        - Use configured `cloneDepth` as the `depth` option.
        - Pass a reasonable `timeoutMs` (see Timeout Strategy below).
        - Track success/failure per repository.
     4. Generate the VS Code workspace file (include only successfully cloned repos).
     5. Return a result object with per-repo clone status.

   - **`deleteWorkspace(projectId, workspaceId)`**:
     1. Validate not STABLE.
     2. Delete workspace folder recursively: `{PROJECTS_FOLDER}/{PROJECT_SLUG}/{WORKSPACE_ID}/`.
     3. Delete VS Code workspace file.
     4. Call `WorkspaceManager.remove()` to remove workspace data.

   - **`renameWorkspace(projectId, oldId, newId)`**:
     1. Validate not renaming STABLE.
     2. Call `WorkspaceManager.rename()` to update data.
     3. Rename workspace folder: `{OLD_ID}/` → `{NEW_ID}/`.
     4. Rename VS Code workspace file.
     5. Regenerate VS Code workspace file content (update folder paths and display names).

### 3. Project Orchestrator

3. **Implement `src/orchestration/project-orchestrator.ts`**:
   - **`createProject(name, repositoryIds, description?, id?)`**:
     1. Call `ProjectManager.create()` to create project data (includes STABLE workspace).
     2. Create project folder: `{PROJECTS_FOLDER}/{PROJECT_SLUG}/`.
     3. Call `WorkspaceOrchestrator.createWorkspace()` for the STABLE workspace (clones repos).

   - **`deleteProject(projectId)`**:
     1. Delete entire project folder recursively: `{PROJECTS_FOLDER}/{PROJECT_SLUG}/`.
     2. Delete all VS Code workspace files for this project.
     3. Call `ProjectManager.remove()` to remove the project metadata file and update the index.
        > Note: `ProjectManager.remove()` handles both deleting the project JSON file and updating `projects-index.json` — do not delete the metadata file separately.

   - **`renameProject(oldId, newId)`**:
     1. Call `ProjectManager.rename()` to update data.
        > Note: `ProjectManager.rename()` handles renaming the project JSON file on disk and updating the index — the orchestrator does not need to touch data files.
     2. Rename project folder: `{OLD_SLUG}/` → `{NEW_SLUG}/`.
     3. Rename and regenerate all VS Code workspace files for this project (new file names and updated folder paths).

### 4. Repository Orchestrator

4. **Implement `src/orchestration/repository-orchestrator.ts`**:
   - **`addRepositoryToProject(projectId, repositoryId)`**:
     1. Call `ProjectManager.addRepository()` to update data.
     2. For each workspace in the project:
        - Clone the repository into the workspace folder using the remote's default branch.
        - Track success/failure per workspace.
     3. Update all VS Code workspace files for this project.
     4. Return result with per-workspace clone status.

   - **`removeRepositoryFromProject(projectId, repositoryId)`**:
     1. For each workspace in the project:
        - Delete the repository clone folder.
     2. Call `ProjectManager.removeRepository()` to update data.
     3. Update all VS Code workspace files for this project.

   - **`deleteRepositoryGlobally(repositoryId)`**:
     1. Find all projects using this repository (scan project index + individual project files).
     2. For each project: call `removeRepositoryFromProject()`.
     3. Call `RepositoryManager.remove()` to remove from global list.

### 5. Branch Orchestrator

5. **Implement `src/orchestration/branch-orchestrator.ts`**:
   - **`getAvailableBranches(projectId, workspaceId): Promise<Map<string, BranchInfo[]>>`**:
     - For each repository in the workspace, fetch and list all branches.
     - Returns a map of `repoId → BranchInfo[]`.

   - **`compileBranchSuggestions(branchMap): string[]`**:
     - Compile a deduplicated, case-insensitive list of branch names across all repositories.
     - Used for the "choose existing branch" UI in the GUI.

   - **`switchBranches(projectId, workspaceId, branchAssignments: Record<string, string>): Promise<BranchSwitchResult>`**:
     - `branchAssignments` is a map of `repoId → branchName`.
     - For each repository:
       1. Use `branchExists()` to check if the branch exists locally or remotely.
       2. If the branch doesn't exist: create it with `createBranch()` (uses `git switch -c`).
       3. If the branch exists: switch to it with `switchBranch()` (uses `git switch`).
       4. Track result per repository (success, conflict, error).
     - Update workspace's DateModified.
     - Return structured result with per-repo outcomes.

   - Type `BranchSwitchResult`: `{ results: Record<string, { success: boolean; conflict: boolean; error?: string }> }`

## Timeout Strategy

Phase 3 hardening added `timeoutMs` support to `cloneRepository()`, `fetchRemote()`, and `fetchAndGetStatus()`. Orchestrators should propagate timeouts as follows:

- **Clone operations:** Use a generous default (e.g. 120 000 ms / 2 minutes). This can be a constant in the orchestration layer — it does not need to be user-configurable in Phase 4, but should be extracted to a named constant so it can be promoted to `AppConfig` later if needed.
- **Fetch operations:** `fetchAndGetStatus()` already accepts an optional `timeoutMs`. Use a shorter default (e.g. 30 000 ms / 30 seconds) since fetches are incremental.
- If a clone or fetch times out, it should be treated as a failure in the per-repo result (same as any other non-zero exit code).

## Dependencies

- Phase 1: Configuration (paths, `cloneDepth`).
- Phase 2: All managers (RepositoryManager, ProjectManager, WorkspaceManager).
- Phase 3: All Git operations (clone, branch, status) — including `timeoutMs` support added in Phase 3 hardening.
- Node.js `fs` module for filesystem operations (mkdir, rm, rename).

## Required Components

- **NEW** `src/orchestration/vscode-workspace.ts`
- **NEW** `src/orchestration/workspace-orchestrator.ts`
- **NEW** `src/orchestration/project-orchestrator.ts`
- **NEW** `src/orchestration/repository-orchestrator.ts`
- **NEW** `src/orchestration/branch-orchestrator.ts`

## Assumptions

- Filesystem operations (recursive delete, rename) are reliable on all target platforms via `fs.promises`.
- VS Code workspace files use JSON format (not JSONC — no comments).
- The user closes VS Code workspace files before renaming projects/workspaces (otherwise file locks on Windows could interfere).
- `git clone` with `--depth` is sufficient; shallow clones can be deepened later by the user if needed.

## Constraints

- Orchestrators must handle partial failures gracefully: if 3 of 5 repos clone successfully, the 3 should be kept and the 2 failures reported.
- VS Code workspace file writes must preserve all properties except `folders`.
- Recursive directory deletion must be done carefully — only delete paths under the configured `ProjectsFolder`.

## Out of Scope

- HTTP API endpoints (Phase 5).
- GUI rendering (Phase 6).
- Git polling scheduler (Phase 5 — the orchestrator provides status functions, but the timer is server-side).

## Acceptance Criteria

- Creating a project clones all its repositories into a STABLE workspace and generates a valid VS Code workspace file.
- Creating an additional workspace clones all project repos and generates its own VS Code workspace file.
- Deleting a workspace removes its folder, clones, VS Code file, and data entry. STABLE cannot be deleted.
- Renaming a workspace/project updates all affected paths, files, and data entries.
- Adding a repository to a project clones it into all existing workspaces and updates all VS Code workspace files.
- Removing a repository deletes its clones from all workspaces and updates all VS Code workspace files.
- Branch switching handles the create-or-switch logic per repository, reports per-repo results, and carries over uncommitted changes.
- VS Code workspace file edits preserve existing user `settings` and other properties.

## Testing Strategy

- **Integration tests** with temporary directories:
  - Create a project → verify folder structure, cloned repos, VS Code file.
  - Add/remove repos → verify clone presence and VS Code file updates.
  - Delete workspace → verify complete cleanup.
  - Rename project/workspace → verify file and folder renames.
- **Branch orchestrator tests** with a local Git server (bare repos):
  - Switch branches across multiple repos, verify checkout state.
  - Create new branches, verify existence.
  - Simulate conflict scenario, verify it's reported correctly.
- **VS Code workspace file tests**:
  - Create new file → verify structure.
  - Update existing file with custom settings → verify settings preserved.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Partial clone failure leaves inconsistent state** | Orchestrator always saves successful clones; failed repos are reported but don't block the operation |
| **Windows file locks on VS Code workspace files** | Document that workspace files should not be open during rename operations; consider retry logic |
| **Recursive delete targets wrong directory** | Validate that all delete paths start with the configured ProjectsFolder |
| **Rename collision (target already exists)** | Validate target name doesn't exist before starting the rename operation |
| **Large repos slow down workspace creation** | CloneDepth (default 50) limits clone size; async cloning allows the UI to show progress |
