## Synthesis

### Completion Status
- Status: COMPLETE
- Completed by: Standalone Developer Agent

### Implementation Summary
- Added `RunGitOptions` interface (`timeoutMs?`, `maxBufferBytes?`) to `git.types.ts` and extended `CloneOptions` with `timeoutMs?`.
- Implemented `AbortController`-based timeout in `runGit()`: when `timeoutMs` is provided, the process is killed after the specified duration and the promise resolves with `exitCode: -1` and a descriptive stderr message.
- Implemented a 10 MB default buffer limit in `runGit()`: accumulated stdout + stderr bytes are tracked; when the limit is exceeded the process is killed and the promise resolves with `exitCode: -1` and a partial stdout result.
- Added URL scheme allowlist validation to `cloneRepository()`: `https://`, `http://`, `git://`, `ssh://`, `git@`, `file://`, and absolute local paths are accepted; exotic protocols such as `ext::` and `rsh::` are rejected with `exitCode: 128`.
- Extended `timeoutMs` propagation through `cloneRepository()` → `runGit()`, `fetchRemote()` → `runGit()`, and `fetchAndGetStatus()` → `fetchRemote()`.
- Added `-` prefix guard to `branchExists()` — returns `false` immediately without invoking git when the branch name starts with `-`.
- Migrated `createBranch()` from `git checkout -b` to `git switch -c` and `switchBranch()` from `git checkout` to `git switch` (safe per `engines.git >= 2.28`).
- Added descriptive comment to `fetchRemote()` documenting the intentional safety of its `remote` argument usage.
- Added 13 new tests covering: AbortController timeout, buffer limit, URL validation (accept/reject), bare clone, and `branchExists` dash-prefix guard.
- Added `SKIP_NETWORK_TESTS=1` guard to the real-clone network test in `git-clone.test.ts`.
- Updated `CONTRIBUTING.md` with: Test Cleanup Requirements, Network-Dependent Tests CI guidance, and Type-Audit Acceptance Criterion.

### Documentation Updates
- `CONTRIBUTING.md`: Added three new sections — "Running tests", "Test Cleanup Requirements" (with `process.on('exit')` pattern), "Network-Dependent Tests" (lists `git-clone.test.ts`, documents `SKIP_NETWORK_TESTS=1`), and "Type-Audit Acceptance Criterion".

### Verification Summary
- Tests run: full suite (`npm test` / `SKIP_NETWORK_TESTS=1 node --test dist/tests/*.test.js`)
- Static analysis run: TypeScript compiler (`tsc`) — zero errors
- Result: **244 tests, 243 pass, 1 skipped (SKIP_NETWORK_TESTS), 0 fail**
  - Previous suite: 231 tests. New tests added: 13.

### Code Insights
- [medium] (debt) `src/git/git-branch.ts` — `branchExists()` still lacks a ref path-traversal guard (noted with a `@remarks` block in the JSDoc). A value like `../config` can resolve to an unintended ref. This was explicitly deferred in the plan and the existing `@remarks` comment documents it; a follow-up WP should add a `validateRef()` utility shared across branch functions.
- [low] (improvement) `src/git/git-cli.ts` — `runGitOrThrow()` does not accept `RunGitOptions`. If callers ever need a timeout on a "throw on failure" call (e.g. `runGitOrThrow(['fetch', ...], cwd, { timeoutMs: 5000 })`), the signature will need to be extended. Low priority since current callers are all local read operations.
- [low] (convention) `src/git/git-branch.ts` — The fixture setup in `git-branch.test.ts` still uses `git checkout -b` / `git checkout` in `execSync` calls (lines that set up the test fixture). These are test-only and use the system git directly, so they work fine, but are inconsistent with the migration of the production code to `git switch`. Not a bug, but worth noting for clarity.
- [low] (improvement) `src/git/git-clone.ts` — Windows UNC paths (`\\server\share`) and drive-letter paths (`C:\...`) are not in the allowlist. The project currently targets macOS/Linux (no Windows CI), but adding them preemptively when Windows support is planned would prevent a regression later.

### Additional Comments
- The `AbortController` approach requires Node.js ≥ 15.4 for the `signal` option in `spawn()`; the project already enforces `engines.node >= 18`, so this is satisfied.
- The TCP-server timeout test (`runGit() with timeoutMs aborts a hanging process`) runs in ~520ms (the 500ms timeout). This is acceptable for a test suite but is the slowest individual test. It could be reduced to 200ms if test-suite speed becomes a concern.
- The `SKIP_NETWORK_TESTS=1` guard is implemented as a Node.js test option object passed to the `test()` call. The `git@` SSH test attempts to connect to GitHub and takes ~1.3 s even when SSH fails fast on some networks — if CI proves flaky this test could also be gated.
