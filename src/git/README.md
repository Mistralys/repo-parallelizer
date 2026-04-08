# Git Layer

Stateless functions wrapping Git CLI subprocess calls. All operations spawn `git` with `shell: false` for security.

## Key Concepts

- **Stateless**: Every function takes a repository path as argument. No cached state.
- **GitResult**: Unified return type with exit code, stdout, and stderr.
- **Timeout support**: Clone and fetch operations accept timeout values to prevent hanging on unreachable remotes.
- **Branch operations**: Listing, creating, switching, checking existence — all work with both local and remote branches.

## Files

| File | Responsibility |
|---|---|
| `git.types.ts` | Type definitions: GitResult, GitStatusInfo, BranchInfo, CloneOptions |
| `git-cli.ts` | Low-level `runGit()` and `runGitOrThrow()` subprocess execution |
| `git-clone.ts` | `cloneRepository()` with depth and timeout options |
| `git-branch.ts` | Branch listing, creation, switching, existence checks |
| `git-status.ts` | Repository status: current branch, uncommitted changes, conflicts |

## Integration Points

- **Consumed by**: Orchestration layer (WorkspaceOrchestrator, BranchOrchestrator).
- **Dependencies**: None (uses Node.js `child_process` only).
