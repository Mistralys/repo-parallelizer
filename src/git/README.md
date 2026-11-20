# Git Layer

Stateless functions wrapping Git CLI subprocess calls. All operations spawn `git` with `shell: false` for security.

## Key Concepts

- **Stateless**: Every function takes a repository path as argument. No cached state.
- **GitResult**: Unified return type with exit code, stdout, and stderr.
- **Timeout support**: Clone, fetch, and push operations accept timeout values to prevent hanging on unreachable remotes.
- **Branch operations**: Listing, creating, switching, checking existence — all work with both local and remote branches.
- **Non-interactive auth suppression**: `runGit()` always sets `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=echo` in the subprocess environment. This is intentional — `GIT_TERMINAL_PROMPT=0` suppresses TTY prompts, and `GIT_ASKPASS=echo` bypasses all credential helpers (including macOS osxkeychain and Linux libsecret) by substituting a no-op askpass binary that returns empty credentials immediately, causing git to fail fast on unauthenticated requests. Do **not** remove `GIT_ASKPASS=echo` — `GIT_TERMINAL_PROMPT=0` alone does not prevent osxkeychain from blocking indefinitely on macOS.
- **Pre-flight argument validation:** branch/ref names, commit identity fields, and sparse-checkout paths are validated before a `GitResult`-returning function ever invokes git — an invalid value resolves immediately with `exitCode: 128` and a `fatal: ...` message in the same shape git itself would produce, rather than being passed through. Each of `git-remote.ts` and `git-commit.ts` defines its own narrowly-scoped guard (`isValidRefName()`, `isValidIdentityValue()`); see those files' module-level comments for the exact character classes rejected.
- **Pathspec/flag-injection guard:** every function that accepts a path or ref derived from caller/config input (fetch/push refspecs, `getPathStatus()`/`stagePaths()`/`commitPaths()` pathspecs) passes it after a literal `--` separator or as part of a pre-validated refspec string, never as a bare trailing argument — this prevents a value starting with `-` from being interpreted as a git flag.

## Files

| File | Responsibility |
|---|---|
| `git.types.ts` | Type definitions: GitResult, GitStatusInfo, BranchInfo, CloneOptions, PathStatusEntry |
| `git-cli.ts` | Low-level `runGit()` and `runGitOrThrow()` subprocess execution; `runGitOrThrow()` strips embedded credential tokens from `stderr` (via `stripEmbeddedCredentials()`) before building its thrown error message |
| `git-credentials.ts` | URL credential utilities: `resolveCredential()`, `injectCredentialToken()`, `extractHost()`, `hasEmbeddedCredentials()`, `stripEmbeddedCredentials()`. |
| `git-clone.ts` | `cloneRepository()` with depth, timeout, partial-clone (`filter: 'blob:none'`), and `noCheckout` options; `FILTER_UNSUPPORTED_WARNING`; `setSparseCheckout()` |
| `git-remote.ts` | Remote URL read/set (`getRemoteUrl()`, `setRemoteUrl()`), branch-scoped fetch/push (`fetchBranch()`, `pushHead()`), fast-forward merge (`mergeFastForward()`), ahead/behind counting (`countAheadBehind()`), changed-path diffing (`changedPathsBetween()`), and URL equivalence comparison (`remoteUrlsMatch()`) |
| `git-commit.ts` | Pathspec-scoped status/staging/commit: `getPathStatus()`, `stagePaths()`, `commitPaths()` (with a one-off `CommitIdentity`, never touching the repo's persisted `user.name`/`user.email`) |
| `git-branch.ts` | Branch listing, creation, switching, existence checks |
| `git-status.ts` | Repository status: current branch, uncommitted changes, conflicts |

## Remote URL Lifecycle (`git-remote.ts`)

`setRemoteUrl()` can be used to temporarily point `origin` at a credential-embedded URL (produced by `injectCredentialToken()`) for a single `fetchBranch()`/`pushHead()` call. **The embedded token is written to the repository's `.git/config` on disk for as long as that URL remains configured** — a caller that does this must restore the plain URL via a second `setRemoteUrl()` call immediately afterward, rather than leaving the authenticated URL configured. This mirrors the non-persistence contract on `resolveRemoteAuth()`'s `url` (see `src/orchestration/remote-auth.ts`), extended to cover on-disk git config as well as in-memory/log/API exposure.

`fetchBranch()`/`pushHead()`/`mergeFastForward()`/`countAheadBehind()`/`changedPathsBetween()` all operate against an explicit branch/ref name (validated via the shared refname guard) rather than git's default "whatever is configured" behavior — this is a deliberate departure from `fetchRemote()`/the branch-wide operations in `git-branch.ts`, chosen so the managed-clone sync flow only ever touches the one branch it is responsible for.

`remoteUrlsMatch()` normalises both URLs (strip embedded credentials, lowercase host, drop a trailing `/` or `.git`) before comparing, so a worktree's locally configured `origin` URL can be compared against the project's stored `Repository.Url` without false mismatches from cosmetic formatting differences — including SCP-style SSH URLs (`git@host:org/repo.git`), which are handled via a separate non-WHATWG-URL code path.

## Pathspec-Scoped Operations (`git-commit.ts`)

`getPathStatus()`, `stagePaths()`, and `commitPaths()` restrict their effect to a single pathspec (e.g. the `.workspace/info.json` sync artifact), unlike `getGitStatus()` in `git-status.ts` which reports the whole working tree. This lets a caller manage one narrow set of files without being influenced by, or accidentally touching, unrelated uncommitted changes elsewhere in the repository.

## Credential Pipeline

`git-credentials.ts` implements a two-step pipeline for injecting HTTPS credentials into clone URLs:

1. **`resolveCredential(url, credentials, credentialId?)`** — selects the correct `GitCredentialEntry` from the configured credential array. When `credentialId` is supplied it performs an exact ID lookup; otherwise it auto-selects the single credential whose `host` matches the URL's hostname (returns `null` if zero or multiple matches are found).
2. **`injectCredentialToken(url, token)`** — embeds the resolved token into the URL as the WHATWG URL username (`https://<token>@<host>/...`). Token characters are automatically percent-encoded; no string concatenation is used.

SSH URLs (`git@…`, `ssh://…`) return `null` from `extractHost()` and are bypassed by both steps — authentication is delegated to the SSH agent.

**Security note:** When `credentialId` is explicit, `resolveCredential()` does not cross-validate the credential's `host` against the URL's hostname. Callers (i.e. the orchestrators) are responsible for ensuring coherence — see the `@remarks` block in `resolveCredential()`.

## Integration Points

- **Consumed by**: Orchestration layer (WorkspaceOrchestrator, BranchOrchestrator).
- **Dependencies**: None (uses Node.js `child_process` only).
