# Plan

## Summary

Address all actionable items from the strategic recommendations and follow-up list in the `2026-04-11-error-log` synthesis report. This plan covers seven concrete improvements spanning backend resilience, code quality, GUI feature wiring, configuration flexibility, and documentation hygiene. Items confirmed as non-issues during codebase verification (recommendation #2 constructor pattern, recommendation #7 source union type, import-type consistency) are excluded.

## Architectural Context

### Error Log Module (New — Delivered in Prior Plan)

The `src/error-log/` module provides `ErrorLogManager` with `append()`, `list()`, `getById()`, `clear()` backed by `{storageFolder}/error-log.json`. The manager is injected into `WorkspaceOrchestrator`, `RepositoryOrchestrator`, `BranchOrchestrator`, `PollingManager`, and `Router` via optional constructor parameters. The GUI exposes an error-log view at `#/error-log` with filtering, expandable details, and a "Clear All" button.

### Key Files

| File | Relevance |
|------|-----------|
| `src/error-log/error-log.manager.ts` | `append()` — needs try/catch + stderr fallback |
| `src/error-log/error-log.types.ts` | `MAX_ERROR_LOG_ENTRIES` constant — to be made configurable |
| `src/storage/json-storage.ts` | `initializeStorage()` — 3 identical seed patterns to extract |
| `src/config/config.types.ts` | `AppConfig` type — new optional field for max error log entries |
| `src/server/router.ts` | `append()` call site in catch block — unwrapped |
| `src/orchestration/workspace-orchestrator.ts` | `append()` call site — unwrapped |
| `src/orchestration/repository-orchestrator.ts` | `append()` call site — unwrapped |
| `src/orchestration/branch-orchestrator.ts` | Two `append()` call sites — unwrapped |
| `src/server/pollingManager.ts` | `append()` call site — unwrapped |
| `src/git/git-status.ts` | `fetchAndGetStatus()` — `.catch(() => undefined)` swallows failures |
| `gui/public/index.html` | Nav link — needs badge span for error count |
| `gui/public/js/app.js` | App bootstrap — needs badge polling loop |
| `gui/public/js/views/error-log.js` | `relativeTime()` — extract to shared util |
| `gui/public/js/components/status-badge.js` | `formatLastActivity()` — parallel relative-time function |
| `gui/public/css/styles.css` | CSS aliases — `.error-detail-row` / `.error-log-detail-row` |
| `context.yaml` | CTX import pattern — missing `gui/module-context.yaml` |
| `config.dist.json` | Distribution config — new field |

## Approach / Architecture

The work is organized into seven independent improvement areas that can be sequenced for minimal interdependence:

1. **Resilient `append()`** — Wrap the `ErrorLogManager.append()` method body in a try/catch that writes a one-line diagnostic to `process.stderr` on failure. This makes all six existing call sites safe without modifying them — the protection is centralized in the manager, not scattered across callers.

2. **Configurable retention limit** — Replace the `MAX_ERROR_LOG_ENTRIES` constant with a field on `AppConfig` (`maxErrorLogEntries`), defaulting to `500`. The `ErrorLogManager` constructor reads this from config instead of the constant. Add the field to `config.dist.json`.

3. **`seedJsonFile()` helper** — Extract the repeated `if (!fs.existsSync()) { writeJsonFile() }` pattern in `initializeStorage()` into a private `seedJsonFile<T>()` helper within `json-storage.ts`.

4. **Shared GUI time utility** — Create `gui/public/js/utils/time.js` exporting both `relativeTime()` (from `error-log.js`) and `formatLastActivity()` (from `status-badge.js`). Update both consumers to import from the shared module.

5. **CSS class cleanup** — Remove the old `.error-detail-row` / `.error-detail-content` aliases from `styles.css`. The JavaScript only emits the `error-log-detail-row` / `error-log-detail-pre` classes. The aliases were defensive during initial delivery but are now dead code.

6. **Error log nav badge** — Add a `<span class="nav-badge">` to the Error Log nav link in `index.html`. Wire a polling loop in `app.js` (or a new `gui/public/js/components/nav-badge.js` component) that calls `api.errorLog.count()` on an interval and updates the badge visibility/count. The `.nav-badge` CSS rules already exist.


### Items Investigated and Excluded

| Recommendation | Reason Excluded |
|------|-----------|
| **#2: Constructor options-bag refactor** | Confirmed clean — only one `undefined` placeholder exists (`PollingManager.fetchStatusFn`, which is intentional for test injection). The current pattern is idiomatic and not worth the churn. |
| **#7: Source union type** | Confirmed correct — open-ended `string` is the right design for an extensible logging system. A union would create unnecessary coupling. |
| **Follow-up: `import type` consistency** | Confirmed consistent — all `import type` statements are top-level and separate. No action needed. |
| **Follow-up: Storage layer error logging** | Injecting `ErrorLogManager` into `readJsonFile`/`writeJsonFile` would create a circular dependency (the manager itself uses these functions). Requires a design rethink (event emitter, callback, or deferred injection) that is out of scope for this rework. |
| **Follow-up: `git-status.ts` fetch error logging** | The `.catch(() => undefined)` in `fetchAndGetStatus()` is intentional by design and documented: status queries must always return results regardless of fetch failures. Logging here would duplicate what `PollingManager` already logs. |
| **#6: CTX `gui/` import** | The `gui/module-context.yaml` is already included via a global module-context import pattern that matches all subfolders. The apparent gap was caused by stale generated docs; running `ctx generate` resolves it. |

## Rationale

- **Centralizing `append()` resilience in the manager** rather than at each call site is preferred because it protects current and future callers with a single change, follows the principle of least surprise (a logging call should never crash the caller), and avoids scattering identical try/catch blocks across six files.
- **Making retention configurable** costs almost nothing and avoids the need for code changes when operators manage disk usage.
- **Extracting `seedJsonFile()`** follows the DRY principle for a pattern that was already repeated three times and will grow if more storage files are added.
- **Shared time utility** prevents two near-identical functions from diverging over time and establishes a `gui/public/js/utils/` convention for future utility extraction.
- **Removing CSS aliases** reduces confusion for future maintainers who would see two class-name systems for the same elements.
- **Nav badge** was explicitly called out as the top next-step by the synthesis and all infrastructure (API method, CSS rules) already exists.
- **CTX import fix** is a one-line change that closes a documentation gap.

## Detailed Steps

### Step 1 — Resilient `append()` with `process.stderr` Fallback

1. In `src/error-log/error-log.manager.ts`, wrap the body of the `append()` method in a `try { ... } catch (err) { process.stderr.write(...) }` block.
2. The stderr message should include a timestamp, the original error message, and a note that the error-log write failed.
3. The method should return normally after writing to stderr (do not re-throw).
4. Add unit tests in `src/tests/error-log.manager.test.ts`:
   - Mock `writeJsonFile` to throw; verify `append()` does not throw.
   - Verify `process.stderr.write` is called with an appropriate message.

### Step 2 — Configurable `MAX_ERROR_LOG_ENTRIES`

1. Add an optional field `maxErrorLogEntries?: number` to the `AppConfig` interface in `src/config/config.types.ts`.
2. Add `"maxErrorLogEntries": 500` to `config.dist.json`.
3. In `src/error-log/error-log.manager.ts`, read `this.config.maxErrorLogEntries ?? 500` instead of importing `MAX_ERROR_LOG_ENTRIES`.
4. Keep the `MAX_ERROR_LOG_ENTRIES` constant in `error-log.types.ts` as the default value (rename to `DEFAULT_MAX_ERROR_LOG_ENTRIES` for clarity), but it may also simply remain for backward-compatible reference.
5. Add a unit test: instantiate `ErrorLogManager` with `maxErrorLogEntries: 5`, append 7 entries, verify only 5 remain.

### Step 3 — Extract `seedJsonFile()` Helper

1. In `src/storage/json-storage.ts`, add a private function:
   ```typescript
   function seedJsonFile<T>(filePath: string, defaultData: T): void {
       if (!fs.existsSync(filePath)) {
           writeJsonFile<T>(filePath, defaultData);
       }
   }
   ```
2. Refactor `initializeStorage()` to call `seedJsonFile()` three times instead of repeating the pattern inline.
3. Verify existing tests in `src/tests/storage-init.test.ts` still pass.

### Step 4 — Shared GUI Time Utility

1. Create `gui/public/js/utils/time.js` containing:
   - `relativeTime(isoString)` — moved from `gui/public/js/views/error-log.js`.
   - `formatLastActivity(isoTimestamp)` — moved from `gui/public/js/components/status-badge.js`.
2. Update `gui/public/js/views/error-log.js` to import `relativeTime` from `../utils/time.js`.
3. Update `gui/public/js/components/status-badge.js` to import `formatLastActivity` from `../utils/time.js`.
4. Verify the GUI functions correctly (manual or existing test coverage).

### Step 5 — Remove CSS Class Aliases

1. In `gui/public/css/styles.css`, remove the comma-separated `.error-detail-row` and `.error-detail-content` selectors (keep only `.error-log-detail-row` and `.error-log-detail-pre`).
2. Search the entire codebase for any remaining references to `error-detail-row` or `error-detail-content` to confirm no other consumer exists.
3. Remove any CSS comments referencing the aliasing.

### Step 6 — Error Log Nav Badge

1. In `gui/public/index.html`, update the Error Log nav link to include a badge span:
   ```html
   <a href="#/error-log" class="nav-link">
       Error Log <span id="error-log-badge" class="nav-badge" hidden></span>
   </a>
   ```
2. Create `gui/public/js/components/nav-badge.js` (or add to `app.js`) with:
   - A function that calls `api.errorLog.count()`, and if `count > 0`, removes the `hidden` attribute and sets `textContent = count`. If `count === 0`, sets `hidden`.
   - An `initNavBadge()` function that calls the above immediately and then on a reasonable interval (e.g., 30 seconds).
   - A `destroyNavBadge()` function that clears the interval (for cleanup).
3. Call `initNavBadge()` during app startup in `gui/public/js/app.js`.
4. Call `destroyNavBadge()` during app teardown if applicable.
5. Ensure the counter resets (re-fetches) when the user clicks "Clear All" in the error-log view.

## Dependencies

- Step 2 depends on Step 1 being designed first (both touch `error-log.manager.ts` and the config relationship).
- Steps 3–6 are fully independent of each other and of Steps 1–2.
- Step 6 depends on `api.errorLog.count()` already existing (confirmed present).

## Required Components

### Existing Files (Modified)

- `src/error-log/error-log.manager.ts`
- `src/error-log/error-log.types.ts`
- `src/config/config.types.ts`
- `src/storage/json-storage.ts`
- `src/server/index.ts` (if config wiring needed)
- `gui/public/index.html`
- `gui/public/js/app.js`
- `gui/public/js/views/error-log.js`
- `gui/public/js/components/status-badge.js`
- `gui/public/css/styles.css`
- `config.dist.json`
- `src/tests/error-log.manager.test.ts`

### New Files

- `gui/public/js/utils/time.js` — shared time-formatting utility
- `gui/public/js/components/nav-badge.js` — nav badge polling component

## Assumptions

- The `api.errorLog.count()` method returns `{ count: number }` and is functional.
- The `.nav-badge` CSS rules in `styles.css` are complete and ready for use.
- The GUI uses vanilla JS module imports (`import` / `export`) without a build step.
- The `ctx` CLI tool is available in the development environment.

## Constraints

- All relative imports in `src/` must use `.js` extensions (Node16 ESM).
- GUI files use vanilla JS — no build step, no framework.
- Storage JSON uses PascalCase keys.
- `ErrorLogManager.append()` must remain synchronous from the caller's perspective (no API change).
- The `seedJsonFile()` helper should remain module-private (not exported).

## Out of Scope

- Storage layer error logging (`source='storage'`) — circular dependency concern requires separate design.
- `fetchAndGetStatus()` error logging — intentional design, already covered by `PollingManager`.
- Constructor options-bag refactor — current pattern is clean and idiomatic.
- Source union type — open `string` is the correct design.
- `import type` consistency — already consistent.
- Authentication/authorization for `DELETE /api/error-log` — only relevant if deployment scope expands beyond localhost.
- Combined severity+source filter in the GUI filter bar.

## Acceptance Criteria

1. `ErrorLogManager.append()` never throws; disk/I/O failures produce a `process.stderr` message instead of propagating exceptions.
2. `maxErrorLogEntries` is configurable via `config.json` with a default of `500`.
3. `initializeStorage()` uses a `seedJsonFile()` helper for all three seed files; no behavioral change.
4. `relativeTime()` and `formatLastActivity()` live in `gui/public/js/utils/time.js` and are imported by their respective consumers; no behavioral change.
5. `styles.css` contains only the `error-log-detail-row` / `error-log-detail-pre` class names (no aliases).
6. The Error Log nav link displays a badge with the current error count; the badge is hidden when count is 0; the count updates periodically and on "Clear All".
7. All existing tests pass. New tests cover the `append()` resilience and configurable retention.
8. TypeScript compiles with zero errors.

## Testing Strategy

| Step | Testing Approach |
|------|-----------|
| **Step 1** | Unit test: mock `writeJsonFile` to throw, verify `append()` returns normally and `process.stderr.write` is called. |
| **Step 2** | Unit test: create `ErrorLogManager` with custom `maxErrorLogEntries`, fill beyond limit, verify eviction. |
| **Step 3** | Existing `storage-init.test.ts` tests validate seeding behavior is unchanged. |
| **Step 4** | Verify existing view tests pass. Manual smoke test of timestamp rendering in both views. |
| **Step 5** | Visual inspection; grep confirms no remaining references to old class names. |
| **Step 6** | Manual test: create errors via API, verify badge appears; clear all, verify badge hides. Verify badge updates on interval. |


## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **`append()` try/catch masks bugs during development** | The stderr fallback includes the full error message and stack, making failures observable in server logs even when they don't crash the process. |
| **Config field added but not validated** | Use the existing config validation pattern. `maxErrorLogEntries` defaults to `500` if missing or invalid (non-positive number). |
| **GUI utility extraction breaks module loading** | The GUI uses standard ES module `import`/`export` — verify script tag `type="module"` is in place; test in browser. |
| **Nav badge polling adds network overhead** | Use a 30-second interval (matching the existing git polling cadence) and a lightweight `HEAD`-style count endpoint. The `count()` method reads a single JSON file. |
| **CSS alias removal breaks unknown consumers** | Full-codebase grep for old class names confirms no other consumer exists before removal. |

> **Note:** CTX `gui/` import (synthesis recommendation #6) was investigated and found to be a non-issue — the `gui/module-context.yaml` is already covered by the existing import configuration. Running `ctx generate` resolves any stale documentation.
