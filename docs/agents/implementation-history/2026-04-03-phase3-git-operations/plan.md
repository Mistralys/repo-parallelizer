# Plan — Phase 3: Git Operations Layer

## Summary

Implement a cross-platform Git CLI wrapper that provides all Git operations needed by the tool: cloning with configurable depth, branch management (list, create, switch, detect default branch), and status polling (local commits, unfetched commits, modified file count, last activity). All operations use `child_process.spawn` with `shell: false` for guaranteed cross-platform behavior.

## Architectural Context

Phase 1 delivers the configuration system (including `CloneDepth` default).
Phase 2 delivers the data models that describe where repositories are cloned and which branches are expected.

The tool description specifies:
- Git interface: CLI (Git is available on all systems).
- CLI interface: Node's `child_process.spawn` with `shell: false`.
- Status polling fields: local commits, unfetched commits on origin, modified file count, last activity.
- Branch switching: create new or switch to existing, carry over uncommitted changes (no stash), detect conflicts.
- Clone depth: configurable, default 50.

## Approach / Architecture

```
src/
├── git/
│   ├── git.types.ts          # Git-related type definitions
│   ├── git-cli.ts            # Low-level spawn wrapper for Git commands
│   ├── git-clone.ts          # Clone operations
│   ├── git-branch.ts         # Branch operations (list, create, switch, default)
│   └── git-status.ts         # Status and polling operations
```

The architecture is layered:
1. **git-cli.ts** — A thin wrapper around `child_process.spawn` that runs any Git command in a specified working directory, captures stdout/stderr, and returns structured results. All other modules build on this.
2. **git-clone.ts** — Clone-specific operations.
3. **git-branch.ts** — Branch listing, creation, switching, and default branch detection.
4. **git-status.ts** — Status queries for the polling system.

All functions are stateless and receive the target repository path (or URL) as a parameter. They do not read from or write to the data models — that coupling happens in Phase 4's orchestration layer.

## Rationale

- **`shell: false`** is specified in the requirements for cross-platform safety and to avoid shell injection.
- **Stateless functions** keep the Git layer reusable and testable in isolation.
- **Separate modules** by Git domain (clone, branch, status) for clarity and to match the distinct use cases in the GUI.
- **No Git library dependency** — the spec explicitly requires CLI-based Git access.

## Detailed Steps

### 1. Git CLI Wrapper

1. **Define types** in `src/git/git.types.ts`:
   - `GitResult`: `{ exitCode: number; stdout: string; stderr: string }`
   - `GitStatusInfo`: `{ localCommits: number; unfetchedCommits: number; modifiedFiles: number; lastActivity: string | null; currentBranch: string | null; hasConflicts: boolean }`
   - `BranchInfo`: `{ name: string; isRemote: boolean; isCurrent: boolean }`
   - `CloneOptions`: `{ depth: number; branch?: string }`

2. **Implement git-cli.ts** in `src/git/git-cli.ts`:
   - `runGit(args: string[], cwd: string): Promise<GitResult>` — Spawns `git` with the given arguments in the given directory, `shell: false`. Resolves with stdout/stderr/exitCode. Rejects only on spawn failure (process not found), not on non-zero exit codes (callers decide what's an error).
   - `runGitOrThrow(args: string[], cwd: string): Promise<string>` — Convenience wrapper that throws on non-zero exit code, returns stdout trimmed.

### 2. Clone Operations

3. **Implement git-clone.ts** in `src/git/git-clone.ts`:
   - `cloneRepository(url: string, targetDir: string, options: CloneOptions): Promise<GitResult>` — Runs `git clone --depth {depth} [--branch {branch}] {url} {targetDir}`. Returns the full result for error handling by the caller.
   - The caller (Phase 4) is responsible for directory creation and error handling UI.

### 3. Branch Operations

4. **Implement git-branch.ts** in `src/git/git-branch.ts`:
   - `listBranches(repoDir: string): Promise<BranchInfo[]>` — Runs `git branch -a` and parses output into typed branch info. Separates local and remote branches.
   - `getCurrentBranch(repoDir: string): Promise<string | null>` — Runs `git rev-parse --abbrev-ref HEAD`.
   - `getDefaultBranch(repoDir: string): Promise<string>` — Determines the remote's default branch. Strategy: `git symbolic-ref refs/remotes/origin/HEAD` → parse, fallback to checking for `main` or `master`.
   - `createBranch(repoDir: string, branchName: string): Promise<void>` — Runs `git checkout -b {branchName}`. Does not stash — carries over changes as specified.
   - `switchBranch(repoDir: string, branchName: string): Promise<GitResult>` — Runs `git checkout {branchName}`. Returns full result so the caller can detect conflicts (non-zero exit + stderr containing "conflict" or "overwritten").
   - `branchExists(repoDir: string, branchName: string, includeRemote: boolean): Promise<boolean>` — Checks if a branch exists locally (and optionally on the remote).
   - `fetchRemote(repoDir: string): Promise<void>` — Runs `git fetch origin`.

### 4. Status Operations

5. **Implement git-status.ts** in `src/git/git-status.ts`:
   - `getGitStatus(repoDir: string): Promise<GitStatusInfo>` — Aggregates multiple Git queries into a single status object:
     - **localCommits**: `git rev-list --count @{upstream}..HEAD` (commits ahead of upstream). Falls back to 0 if no upstream is set.
     - **unfetchedCommits**: `git rev-list --count HEAD..@{upstream}` after a `git fetch --dry-run` equivalent. Uses `git rev-list --count HEAD..origin/{branch}` after fetch.
     - **modifiedFiles**: `git status --porcelain` → count non-empty lines.
     - **lastActivity**: `git log -1 --format=%cI` → ISO 8601 timestamp of last commit.
     - **currentBranch**: Via `getCurrentBranch()`.
     - **hasConflicts**: `git status --porcelain` → look for lines starting with `UU`, `AA`, `DD`, etc.
   - `fetchAndGetStatus(repoDir: string): Promise<GitStatusInfo>` — Runs `git fetch origin` first (to update remote tracking), then `getGitStatus()`. This is the method the polling system will use.

## Dependencies

- Phase 1: Configuration (for `CloneDepth` default).
- Git must be installed and available on `PATH`.

## Required Components

- **NEW** `src/git/git.types.ts` — Git type definitions
- **NEW** `src/git/git-cli.ts` — Low-level spawn wrapper
- **NEW** `src/git/git-clone.ts` — Clone operations
- **NEW** `src/git/git-branch.ts` — Branch operations
- **NEW** `src/git/git-status.ts` — Status polling operations

## Assumptions

- Git is installed and available on `PATH` on all target platforms.
- Remote is always named `origin` (standard for cloned repositories).
- Branch names do not contain characters that would break Git CLI argument parsing (Git enforces this).
- `git fetch` is acceptable for status polling (network access is assumed).

## Constraints

- All Git commands use `spawn` with `shell: false` — no shell injection vectors.
- Git arguments must never include user input without validation (branch names are validated in Phase 2's workspace model).
- Operations are async (Promise-based) since `spawn` is inherently asynchronous.

## Out of Scope

- Orchestrating multi-repo clone/branch operations (Phase 4).
- Git polling scheduler/timer (Phase 5).
- Merge/conflict resolution (explicitly out of scope per tool description).
- Git authentication (assumed pre-configured via SSH keys or credential helper).

## Acceptance Criteria

- `runGit()` correctly spawns Git commands on macOS, captures stdout/stderr, and returns exit codes.
- `cloneRepository()` clones a public repository with the specified depth.
- `listBranches()` returns correctly typed local and remote branches.
- `getDefaultBranch()` detects the default branch for a cloned repository.
- `createBranch()` and `switchBranch()` work correctly, with `switchBranch()` reporting conflicts via its result.
- `fetchAndGetStatus()` returns accurate status info: local commit count, unfetched commit count, modified file count, last activity timestamp, and current branch.

## Testing Strategy

- **Unit tests with a real Git repo**: Create a temporary Git repository (local, no remote) to test branch operations, status queries, and CLI wrapper behavior.
- **Integration test with a remote**: Clone a small public GitHub repository to verify clone, fetch, and remote branch detection.
- **Edge case tests**: No upstream set, empty repository, detached HEAD, no commits.
- **Error handling tests**: Invalid repository path, Git not found, network failure during fetch.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Git not installed** | `runGit` checks for ENOENT spawn error and provides a clear "Git not found" message |
| **Network failures during fetch** | `fetchAndGetStatus` catches fetch errors and returns status with a flag; polling continues |
| **Inconsistent Git output across versions** | Parse Git output conservatively; use `--porcelain` where available for machine-readable output |
| **Long-running Git operations block polling** | Clone/fetch are async; polling uses reasonable timeouts |
| **Shell injection via branch names** | `shell: false` prevents injection; branch names validated by workspace model |
