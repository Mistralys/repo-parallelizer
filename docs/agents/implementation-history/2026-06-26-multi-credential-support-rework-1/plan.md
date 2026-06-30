# Plan

## Plan Audit Cycles
- Audits: 2 — Plan Auditor v1.5.0
- Architectural Reviews: none — Plan Architect Reviewer v1.6.0

## Prior Project Context
This plan is a rework cycle addressing the deferred items and strategic recommendations from the completed `2026-06-26-multi-credential-support` project (10/10 WPs delivered, 896 server tests + 199 GUI tests passing, 0 critical/high security findings). The original project migrated the credential system from `Record<string, string>` to `GitCredentialEntry[]` across the full vertical stack. This rework addresses the cleanup, hardening, and UX gaps identified during delivery — primarily: dead-code removal, credential badge persistence across page reloads, host-coherence validation, security hardening of error messages and API inputs, audit logging, and GUI refactors.

## Summary
Address all actionable deferred items from the multi-credential-support synthesis: remove the deprecated `injectCredentials()` legacy function and its tests, persist credential-error badge state across page reloads, add host/credential coherence validation at the REST API layer, fix hostname leaks in config error messages, add hostname format validation on credential host fields, add per-field maximum length validation on credential fields, introduce audit logging for credential mutations, extract duplicated credential badge DOM code into a shared helper with improved accessibility, add missing test coverage (T2 mixed toast, SSH integration), relocate the `CREDENTIAL_MISSING_SENTINEL` constant to the shared constants module, and fix the `notes-collected.test.mjs` infinite hang caused by an unstubbed `api.config.notesDisplay.get()` call and fragile timer restoration.

## Architectural Context

### Credential Resolution Pipeline (Current)
The standard authenticated git call sequence uses two functions from `src/git/git-credentials.ts`:
```ts
const entry = resolveCredential(repoUrl, config.gitCredentials, repo.credentialId);
const authenticatedUrl = entry ? injectCredentialToken(repoUrl, entry.token) : repoUrl;
```
The legacy `injectCredentials(url, credentials: Record<string, string>)` function is `@deprecated` and has zero active callers in production code — only referenced by 7 test cases in `src/tests/git-credentials.test.ts`.

### Config Parsing (Legacy Migration Path)
`src/config/config.ts` `parseGitCredentials()` handles backward-compatible migration from the old `Record<string, string>` format. Error messages at lines 236 and 241 interpolate the hostname key directly: `gitCredentials["${host}"]`, which leaks the hostname in thrown errors.

### REST API Credential Routes
- `src/server/routes/config.ts`: `PUT /api/config/credentials` (lines 196–283) and `DELETE /api/config/credentials/:id` (lines 288–316) — no audit logging.
- `src/server/routes/repositories.ts`: `PUT /api/repositories/:id/credential` (lines 241–293) — validates credential existence but performs no host-coherence check.

### GUI Credential Badge (Duplicated)
The credential status badge DOM construction is verbatim-duplicated:
- `gui/public/js/views/repositories.js` `buildRepoRow()` lines 107–123
- `gui/public/js/views/project-detail.js` `buildRepositoriesSection()` lines 278–292

### GUI Credential Error State (In-Memory Only)
`gui/public/js/views/workspace-detail.js` uses a module-scoped `CREDENTIAL_MISSING_SENTINEL` constant (line 114) and an in-memory `credentialErrorRepoIds` Set to track credential failures. This state is lost on page reload.

### Shared Constants
`gui/public/js/utils/constants.js` currently exports `STABLE_WS_ID` and `APP_NAME_SHORT`.

### Error Log Infrastructure
`ErrorLogManager` (`src/error-log/error-log.manager.ts`) provides structured append-only logging with FIFO eviction, filterable by `Source` and `Severity`. Already used by orchestrators for credential-missing errors with `source: 'credentials'`.

## Approach / Architecture

The rework is organised into seven steps, grouped by dependency:

1. **Legacy dead-code removal** — Delete `injectCredentials()` and its 7 tests. Clean, isolated, no user-facing impact.

2. **Security hardening (config + API)** — Fix hostname interpolation in config error messages, add hostname format validation on the credential `host` field in the `PUT /api/config/credentials` route, and add a host/credential coherence guard to `PUT /api/repositories/:id/credential`. These three changes address four Medium-severity security findings from the original project.

3. **Audit logging for credential mutations** — Add structured `ErrorLogManager.append()` calls in the credential `PUT` and `DELETE` route handlers in `src/server/routes/config.ts` and `src/server/routes/repositories.ts`. Uses the existing `ErrorLogManager` infrastructure with a new `Source: 'credential-audit'` — no new logging framework.

4. **Persist credential-error badge state** — Extend the workspace health API to include credential-error state. The `GET /api/projects/:id/workspaces/:wid/health` response already returns an `issues[]` array; a new issue type `credential-missing` (with `repositoryId` set) will be persisted by the orchestrators when credential resolution fails. The GUI reads this on page load and populates the amber badge from the health report, eliminating the in-memory-only state problem.

5. **GUI refactors** — Extract `buildCredentialBadge()` to `gui/public/js/utils/dom.js`, replace emoji with a CSS-styled badge with `aria-label` for accessibility, and move `CREDENTIAL_MISSING_SENTINEL` to `gui/public/js/utils/constants.js`.

6. **Per-field length validation on credential fields** — Add maximum length constraints on `id`, `label`, `host`, and `token` fields in both the `PUT /api/config/credentials` route handler and `parseGitCredentials()` config parser. Defence-in-depth measure complementing the existing global 1 MB body limit.

7. **Missing test coverage** — Add the T2 mixed-toast assertion in `workspace-detail.credential-error.test.mjs` and an SSH-URL orchestrator-level integration test.

8. **Fix `notes-collected.test.mjs` infinite hang** — The test file's `render()` helper hangs because `api.config.notesDisplay.get()` is never stubbed, and the timer restoration is fragile (skipped if a test throws). Fix by stubbing the missing API namespace and wrapping timer restoration in proper `afterEach` cleanup.

9. **Documentation** — Update all affected manifest documents.

## Rationale
- **Audit logging via `ErrorLogManager`** rather than a new `AuditLogManager`: the existing infrastructure is proven, has FIFO eviction, filtering by source, and a REST API + GUI view. Adding a `Source: 'credential-audit'` value is a zero-cost extension. A dedicated audit logger is not justified until the tool has user authentication (which it does not — localhost-only tool).
- **Health-based credential-error persistence** rather than a dedicated API field: the health report is already fetched on workspace-detail load and poll cycles. Adding `credential-missing` issues to the health check is semantically correct (it *is* a workspace health issue) and avoids adding a new API endpoint or response field. The orchestrators already log credential-missing errors; the health check can surface them.
- **CSS-based badge** rather than emoji: resolves the cross-platform rendering inconsistency flagged by QA (emoji → CSS icon with proper `aria-label`).

## Considered Alternatives

| Decision | Chosen Shape | Alternatives Considered | Trade-Off Summary |
|----------|--------------|-------------------------|-------------------|
| Audit logging mechanism | `ErrorLogManager` with `Source: 'credential-audit'` | New `AuditLogManager` class; structured log file; console-only logging | `ErrorLogManager` is proven, has REST API + GUI; new class adds unjustified complexity for a localhost tool |
| Credential-error persistence | Workspace health issues (`credential-missing` type) | New `credentialErrors` API response field; localStorage; session storage | Health report is already fetched on load; new field adds API surface without benefit; localStorage couples state to browser |
| Host-coherence validation location | `PUT /api/repositories/:id/credential` route handler | Inside `resolveCredential()` utility; inside `RepositoryManager.updateCredential()` | Route handler is the system boundary where both credential and repo data are available; utility is host-unaware by design |
| Badge replacement | CSS-styled `<span>` with `.credential-badge` class | Keep emoji; SVG icon; icon font | CSS span is framework-free, accessible via `aria-label`, and renders consistently cross-platform |

## Pattern Alignment
- **Error messages avoid raw interpolation of external data** — aligns with the existing convention in `src/git/git-cli.ts` where `args[0]` (subcommand only) is used, never the full args array. Fixing the config error messages brings them in line.
- **Route-level input validation producing HTTP 400** — aligns with the established pattern across all other route handlers (see knowledge base insight #6). The host-coherence guard and hostname format validation follow this pattern.
- **`ErrorLogManager` as the logging sink** — aligns with the existing `source: 'credentials'` usage in orchestrators (WP-007).
- **Shared DOM utility in `gui/public/js/utils/dom.js`** — aligns with the existing `clearElement()` utility already in that file.
- **Constants in `gui/public/js/utils/constants.js`** — aligns with the existing `STABLE_WS_ID` and `APP_NAME_SHORT` co-location pattern.
- **Test helpers in `src/tests/test-helpers.ts`** — any new test helper follows the established pattern (e.g., `setupFakeGit()`).

## Detailed Steps

### Step 1: Remove `injectCredentials()` Legacy Function
1. Delete the `injectCredentials()` function from `src/git/git-credentials.ts` (lines 55–86).
2. Remove its export from the module.
3. Remove the 7 test cases for `injectCredentials` from `src/tests/git-credentials.test.ts` (lines 49–97) and the import.
4. Update `docs/agents/project-manifest/api-surface.md` to remove the `injectCredentials` entry.

### Step 2: Fix Hostname Leak in Config Error Messages
1. In `src/config/config.ts`, replace the error message at line 236:
   - **Before:** `gitCredentials["${host}"] must be a string, got ${typeof token}.`
   - **After:** `gitCredentials entry #${index + 1} (legacy format) must have a string value, got ${typeof token}.`
2. Replace the error message at line 241:
   - **Before:** `gitCredentials["${host}"] must not be an empty string.`
   - **After:** `gitCredentials entry #${index + 1} (legacy format) must not have an empty string value.`
3. Update the two corresponding test assertions in `src/tests/config.test.ts` that match these error message strings.

### Step 3: Add Hostname Format Validation on Credential Host Field
1. In `src/server/routes/config.ts`, in the `PUT /api/config/credentials` handler (line ~196), add a validation guard after the existing `host` type check:
   - Reject `host` values containing `/`, `\`, `\0` (null byte), or whitespace characters.
   - Return HTTP 400 with a descriptive error message.
2. Add corresponding test cases in `src/server/__tests__/` for the new validation.

### Step 4: Add Host/Credential Coherence Guard
1. In `src/server/routes/repositories.ts`, in the `PUT /api/repositories/:id/credential` handler (line ~271), after validating that the credential ID exists in the config:
   - Extract the repository URL's hostname using `extractHost(repo.Url)`.
   - Compare it with `credential.host`.
   - If they differ, return HTTP 400 with: `Credential "${credentialId}" is configured for host "${credential.host}" but repository URL resolves to "${repoHost}".`
   - Skip the check when `credentialId` is `null` (clearing the association).
2. Add corresponding test cases.
3. Update `docs/agents/project-manifest/rest-api.md` to document the new 400 case and remove the "Known limitation — host/credential coherence" note.

### Step 5: Add Audit Logging for Credential Mutations

#### Step 5.0: Wire `errorLogManager` into Route Handler Interfaces (prerequisite)
1. In `src/server/routes/config.ts`, add `errorLogManager?: ErrorLogManager` to the `ConfigRoutesOptions` interface.
2. In `src/server/routes/repositories.ts`, add `errorLogManager?: ErrorLogManager` as a fourth parameter to `registerRepositoryRoutes()`.
3. In `src/server/index.ts`, update both call sites:
   - `registerConfigRoutes({ router, appConfig: config.appConfig, pollingManager, errorLogManager })`
   - `registerRepositoryRoutes(router, repoManager, config.appConfig, errorLogManager)`

> **Implementation note for the PUT handler snippet below:** `isUpdate` maps to `existingIndex !== -1` and `savedEntry` refers to the entry object just written into `appConfig.gitCredentials`. Neither variable exists by name in the current handler; the implementer must derive these values from the existing handler logic.

1. In `src/server/routes/config.ts`:
   - After the successful `saveConfigField` call in the `PUT /api/config/credentials` handler (line ~281), add:
     ```ts
     errorLogManager.append({
         Severity: 'warning',
         Source: 'credential-audit',
         Operation: isUpdate ? 'update-credential' : 'create-credential',
         Context: {},
         Message: `Credential ${isUpdate ? 'updated' : 'created'}: id="${savedEntry.id}", label="${savedEntry.label}", host="${savedEntry.host}"`,
     });
     ```
   - After the successful `saveConfigField` call in the `DELETE /api/config/credentials/:id` handler (line ~313), add:
     ```ts
     errorLogManager.append({
         Severity: 'warning',
         Source: 'credential-audit',
         Operation: 'delete-credential',
         Context: {},
         Message: `Credential deleted: id="${deletedEntry.id}", label="${deletedEntry.label}", host="${deletedEntry.host}"`,
     });
     ```
2. In `src/server/routes/repositories.ts`:
   - After the successful `updateCredential` call in the `PUT /api/repositories/:id/credential` handler, add:
     ```ts
     errorLogManager.append({
         Severity: 'warning',
         Source: 'credential-audit',
         Operation: credentialId ? 'assign-credential' : 'clear-credential',
         Context: { RepositoryId: id },
         Message: credentialId
             ? `Credential "${credentialId}" assigned to repository "${id}"`
             : `Credential cleared from repository "${id}"`,
     });
     ```
3. Add test cases verifying the audit log entries are created for each mutation type.
4. Note: `Severity: 'warning'` is used because this is informational audit data, not an error. The existing severity enum only has `'error' | 'warning'` — `'warning'` is the closest match for informational audit entries.

### Step 6: Persist Credential-Error Badge State
1. **No changes required in `workspace-orchestrator.ts`** — the orchestrator already appends `Source: 'credentials'` entries to `ErrorLogManager` with `ProjectId`, `WorkspaceId`, and `RepositoryId` in the `Context` field when credential resolution fails. Steps 6.2–6.3 query these existing entries; no additional orchestrator logging is needed.
2. In `src/orchestration/workspace-health.ts`:
   - Add `errorLogManager?: ErrorLogManager` as a fifth parameter to `checkWorkspaceHealth(projectId, workspaceId, projectsFolder, repositoryIds, errorLogManager?)`.
   - Add a new health issue type: `credential-missing` with `fixAction: 'configure-credential'` and `severity: 'warning'`.
   - Query the supplied `errorLogManager` for recent `Source: 'credentials'` entries scoped to the workspace's repositories, and surface them as health issues.
3. In `src/server/routes/workspaces.ts`, update the `checkWorkspaceHealth()` call site to pass `errorLogManager` as the fifth argument (`errorLogManager` is already in scope via the `registerWorkspaceRoutes` options).
4. In `gui/public/js/views/workspace-detail.js`:
   - On initial load, after fetching the health report, scan for `credential-missing` issues and populate `credentialErrorRepoIds` from them.
   - The existing badge rendering logic then works without change.
5. Add test cases for the new health issue type.
6. Update the `rest-api.md` to document the new `credential-missing` health issue type and `configure-credential` fix action.

### Step 7: Extract `buildCredentialBadge()` and Improve Accessibility
1. In `gui/public/js/utils/dom.js`, add a new exported function:
   ```js
   export function buildCredentialBadge(credentialId) {
       const badge = document.createElement('span');
       if (credentialId) {
           badge.className   = 'credential-badge credential-badge--set';
           badge.title       = `Credential: ${credentialId}`;
           badge.textContent = '\u2713';  // ✓ checkmark
           badge.setAttribute('aria-label', 'Credential configured');
       } else {
           badge.className   = 'credential-badge credential-badge--none';
           badge.title       = 'No credential configured';
           badge.textContent = '—';
           badge.setAttribute('aria-label', 'No credential configured');
       }
       return badge;
   }
   ```
2. Add CSS in `gui/public/css/styles.css` for `.credential-badge--set` styling (background, color, border-radius) replacing the emoji rendering.
3. Replace the duplicated badge code in:
   - `gui/public/js/views/repositories.js` `buildRepoRow()` (lines 107–123)
   - `gui/public/js/views/project-detail.js` `buildRepositoriesSection()` (lines 278–292)
   with a call to `buildCredentialBadge(repo.credentialId)`.
4. Update existing GUI tests for the changed badge class names (`credential-status-badge` → `credential-badge`).

### Step 8: Move `CREDENTIAL_MISSING_SENTINEL` to Constants
1. Move the `CREDENTIAL_MISSING_SENTINEL` constant from `gui/public/js/views/workspace-detail.js` (line 114) to `gui/public/js/utils/constants.js`.
2. Update `workspace-detail.js` to import from `../utils/constants.js`.
3. Update any test files that reference the constant.

### Step 9: Add Per-Field Length Validation on Credential Fields
1. Define maximum length constants (co-located with credential types or in `config.constants.ts`):
   - `MAX_CREDENTIAL_ID_LENGTH = 100`
   - `MAX_CREDENTIAL_LABEL_LENGTH = 200`
   - `MAX_CREDENTIAL_HOST_LENGTH = 253` (DNS hostname max)
   - `MAX_CREDENTIAL_TOKEN_LENGTH = 500`
2. In `src/server/routes/config.ts`, in the `PUT /api/config/credentials` handler, after the existing type and empty-string checks, add length guards for each field:
   - If any field exceeds its maximum, return HTTP 400 with: `"${field}" exceeds maximum length of ${max} characters.`
3. In `src/config/config.ts`, in `parseGitCredentials()`, add matching length guards in the per-field validation loop so malformed `config.json` entries are caught at load time with descriptive error messages.
4. Add test cases for both the route handler (HTTP 400 on over-length fields) and the config parser (thrown error on over-length fields).

### Step 10: Add Missing Test Coverage
1. In `gui/public/js/views/workspace-detail.credential-error.test.mjs`:
   - Add a T2 test case that exercises the mixed-failure toast branch: when setup failures include both credential-missing and non-credential errors, verify the toast message reads `"Missing credentials for: <cred-repos>. Failed to clone: <other-repos>."`.
2. In `src/tests/` (new file `credential-ssh-bypass.test.ts` or added to `repository-orchestrator.test.ts`):
   - Add an orchestrator-level integration test that exercises an SSH URL (`git@github.com:org/repo.git`) with `gitCredentials` configured, verifying that credential injection is bypassed (the URL is passed unchanged to `cloneRepository()`).

### Step 11: Fix `notes-collected.test.mjs` Infinite Hang
1. In `gui/public/js/views/notes-collected.test.mjs`:
   - **Stub the missing API namespace:** In the test setup (before `render()` calls), add:
     ```js
     api.config = { notesDisplay: { get: async () => ({}) } };
     ```
     This prevents the `Promise.all` in `renderNotesCollected()` from hanging on an unstubbed `api.config.notesDisplay.get()` call.
   - **Move timer restoration to `afterEach`:** Replace the manual `restoreTimers()` calls at the end of each test with a single `afterEach(() => { restoreTimers(); })` hook. This ensures the original `setTimeout`/`clearTimeout` are restored even when a test assertion fails mid-execution, preventing cascading hangs in subsequent tests.
   - **Fix `clearTimeout` ID tracking:** The current `clearTimeout` stub compares against `_timerId` (which advances on every `setTimeout` call), making it impossible to clear any timer except the most recent one. Replace the single `_timerId` counter with a `Map<number, Function>` that stores all pending callbacks, and update `clearTimeout` to delete by ID.
2. Verify the test file runs to completion without hanging when executed in isolation (`node --test gui/public/js/views/notes-collected.test.mjs`).

### Step 12: Documentation Updates
Covered in the Documentation Updates section below.

## Dependencies
- Steps 1–5 are independent of each other and can be parallelised.
- Step 6 (persist credential-error badge) depends on no prior step but involves both backend and GUI changes.
- Step 7 (extract badge helper) is independent; CSS class rename may affect Step 6 GUI code if done in parallel — sequence Step 7 before or after Step 6's GUI portion.
- Step 8 (move constant) should be done after Step 6, which references the constant.
- Step 9 (per-field length validation) is independent of other steps; touches the same files as Step 3 (hostname format validation) so should be sequenced with it.
- Step 10 (tests) can be done in parallel with the main work but should be sequenced after the code changes they test.
- Step 11 (notes-collected test fix) is fully independent — no overlap with any other step.
- Step 12 (docs) is always last.

## Required Components

### Modified Files (Existing)
- `src/git/git-credentials.ts` — remove `injectCredentials()`
- `src/config/config.ts` — fix error messages at lines 236/241
- `src/server/routes/config.ts` — add hostname validation, audit logging
- `src/server/routes/repositories.ts` — add host-coherence guard, audit logging
- `src/server/index.ts` — wire `errorLogManager` into `registerConfigRoutes` and `registerRepositoryRoutes` call sites
- `src/orchestration/workspace-health.ts` — add `credential-missing` health issue type; add `errorLogManager` parameter
- `src/server/routes/workspaces.ts` — pass `errorLogManager` to `checkWorkspaceHealth()` call site
- `gui/public/js/utils/dom.js` — add `buildCredentialBadge()`
- `gui/public/js/utils/constants.js` — add `CREDENTIAL_MISSING_SENTINEL`
- `gui/public/js/views/repositories.js` — use shared badge helper
- `gui/public/js/views/project-detail.js` — use shared badge helper
- `gui/public/js/views/workspace-detail.js` — read credential errors from health report; import constant
- `gui/public/css/styles.css` — add `.credential-badge` CSS rules
- `src/tests/git-credentials.test.ts` — remove legacy tests
- `src/tests/config.test.ts` — update error message assertions
- `gui/public/js/views/workspace-detail.credential-error.test.mjs` — add T2 test

### New Files
- None required at the source level. Test additions may be in new or existing files (developer's discretion).

### Additional Modified Files (from newly in-scope items)
- `src/config/config.ts` — add per-field length validation in `parseGitCredentials()`
- `src/config/config.constants.ts` — add `MAX_CREDENTIAL_*_LENGTH` constants (or co-locate with credential types)
- `src/server/routes/config.ts` — add per-field length validation in PUT handler
- `gui/public/js/views/notes-collected.test.mjs` — fix hang (stub API, afterEach cleanup, timer ID tracking)

## Assumptions
- The `ErrorLogManager` instance must be explicitly wired into `ConfigRoutesOptions` and `registerRepositoryRoutes()` (Step 5.0); `startServer()` already has `errorLogManager` in scope and will pass it through.
- The `extractHost()` function is importable from `src/git/git-credentials.ts` in the repositories route file.
- The workspace health check infrastructure (`src/orchestration/workspace-health.ts`) supports adding new issue types without schema changes.
- GUI tests use jsdom and can test the new `buildCredentialBadge()` utility directly.

## Constraints
- All relative imports must use `.js` extensions (Node16 ESM).
- No new production dependencies.
- No `SCHEMA_VERSION` bump required — all changes are optional field additions or behavioural changes.
- Token values must never appear in audit log messages — only credential `id`, `label`, and `host`.
- The credential badge CSS change (`credential-status-badge` → `credential-badge`) is a GUI-only class rename — no backend impact, but all GUI tests referencing the old class names must be updated.

## Out of Scope
- Adding user authentication or multi-user access control.
- Credential encryption at rest (by design — plaintext with `chmod 0o600`).

## Acceptance Criteria
1. `injectCredentials()` and its 7 test cases are removed; no compile errors; all remaining tests pass.
2. Config error messages no longer interpolate raw hostname values.
3. `PUT /api/config/credentials` rejects `host` values containing `/`, `\`, null bytes, or whitespace with HTTP 400.
4. `PUT /api/repositories/:id/credential` rejects credential assignments where `credential.host` does not match the repository URL's hostname with HTTP 400.
5. Credential create/update/delete operations and credential-assignment/clear operations produce audit log entries with `Source: 'credential-audit'`.
6. The "Missing Credential" amber badge in workspace-detail persists across page reloads (populated from the workspace health report).
7. Credential badge DOM construction is consolidated in a single `buildCredentialBadge()` function in `gui/public/js/utils/dom.js`.
8. Credential badge uses a CSS-styled element (not emoji) with proper `aria-label`.
9. `CREDENTIAL_MISSING_SENTINEL` is defined in `gui/public/js/utils/constants.js` and imported by `workspace-detail.js`.
10. The T2 mixed-toast test case passes in `workspace-detail.credential-error.test.mjs`.
11. An SSH-URL orchestrator-level test verifies credential injection bypass.
12. All affected manifest documents are updated.
13. Per-field maximum length validation rejects over-length `id` (>100), `label` (>200), `host` (>253), and `token` (>500) values with HTTP 400 at the API layer and a thrown error at config parse time.
14. `notes-collected.test.mjs` runs to completion without hanging.
15. Zero TypeScript compile errors; all server and GUI tests pass.

## Testing Strategy
Each step produces targeted unit and integration tests. The overall strategy is:
- **Unit tests** for new validation logic (hostname format, host-coherence) in existing test files.
- **Unit tests** for the `buildCredentialBadge()` DOM utility.
- **Integration tests** for audit log entries (verify `ErrorLogManager.append()` is called with correct parameters during credential route mutations).
- **Existing test suite regression** — the full 896 server + 199 GUI test suite must pass after all changes.
- **Hang fix verification** — `notes-collected.test.mjs` must complete without timeout when run in isolation.

## Test Plan

- `src/tests/git-credentials.test.ts` — Remove 7 `injectCredentials` test cases; verify the remaining `resolveCredential`, `injectCredentialToken`, `extractHost`, `hasEmbeddedCredentials`, `stripEmbeddedCredentials` tests still pass — AC1
- `src/tests/config.test.ts` — Update 2 error message assertions to match new positional-index format — AC2
- `src/server/__tests__/routes/config.test.ts` — Add tests: `host` with `/` → 400; `host` with `\` → 400; `host` with null byte → 400; `host` with whitespace → 400; valid `host` → 200 — AC3
- `src/server/__tests__/routes/repositories.test.ts` — Add tests: assign credential with mismatched host → 400; assign credential with matching host → 200; clear credential (null) → 200 (no host check) — AC4
- `src/server/__tests__/routes/config.test.ts` — Add tests: `PUT` credential → audit log entry created with correct Source/Operation/Message; `DELETE` credential → audit log entry; verify token NOT present in audit message — AC5
- `src/server/__tests__/routes/repositories.test.ts` — Add tests: assign credential → audit log entry; clear credential → audit log entry — AC5
- `src/tests/workspace-health.test.ts` — Add tests: health report includes `credential-missing` issues when error log contains recent credential errors; health report omits `credential-missing` when no credential errors — AC6
- `gui/public/js/views/workspace-detail.credential-error.test.mjs` — Add T2 test: mixed credential + non-credential failures produce combined toast message — AC10
- `gui/public/js/utils/dom.test.mjs` (or existing test file) — Add tests: `buildCredentialBadge('some-id')` returns element with `.credential-badge--set`; `buildCredentialBadge(null)` returns element with `.credential-badge--none` — AC7, AC8
- `src/tests/repository-orchestrator.test.ts` (or new `credential-ssh-bypass.test.ts`) — Add test: SSH URL with `gitCredentials` configured → `cloneRepository` called with unmodified SSH URL — AC11
- `src/server/__tests__/routes/config.test.ts` — Add tests: `id` exceeding 100 chars → 400; `label` exceeding 200 chars → 400; `host` exceeding 253 chars → 400; `token` exceeding 500 chars → 400; values at the limit → 200 — AC13
- `src/tests/config.test.ts` — Add tests: `parseGitCredentials` throws on over-length `id`, `label`, `host`, `token` fields — AC13
- `gui/public/js/views/notes-collected.test.mjs` — Verify the file runs without hanging after the timer/API stub fix — AC14

## Documentation Updates
- `docs/agents/project-manifest/api-surface.md` — Remove `injectCredentials` entry; add `buildCredentialBadge` to GUI utilities section (if present)
- `docs/agents/project-manifest/rest-api.md` — Document new 400 cases on `PUT /api/config/credentials` (hostname validation) and `PUT /api/repositories/:id/credential` (host-coherence); remove "Known limitation — host/credential coherence" note; document `credential-missing` health issue type and `configure-credential` fix action
- `docs/agents/project-manifest/gui-frontend.md` — Update badge class references from `credential-status-badge` to `credential-badge`; note `buildCredentialBadge()` utility in `dom.js`; note `CREDENTIAL_MISSING_SENTINEL` location in `constants.js`
- `docs/agents/project-manifest/constraints.md` — Add hostname format validation rule for credential `host` field; add host-coherence validation rule for credential-repository association; document per-field length limits for `GitCredentialEntry` fields
- Re-run `ctx generate` for the `.context/` folder structure file

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Health-based credential-error persistence may surface stale errors** | The health check should only surface credential-missing errors from the most recent setup run (keyed by workspace + repository). Older error log entries for the same scope are superseded, not accumulated. |
| **CSS badge class rename breaks existing GUI tests** | All GUI test files referencing `credential-status-badge` must be updated atomically with the class rename. A grep for the old class name across `gui/` confirms completeness. |
| **Host-coherence guard rejects valid edge cases** | The guard only fires on `PUT /api/repositories/:id/credential` with a non-null `credentialId`. Clearing (null) is always allowed. The error message is actionable, telling the user which hosts are mismatched. |
| **Audit logging volume inflates error log** | `ErrorLogManager` has FIFO eviction at 500 entries (configurable). Credential mutations are infrequent in normal use. The `source: 'credential-audit'` filter ensures audit entries can be viewed in isolation. |
| **Removing `injectCredentials()` breaks external consumers** | The function was not part of any documented public API. The tool has no external consumers — it is a single-user localhost application. |
| **Per-field length limits are too restrictive** | Limits are generous: 100 for ID (kebab-case), 200 for label, 253 for host (DNS max), 500 for token (covers GitHub fine-grained PATs at ~93 chars and GitLab tokens at ~26 chars with wide margin). Can be adjusted without schema changes. |
| **`notes-collected.test.mjs` fix masks a deeper async issue** | The fix addresses the two concrete root causes (unstubbed API, fragile timer restoration). The timer ID tracking improvement also makes future debounce-related tests more robust. |
