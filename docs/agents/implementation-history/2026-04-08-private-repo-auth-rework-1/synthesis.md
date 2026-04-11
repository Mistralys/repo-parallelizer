## Synthesis

### Completion Status
- Status: COMPLETE
- Completed by: Standalone Developer Agent

### Implementation Summary
- **Step 1:** Added `decodeURIComponent()` with try/catch to the DELETE `/api/config/credentials/:host` handler. Malformed percent-encoding (e.g. `%ZZ`) returns 400. Hosts with colons (e.g. `gitlab.com:8080`) now resolve correctly when percent-encoded in the URL path.
- **Step 2:** Added prototype-key blocklist (`__proto__`, `constructor`, `prototype`) to the PUT `/api/config/credentials` handler, rejecting reserved host names with 400.
- **Step 3:** Added `fs.chmodSync(resolvedConfigPath, 0o600)` after `writeJsonFile()` in `saveConfigField()`, guarded by `process.platform !== 'win32'`. Only `saveConfigField()` applies chmod — `writeJsonFile()` remains permission-agnostic.
- **Step 4:** Added `process.on('exit')` cleanup handlers to all 6 previously non-compliant test files: `config.test.ts`, `repository.manager.test.ts`, `json-storage.test.ts`, `project.manager.test.ts`, `storage-init.test.ts`, `workspace.manager.test.ts`. Each uses a `cleanupPaths` array and auto-registers temp dirs via `makeTempDir()`.
- **Step 5:** Extracted `setupFakeGit()` to `src/tests/test-helpers.ts`. Both `workspace-orchestrator.test.ts` and `repository-orchestrator.test.ts` now import from the shared helper.
- **Step 6:** Removed the only `console.warn` in production code from `RepositoryManager.add()`. Added `credentialsStripped?: boolean` to the `Repository` interface (transient, not persisted). The method now returns `{ ...repo, credentialsStripped: true }` when credentials are stripped — the saved object does not contain the field. Updated tests to assert the flag instead of intercepting console.warn.

### Documentation Updates
- `docs/agents/project-manifest/api-surface.md`: Updated `Repository` interface to include the new `credentialsStripped?: boolean` field with a transient annotation.
- `docs/agents/project-manifest/constraints.md`: Updated the fake-git binary pattern section to reference the shared `src/tests/test-helpers.ts` location instead of the two individual test files.

### Verification Summary
- Tests run: `node --test dist/tests/*.test.js dist/server/__tests__/*.test.js dist/server/__tests__/**/*.test.js`
- Static analysis run: `tsc` (zero errors)
- Result: **620 tests pass, 0 failures** (up from 612 baseline — 8 new tests added: 2 for decodeURIComponent, 3 for prototype blocklist, 1 for chmod, 3 for credentialsStripped flag including persistence check)

### Code Insights
- ~~[low] (convention) `src/server/routes/config.ts`: The PUT and DELETE handlers use different patterns — PUT is async (parseJsonBody), DELETE is sync. This is intentional (DELETE has no body to parse) but the asymmetry may confuse contributors. Consider a brief comment noting why.~~ **Done** — added inline comment on the DELETE handler.
- ~~[low] (improvement) `src/tests/config.test.ts`, `src/tests/repository.manager.test.ts`, etc.: The `cleanupPaths` + `process.on('exit')` pattern is now duplicated across 6 files. A shared `makeTempDir(cleanupPaths)` utility in `test-helpers.ts` could reduce this boilerplate if more test files are added.~~ **Done** — added `createTempDirTracker()` to `test-helpers.ts` and refactored all 6 test files to use it.
- ~~[low] (debt) `src/models/repository/repository.types.ts`: The `credentialsStripped` property uses a lowercase naming convention while all other `Repository` fields use PascalCase (`Id`, `Name`, `Url`). This is intentional per the plan (transient field, not persisted, not part of the data schema) but the mixed convention may surprise contributors. Consider adding a comment to explain the difference.~~ **Done** — added JSDoc note explaining the naming convention difference.

### Additional Comments
- The `extractParams()` function in `src/server/requestUtils.ts` does **not** perform URI decoding on captured path segments. The `decodeURIComponent` call was placed in the DELETE handler rather than in the router to avoid changing the router's contract for other routes that may not expect decoded params.
- The `credentialsStripped` field is deliberately excluded from persistence by constructing a separate return object (`{ ...repo, credentialsStripped: true }`) after `save()` is called. The stored `Repository` array entry never contains the field.
