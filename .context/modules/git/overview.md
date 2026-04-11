# Git - Overview
```
// Structure of documents
└── src/
    └── git/
        └── README.md

```
###  Path: `/src/git/README.md`

```md
# Git Layer

Stateless functions wrapping Git CLI subprocess calls. All operations spawn `git` with `shell: false` for security.

## Key Concepts

- **Stateless**: Every function takes a repository path as argument. No cached state.
- **GitResult**: Unified return type with exit code, stdout, and stderr.
- **Timeout support**: Clone and fetch operations accept timeout values to prevent hanging on unreachable remotes.
- **Branch operations**: Listing, creating, switching, checking existence — all work with both local and remote branches.
- **Non-interactive auth suppression**: `runGit()` always sets `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=echo` in the subprocess environment. This is intentional — `GIT_TERMINAL_PROMPT=0` suppresses TTY prompts, and `GIT_ASKPASS=echo` bypasses all credential helpers (including macOS osxkeychain and Linux libsecret) by substituting a no-op askpass binary that returns empty credentials immediately, causing git to fail fast on unauthenticated requests. Do **not** remove `GIT_ASKPASS=echo` — `GIT_TERMINAL_PROMPT=0` alone does not prevent osxkeychain from blocking indefinitely on macOS.

## Files

| File | Responsibility |
|---|---|
| `git.types.ts` | Type definitions: GitResult, GitStatusInfo, BranchInfo, CloneOptions |
| `git-cli.ts` | Low-level `runGit()` and `runGitOrThrow()` subprocess execution |
| `git-credentials.ts` | URL credential utilities: `extractHost()`, `injectCredentials()`, `hasEmbeddedCredentials()`, `stripEmbeddedCredentials()` |
| `git-clone.ts` | `cloneRepository()` with depth and timeout options |
| `git-branch.ts` | Branch listing, creation, switching, existence checks |
| `git-status.ts` | Repository status: current branch, uncommitted changes, conflicts |

## Integration Points

- **Consumed by**: Orchestration layer (WorkspaceOrchestrator, BranchOrchestrator).
- **Dependencies**: None (uses Node.js `child_process` only).

```
---
**File Statistics**
- **Size**: 2.11 KB
- **Lines**: 46
File: `modules/git/overview.md`
