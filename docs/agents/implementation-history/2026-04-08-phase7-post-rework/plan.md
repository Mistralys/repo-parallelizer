# Plan

## Summary

Address all actionable items identified in the Phase 7 synthesis strategic recommendations. This covers pre-publish hardening (placeholder URL, `.npmignore`, `.gitattributes`), CLI robustness fixes (TTY guard, async error handling, SIGINT shutdown), a testability improvement for the setup wizard, a `node:` import prefix cleanup pass, and a minor dead-code removal. Item 6 (`.context/` regeneration) is excluded — already resolved.

## Architectural Context

The Phase 7 delivery added the `src/cli/` module (4 files) and updated `src/index.ts` as the CLI entry point. The issues span:

- **Root project files:** `package.json` (distribution metadata), missing `.npmignore` and `.gitattributes`.
- **CLI entry:** `src/index.ts` — async IIFE without `.catch()`.
- **CLI terminal UI:** `src/cli/terminal-ui.ts` — `waitForKey()` lacks TTY guard.
- **CLI menu:** `src/cli/menu.ts` — `launchGui()` has no SIGINT/graceful shutdown; `config.serverPort ?? 4200` is a redundant fallback.
- **CLI setup:** `src/cli/setup.ts` — `runSetup()` calls `askYesNo`/`askQuestion` directly (not injectable); `_promptNumber` has dead `isNaN` check.
- **Pre-Phase-7 source files:** 11 source files and 16 test files use bare `'fs'`/`'path'`/`'child_process'` imports instead of `'node:'`-prefixed equivalents.

Key files referenced:

- `package.json` — npm distribution fields, `files` array
- `src/index.ts` — CLI command dispatcher
- `src/cli/terminal-ui.ts` — `waitForKey()`, `askQuestion()`, `askYesNo()`
- `src/cli/menu.ts` — `showMenu()`, `launchGui()`
- `src/cli/setup.ts` — `runSetup()`, `_promptPath()`, `_promptNumber()`
- `src/server/index.ts` — `startServer()`, `stopServer()`

## Approach / Architecture

Seven discrete, low-risk changes grouped by priority. Each can be implemented independently. No new modules are created; all changes are modifications to existing files or creation of small root-level dotfiles.

## Rationale

These are hardening, hygiene, and distribution-readiness items. None change runtime behaviour for interactive users — they fix edge cases (CI/piped environments, uncaught rejections, Windows line endings) and improve codebase consistency. Grouping them into a single focused plan avoids the overhead of individual phase plans for what are mostly one-line or mechanical changes.

## Detailed Steps

### Step 1 — Pre-publish: `.npmignore`

**Issue:** The `files` field in `package.json` includes `dist/`, which ships `dist/tests/` and `dist/server/__tests__/` in the npm tarball (~700 kB of unnecessary test artifacts).

**Action:** Create a `.npmignore` file at the project root with the following entries:

```
# Exclude compiled test files from the npm tarball
dist/tests/
dist/server/__tests__/
```

**Verification:** Run `npm pack --dry-run` and confirm no `dist/tests/` or `dist/server/__tests__/` files appear in the output. The unpacked size should drop by approximately 700 kB.

### Step 2 — Pre-publish: `.gitattributes`

**Issue:** `menu.sh` has a Unix shebang line. On Windows, Git's default `core.autocrlf` setting may convert LF → CRLF, breaking bash execution.

**Action:** Create a `.gitattributes` file at the project root:

```
# Ensure Unix line endings for shell scripts on all platforms
*.sh text eol=lf
```

**Verification:** The file exists and `git check-attr eol menu.sh` reports `eol: lf`.

### Step 3 — Pre-publish: repository URL placeholder

**Issue:** `package.json` contains `"url": "https://github.com/user/repo-parallelizer"` — a placeholder that must not reach the npm registry.

**Action:** Replace with the real GitHub repository URL. If the repository is not yet public or the URL is not known, replace with an empty string and add a `TODO` comment in a visible location (e.g., `CONTRIBUTING.md` or `README.md`).

**Note:** This step requires input from the project owner. The implementing engineer should ask for the correct URL or leave a clearly marked placeholder (`TODO: replace with actual repository URL`).

### Step 4 — TTY guard in `waitForKey()`

**Issue:** `waitForKey()` in `src/cli/terminal-ui.ts` calls `process.stdin.setRawMode(true)` without first checking `process.stdin.isTTY`. In non-TTY environments (CI, piped input), `setRawMode` is `undefined` and the call throws.

**Action:** Add an `isTTY` guard at the top of `waitForKey()`. When not a TTY, reject the returned promise with a clear error message:

```typescript
export function waitForKey(validKeys: string[]): Promise<string> {
    if (!process.stdin.isTTY) {
        return Promise.reject(new Error('waitForKey() requires an interactive terminal (TTY).'));
    }
    // ... existing implementation unchanged
}
```

**Verification:** Calling `waitForKey(['q'])` in a non-TTY context (e.g., `echo "" | node -e "..."`) should reject with the descriptive error instead of throwing a `TypeError`.

### Step 5 — Async IIFE `.catch()` in `src/index.ts`

**Issue:** The top-level `(async () => { ... })()` in `src/index.ts` has no `.catch()` handler. An uncaught rejection from a future code change would emit an `UnhandledPromiseRejection` warning instead of producing a clean exit-1.

**Action:** Append `.catch()` to the IIFE:

```typescript
(async () => {
    switch (command) {
        // ... existing cases
    }
})().catch((err) => {
    process.stderr.write(`repo-parallelizer: unexpected error: ${(err as Error).message}\n`);
    process.exit(1);
});
```

**Verification:** `tsc` compiles cleanly. Test suite passes unchanged.

### Step 6 — SIGINT / graceful shutdown in `launchGui()`

**Issue:** `launchGui()` in `src/cli/menu.ts` blocks forever via `await new Promise<never>(() => {})`. When the user presses Ctrl+C, Node.js exits immediately without calling `stopServer()`, leaving the HTTP server's resources (polling timers, open handles) uncleaned.

**Action:** Replace the infinite-promise idiom with a SIGINT listener that calls `stopServer()` before exiting:

```typescript
// Replace: await new Promise<never>(() => {});
// With:
await new Promise<void>((resolve) => {
    process.on('SIGINT', async () => {
        printInfo('\nShutting down server...');
        await stopServer();
        resolve();
    });
});
```

Import `stopServer` from `../server/index.js` (it is already exported).

**Verification:** Launch via `paralizer menu` → `[G]`, then press Ctrl+C. The server should print a shutdown message and exit cleanly (exit code 0). No orphaned polling timers or open handles should remain.

### Step 7 — IO adapter for `runSetup()` integration tests

**Issue:** `runSetup()` in `src/cli/setup.ts` calls `askYesNo()` and `askQuestion()` directly from `terminal-ui.ts`. Unlike `_promptPath` and `_promptNumber` (which accept injectable `_ask`/`_confirm` callbacks for testing), `runSetup()` itself cannot be tested end-to-end without a real TTY.

**Action:** Add an optional options parameter to `runSetup()` for dependency injection:

```typescript
interface SetupIO {
    ask: (prompt: string) => Promise<string>;
    confirm: (prompt: string, defaultYes?: boolean) => Promise<boolean>;
}

export async function runSetup(io?: SetupIO): Promise<void> {
    const ask = io?.ask ?? askQuestion;
    const confirm = io?.confirm ?? askYesNo;
    // ... use `ask` and `confirm` instead of direct askQuestion/askYesNo calls
    // ... also pass `ask`/`confirm` through to _promptPath and _promptNumber
}
```

The `SetupIO` interface should be exported for test consumers.

**Verification:** Write at least one integration test in `src/tests/setup.test.ts` that exercises the full `runSetup()` flow using injected IO stubs, validating that `config.json` is written with expected values and storage is initialized.

### Step 8 — `node:` import prefix cleanup pass

**Issue:** 11 source files and 16 test files use bare `'fs'`/`'path'`/`'child_process'` imports. All Phase 7 code and all server-layer code already use the `'node:'` prefix. This is a cosmetic inconsistency.

**Action:** Mechanically replace all bare Node.js built-in imports with `node:`-prefixed equivalents across the following files:

**Source files (11):**

| File | Bare imports to fix |
|------|-------------------|
| `src/utils/paths.ts` | `'fs'` → `'node:fs'`, `'path'` → `'node:path'` |
| `src/storage/json-storage.ts` | `'fs'` → `'node:fs'`, `'path'` → `'node:path'` |
| `src/models/project/project.manager.ts` | `'fs'` → `'node:fs'`, `'path'` → `'node:path'` |
| `src/models/repository/repository.manager.ts` | `'path'` → `'node:path'` |
| `src/orchestration/workspace-orchestrator.ts` | `'fs'` → `'node:fs'`, `'path'` → `'node:path'` |
| `src/orchestration/repository-orchestrator.ts` | `'fs'` → `'node:fs'`, `'path'` → `'node:path'` |
| `src/orchestration/branch-orchestrator.ts` | `'path'` → `'node:path'` |
| `src/orchestration/vscode-workspace.ts` | `'fs'` → `'node:fs'`, `'path'` → `'node:path'` |
| `src/orchestration/project-orchestrator.ts` | `'fs'` → `'node:fs'`, `'path'` → `'node:path'` |
| `src/config/config.ts` | *(already clean — no bare imports found)* |
| `src/git/git-cli.ts` | `'child_process'` → `'node:child_process'` |

**Test files (16):**

| File | Bare imports to fix |
|------|-------------------|
| `src/tests/project-orchestrator.test.ts` | `'fs'`, `'path'` |
| `src/tests/json-storage.test.ts` | `'fs'`, `'path'` |
| `src/tests/git-status.test.ts` | `'fs'`, `'path'` |
| `src/tests/project.manager.test.ts` | `'fs'`, `'path'` |
| `src/tests/git-cli.test.ts` | `'fs'`, `'path'` |
| `src/tests/storage-init.test.ts` | `'fs'`, `'path'` |
| `src/tests/repository-orchestrator.test.ts` | `'fs'`, `'path'` |
| `src/tests/config.test.ts` | `'fs'`, `'path'` |
| `src/tests/workspace-orchestrator.test.ts` | `'fs'`, `'path'` |
| `src/tests/repository.manager.test.ts` | `'fs'`, `'path'` |
| `src/tests/workspace.manager.test.ts` | `'fs'`, `'path'` |
| `src/tests/vscode-workspace.test.ts` | `'fs'`, `'path'` |
| `src/tests/git-branch.test.ts` | `'fs'`, `'path'` |
| `src/tests/branch-orchestrator.test.ts` | `'fs'`, `'path'` |
| `src/tests/git-clone.test.ts` | `'fs'`, `'path'` |
| `src/tests/paths.test.ts` | `'fs'`, `'path'` |

**Verification:** `tsc` compiles with 0 errors. Full test suite passes with 0 failures. `grep -r "from 'fs'" src/ && grep -r "from 'path'" src/ && grep -r "from 'child_process'" src/` returns no matches.

### Step 9 — Dead code removal in `_promptNumber`

**Issue:** In `src/cli/setup.ts` line 106, the condition `!Number.isInteger(parsed) || Number.isNaN(parsed)` contains a dead `isNaN` check — `Number.isInteger(NaN)` already returns `false`, making the `isNaN` branch unreachable.

**Action:** Simplify to:

```typescript
if (!Number.isInteger(parsed)) {
```

**Verification:** `setup.test.ts` tests continue to pass. No behaviour change.

### Step 10 — Remove redundant fallback in `launchGui()`

**Issue:** `src/cli/menu.ts` uses `config.serverPort ?? 4200` but `loadConfig()` already applies the `4200` default, so the nullish coalescing is redundant.

**Action:** Simplify to `const port = config.serverPort;`.

**Verification:** `tsc` compiles cleanly. Existing tests pass.

## Dependencies

- Step 6 depends on `stopServer()` being exported from `src/server/index.ts` (confirmed: it is already exported).
- Step 7 depends on Step 4 conceptually (TTY guard makes non-TTY testing safer), but both can be implemented independently.
- All other steps are fully independent.

## Required Components

- `package.json` — Steps 1, 3
- `.npmignore` — **New file** (Step 1)
- `.gitattributes` — **New file** (Step 2)
- `src/cli/terminal-ui.ts` — Step 4
- `src/index.ts` — Step 5
- `src/cli/menu.ts` — Steps 6, 10
- `src/cli/setup.ts` — Steps 7, 9
- `src/tests/setup.test.ts` — Step 7
- 27 files across `src/` — Step 8

## Assumptions

- The project compiles cleanly with `tsc` before this plan begins (confirmed: 0 errors at Phase 7 completion).
- The full test suite (539 tests) passes before this plan begins.
- `stopServer()` properly closes the HTTP server and stops polling timers (confirmed via `src/server/index.ts` exports).

## Constraints

- No Git write commands (add, commit, branch) — handled by the developer.
- `.js` extensions required on all relative imports (Node16 ESM convention).
- `picocolors` remains the only runtime dependency.
- All test files must register `process.on('exit')` cleanup handlers for temp files.

## Out of Scope

- `.context/` regeneration discipline (Recommendation 6) — already resolved by the user running `ctx generate`.
- The `branchExists()`/`fetchRemote()` input validation gaps mentioned in `constraints.md` — these are pre-existing and tracked separately.
- Any functional feature additions to the CLI or server.

## Acceptance Criteria

1. `.npmignore` exists and `npm pack --dry-run` excludes `dist/tests/` and `dist/server/__tests__/`.
2. `.gitattributes` exists with `*.sh text eol=lf`.
3. `package.json` `repository.url` is either the real URL or has a clearly marked `TODO`.
4. `waitForKey()` rejects with a descriptive error when `process.stdin.isTTY` is falsy.
5. `src/index.ts` async IIFE has a `.catch()` that writes to stderr and exits with code 1.
6. `launchGui()` registers a `SIGINT` handler that calls `stopServer()` before exiting.
7. `runSetup()` accepts an optional IO adapter parameter; at least one integration test exercises the full wizard flow with injected stubs.
8. Zero bare `'fs'`/`'path'`/`'child_process'` imports remain in `src/`.
9. `_promptNumber` condition simplified (dead `isNaN` removed).
10. Redundant `?? 4200` fallback removed from `launchGui()`.
11. `tsc` compiles with 0 errors after all changes.
12. Full test suite passes with 0 failures after all changes.

## Testing Strategy

- **Steps 1–3:** Manual verification via `npm pack --dry-run`, `git check-attr`, and visual inspection.
- **Step 4:** Can be verified by piping input to the CLI entry point and confirming the error message (or a dedicated unit test mocking `process.stdin.isTTY = false`).
- **Step 5:** Existing tests cover all command paths; the `.catch()` is a safety net for future regressions.
- **Step 6:** Manual test: launch GUI, press Ctrl+C, confirm clean shutdown message.
- **Step 7:** New integration test(s) in `src/tests/setup.test.ts` using injected IO stubs.
- **Steps 8–10:** Existing test suite validates no regressions from mechanical changes.
- **Cross-cutting:** `tsc` build + full `npm test` run after all changes.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Step 6 SIGINT handler interferes with other signal handling** | Use `process.once('SIGINT', ...)` to avoid stacking handlers. Test with multiple Ctrl+C presses. |
| **Step 7 changes `runSetup()` public API** | The `io` parameter is optional with full backward compatibility. Existing callers are unaffected. |
| **Step 8 mechanical replacement misses an edge case** | Full `grep` scan + `tsc` + test suite run as verification gate. |
| **`.npmignore` unexpectedly excludes needed files** | The `files` field in `package.json` takes precedence for inclusion; `.npmignore` only subtracts. Verify with `npm pack --dry-run`. |
