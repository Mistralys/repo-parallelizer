## Synthesis

### Completion Status
- Status: COMPLETE
- Completed by: Standalone Developer Agent

### Implementation Summary
- Created `.npmignore` (documents intent) and replaced `dist/` with explicit sub-paths in `package.json` `files` field — `dist/tests/` and `dist/server/__tests__/` are now excluded from the npm tarball. (Note: npm ignores `.npmignore` entries for paths already whitelisted in `files`; the exclusion is achieved by making the `files` list specific rather than a blanket `dist/`.)
- Created `.gitattributes` with `*.sh text eol=lf` to enforce Unix line endings for `menu.sh`.
- Replaced placeholder `package.json` `repository.url` with a clearly-marked `TODO` string.
- Added `isTTY` guard to `waitForKey()` in `src/cli/terminal-ui.ts`: rejects with a descriptive `Error` when not in an interactive terminal, preventing a `TypeError` in CI/piped environments.
- Added `.catch()` handler to the async IIFE in `src/index.ts`: unexpected rejections now write to `stderr` and exit with code 1 instead of emitting a silent `UnhandledPromiseRejection` warning.
- Replaced the infinite-promise idiom in `launchGui()` with a `process.once('SIGINT', ...)` handler that calls `stopServer()` before resolving — Ctrl+C now shuts down cleanly.
- Removed the redundant `?? 4200` fallback in `launchGui()` (config already guarantees the default).
- Added `SetupIO` interface (exported) and optional `io?: SetupIO` parameter to `runSetup()` in `src/cli/setup.ts`. All `askQuestion`/`askYesNo` calls and sub-calls to `_promptPath`/`_promptNumber` are now threaded through the adapter.
- Added two integration tests to `src/tests/setup.test.ts`: one full wizard flow (validates `config.json` written with correct values and storage initialized) and one cancellation test (validates config is not modified when user declines overwrite).
- Replaced all bare `'fs'`, `'path'`, and `'child_process'` imports with `'node:'`-prefixed equivalents across 10 source files and 16 test files (27 files total).
- Removed dead `Number.isNaN(parsed)` check in `_promptNumber` — `Number.isInteger(NaN)` already returns `false`.

### Documentation Updates
- `docs/agents/project-manifest/api-surface.md`: Updated `waitForKey()` description to document the TTY rejection behaviour; updated `runSetup()` signature to include the new `SetupIO` interface and optional parameter.
- No other documentation updates required — no public API contracts or data-flow changes outside what is documented above.

### Verification Summary
- Tests run: full test suite via `npm test` (compiles with `tsc` then runs `node --test`)
- Static analysis run: `tsc` (TypeScript strict mode)
- Result: **541 tests, 0 failures, 0 TypeScript errors**
- `npm pack --dry-run` confirms `dist/tests/` and `dist/server/__tests__/` are absent from the tarball
- `git check-attr eol menu.sh` reports `eol: lf`
- `grep -r "from 'fs'\|from 'path'\|from 'child_process'" src/` returns no matches

### Code Insights
- ~~[medium] (debt) `src/utils/paths.ts` → `getConfigPath()`: **Fixed.** Added `PARALIZER_CONFIG_PATH` env var override. Integration tests now inject a temp path via the env var instead of using backup/restore guards against the real project-root `config.json`.~~ **DONE**
- ~~[low] (improvement) `src/cli/menu.ts` → `launchGui()`: **Fixed.** SIGINT handler now calls `process.exit(0)` directly after stopping the server. The menu loop is not resumed after Ctrl+C; `case 'g'` changed from `return` to `break` to correctly handle early-return (config/start failure) by looping back.~~ **DONE**
- ~~[low] (convention) `src/tests/setup.test.ts`: **Fixed.** Extracted `withTempConfig()` helper that sets `PARALIZER_CONFIG_PATH` to a unique temp path, injects it for the test body, and cleans up in a `finally` block. Both integration tests now use it.~~ **DONE**

### Additional Comments
- The `.npmignore` file is retained for documentation/discoverability, but the actual tarball exclusion is enforced by the explicit `files` list in `package.json` — npm does not apply `.npmignore` to files covered by the `files` allowlist. This distinction is noted in the Code Insights but is not a bug.
- Step 3 (repository URL) leaves a `TODO` string as instructed. The project owner must replace it with the real URL before the first `npm publish`.
