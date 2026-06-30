# Plan

## Plan Audit Cycles
- Audits: 1 — Plan Auditor v1.5.0
- Architectural Reviews: none — Plan Architect Reviewer v1.6.0

## Prior Project Context
Two completed projects in the `paralizer` repository are directly relevant:

- **`2026-06-26-multi-credential-support`** — Migrated the credential system from single-token-per-host to named multi-credential array. All 10 WPs completed; 896 server + 199 GUI tests passing.
- **`2026-06-26-multi-credential-support-rework-1`** — Closed deferred security hardening, UX polish, dead-code removal, and audit logging items from the original project. All 10 WPs completed; 919 server + 237 GUI tests passing, 0 security issues.

This rework cycle addresses the remaining deferred items from the rework-1 synthesis, excluding the Windows file-permission gap (explicitly out of scope per user direction).

## Summary
Address all remaining actionable deferred items from the `2026-06-26-multi-credential-support-rework-1` synthesis: add a dedicated `'audit'` severity to `ErrorSeverity`, extract a shared `MockErrorLogManager` test helper, resolve stale credential badges via success log entries, add a "Configure Credential" button to the health alert section, align `parseGitCredentials()` field trimming, enrich config-level credential audit entries with richer context, and unify CSS variable naming for credential badges.

## Architectural Context

### Error Logging
- `ErrorSeverity` type at `src/error-log/error-log.types.ts` — currently `'error' | 'warning'`.
- `ErrorLogManager` at `src/error-log/error-log.manager.ts` — stateless per-call disk I/O; `append()` accepts `Omit<ErrorLogEntry, 'Id' | 'Timestamp'>`.
- Error log REST route at `src/server/routes/error-log.ts` — GET handler validates severity with `severityRaw === 'error' || severityRaw === 'warning'` before casting.
- Credential audit entries use `Source: 'credential-audit'`, `Severity: 'warning'` across `src/server/routes/config.ts` (3 callsites) and `src/server/routes/repositories.ts` (1 callsite).
- Error log GUI at `gui/public/js/views/error-log.js` — `SEVERITY_OPTIONS` array drives the filter dropdown; `buildSeverityBadge()` generates CSS class `severity-${normalised}`.
- CSS at `gui/public/css/styles.css` — `.severity-error` and `.severity-warning` classes exist at lines 696–704.

### Health Reporting & Credential Badges
- `checkWorkspaceHealth()` at `src/orchestration/workspace-health.ts` — queries `errorLogManager.list({ source: 'credentials' })` for credential-missing entries. No success entries are ever written, causing stale badges.
- Credential-missing errors are written by `WorkspaceOrchestrator.createWorkspace()` (line 157) and `RepositoryOrchestrator.addRepositoryToProject()` (line 146) with `Source: 'credentials'`, `Severity: 'error'`.
- `buildHealthAlertSection()` at `gui/public/js/views/workspace-detail.js` (line 814) — handles `fixAction: 'regenerate-workspace-file'` and `'setup-workspace'` with buttons, but issues with `fixAction: 'configure-credential'` render as message-only rows.

### Test Helpers
- `makeMockErrorLogManager()` is defined identically in:
  - `src/server/__tests__/routes/config.test.ts` (line 80)
  - `src/server/__tests__/routes/repositories.test.ts` (line 112)
- A different `MockErrorLogManager` class exists in `src/server/__tests__/routes/workspaces-launch.test.ts` (line 114) and `error-log.test.ts` (line 12) with different shapes.

### CSS Variables
- `.status-badge-credential` uses `--badge-credential` / `--badge-credential-bg` (amber, clickable).
- `.credential-badge` uses `--badge-clean` / `--badge-clean-bg` (green, static) and `--color-text-muted` / `--color-border-light` (neutral).
- Comment at line 629 already documents the distinction but the variable naming divergence was flagged.

### Config Parser
- `parseGitCredentials()` at `src/config/config.ts` (line 180) trims field values for length validation but returns un-trimmed strings from `config.json`. The PUT credential route handler trims on write. The asymmetry is documented in `constraints.md` but not enforced at parse time.

## Approach / Architecture

### 1. `ErrorSeverity` Expansion (Vertical Cut)
Add `'audit'` to the `ErrorSeverity` union type. Update all downstream consumers:
- Error log REST route: add `'audit'` to the severity validation guard.
- Error log GUI: add `'Audit'` to `SEVERITY_OPTIONS`, add `.severity-audit` CSS class.
- Credential audit `append()` callsites: change `Severity: 'warning'` → `Severity: 'audit'`.
- Documentation updates.

### 2. Shared Test Helper (Extract & Import)
Create `src/server/__tests__/helpers/mock-error-log-manager.ts` with the `makeMockErrorLogManager()` function. Update `config.test.ts` and `repositories.test.ts` to import from the shared module. Leave `workspaces-launch.test.ts` and `error-log.test.ts` alone — they use different mock shapes suited to their specific needs.

### 3. Stale Credential Badge Resolution
After a successful clone with credentials in both `WorkspaceOrchestrator` and `RepositoryOrchestrator`, write a `Source: 'credentials'`, `Severity: 'info'` log entry. Update `checkWorkspaceHealth()` to check the severity of the most recent credential log entry per repository — if it's `'info'` (success), suppress the health issue. This requires adding `'info'` to `ErrorSeverity` alongside `'audit'`.

### 4. Health Alert "Configure Credential" Button
Add a `fixAction === 'configure-credential'` branch in `buildHealthAlertSection()` that renders a "Configure" button. The button navigates to `#/repositories` (the repository list page where credential assignment is accessible).

### 5. `parseGitCredentials()` Trim-on-Parse
Normalize all four credential fields (id, label, host, token) by trimming at parse time, before returning the array. This eliminates the documented asymmetry where the API trims on write but the parser returns raw values.

### 6. Config-Level Credential Audit Context Enrichment
The config-level credential audit entries (create/update/delete in `config.ts`) currently use `Context: {}`. While credentials are not scoped to a project, adding the credential `id` to the `Context` is not useful (it's already in the message). This item is low value — defer to documentation-only resolution.

### 7. CSS Variable Naming Unification
Add `--badge-credential-set` / `--badge-credential-set-bg` design tokens that alias `--badge-clean` / `--badge-clean-bg`, and update `.credential-badge--set` to use the new tokens. This gives credential badges their own semantic variable names while preserving the visual appearance.

## Rationale
- **`'audit'` + `'info'` severities:** Adding both in one pass avoids a second migration. `'audit'` enables GUI-level filtering of security events. `'info'` enables suppression of stale credential badges via success entries. Both are additive type-union extensions with zero breaking-change risk.
- **Shared mock helper:** The two `makeMockErrorLogManager()` functions are verbatim-identical 12-line blocks. A shared helper eliminates the duplication and keeps stubs in sync as `ErrorLogManager` evolves. The other two mock classes have different shapes and are left alone.
- **Trim-on-parse:** Normalizing at the parser layer means all downstream consumers see trimmed values, eliminating the "consumers must trim before use" contract noted in `constraints.md`.
- **Navigate to `#/repositories`:** The repository list page is the most contextually appropriate destination for "Configure Credential" — users can see all repositories and their credential assignments.

## Considered Alternatives

| Decision | Chosen Shape | Alternatives Considered | Trade-Off Summary |
|----------|--------------|-------------------------|-------------------|
| New severity values | `'audit' \| 'info'` as new union members | Single `'audit'` only; numeric severity levels; separate `AuditLog` store | Two string values are minimal; numeric levels over-engineer for 4 values; separate store unjustified |
| Stale badge resolution | Write `info`-severity success entry to existing error log | TTL-based expiry; separate success-tracking store; clear old entries on success | Reusing the existing log + severity filter is lowest-cost; no new stores or expiry logic needed |
| Credential badge CSS variables | New `--badge-credential-set` / `--badge-credential-set-bg` aliases | Rename `--badge-clean` to `--badge-credential-set`; leave as-is | Aliases preserve backward compatibility while giving credential badges semantic names |
| Trim strategy | Trim at parse time in `parseGitCredentials()` | Trim only at write time (current); trim at both endpoints | Trim-at-parse is the single authoritative normalization point; reduces consumer responsibility |
| Health alert button target | Navigate to `#/repositories` | Deep-link to specific repository; open modal | `#/repositories` is a simple hash navigation; deep-linking requires additional infrastructure |

## Pattern Alignment
- **`ErrorSeverity` type union** — follows the existing `'error' | 'warning'` union pattern in `src/error-log/error-log.types.ts`. Extension is additive.
- **`SEVERITY_OPTIONS` array in error-log GUI** — follows the existing declarative pattern at `gui/public/js/views/error-log.js` line 32.
- **CSS severity classes** — follows the `.severity-{value}` naming convention established by `.severity-error` and `.severity-warning` at `gui/public/css/styles.css` lines 696–704.
- **Shared test helper extraction** — follows the existing `src/tests/test-helpers.ts` pattern for shared test utilities (note: the server test helpers use a different directory at `src/server/__tests__/helpers/`; this plan follows that convention).
- **`Source: 'credentials'` log entries** — follows the existing pattern in `WorkspaceOrchestrator` and `RepositoryOrchestrator` for credential error logging.
- **Health alert button pattern** — follows the existing `fixAction === 'regenerate-workspace-file'` and `fixAction === 'setup-workspace'` button patterns in `buildHealthAlertSection()`.
- **Design token aliasing** — new CSS variables alias existing tokens, following the existing token indirection pattern in the stylesheet's `:root` block.

## Detailed Steps

### Step 1: Expand `ErrorSeverity` Type
1. In `src/error-log/error-log.types.ts`, change `ErrorSeverity` from `'error' | 'warning'` to `'error' | 'warning' | 'audit' | 'info'`.

### Step 2: Update Error Log REST Route
1. In `src/server/routes/error-log.ts`, update the severity validation guard (line 91) to also accept `'audit'` and `'info'`:
   ```typescript
   const VALID_SEVERITIES: ReadonlySet<ErrorSeverity> = new Set(['error', 'warning', 'audit', 'info']);
   const severity = VALID_SEVERITIES.has(severityRaw as ErrorSeverity)
       ? (severityRaw as ErrorSeverity)
       : undefined;
   ```

### Step 3: Update Error Log GUI
1. In `gui/public/js/views/error-log.js`, add `{ value: 'audit', label: 'Audit' }` and `{ value: 'info', label: 'Info' }` to the `SEVERITY_OPTIONS` array.
2. In `gui/public/css/styles.css`, add `.severity-audit` and `.severity-info` CSS classes after `.severity-warning`:
   - `.severity-audit` — use a blue/indigo colour scheme (e.g. `--badge-ahead` / `--badge-ahead-bg` which are already defined as `#2563eb` / `#dbeafe`).
   - `.severity-info` — use a neutral/grey colour scheme (e.g. `--color-text-muted` / `--color-border-light`).

### Step 4: Change Credential Audit Severity
1. In `src/server/routes/config.ts`, change the two `Severity: 'warning'` audit entries (create/update at line 320, delete at line 365) to `Severity: 'audit'`.
2. In `src/server/routes/repositories.ts`, change the `Severity: 'warning'` audit entry (assign/clear at line 307) to `Severity: 'audit'`.

### Step 5: Update Credential Audit Tests
1. In `src/server/__tests__/routes/config.test.ts`, update all test assertions that check `Severity: 'warning'` on credential-audit entries to `Severity: 'audit'`.
2. In `src/server/__tests__/routes/repositories.test.ts`, do the same.

### Step 6: Extract Shared `makeMockErrorLogManager`
1. Create `src/server/__tests__/helpers/mock-error-log-manager.ts` with the shared `makeMockErrorLogManager()` function (verbatim from `config.test.ts`).
2. Update `src/server/__tests__/routes/config.test.ts` to import from the shared helper; remove the local copy.
3. Update `src/server/__tests__/routes/repositories.test.ts` to import from the shared helper; remove the local copy.

### Step 7: Write Credential Success Log Entries
1. In `src/orchestration/workspace-orchestrator.ts`, after a successful clone, guard on `credential !== null` before appending the success log entry:
   ```typescript
   if (credential !== null) {
       this.errorLogManager?.append({
           Severity: 'info',
           Source: 'credentials',
           Operation: 'workspace-setup',
           Context: { ProjectId: projectId, WorkspaceId: workspaceId, RepositoryId: repoId },
           Message: `Credential resolved successfully for repository '${repo.Name}'.`,
       });
   }
   ```
2. In `src/orchestration/repository-orchestrator.ts`, apply the same pattern (guarded by `credential !== null`) with `Operation: 'add-repository'`. SSH clones where `credential === null` must not produce an `'info'` log entry.

### Step 8: Update `checkWorkspaceHealth()` to Suppress Stale Badges
1. In `src/orchestration/workspace-health.ts`, update the credential-missing check (Check 3) to inspect the severity of the most recent `Source: 'credentials'` entry per repository. If the most recent entry is `'info'` (indicating a successful credential use), skip adding a `credential-missing` health issue for that repository.
2. Update the `@remarks` JSDoc to reflect that stale badges are now resolved by success entries.

### Step 9: Add "Configure Credential" Button to Health Alert Section
1. In `gui/public/js/views/workspace-detail.js`, add an `else if (issue.fixAction === 'configure-credential')` branch in `buildHealthAlertSection()` (after the `'setup-workspace'` branch). The button:
   - Text: `"Configure"`
   - On click: `window.location.hash = '#/repositories'`
   - Uses the same `btn btn-secondary btn-sm` pattern as existing buttons.

### Step 10: Trim Fields in `parseGitCredentials()`
1. In `src/config/config.ts`, in the new-format array branch of `parseGitCredentials()`, after the length validation loop, trim all four field values on the entry objects before returning.
2. In the legacy-format branch, trim `host` and `token` values before constructing the `GitCredentialEntry`.

### Step 11: Add CSS Credential Badge Design Tokens
1. In `gui/public/css/styles.css`, add `--badge-credential-set` and `--badge-credential-set-bg` tokens to the `:root` block, aliasing `--badge-clean` and `--badge-clean-bg` respectively.
2. Update `.credential-badge--set` to use `--badge-credential-set` / `--badge-credential-set-bg` instead of `--badge-clean` / `--badge-clean-bg`.
3. Add a CSS comment explaining the alias relationship.

### Step 12: Update Documentation
1. Update `docs/agents/project-manifest/rest-api.md`:
   - Update the `ErrorSeverity` documentation to include `'audit'` and `'info'`.
   - Remove the note about credential-audit entries using `Severity: 'warning'` as a workaround.
   - Update the severity filter documentation for `GET /api/error-log`.
2. Update `docs/agents/project-manifest/constraints.md`:
   - Update the `ErrorSeverity` type documentation.
   - Remove the "consumers must trim before use" note for `parseGitCredentials()` — trimming is now done at parse time.
3. Update `docs/agents/project-manifest/api-surface.md`:
   - Update `ErrorSeverity` type.
   - Update `checkWorkspaceHealth()` documentation regarding stale badge resolution.
4. Update `docs/agents/project-manifest/gui-frontend.md`:
   - Document the new severity filter options.
   - Document the `.severity-audit` and `.severity-info` CSS classes.
   - Document the "Configure" button in health alert section.
5. Update `docs/agents/project-manifest/data-flows.md`:
   - Document the credential success log entry flow.
6. Update `src/config/README.md`:
   - Note that `parseGitCredentials()` now trims all fields at parse time.
7. Update `src/server/README.md`:
   - Update the audit logging note to reflect `Severity: 'audit'` instead of `'warning'`.
8. Re-run `ctx generate` to regenerate `.context/` files.

## Dependencies
- Steps 1 must complete before Steps 2–5.
- Step 6 has no dependencies on other steps (can run in parallel with 1–5).
- Steps 7–8 depend on Step 1 (for the `'info'` severity value).
- Step 9 has no dependencies on other steps.
- Step 10 has no dependencies on other steps.
- Step 11 has no dependencies on other steps.
- Step 12 depends on all prior steps.

## Required Components
- `src/error-log/error-log.types.ts` — modify `ErrorSeverity` type.
- `src/server/routes/error-log.ts` — modify severity validation.
- `src/server/routes/config.ts` — modify credential audit severity.
- `src/server/routes/repositories.ts` — modify credential audit severity.
- `gui/public/js/views/error-log.js` — modify severity options.
- `gui/public/css/styles.css` — add severity classes and design tokens.
- `src/server/__tests__/helpers/mock-error-log-manager.ts` — **new file**.
- `src/server/__tests__/routes/config.test.ts` — modify imports and assertions.
- `src/server/__tests__/routes/repositories.test.ts` — modify imports and assertions.
- `src/orchestration/workspace-orchestrator.ts` — add credential success log.
- `src/orchestration/repository-orchestrator.ts` — add credential success log.
- `src/orchestration/workspace-health.ts` — modify credential-missing suppression.
- `gui/public/js/views/workspace-detail.js` — add "Configure" button.
- `src/config/config.ts` — modify `parseGitCredentials()` trimming.

## Assumptions
- The `'audit'` and `'info'` severity values do not conflict with any existing `Source` strings or other log entry fields.
- The `ErrorLogManager.list()` method already supports filtering by the new severity values — the filter is a simple string equality check against `ErrorSeverity`.
- No external consumers of `config.json` depend on un-trimmed credential field values.
- Existing tests that assert `Severity: 'warning'` on credential-audit entries are the only tests affected by the severity change.

## Constraints
- The `ErrorSeverity` type is a string union, not an enum. All changes must use the union extension pattern.
- Node16 ESM module system — all new file imports must use `.js` extensions.
- The `parseGitCredentials()` trimming must not break backward compatibility — existing valid `config.json` files with trimmed values must parse identically.
- GUI has no build step — all JavaScript is vanilla ES modules.

## Out of Scope
- Windows Credential Manager integration for stored tokens (per user direction).
- Adding `ProjectId` to config-level credential audit entries — credentials are global, not project-scoped. The synthesis item is resolved by documentation.
- Refactoring `MockErrorLogManager` in `workspaces-launch.test.ts` or `error-log.test.ts` — these use different mock shapes appropriate to their test contexts.
- Relocating other sentinel constants from view modules — the synthesis noted `CREDENTIAL_MISSING_SENTINEL` was already relocated; no other candidates were identified.
- `DELETE /api/config/credentials/:id` handler async/sync mismatch — accepted as-is per synthesis.

## Acceptance Criteria
1. `ErrorSeverity` type supports `'error' | 'warning' | 'audit' | 'info'`.
2. All credential-audit `append()` calls use `Severity: 'audit'`.
3. Error log GUI severity filter includes "Audit" and "Info" options.
4. `.severity-audit` and `.severity-info` CSS classes render distinct visual styles.
5. `GET /api/error-log?severity=audit` returns only audit entries; `?severity=info` returns only info entries.
6. `makeMockErrorLogManager()` exists in a single shared module; `config.test.ts` and `repositories.test.ts` import from it.
7. Successful clone with credentials writes a `Source: 'credentials'`, `Severity: 'info'` log entry.
8. `checkWorkspaceHealth()` suppresses `credential-missing` health issues when the most recent credential log entry for the repository is `Severity: 'info'`.
9. `buildHealthAlertSection()` renders a "Configure" button for `fixAction: 'configure-credential'` issues that navigates to `#/repositories`.
10. `parseGitCredentials()` returns trimmed field values for all four credential fields in both new-format and legacy-format branches.
11. `.credential-badge--set` uses `--badge-credential-set` / `--badge-credential-set-bg` design tokens.
12. All existing tests pass after changes. New tests cover the new behaviour.

## Testing Strategy
Each step introduces testable behaviour. Backend changes are validated via the Node.js built-in test runner (`node --test`). GUI tests use the existing `.test.mjs` test harness. All tests run as part of the existing CI surface.

## Test Plan

- `src/server/__tests__/routes/error-log.test.ts` — Add test: `GET /api/error-log?severity=audit` returns only audit entries. Add test: `GET /api/error-log?severity=info` returns only info entries. — AC 5
- `src/server/__tests__/routes/config.test.ts` — Update existing credential-audit tests to assert `Severity: 'audit'` instead of `'warning'`. Verify import from shared helper compiles and runs. — AC 2, 6
- `src/server/__tests__/routes/repositories.test.ts` — Update existing credential-audit tests to assert `Severity: 'audit'` instead of `'warning'`. Verify import from shared helper compiles and runs. — AC 2, 6
- `src/tests/workspace-orchestrator.test.ts` — Add test: successful clone with credentials writes `Source: 'credentials'`, `Severity: 'info'` log entry. — AC 7
- `src/tests/repository-orchestrator.test.ts` — Add test: successful clone with credentials writes `Source: 'credentials'`, `Severity: 'info'` log entry. — AC 7
- `src/tests/workspace-health.test.ts` — Add test: `checkWorkspaceHealth()` does NOT report `credential-missing` when most recent credential entry for the repo is `Severity: 'info'`. Add test: still reports `credential-missing` when most recent entry is `Severity: 'error'` even if an older `'info'` entry exists. — AC 8
- `src/tests/config.test.ts` — Add test: `parseGitCredentials()` trims whitespace from all four fields in new-format entries. Add test: legacy-format entries are trimmed. — AC 10
- `gui/public/js/views/workspace-detail.credential-error.test.mjs` — Add test: `buildHealthAlertSection()` renders a "Configure" button for `configure-credential` fix action. — AC 9
- `gui/public/js/views/error-log.test.mjs` — **New file.** Create following the same JSDOM harness pattern as the other `.test.mjs` files in this directory (e.g. `repositories.test.mjs`). Add test: severity filter dropdown includes "Audit" and "Info" options. — AC 3

## Documentation Updates

- `docs/agents/project-manifest/rest-api.md` — Update `ErrorSeverity` docs, remove `Severity: 'warning'` workaround note, update severity filter docs.
- `docs/agents/project-manifest/constraints.md` — Update `ErrorSeverity` type, remove "consumers must trim" note.
- `docs/agents/project-manifest/api-surface.md` — Update `ErrorSeverity` type, update `checkWorkspaceHealth()` docs.
- `docs/agents/project-manifest/gui-frontend.md` — Document new severity options, CSS classes, "Configure" button.
- `docs/agents/project-manifest/data-flows.md` — Document credential success log entry flow.
- `src/config/README.md` — Note parse-time trimming.
- `src/server/README.md` — Update audit severity from `'warning'` to `'audit'`.
- `.context/` — Re-run `ctx generate` after all code changes.

## Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| **Existing tests assert `Severity: 'warning'` for audit entries** | Step 5 explicitly updates all affected assertions before tests run. Search for `credential-audit` + `warning` to catch any missed callsites. |
| **`'info'` entries inflate the error log** | Credential success entries are written at the same frequency as clone operations (once per repo per setup). The existing FIFO eviction at 500 entries (configurable) handles volume. |
| **Stale badge suppression has an edge case: success entry followed by credential removal** | The health check uses the *most recent* entry. If a credential is removed after a successful clone, the next setup attempt will write a new `Severity: 'error'` entry, re-surfacing the badge. This is correct behaviour. |
| **`parseGitCredentials()` trimming changes persisted data semantics** | Trimming at parse time only affects the in-memory representation. The `config.json` file content is unchanged. The PUT route already trims on write, so round-tripping is idempotent. |
| **CSS design tokens alias existing variables** | Aliases, not renames. No existing class loses its token reference. |
