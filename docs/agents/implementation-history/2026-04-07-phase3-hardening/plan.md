# Plan — Phase 3 Hardening: Git Operations Cleanup & Security

## Summary

Address all known gaps, security deferred items, and strategic recommendations from the Phase 3 synthesis before entering Phase 4 (Workspace Orchestration). Phase 4 will exercise every `src/git/` function at scale — these hardening changes prevent reliability and security issues from compounding under orchestration.

## Architectural Context

Phase 3 delivered a complete `src/git/` module (5 source files, 5 test files, 231 tests). The synthesis identified 5 known security/reliability gaps and 6 strategic recommendations. This plan consolidates all actionable items into a focused cleanup phase.

The affected files are all within `src/git/`:

```
src/git/
├── git.types.ts         # Type additions (timeout, buffer options)
├── git-cli.ts           # Core changes (AbortController, buffer limit)
├── git-clone.ts         # URL validation
├── git-branch.ts        # Input guard extension, checkout→switch migration
└── git-status.ts        # (no direct changes, benefits from git-cli hardening)
```

## Rationale

- Phase 4 orchestrates multi-repo operations — a single hanging `git fetch` on a bad remote would block the entire workspace. The `AbortController` timeout is the single highest-priority fix.
- Input validation asymmetry (guards on `createBranch`/`switchBranch` but not `branchExists`/`fetchRemote`) is a maintenance trap that should be closed before more code builds on these functions.
- Buffer limits prevent OOM on large repos during `git log --all` or similar unbounded output commands.
- Convention/documentation gaps should be addressed before Phase 4 adds more test files.

## Detailed Steps

### 1. Add `AbortController` Timeout to `runGit()`

**Priority: HIGH** — Synthesis recommendation #1, known gap #1.

1. **Add timeout option to types** in `src/git/git.types.ts`:
   - Add `RunGitOptions`: `{ timeoutMs?: number }` (default: 30000 for network ops, no limit for local ops).
   - Extend `CloneOptions` with optional `timeoutMs`.

2. **Implement timeout in `runGit()`** in `src/git/git-cli.ts`:
   - Accept optional `RunGitOptions` parameter.
   - Create an `AbortController` when `timeoutMs` is provided.
   - Pass `signal` to `spawn()` options.
   - Set `setTimeout` to call `controller.abort()` after the specified duration.
   - On abort, resolve with `exitCode: -1` and a descriptive stderr message (do not reject — callers handle non-zero exit codes).
   - Clear the timeout on process exit.

3. **Surface timeout through callers**:
   - `cloneRepository()`: Pass `timeoutMs` from `CloneOptions` to `runGit()`.
   - `fetchRemote()`: Accept optional `timeoutMs` parameter, pass to `runGit()`.
   - `fetchAndGetStatus()`: Accept optional `timeoutMs`, pass to `fetchRemote()`.

4. **Tests** in `src/tests/git-cli.test.ts`:
   - Test that a timed-out command returns `exitCode: -1` and does not hang.
   - Test that a fast command completes normally despite a generous timeout.
   - Test that no timeout is applied when `timeoutMs` is omitted.

### 2. Add `stdout`/`stderr` Buffer Limit to `runGit()`

**Priority: MEDIUM** — Known gap #4.

1. **Add buffer limit option** to `RunGitOptions`:
   - `maxBufferBytes?: number` (default: 10 MB).

2. **Implement in `runGit()`** in `src/git/git-cli.ts`:
   - Track accumulated buffer size for both `stdout` and `stderr`.
   - When the limit is reached, kill the child process and resolve with a descriptive error in stderr.
   - Include the partial output captured up to that point in the result.

3. **Tests** in `src/tests/git-cli.test.ts`:
   - Test that exceeding the buffer limit terminates the process gracefully.

### 3. Extend `-` Prefix Input Validation Guard

**Priority: MEDIUM** — Synthesis recommendation #2, known gap #2.

1. **Add guard to `branchExists()`** in `src/git/git-branch.ts`:
   - If `branchName` starts with `-`, return `false` immediately without invoking git.

2. **Add guard to `fetchRemote()`** in `src/git/git-branch.ts`:
   - Validate that no argument starts with `-` (the `remote` parameter, if extended in future).
   - Current implementation hardcodes `origin` — add a comment documenting that this is intentionally safe.

3. **Tests** in `src/tests/git-branch.test.ts`:
   - Test that `branchExists('--flag')` returns `false` without invoking git.
   - Test that `fetchRemote()` with a valid repo path works normally.

### 4. Add URL Scheme Validation to `cloneRepository()`

**Priority: MEDIUM** — Known gap #3. Severity escalates to Critical when exposed via API in Phase 5.

1. **Implement validation** in `src/git/git-clone.ts`:
   - Before invoking git, validate the URL against an allowlist of safe schemes: `https://`, `http://`, `git://`, `ssh://`, `git@` (SCP-style).
   - Reject `ext::`, `rsh::`, and any other exotic transport protocols.
   - Return a `GitResult` with `exitCode: 128` and a descriptive stderr on rejection.

2. **Tests** in `src/tests/git-clone.test.ts`:
   - Test that `https://` and `git@` URLs are accepted.
   - Test that `ext::` and `rsh::` URLs are rejected with `exitCode: 128`.
   - Test that an empty or malformed URL is rejected.

### 5. Migrate `createBranch()` from `git checkout -b` to `git switch -c`

**Priority: LOW** — Synthesis recommendation #6.

1. **Update `createBranch()`** in `src/git/git-branch.ts`:
   - Replace `git checkout -b {branchName}` with `git switch -c {branchName}`.

2. **Update `switchBranch()`** in `src/git/git-branch.ts`:
   - Replace `git checkout {branchName}` with `git switch {branchName}`.
   - Note: Conflict detection logic may need adjustment — verify stderr patterns match under `git switch`.

3. **Guard with Git version check**:
   - `git switch` requires Git ≥ 2.23. The project already declares `engines.git >= 2.28` in `package.json`, so this is safe.

4. **Tests** in `src/tests/git-branch.test.ts`:
   - Existing branch tests should continue to pass. Verify stderr patterns for conflict detection still match.

### 6. Add Bare-Clone Test Coverage

**Priority: LOW** — Noted in synthesis "Next Steps" section.

1. **Add test** in `src/tests/git-clone.test.ts`:
   - Test that `cloneRepository()` with `bare: true` (if supported in `CloneOptions`) produces a bare repository.
   - Verify the cloned directory contains no working tree (check for `HEAD` file at root, absence of `.git` subdirectory).

2. **Update README** if the bare-clone gap-marker note still exists.

### 7. Establish Test Cleanup Convention in CONTRIBUTING.md

**Priority: MEDIUM** — Synthesis recommendation #3.

1. **Add section to `CONTRIBUTING.md`** titled "Test Cleanup Requirements":
   - All tests creating temporary directories or files **must** register a `process.on('exit')` cleanup handler.
   - Provide a code snippet showing the standard pattern.
   - Explain that `afterAll` is insufficient — it does not run on `SIGINT` or test runner crashes.

### 8. Document Network-Dependent Tests for CI

**Priority: LOW** — Synthesis recommendation #5.

1. **Add CI note to `CONTRIBUTING.md`** or a separate `docs/testing.md`:
   - List all tests that require network access (currently: `git-clone.test.ts`).
   - Recommend `SKIP_NETWORK_TESTS` environment variable pattern for CI gating.

2. **Optionally add skip guard** in `src/tests/git-clone.test.ts`:
   - Check `process.env.SKIP_NETWORK_TESTS` and skip the real-clone test if set.

### 9. Add Type-Audit Acceptance Criterion to QA Pipeline

**Priority: MEDIUM** — Synthesis recommendation #4. Process change, not code.

1. **Document in project workflow** (CONTRIBUTING.md or equivalent):
   - Any WP that adds or modifies types must include an acceptance criterion: "Exported types match plan specification."
   - QA WPs that follow implementation WPs should verify type signatures against the plan.

## Dependencies

- Phase 3 (complete) — all affected source files exist.
- Git ≥ 2.23 for `git switch` (already satisfied by `engines.git >= 2.28`).

## Required Components

- **MODIFY** `src/git/git.types.ts` — Add `RunGitOptions` interface
- **MODIFY** `src/git/git-cli.ts` — Timeout + buffer limit
- **MODIFY** `src/git/git-clone.ts` — URL validation
- **MODIFY** `src/git/git-branch.ts` — Input guards, checkout→switch migration
- **MODIFY** `src/tests/git-cli.test.ts` — Timeout + buffer tests
- **MODIFY** `src/tests/git-clone.test.ts` — URL validation + bare-clone tests
- **MODIFY** `src/tests/git-branch.test.ts` — Input guard tests
- **MODIFY** `CONTRIBUTING.md` — Test cleanup convention, CI docs, type-audit AC

## Assumptions

- No consumers of the `runGit()` signature exist outside `src/git/` (signature change is non-breaking).
- `git switch` behavior is compatible with current test assertions.
- 10 MB default buffer limit is sufficient for all expected git operations.

## Constraints

- All changes must maintain backward compatibility — no existing tests may break.
- `shell: false` must remain enforced throughout.
- The `AbortController` approach requires Node.js ≥ 15.4 (verify against project's `engines.node`).

## Out of Scope

- Phase 4 workspace orchestration logic.
- Git authentication or credential management.
- Merge/conflict resolution.
- `branchExists()` ref path-traversal fix (requires deeper git ref semantics — deferred).

## Acceptance Criteria

- `runGit()` aborts and resolves cleanly after timeout expiry.
- `runGit()` terminates the process when buffer limits are exceeded.
- `branchExists('--flag')` returns `false` without invoking git.
- `cloneRepository('ext::...')` rejects with exitCode 128.
- `createBranch()` and `switchBranch()` use `git switch` instead of `git checkout`.
- All existing 231 tests continue to pass.
- `CONTRIBUTING.md` documents the test cleanup convention and network-test CI guidance.

## Testing Strategy

- Extend existing test files — no new test files needed.
- Timeout test: spawn a deliberately slow command (e.g., `git hash-object --stdin` waiting for input) with a short timeout.
- Buffer limit test: generate large output via git command piped through the wrapper.
- URL validation tests: pure input validation, no network access needed.
- All branch migration tests use local repos (no network dependency).

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `AbortController` not available in project's Node.js target | Verify `engines.node` ≥ 15.4; fall back to `child.kill()` + manual timeout if needed |
| `git switch` stderr patterns differ from `git checkout` | Run existing tests first, adjust conflict detection regex if needed |
| Buffer limit kills legitimate large operations | Default 10 MB is generous; callers can override via `RunGitOptions` |
| URL allowlist too restrictive | Start with common schemes; document how to extend |

## Sequencing Recommendation

**Critical path:** Steps 1 → 2 (both modify `runGit()`, should be done together).

**Parallelizable:** Steps 3, 4, 5, 6 are independent of each other and of steps 1–2 (different files or non-overlapping functions).

**Documentation only:** Steps 7, 8, 9 can run in parallel with all code changes.

Recommended execution order:
1. Steps 1+2 (runGit hardening — highest value, shared file)
2. Steps 3+4 (input validation — medium priority, security)
3. Steps 5+6 (git switch migration + bare-clone test — low priority)
4. Steps 7+8+9 (documentation/process — can be done anytime)
