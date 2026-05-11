# Plan

## Summary

Address all actionable items identified in the `2026-05-07-notes-view-display-settings` synthesis report. This is a test infrastructure and code quality refactoring plan that eliminates duplicated fixtures and mock helpers across the test suite, tightens validation in `loadConfig()`, extracts shared validation helpers in the route layer, normalises the Settings view composition pattern, and decouples `setup.ts` from manual `AppConfig` field enumeration.

## Architectural Context

The codebase follows a layered architecture (Storage → Models → Git → Orchestration → Server → CLI) with a vanilla JS SPA frontend. Key areas affected by this plan:

- **Test infrastructure** — `src/tests/test-helpers.ts` already exports `createTempDirTracker()` and `setupFakeGit()`. Nine test files in `src/tests/` each define their own `makeConfig()`/`makeTestConfig()` factory that builds a full `AppConfig` literal. Two server test files (`src/server/__tests__/routes/config.test.ts` and `src/server/__tests__/config.notes-display.test.ts`) duplicate `mockRequest()`, `mockResponse()`, `MockResponse`, and temp-dir teardown verbatim. Two additional server test files (`pollingManager.test.ts`, `pollingManager.errorLog.test.ts`) define inline `BASE_CONFIG` objects.
- **Config layer** — `src/config/config.ts` defines a `DEFAULTS` object typed as `Pick<AppConfig, ...>` with manually enumerated fields. `loadConfig()` uses `typeof === 'number'` guards without `Number.isInteger()` or bounds clamping.
- **Route layer** — `src/server/routes/config.ts` repeats the `typeof !== 'number'` / `!Number.isFinite()` / `!Number.isInteger()` validation sequence three times (polling interval, notesCardHeight, notesColumns).
- **CLI** — `src/cli/setup.ts` manually constructs `AppConfig` at lines 218–225 using individual constants, not leveraging `loadConfig()` or the `DEFAULTS` object.
- **Frontend** — `gui/public/js/views/settings.js` builds three sections via `build*Section()` factories but constructs the credentials section inline in `renderSettings()`.

## Approach / Architecture

Group changes into logical areas to minimise risk and maximise reviewability:

1. **Shared test config factory** — Add `makeTestConfig()` to the existing `src/tests/test-helpers.ts`, backed by `DEFAULTS` from `src/config/config.constants.ts`. Update all 9 test files to import it. This eliminates the N-file update cost when `AppConfig` gains new fields.
2. **Shared mock HTTP helpers** — Create `src/server/__tests__/helpers/mock-http.ts` exporting `mockRequest()`, `mockResponse()`, and the `MockResponse` interface. Update the 2 consuming test files.
3. **`loadConfig()` hardening** — Add `Number.isInteger()` guards and `console.warn` for out-of-range values (no clamping — preserve current behaviour). Apply to `notesCardHeight`, `notesColumns`, and for consistency to `cloneDepth`, `serverPort`, and `gitPollingIntervalSeconds`.
4. **Route validation helper** — Extract `isValidFiniteInteger()` in `src/server/routes/config.ts` (file-local) and replace the three duplicated validation sequences.
5. **Settings view consistency** — Extract `buildCredentialsSection()` in `gui/public/js/views/settings.js` to match the `build*Section()` pattern.
6. **`setup.ts` DEFAULTS coupling** — Import the `DEFAULTS` object (or individual constants) and spread it into the config construction to remove manual field enumeration.

## Rationale

- The `makeTestConfig()` factory is the highest-impact change: every future `AppConfig` field addition drops from 9+ file edits to 1.
- Mock HTTP extraction is self-contained and removes a TODO already documented in the codebase.
- `loadConfig()` integer guards align the config parsing layer with the stricter validation already enforced by the REST API, closing a consistency gap where `config.json` could contain float or out-of-range values silently.
- The route validation helper reduces boilerplate but is kept file-local to avoid premature abstraction.
- The settings view extraction is cosmetic but makes the composition pattern uniform, easing future section additions.

## Detailed Steps

### Step 1 — Shared test config factory (`makeTestConfig`)

1. In `src/tests/test-helpers.ts`, add a new exported function:
   ```typescript
   export function makeTestConfig(base: string, overrides?: Partial<AppConfig>): AppConfig
   ```
   It returns a fully-populated `AppConfig` using `DEFAULT_*` constants from `src/config/config.constants.ts` and the well-known test defaults (`cloneDepth: 50`, `serverPort: 4200`, `gitPollingIntervalSeconds: 30`). The `storageFolder` and `projectsFolder` are derived from `base`. The `overrides` parameter allows individual tests to customise specific fields.

2. Update all 9 test files in `src/tests/` that define local `makeConfig()`/`makeTestConfig()`:
   - `storage-init.test.ts`
   - `project.manager.test.ts`
   - `repository.manager.test.ts`
   - `workspace.manager.test.ts`
   - `error-log.manager.test.ts`
   - `branch-orchestrator.test.ts`
   - `project-orchestrator.test.ts`
   - `repository-orchestrator.test.ts`
   - `workspace-orchestrator.test.ts`

   In each file: remove the local factory function, add an import of `makeTestConfig` from `./test-helpers.js`, and update all call sites. Some files call `makeConfig(base)` while others call `makeTestConfig(base)` — both become `makeTestConfig(base)`.

3. Update the 2 server test files that define inline `BASE_CONFIG` objects:
   - `src/server/__tests__/pollingManager.test.ts`
   - `src/server/__tests__/pollingManager.errorLog.test.ts`

   Replace `BASE_CONFIG` with an import from `../../tests/test-helpers.js`.

4. Run `npm test` to verify zero regressions.

### Step 2 — Shared mock HTTP helpers

1. Create `src/server/__tests__/helpers/mock-http.ts` exporting:
   - `mockRequest(method, url, bodyJson?): IncomingMessage`
   - `mockResponse(): MockResponse`
   - `MockResponse` interface

   Copy the existing implementation from either test file (they are identical).

2. Update `src/server/__tests__/routes/config.test.ts`: remove local `mockRequest`, `mockResponse`, `MockResponse`; import from `../helpers/mock-http.js`.

3. Update `src/server/__tests__/config.notes-display.test.ts`: remove local `mockRequest`, `mockResponse`, `MockResponse`; import from `./helpers/mock-http.js`. Remove the TODO comment.

4. Run `npm test` to verify zero regressions.

### Step 3 — `loadConfig()` integer guards and bounds warnings

1. In `src/config/config.ts`, import `MIN_*` and `MAX_*` constants for all numeric fields from `config.constants.ts`.

2. For each numeric field in the return object (`cloneDepth`, `serverPort`, `gitPollingIntervalSeconds`, `notesCardHeight`, `notesColumns`), tighten the guard from:
   ```typescript
   typeof raw['field'] === 'number' ? raw['field'] : DEFAULTS.field
   ```
   to:
   ```typescript
   typeof raw['field'] === 'number' && Number.isInteger(raw['field'] as number)
       ? raw['field'] as number
       : DEFAULTS.field
   ```

3. After the return object is constructed (assign to a variable before returning), add a validation block that emits `console.warn()` for any numeric field outside its `[MIN, MAX]` bounds. Do not clamp — only warn. Example:
   ```
   Warning: config.json "notesCardHeight" value 1500 is outside allowed range [120, 800]. The API layer will reject updates to this value.
   ```

4. Update `src/tests/config.test.ts` to add test cases for:
   - Float values falling back to defaults (e.g., `notesCardHeight: 220.5` → default)
   - Out-of-range values producing a console.warn (spy on `console.warn`)

5. Run `npm test` to verify.

### Step 4 — Route validation helper (`isValidFiniteInteger`)

1. In `src/server/routes/config.ts`, add a file-local helper:
   ```typescript
   function isValidFiniteInteger(value: unknown): value is number {
       return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
   }
   ```

2. Replace the three duplicated validation sequences (polling interval at ~line 250, notesCardHeight at ~line 398, notesColumns at ~line 415) to use `isValidFiniteInteger()`. Each existing pair of checks (`typeof !== 'number'` + `!Number.isFinite() || !Number.isInteger()`) collapses to a single `if (!isValidFiniteInteger(value))` with the appropriate error message.

3. Run `npm test` to verify all existing route tests still pass.

### Step 5 — Settings view: extract `buildCredentialsSection()`

1. In `gui/public/js/views/settings.js`, extract the inline credentials section construction from `renderSettings()` into a new function:
   ```javascript
   function buildCredentialsSection() { ... }
   ```
   It should return `{ element }` (matching the pattern of other `build*Section()` factories). The returned element includes the heading, description, table container, and add-credential form. The initial `renderCredentialsTable()` call should be invoked inside the factory.

2. Update `renderSettings()` to call `buildCredentialsSection()` and append `result.element`, matching the pattern used for `buildRefreshDelaySection()`, `buildWebserverUrlSection()`, and `buildNotesDisplaySection()`.

3. Run `npm run test:gui` to verify.

### Step 6 — `setup.ts`: derive config from DEFAULTS

1. In `src/cli/setup.ts`, import the `DEFAULTS` object (or the relevant constants it uses) from `../config/config.ts` or `../config/config.constants.ts`.

2. Replace the manual config construction at lines 218–225:
   ```typescript
   const config: AppConfig = {
       projectsFolder,
       storageFolder,
       cloneDepth,
       serverPort,
       gitPollingIntervalSeconds,
       notesCardHeight: DEFAULT_NOTES_CARD_HEIGHT,
       notesColumns: DEFAULT_NOTES_COLUMNS,
   };
   ```
   with a spread from DEFAULTS for the non-prompted fields:
   ```typescript
   const config: AppConfig = {
       projectsFolder,
       storageFolder,
       cloneDepth,
       serverPort,
       gitPollingIntervalSeconds,
       ...DEFAULTS_FOR_UNPROMPTED_FIELDS,
   };
   ```
   Where `DEFAULTS_FOR_UNPROMPTED_FIELDS` is a `Pick` of the DEFAULTS covering only fields not prompted interactively (currently: `notesCardHeight`, `notesColumns`). Alternatively, simply spread the full `DEFAULTS` object first and then override with the prompted values, since prompted values always take precedence.

3. Run `npm test` and verify `setup.test.ts` still passes.

## Dependencies

- Step 1 has no dependencies and should be done first (it is the highest-impact change).
- Steps 2–6 are independent of each other and can be parallelised.
- Step 3 depends on Step 1 being complete (test files will import from `test-helpers.ts`).
- Step 6 may need a minor export from `src/config/config.ts` if `DEFAULTS` is not already exported.

## Required Components

### Modified files
- `src/tests/test-helpers.ts` (Step 1 — extend with `makeTestConfig`)
- `src/tests/storage-init.test.ts` (Step 1)
- `src/tests/project.manager.test.ts` (Step 1)
- `src/tests/repository.manager.test.ts` (Step 1)
- `src/tests/workspace.manager.test.ts` (Step 1)
- `src/tests/error-log.manager.test.ts` (Step 1)
- `src/tests/branch-orchestrator.test.ts` (Step 1)
- `src/tests/project-orchestrator.test.ts` (Step 1)
- `src/tests/repository-orchestrator.test.ts` (Step 1)
- `src/tests/workspace-orchestrator.test.ts` (Step 1)
- `src/server/__tests__/pollingManager.test.ts` (Step 1)
- `src/server/__tests__/pollingManager.errorLog.test.ts` (Step 1)
- `src/server/__tests__/routes/config.test.ts` (Step 2)
- `src/server/__tests__/config.notes-display.test.ts` (Step 2)
- `src/config/config.ts` (Step 3)
- `src/tests/config.test.ts` (Step 3)
- `src/server/routes/config.ts` (Step 4)
- `gui/public/js/views/settings.js` (Step 5)
- `src/cli/setup.ts` (Step 6)

### New files
- `src/server/__tests__/helpers/mock-http.ts` (Step 2)

## Assumptions

- The `DEFAULTS` object in `src/config/config.ts` is currently not exported. Step 6 may require exporting it or exporting a subset. If exporting `DEFAULTS` directly would create an unwanted public API surface, individual constants can be imported from `config.constants.ts` instead.
- The `notes-collected.test.mjs` hang issue mentioned in the synthesis is a pre-existing problem and is out of scope for this plan.
- The `DEFAULTS Pick type` concern (synthesis low-priority item) is addressed implicitly by Step 3's tighter guards — if a new field is added to `AppConfig` but omitted from `DEFAULTS`, the `Number.isInteger()` guard will still fall back to the default, which will be `undefined` and trigger a default value. No explicit type change to `DEFAULTS` is proposed; the existing `Pick` pattern is adequate when paired with step 1's `makeTestConfig()` factory which will catch missing fields at compile time.

## Constraints

- All relative imports must use `.js` extensions (Node16 ESM).
- No external dependencies may be added.
- All new test files must follow the `process.on('exit')` cleanup convention.
- `loadConfig()` must not clamp out-of-range values (only warn) — clamping is the API layer's responsibility.
- The `isValidFiniteInteger()` helper must remain file-local in `config.ts` routes — no new module for a single function.

## Out of Scope

- The `notes-collected.test.mjs` sandbox hang (pre-existing issue, not caused by this feature).
- A generic `buildNumberInputRow()` helper for `settings.js` (flagged as a future consideration for 5+ sections; currently only 4 sections exist).
- Browser-based / Playwright end-to-end tests for the notes view.
- Changes to the `DEFAULTS` Pick type pattern — the existing approach is well-considered per the synthesis.
- The cosmetic WP-004 ledger metadata mismatch.

## Acceptance Criteria

- `makeTestConfig()` is exported from `src/tests/test-helpers.ts` and accepts `(base: string, overrides?: Partial<AppConfig>): AppConfig`.
- All 9 test files in `src/tests/` use the shared factory; no local `makeConfig`/`makeTestConfig` definitions remain.
- `BASE_CONFIG` in the 2 polling manager test files uses the shared factory.
- `mockRequest()`, `mockResponse()`, and `MockResponse` are exported from `src/server/__tests__/helpers/mock-http.ts` and imported by both consumer files; no local definitions remain. The TODO comment in `config.notes-display.test.ts` is removed.
- `loadConfig()` rejects float values for all numeric fields (falls back to default).
- `loadConfig()` emits `console.warn` for out-of-range numeric values.
- The PUT handlers in `src/server/routes/config.ts` use a shared `isValidFiniteInteger()` helper; no duplicated validation sequences remain.
- `renderSettings()` in `settings.js` calls `buildCredentialsSection()` instead of constructing the credentials section inline.
- `setup.ts` no longer manually enumerates `notesCardHeight` and `notesColumns` — they are derived from constants or a DEFAULTS spread.
- `npm test` and `npm run test:gui` pass with zero failures.
- TypeScript build (`tsc --noEmit`) exits cleanly.

## Testing Strategy

- **Unit tests** — Existing test suites are the primary validation vehicle. All 834+ backend tests and all GUI tests must continue to pass after each step.
- **New tests** — Step 3 adds new test cases in `config.test.ts` for float rejection and bounds warnings.
- **Integration** — The existing `config.notes-display.test.ts` integration suite covers the full route stack and must remain green after Steps 2 and 4.
- **Build verification** — `tsc --noEmit` after every step.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **`makeTestConfig()` signature mismatches** — some test files may use slightly different default values or require additional fields not in the standard set. | The `overrides` parameter allows per-test customisation. Review each file's factory body before replacing. |
| **`console.warn` in `loadConfig()` produces noise in test output** — tests using out-of-range values will emit warnings. | Tests that intentionally use out-of-range values should spy on and suppress `console.warn`. |
| **`DEFAULTS` export from `config.ts` widens public API** — exporting the DEFAULTS object may be undesirable. | Use individual constants from `config.constants.ts` instead, or export a `Pick` subset limited to unprompted fields. |
| **`buildCredentialsSection()` extraction changes event wiring** — the credentials section has `renderCredentialsTable()` called after DOM attachment. | Ensure the factory returns the element with the table container, and the initial render call happens inside or immediately after the factory, matching current timing. |
