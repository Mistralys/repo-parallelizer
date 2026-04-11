# Plan

## Summary

Address all actionable technical debt and security hardening items surfaced by the `2026-04-08-private-repo-auth` synthesis. Six concrete fixes target credential route robustness (`decodeURIComponent`, prototype-pollution host blocklist), config file permission enforcement (`chmodSync 0o600`), test hygiene (temp dir cleanup in 6 files, `setupFakeGit()` extraction), and a minor production code quality improvement (replacing `console.warn` with error propagation in `RepositoryManager.add()`).

## Architectural Context

The changes touch four distinct layers:

- **Server routes** (`src/server/routes/config.ts`) — REST API handlers for credential CRUD. The DELETE handler lacks `decodeURIComponent` on the `:host` parameter, and the PUT handler lacks a prototype-key blocklist.
- **Config persistence** (`src/config/config.ts`, `src/storage/json-storage.ts`) — `saveConfigField()` delegates writes to `writeJsonFile()`. Neither applies restrictive file permissions after writing. Since `config.json` now stores plaintext PATs in the `gitCredentials` field, this is a file-permission hardening gap.
- **Test files** (`src/tests/`) — Six test files create temp directories via `makeTempDir()` without `process.on('exit')` cleanup, violating the MUST rule in AGENTS.md Section 4. Additionally, `setupFakeGit()` is duplicated in two test files.
- **Repository model** (`src/models/repository/repository.manager.ts`) — The `add()` method calls `console.warn()` when embedded credentials are stripped — the only `console.warn` in production code.

Relevant patterns and conventions:
- All route handlers already use the shared `isPlainObject()` guard from `src/server/requestUtils.ts` (confirmed across all 5 route files).
- Test files with cleanup follow a consistent pattern: module-level `cleanupPaths: string[]` array, `process.on('exit', ...)` handler calling `fs.rmSync()` on each path.
- The project uses the Node.js built-in test runner (`node --test`), no external test framework.

## Approach / Architecture

Six independent, low-risk fixes, each self-contained:

1. **`decodeURIComponent` on DELETE `:host`** — Wrap the parameter in `decodeURIComponent()` with try/catch (malformed percent-encoding → 400).
2. **Prototype-key blocklist on PUT host field** — Reject `__proto__`, `constructor`, `prototype` as host values with a 400 response.
3. **`fs.chmodSync(0o600)` after config writes** — Add a platform-guarded `chmodSync` call in `saveConfigField()` (not in the generic `writeJsonFile()`, since config.json is the only sensitive file; `repositories.json` and project files do not contain secrets).
4. **Temp dir cleanup in 6 test files** — Add `process.on('exit')` handlers following the established pattern from the other 10 test files.
5. **Extract `setupFakeGit()` to shared test helper** — Create `src/tests/test-helpers.ts` with the function and update both consumers.
6. **Replace `console.warn` in `RepositoryManager.add()`** — Return the warning information through the return type or propagate via a structured mechanism instead of writing to stdout.

## Rationale

- **Items 1–2** are security hardening: the `decodeURIComponent` gap creates ghost credentials for hosts with colons/ports, and the prototype-key gap is a defence-in-depth measure (V8-safe today, but convention should prevent future risk).
- **Item 3** closes the Security Auditor's residual plaintext-at-rest concern. Scoping the chmod to `saveConfigField()` rather than the generic `writeJsonFile()` avoids unintended side-effects on other JSON files.
- **Item 4** is a MUST requirement per AGENTS.md Section 4 — pre-existing debt that should be resolved.
- **Item 5** is DRY housekeeping — the synthesis recommends extraction when a third consumer appears, but with an active rework touching tests, deduplication now reduces future maintenance.
- **Item 6** removes the only `console.warn` in production code, improving composability (callers can decide whether to warn).

## Detailed Steps

### Step 1 — Fix `decodeURIComponent` in DELETE `/api/config/credentials/:host`

**File:** `src/server/routes/config.ts`

1. At the top of the DELETE handler, wrap `params['host']` in `decodeURIComponent()` inside a try/catch.
2. On `URIError` (malformed percent-encoding), return `sendError(res, 400, 'Malformed host parameter.')`.
3. Use the decoded host for the credential lookup and deletion.
4. Add a test covering a host with a colon (e.g., `gitlab.com:8080`) — this requires percent-encoding the colon in the URL path as `%3A`.
5. Add a test for a malformed percent-encoded host (e.g., `%ZZ`) → expects 400.

### Step 2 — Add prototype-key blocklist to PUT host validation

**File:** `src/server/routes/config.ts`

1. After the existing `cleanHost` validation (path separator / whitespace check), add a guard rejecting `__proto__`, `constructor`, and `prototype` as host values.
2. Return `sendError(res, 400, 'Field "host" contains a reserved name.')` on match.
3. Add a test for each blocked key verifying 400 is returned.

### Step 3 — Apply `fs.chmodSync(0o600)` after config writes

**File:** `src/config/config.ts`

1. Import `chmodSync` from `node:fs`.
2. After the `writeJsonFile()` call in `saveConfigField()`, add a platform-guarded chmod:
   ```typescript
   if (process.platform !== 'win32') {
       fs.chmodSync(resolvedConfigPath, 0o600);
   }
   ```
3. Do NOT add chmod to `writeJsonFile()` — the generic writer should remain permission-agnostic.
4. Add a test in `config.test.ts` that writes a config field via `saveConfigField()` and verifies `fs.statSync(path).mode & 0o777 === 0o600` on non-Windows platforms.

### Step 4 — Add `process.on('exit')` cleanup to 6 test files

**Files:**
- `src/tests/config.test.ts`
- `src/tests/repository.manager.test.ts`
- `src/tests/json-storage.test.ts`
- `src/tests/project.manager.test.ts`
- `src/tests/storage-init.test.ts`
- `src/tests/workspace.manager.test.ts`

For each file, follow the established pattern:

1. Add a module-level `const cleanupPaths: string[] = [];` array.
2. Register a `process.on('exit', () => { ... })` handler that iterates `cleanupPaths` and calls `fs.rmSync(p, { recursive: true, force: true })` for each.
3. Push each `makeTempDir()` result into `cleanupPaths` — either by modifying `makeTempDir()` to auto-register, or by adding `cleanupPaths.push(dir)` after each call.

### Step 5 — Extract `setupFakeGit()` to `src/tests/test-helpers.ts`

**New file:** `src/tests/test-helpers.ts`

1. Create `src/tests/test-helpers.ts` exporting the `setupFakeGit(dir: string): string` function (the implementation from either source file can be used — they are identical).
2. In `src/tests/workspace-orchestrator.test.ts`, remove the local `setupFakeGit()` and import it from `./test-helpers.js`.
3. In `src/tests/repository-orchestrator.test.ts`, remove the local `setupFakeGit()` and import it from `./test-helpers.js`.
4. Verify the function signature and behavior remain identical — no changes to the implementation.

### Step 6 — Replace `console.warn` in `RepositoryManager.add()`

**File:** `src/models/repository/repository.manager.ts`

1. Remove the `console.warn(...)` call from the credential-stripping branch.
2. Add a `credentialsStripped: boolean` field to the `Repository` return type is not necessary — instead, add a `warnings?: string[]` field to the return value's type, or return a richer result object. However, the simplest approach that does not change the return type is to make the caller responsible for the warning:
   - The existing callers of `RepositoryManager.add()` are in `src/orchestration/repository-orchestrator.ts` and `src/server/routes/repositories.ts`.
   - Add a `strippedCredentials` boolean flag to the returned `Repository` type, or add a second return value.
   - **Simplest approach:** Change the return value to `{ repository: Repository; credentialsStripped: boolean }` — but this changes the public API signature.
   - **Alternative simplest approach:** Keep the return type as `Repository`, but add a boolean `credentialsStripped` property to the `Repository` interface (transient, not persisted).

   Given the layered architecture, the cleanest approach is:
   1. Add an optional `credentialsStripped?: boolean` field to the `Repository` interface in `src/models/repository/repository.types.ts` — marked with a JSDoc note that it is transient (set by `add()` but not persisted).
   2. Set `repo.credentialsStripped = true` when stripping occurs, instead of calling `console.warn`.
   3. Move the warning output to the callers: `repository-orchestrator.ts` (CLI context — `console.warn` is appropriate there) and `repositories.ts` route handler (can include it in the API response or ignore).
   4. Ensure `credentialsStripped` is NOT written to `repositories.json` — it should be stripped before persistence or simply not included in the serialized fields (since `writeJsonFile` serializes the whole object, omit it before saving).

## Dependencies

- Steps 1–6 are independent and can be implemented in any order or in parallel.
- Step 4 is entirely self-contained within test files.
- Step 5 only affects test files.
- Steps 1–2 affect the same file (`config.ts` route) but different handlers.

## Required Components

- `src/server/routes/config.ts` — Steps 1, 2
- `src/config/config.ts` — Step 3
- `src/tests/config.test.ts` — Steps 3, 4
- `src/tests/repository.manager.test.ts` — Step 4
- `src/tests/json-storage.test.ts` — Step 4
- `src/tests/project.manager.test.ts` — Step 4
- `src/tests/storage-init.test.ts` — Step 4
- `src/tests/workspace.manager.test.ts` — Step 4
- `src/tests/test-helpers.ts` — Step 5 (NEW)
- `src/tests/workspace-orchestrator.test.ts` — Step 5
- `src/tests/repository-orchestrator.test.ts` — Step 5
- `src/models/repository/repository.manager.ts` — Step 6
- `src/models/repository/repository.types.ts` — Step 6
- `src/orchestration/repository-orchestrator.ts` — Step 6
- `src/server/routes/repositories.ts` — Step 6

## Assumptions

- The DELETE `:host` parameter is URL-encoded by the browser/client when the host contains special characters (colons, dots are generally safe, but colons in port notation may be encoded by some clients).
- `process.platform !== 'win32'` is an adequate guard for the chmod call — Windows does not support POSIX file permissions.
- The `setupFakeGit()` implementations in both test files are byte-identical (verified: both create a shell script at `{dir}/git` that writes `"$@"` to a capture file and exits 128).
- The `credentialsStripped` field on `Repository` will be transient only — not persisted to `repositories.json`.

## Constraints

- Node16 ESM: all new relative imports must include the `.js` extension.
- Test cleanup handlers must be registered via `process.on('exit')` — not `afterAll` alone (per AGENTS.md Section 4).
- No new production dependencies.
- `writeJsonFile()` must remain permission-agnostic (chmod only in `saveConfigField()`).

## Out of Scope

- **SSH key authentication** — Noted as a known gap in the synthesis. Implementing SSH auth requires a fundamentally different approach (agent forwarding, key management) and is a separate feature, not a rework item.
- **Structured logging system** — The synthesis notes that `console.warn` should be migrated to a structured logger "when one is introduced." Introducing a logging system is out of scope; this plan only relocates the warning to callers.
- **WHATWG URL parser defensive pattern** — Already resolved during WP-006 and documented in `constraints.md`. No further action needed.
- **`GIT_TERMINAL_PROMPT` / `GIT_ASKPASS`** — Already implemented and documented. The synthesis marks these as "do not remove" — no action needed beyond awareness.
- **`isPlainObject()` adoption** — Already used consistently across all 5 route files (confirmed). No further action needed.
- **Token injection lifetime contract** — Already documented in `constraints.md` and `data-flows.md`. No further action needed.

## Acceptance Criteria

1. DELETE `/api/config/credentials/gitlab.com%3A8080` correctly decodes the host and deletes the matching credential entry.
2. DELETE with malformed percent-encoding (e.g., `%ZZ`) returns 400.
3. PUT `/api/config/credentials` with `{ "host": "__proto__", "token": "x" }` returns 400.
4. After `saveConfigField()` writes `config.json` on non-Windows, `fs.statSync(path).mode & 0o777` equals `0o600`.
5. All 6 previously non-compliant test files have `process.on('exit')` cleanup handlers, and `makeTempDir()` results are tracked for cleanup.
6. `setupFakeGit()` exists in `src/tests/test-helpers.ts` and is imported (not duplicated) by both orchestrator test files.
7. `RepositoryManager.add()` does not call `console.warn()`. Credential stripping is signalled to callers via a `credentialsStripped` flag on the returned `Repository`.
8. All existing tests pass (612/612 or more).
9. TypeScript build is clean (zero errors).
10. **Type audit:** Any new/modified interface properties match this plan's specification in name, type, and optionality.

## Testing Strategy

- **Steps 1–2:** Add targeted tests in the existing config routes test file (`src/server/__tests__/routes/config.test.ts`). Test the happy path (properly encoded host, blocked key) and the error path (malformed encoding, prototype keys).
- **Step 3:** Add a test in `src/tests/config.test.ts` that verifies file permissions after `saveConfigField()`. Skip on Windows via `process.platform` check.
- **Step 4:** No new tests needed — this is test infrastructure. Verify by running the full test suite and confirming no leftover temp dirs after `SIGINT` or crash.
- **Step 5:** No new tests needed — this is a refactor. Verify by running existing tests for both orchestrator files.
- **Step 6:** Update existing `repository.manager.test.ts` tests to assert `credentialsStripped === true` when a URL with embedded credentials is added. Add a negative test (clean URL → `credentialsStripped` is undefined/false).
- **Full regression:** `npm test` must pass (612+ tests, 0 failures).

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **`decodeURIComponent` double-decoding** if the router already decodes params | Verify the router does NOT decode params before applying `decodeURIComponent`. Inspect `src/server/router.ts` parameter extraction logic. |
| **chmod breaks tests on CI** if test runner runs on Windows or as root | Guard with `process.platform !== 'win32'`. Tests asserting permissions should also be platform-guarded. |
| **`credentialsStripped` leaking to JSON storage** | Ensure `writeJsonFile` serialises the field — must either delete the field before save, or use a separate result object that is not the stored entity. Prefer the latter (do not mutate the stored entity). |
| **`setupFakeGit` import path change** breaks test discovery | Ensure the helper file compiles and the `.js` extension is used in imports. Run full test suite. |
