# Tests

Shared test utilities and all unit test suites for the `src/` server layer.

## Key Concepts

- **Test isolation via temp directories** — every test that touches the filesystem creates its own temp tree under `os.tmpdir()` and registers a `process.on('exit')` cleanup handler so directories are removed even on crash or `SIGINT`.
- **Fake git binary** — tests that exercise git-invocation paths use `setupFakeGit` to intercept subprocess calls without touching a real repository.
- **Minimal config fixture** — `makeTestConfig` produces a complete `AppConfig` rooted at a caller-supplied temp directory, avoiding repetition of the full config literal across test files.

## Folder Structure

All files live flat in this directory — there are no subdirectories. `test-helpers.ts` is the only non-test file; every other `*.test.ts` file is a self-contained test suite.

## Integration Points

- **Inbound:** All `*.test.ts` suites in this directory import from `test-helpers.ts`. Server-layer tests in `src/server/__tests__/` also import `makeTestConfig` from here (using the relative path `../../tests/test-helpers.js`). No production module imports from `src/tests/`.
- **Outbound:** `test-helpers.ts` imports `AppConfig` from `src/config/config.types.ts` to type the config fixture. Test suites import from the module they exercise (e.g. `src/git/`, `src/storage/`, `src/orchestration/`).
