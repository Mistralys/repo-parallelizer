# Plan

## Summary

Address six actionable items surfaced by the synthesis of the `2026-04-13-configurable-refresh-delay` plan. The items span a medium-priority security fix (unbounded polling interval), a missing feature (workspace-detail dynamic interval), a DX refactor (named-options signature), a constant-extraction task, a CSS layout rule, and a new test file. Each item has been verified against the current codebase.

## Architectural Context

### Polling Configuration Stack

The polling interval flows through these layers:

| Layer | File | Current State |
|-------|------|---------------|
| Config defaults | `src/config/config.ts` | `DEFAULTS.gitPollingIntervalSeconds = 30` |
| Server-side validation | `src/server/routes/config.ts` | `MIN_POLLING_INTERVAL_SECONDS = 10` (module-local constant); no upper bound |
| Backend wiring | `src/server/index.ts` | `registerConfigRoutes(router, config.appConfig, undefined, pollingManager)` — positional `undefined` gap |
| Frontend API client | `gui/public/js/api.js` | `api.config.polling.get()` / `.set(seconds)` |
| Settings UI | `gui/public/js/views/settings.js` | `input.min = '10'`; hardcoded `value < 10` guard; no max |
| Workspace-detail view | `gui/public/js/views/workspace-detail.js` | `POLL_INTERVAL_MS = 10_000` hardcoded; does **not** consult `GET /api/config/polling` |

### CSS

`gui/public/css/styles.css` contains no `.refresh-delay-input-row` rule. The input row relies on default block layout.

### Test Coverage

`gui/public/js/api.errorLog.test.mjs` exists as a pattern reference for client-side unit tests. No corresponding `api.config.polling` test file exists.

## Approach / Architecture

Six independent changes, grouped by priority:

1. **Security fix** — Add `MAX_POLLING_INTERVAL_SECONDS = 86400` to the `PUT /api/config/polling` handler and mirror it in the frontend input.
2. **Feature delivery** — Make `workspace-detail.js` fetch `GET /api/config/polling` on render and use the returned value instead of the hardcoded `POLL_INTERVAL_MS` constant (keep constant as fallback).
3. **DX refactor** — Migrate `registerConfigRoutes` from positional to named-options signature.
4. **Constant extraction** — Move `MIN_POLLING_INTERVAL_SECONDS` (and the new max) to a shared location importable by both server routes and tests.
5. **CSS polish** — Add `.refresh-delay-input-row` flex layout rule.
6. **Test gap** — Create `gui/public/js/api.config.test.mjs` mirroring the `api.errorLog.test.mjs` pattern.

## Rationale

- The upper-bound fix closes a medium-severity security finding where `Number.MAX_SAFE_INTEGER` effectively disables polling.
- The workspace-detail dynamic interval was originally planned in the parent plan but dropped during implementation — this completes the feature.
- The named-options refactor was flagged by three independent pipeline agents (Developer, QA, Reviewer) as a DX hazard; addressing it now prevents the positional `undefined` gap from growing.
- Extracting constants to a shared location eliminates the duplicate `10` literal in the client-side guard and ensures a single source of truth.
- CSS and test items are low-effort polish that round out the feature delivery.

## Detailed Steps

### Step 1 — Add Upper Bound to Polling Interval (Security)

1. In `src/server/routes/config.ts`, add a `MAX_POLLING_INTERVAL_SECONDS = 86400` constant next to the existing `MIN_POLLING_INTERVAL_SECONDS`.
2. In the `PUT /api/config/polling` handler, after the `< MIN_POLLING_INTERVAL_SECONDS` guard, add a `> MAX_POLLING_INTERVAL_SECONDS` guard that returns 400 with `Field "seconds" must be at most 86400 (24 hours). Received: ${seconds}.`.
3. In `gui/public/js/views/settings.js`, set `input.max = '86400'` alongside the existing `input.min = '10'` and add a corresponding client-side guard that shows an inline error for values exceeding 86400.
4. Add test cases in `src/server/__tests__/routes/config.test.ts`:
   - `seconds = 86400` → 200 (boundary ok).
   - `seconds = 86401` → 400 with descriptive error.

### Step 2 — Workspace-Detail Dynamic Interval Fetch

1. In `gui/public/js/views/workspace-detail.js`, rename the existing `POLL_INTERVAL_MS` constant to `DEFAULT_POLL_INTERVAL_MS` (value stays `10_000`).
2. At the top of the main exported render function (before polling starts), call `api.config.polling.get()`.
3. On success, compute `pollIntervalMs = response.gitPollingIntervalSeconds * 1000`. On failure (network error, unexpected shape), fall back to `DEFAULT_POLL_INTERVAL_MS`.
4. Pass `pollIntervalMs` to all downstream references that currently use `POLL_INTERVAL_MS` — the `setInterval` call and the five `remainingSeconds` / `totalSeconds` calculations.
5. Ensure `api.js` is already imported in the workspace-detail module (it should be — verify and add import if missing).

### Step 3 — Migrate `registerConfigRoutes` to Named-Options Signature

1. In `src/server/routes/config.ts`, define a new interface:
   ```ts
   export interface ConfigRoutesOptions {
       router: Router;
       appConfig: AppConfig;
       configPath?: string;
       pollingManager?: PollingManager;
   }
   ```
2. Change the `registerConfigRoutes` function signature to accept a single `options: ConfigRoutesOptions` parameter. Destructure the four fields inside the function body.
3. Update the call site in `src/server/index.ts` (line 138) to pass a named-options object:
   ```ts
   registerConfigRoutes({ router, appConfig: config.appConfig, pollingManager });
   ```
   Note: `configPath` is omitted (uses default), eliminating the `undefined` gap.
4. Update all three call sites in `src/server/__tests__/routes/config.test.ts`:
   - Line 114: `registerConfigRoutes({ router, appConfig, configPath })`
   - Line 137: `registerConfigRoutes({ router, appConfig, configPath, pollingManager })`
   - Line 743: `registerConfigRoutes({ router, appConfig, configPath })`

### Step 4 — Extract Polling Constants to Shared Module

1. Create a new file `src/config/config.constants.ts` with:
   ```ts
   /** Minimum allowed polling interval in seconds. */
   export const MIN_POLLING_INTERVAL_SECONDS = 10;
   /** Maximum allowed polling interval in seconds (24 hours). */
   export const MAX_POLLING_INTERVAL_SECONDS = 86_400;
   ```
2. In `src/server/routes/config.ts`, replace the module-level constant with an import from `../../config/config.constants.js`.
3. Update the `input.min` value in `gui/public/js/views/settings.js` comment to reference the shared constant as authoritative source (the frontend cannot import TS — document the link).

### Step 5 — Add CSS Layout Rule for Refresh Delay Input Row

1. In `gui/public/css/styles.css`, add at the end of the settings section (or at the end of the file):
   ```css
   .refresh-delay-input-row {
       display: flex;
       align-items: center;
       gap: 0.5rem;
   }
   ```

### Step 6 — Add `api.config.polling` Unit Test File

1. Create `gui/public/js/api.config.test.mjs` mirroring the structure of `gui/public/js/api.errorLog.test.mjs`:
   - Set up the same `globalThis.fetch` mock infrastructure.
   - Dynamic-import `api.js` to obtain the `api` namespace.
   - Test `api.config.polling.get()`:
     - 200 response → returns `{ gitPollingIntervalSeconds: N }`.
     - Non-ok response → throws with error message.
   - Test `api.config.polling.set(seconds)`:
     - 200 response → sends `PUT` with `{ seconds }` body; returns updated config.
     - Non-ok response → throws with error message.

## Dependencies

- Steps 1 and 4 are related: Step 4 extracts the constants that Step 1 introduces. Implement Step 1 first (add the max constant locally), then Step 4 extracts both constants.
- Step 3 is independent but touches the same file as Steps 1 and 4 (`src/server/routes/config.ts`). Sequence: Step 1 → Step 4 → Step 3.
- Steps 2, 5, and 6 are fully independent of each other and of Steps 1/3/4.

## Required Components

### Modified files

| File | Steps |
|------|-------|
| `src/server/routes/config.ts` | 1, 3, 4 |
| `src/server/index.ts` | 3 |
| `src/server/__tests__/routes/config.test.ts` | 1, 3 |
| `gui/public/js/views/settings.js` | 1 |
| `gui/public/js/views/workspace-detail.js` | 2 |
| `gui/public/css/styles.css` | 5 |

### New files

| File | Step |
|------|------|
| `src/config/config.constants.ts` | 4 |
| `gui/public/js/api.config.test.mjs` | 6 |

## Assumptions

- The `api` namespace is already importable in `workspace-detail.js` (verified: `api.js` is the central API module used by all views).
- The `gui/public/js/api.errorLog.test.mjs` pattern (Node built-in test runner + `globalThis.fetch` mock) is the established convention for frontend unit tests.
- A 24-hour (86400 seconds) upper bound is a reasonable maximum for the polling interval.

## Constraints

- Node16 ESM: all new relative imports must use `.js` extensions.
- The frontend is vanilla JS with no build step — no TS imports are possible from the GUI layer. The shared constants file is only for the backend; the frontend must hardcode matching values with a comment referencing the source of truth.
- Existing test count (697) must not decrease; all new tests must pass.

## Out of Scope

- **Process recommendation #4** (split multi-change-set WPs) — this is a workflow convention, not a code change.
- **`nav-badge.js` polling interval** (`POLL_INTERVAL_MS = 30_000`) — the synthesis explicitly marks this as a different concern (error-log badge polling, not git polling).
- Regeneration of `.context/` files — the PM/Engineer pipeline handles this automatically.

## Acceptance Criteria

1. `PUT /api/config/polling` with `seconds = 86401` returns 400 with a descriptive error message.
2. `PUT /api/config/polling` with `seconds = 86400` returns 200.
3. The settings UI prevents submission of values above 86400 with an inline error.
4. `workspace-detail.js` fetches the configured polling interval from `GET /api/config/polling` on render and uses it for the `setInterval` and countdown calculations.
5. If `GET /api/config/polling` fails, `workspace-detail.js` falls back to a `DEFAULT_POLL_INTERVAL_MS` of `10_000`.
6. `registerConfigRoutes` accepts a single named-options object; no positional `undefined` gaps exist in any call site.
7. `MIN_POLLING_INTERVAL_SECONDS` and `MAX_POLLING_INTERVAL_SECONDS` are exported from `src/config/config.constants.ts` and imported in `src/server/routes/config.ts`.
8. `.refresh-delay-input-row` has an explicit flex layout rule in `styles.css`.
9. `gui/public/js/api.config.test.mjs` exists with tests for `get()` and `set()`, all passing.
10. All 697+ tests pass; `tsc` reports zero errors.

## Testing Strategy

- **Unit tests (backend):** Extend `src/server/__tests__/routes/config.test.ts` with boundary tests for the new upper-bound guard (86400 ok, 86401 rejected).
- **Unit tests (frontend API):** New `gui/public/js/api.config.test.mjs` file covers `api.config.polling.get()` and `.set()`.
- **Integration (manual):** Open Settings → Refresh Delay, enter 86401, observe inline error. Enter 30, save, navigate to a workspace detail view, verify countdown uses the configured value.
- **Regression:** Full test suite (`npm test`) must pass with all existing + new tests.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Named-options refactor breaks test call sites** | The three test call sites are explicitly listed; the change is mechanical. `tsc --noEmit` catches any missed callers. |
| **Workspace-detail API call adds latency to view render** | The fetch is non-blocking; polling starts with the fallback constant immediately and adjusts once the response arrives. Alternatively, fire the fetch early and await before first interval setup. |
| **Frontend max value drifts from backend constant** | A code comment in `settings.js` and `workspace-detail.js` references `src/config/config.constants.ts` as the source of truth. |
| **New `config.constants.ts` file needs manifest updates** | The PM pipeline regenerates `api-surface.md` and runs `ctx generate` as standard procedure. |
