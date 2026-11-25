# Tests

Shared test utilities and all unit test suites for the `src/` server layer.

## Key Concepts

- **Test isolation via temp directories** — every test that touches the filesystem creates its own temp tree under `os.tmpdir()` and registers a `process.on('exit')` cleanup handler so directories are removed even on crash or `SIGINT`.
- **Fake git binary** — tests that exercise git-invocation paths use `setupFakeGit` to intercept subprocess calls without touching a real repository.
- **Minimal config fixture** — `makeTestConfig` produces a complete `AppConfig` rooted at a caller-supplied temp directory, avoiding repetition of the full config literal across test files.

## Folder Structure

Files live flat in this directory, plus a `fixtures/` subfolder. `test-helpers.ts` and `fixtures/` hold the non-test modules; every `*.test.ts` file is a self-contained test suite.

`fixtures/` holds the workspace-index golden-baseline material (compiled to `dist/tests/fixtures/`, not matched by the `npm test` globs):

- `workspace-index-contexts.ts` — fixed `WorkspaceIndexContext` fixtures A (minimal), B (custom/repository files, descriptions) and C (hostile strings).
- `workspace-index-baseline.ts` — generated `BASELINE_README_A/B/C` constants (the README.md output must stay byte-identical; the AGENTS.md baseline was retired because its text now changes deliberately). Do not edit by hand.
- `workspace-index-postB.ts` — generated post-Phase-B regression snapshot: `POSTB_AGENTS_*` and `POSTB_README_*` for contexts A, B, C and their two-workspace variants (`A_TWO`, `B_TWO`, `C_TWO`). Captured from reviewed output; a regression snapshot, not a correctness oracle. `POSTB_README_A/B/C` equal `BASELINE_README_A/B/C`. Do not edit by hand.
- `capture-golden.ts` — the capture script. Invocation: `npm run build && node dist/tests/fixtures/capture-golden.js <target> [--check]`. Target `baseline` rewrites the baseline file; target `postB` rewrites the post-B snapshot; `--check` writes nothing and exits non-zero, printing the first differing line, when the renderer output differs from the committed baseline.

## Integration Points

- **Inbound:** All `*.test.ts` suites in this directory import from `test-helpers.ts`. Server-layer tests in `src/server/__tests__/` also import `makeTestConfig` from here (using the relative path `../../tests/test-helpers.js`). No production module imports from `src/tests/`.
- **Outbound:** `test-helpers.ts` imports `AppConfig` from `src/config/config.types.ts` to type the config fixture. Test suites import from the module they exercise (e.g. `src/git/`, `src/storage/`, `src/orchestration/`).
