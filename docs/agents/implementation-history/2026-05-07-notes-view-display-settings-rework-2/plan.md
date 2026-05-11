# Plan

## Summary

Complete all actionable items identified in the Rework-1 synthesis: finish the mock-HTTP helper migration across the remaining 12 server test files (unifying the `headers`-capturing variant), add `MIN`/`MAX` bounds constants for `cloneDepth` and `serverPort`, add explicit `notesCardHeight`/`notesColumns` assertions to `setup.test.ts`, simplify the `error-log.manager.test.ts` spread pattern to use the `overrides` parameter, add a compile-time DEFAULTS coverage guard, and standardise the `console.warn` spy pattern to join all arguments.

## Architectural Context

The codebase uses a layered architecture: Storage → Models → Git → Orchestration → Server/CLI. Server-layer tests live under `src/server/__tests__/` (top-level tests for utilities like `router.test.ts`, `requestUtils.test.ts`, `staticServer.test.ts`) and `src/server/__tests__/routes/` (per-route suites). A shared helpers directory at `src/server/__tests__/helpers/mock-http.ts` was introduced in Rework-1 but only two files currently consume it.

Key files:
- `src/server/__tests__/helpers/mock-http.ts` — shared HTTP mocks (currently without `headers` capture)
- `src/config/config.constants.ts` — numeric boundary constants
- `src/config/config.ts` — exports `DEFAULTS`, `loadConfig()`, private `parseIntegerField()`
- `src/config/config.types.ts` — `AppConfig` interface
- `src/tests/setup.test.ts` — integration test for `runSetup`
- `src/tests/error-log.manager.test.ts` — error-log tests using spread pattern
- `src/tests/config.test.ts` — config loading tests with `console.warn` spy

## Approach / Architecture

Six independent changes, grouped into logical work packages:

1. **Extend `mock-http.ts` with `headers` capture and migrate all 12 remaining files.** The existing `MockResponse` interface gets a `headers` field. The `mockResponse()` factory captures `writeHead` headers. All inline copies are replaced with imports. Files with variant signatures (`requestUtils.test.ts` uses a `Buffer[]`-based `mockRequest`, `staticServer.test.ts` uses a `url`-only `mockRequest`) will need per-file adaptation — the shared helper already supports the superset signature `(method, url, bodyJson?)`, so thin wrappers or signature adjustments are acceptable.
2. **Add `MIN_CLONE_DEPTH`, `MAX_CLONE_DEPTH`, `MIN_SERVER_PORT`, `MAX_SERVER_PORT` to `config.constants.ts` and wire into `parseIntegerField()` calls.** Add corresponding range-warning tests.
3. **Add `notesCardHeight`/`notesColumns` round-trip assertions to `setup.test.ts`.**
4. **Simplify `error-log.manager.test.ts` spread to use `makeTestConfig(base, { maxErrorLogEntries: 5 })`.**
5. **Add a `satisfies AppConfig` compile-time guard for DEFAULTS coverage in `config.ts`.**
6. **Standardise `console.warn` spy to join all args before matching.**

## Rationale

- The mock-HTTP migration eliminates ~400 lines of duplicated boilerplate across 12 files, reducing maintenance burden when the mock shape needs to evolve.
- Adding bounds for `cloneDepth` and `serverPort` aligns all numeric fields with the same validation quality — currently these two fields silently accept values like `serverPort: 99999` or `cloneDepth: -1` without any warning.
- The `setup.test.ts` assertions make DEFAULTS coverage explicit and catch future regressions where a new field is added to `AppConfig`/`DEFAULTS` but not propagated through the setup wizard.
- The spread simplification is a trivial quality-of-life improvement that demonstrates idiomatic usage of the `overrides` parameter.
- The `satisfies` guard makes the Pick maintenance requirement compiler-enforceable rather than relying on human memory.
- Joining `console.warn` args future-proofs the spy against format changes.

## Detailed Steps

### Step 1 — Extend `mock-http.ts` MockResponse with `headers`

1. In `src/server/__tests__/helpers/mock-http.ts`, add `headers: Record<string, string | number>` to the `MockResponse` interface.
2. Update `mockResponse()` to capture the `headers` argument from `writeHead(status, headers)` into `mock.headers`.
3. Update the JSDoc consumers list.

### Step 2 — Migrate route test files to shared mock-http

Migrate these 8 route test files (remove inline `mockRequest`/`mockResponse`/`MockResponse`, add `import { mockRequest, mockResponse, MockResponse } from '../helpers/mock-http.js'`):
- `src/server/__tests__/routes/branches.test.ts`
- `src/server/__tests__/routes/error-log.test.ts`
- `src/server/__tests__/routes/notes.test.ts`
- `src/server/__tests__/routes/projects.test.ts`
- `src/server/__tests__/routes/repositories.test.ts`
- `src/server/__tests__/routes/status.test.ts`
- `src/server/__tests__/routes/workspaces.test.ts`
- `src/server/__tests__/routes/workspaces-health.test.ts`
- `src/server/__tests__/routes/workspaces-launch.test.ts`

For files that use the `bodyJson` parameter in `mockRequest()` (branches, repositories, projects, workspaces), the existing shared helper already supports that signature — direct replacement.

For files that do NOT pass `bodyJson` (notes, error-log, status, workspaces-health, workspaces-launch), the helper still works since `bodyJson` is optional.

### Step 3 — Migrate top-level server test files

Migrate these 3 top-level test files:
- `src/server/__tests__/router.test.ts` — uses `mockRequest(method, url)` without body (compatible). Its `mockRequest` lacks `destroy()` and does not emit data/end events; since router tests only test URL matching and don't await body parsing, the shared helper's `nextTick` data/end emission is harmless but must be verified.
- `src/server/__tests__/requestUtils.test.ts` — uses a **different** `mockRequest` signature: `mockRequest(chunks: Buffer[])`. This is a body-parsing utility test and requires a different mock shape. **Do not migrate `mockRequest` in this file.** Only migrate `MockResponse`/`mockResponse()`.
- `src/server/__tests__/staticServer.test.ts` — uses `mockRequest(url)` (no method). This requires adaptation: either add a thin wrapper `const req = mockRequest('GET', url)` or keep a local `mockRequest` and only migrate `MockResponse`/`mockResponse()`. Prefer the wrapper approach.

### Step 4 — Add MIN/MAX constants for cloneDepth and serverPort

1. In `src/config/config.constants.ts`, add:
   - `MIN_CLONE_DEPTH = 0` (0 means full clone, per JSDoc)
   - `MAX_CLONE_DEPTH = 2_147_483_647` (max safe 32-bit int, git's limit)
   - `MIN_SERVER_PORT = 1`
   - `MAX_SERVER_PORT = 65_535`
2. Import these in `src/config/config.ts`.
3. Wire into the `parseIntegerField()` calls for `cloneDepth` and `serverPort`.
4. Add range-warning tests in `src/tests/config.test.ts` (at least 4 new tests: below-min and above-max for each field).

### Step 5 — Add setup.test.ts assertions

After the existing assertions (line ~351), add:
```typescript
assert.strictEqual(loaded.notesCardHeight, DEFAULTS.notesCardHeight);
assert.strictEqual(loaded.notesColumns, DEFAULTS.notesColumns);
```
Import `DEFAULTS` from `'../config/config.js'` if not already imported.

### Step 6 — Simplify error-log.manager.test.ts spread

Change line 342–345:
```typescript
const config: AppConfig = {
    ...makeTestConfig(base),
    maxErrorLogEntries: 5,
};
```
To:
```typescript
const config = makeTestConfig(base, { maxErrorLogEntries: 5 });
```
Remove the `AppConfig` type annotation (inferred from the factory return type).

### Step 7 — Add DEFAULTS compile-time coverage guard

In `src/config/config.ts`, after the `DEFAULTS` declaration, add a compile-time assertion:
```typescript
// Compile-time guard: ensures DEFAULTS + required fields cover the full AppConfig shape.
// If a new required field is added to AppConfig without updating DEFAULTS, this line
// will produce a type error.
const _defaultsCoverageGuard: AppConfig = {
    ...DEFAULTS,
    projectsFolder: '',
    storageFolder: '',
} satisfies AppConfig;
void _defaultsCoverageGuard;
```
This will error at compile time if a new non-optional field is added to `AppConfig` without adding it to `DEFAULTS`.

### Step 8 — Standardise console.warn spy

In `src/tests/config.test.ts`, change the spy from:
```typescript
console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
```
To:
```typescript
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
```
Apply to all 5+ test blocks that use this pattern.

## Dependencies

- Steps 1–3 form a dependency chain: Step 1 (extend interface) must complete before Steps 2–3 (migrations).
- Steps 4–8 are independent of each other and of Steps 1–3.

## Required Components

- `src/server/__tests__/helpers/mock-http.ts` (modify)
- `src/server/__tests__/routes/branches.test.ts` (modify)
- `src/server/__tests__/routes/error-log.test.ts` (modify)
- `src/server/__tests__/routes/notes.test.ts` (modify)
- `src/server/__tests__/routes/projects.test.ts` (modify)
- `src/server/__tests__/routes/repositories.test.ts` (modify)
- `src/server/__tests__/routes/status.test.ts` (modify)
- `src/server/__tests__/routes/workspaces.test.ts` (modify)
- `src/server/__tests__/routes/workspaces-health.test.ts` (modify)
- `src/server/__tests__/routes/workspaces-launch.test.ts` (modify)
- `src/server/__tests__/router.test.ts` (modify)
- `src/server/__tests__/requestUtils.test.ts` (modify — `mockResponse`/`MockResponse` only)
- `src/server/__tests__/staticServer.test.ts` (modify)
- `src/config/config.constants.ts` (modify)
- `src/config/config.ts` (modify)
- `src/tests/config.test.ts` (modify)
- `src/tests/setup.test.ts` (modify)
- `src/tests/error-log.manager.test.ts` (modify)

## Assumptions

- The `requestUtils.test.ts` `mockRequest(chunks: Buffer[])` is a fundamentally different utility (tests the body-parser, not a route handler) and should retain its custom `mockRequest` while still benefiting from the shared `MockResponse`/`mockResponse()`.
- The `staticServer.test.ts` `mockRequest(url)` can be replaced with a thin local wrapper: `const staticReq = (url: string) => mockRequest('GET', url)`.
- `cloneDepth: 0` is valid (full clone), so `MIN_CLONE_DEPTH = 0`.
- Git uses 32-bit signed integers for depth, so `MAX_CLONE_DEPTH = 2_147_483_647` is the natural upper bound.
- Standard TCP port range gives `MIN_SERVER_PORT = 1`, `MAX_SERVER_PORT = 65_535`.
- The `satisfies AppConfig` guard is idiomatic TypeScript 4.9+ and will not conflict with the project's TypeScript 5.4+ baseline.

## Constraints

- Node16 ESM: all relative imports must use `.js` extension.
- No production behaviour changes — these are purely test-infrastructure and compile-time improvements.
- Existing tests must continue to pass without modification to their assertions.
- The `parseIntegerField()` range-warning semantics are: warn but pass value through (no clamping). This must remain consistent for the new `cloneDepth`/`serverPort` bounds.

## Out of Scope

- The pre-existing `notes-collected.test.mjs` GUI test hang — tracked separately.
- Any changes to `loadConfig()` clamping behaviour (out-of-range values are still passed through).
- Adding MIN/MAX enforcement at the REST API layer for `cloneDepth`/`serverPort` — only config-file loading is addressed.
- Migrating `pollingManager.test.ts` or `pollingManager.errorLog.test.ts` mock HTTP (these were already addressed in Rework-1 WP-006).

## Acceptance Criteria

- All 12 remaining server test files no longer contain inline `mockRequest`/`mockResponse`/`MockResponse` definitions (except `requestUtils.test.ts` which retains its custom `mockRequest` only).
- `mock-http.ts` `MockResponse` interface includes `headers` field; all existing tests that assert on `mock.headers` still pass.
- `config.constants.ts` exports `MIN_CLONE_DEPTH`, `MAX_CLONE_DEPTH`, `MIN_SERVER_PORT`, `MAX_SERVER_PORT`.
- `loadConfig()` emits `console.warn` for out-of-range `cloneDepth` and `serverPort` values.
- `setup.test.ts` asserts `notesCardHeight` and `notesColumns` on the loaded config.
- `error-log.manager.test.ts` uses `makeTestConfig(base, { maxErrorLogEntries: 5 })` without spread.
- `config.ts` contains a `satisfies AppConfig` compile-time guard that would fail if DEFAULTS becomes stale.
- All `console.warn` spy blocks join args with `.map(String).join(' ')`.
- Full test suite passes (`npm test`). Zero TypeScript errors (`npx tsc --noEmit`).

## Testing Strategy

- Run `npm test` after each step to verify no regressions.
- The mock-HTTP migration steps must verify all existing assertions still pass with the shared helper (no semantic change to what's captured).
- New range-warning tests for `cloneDepth` and `serverPort` follow the same pattern as the existing `notesCardHeight`/`notesColumns` warning tests.
- The `satisfies` guard is validated by `npx tsc --noEmit` — no runtime test needed (it's a compile-time assertion).

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **`router.test.ts` mock doesn't emit data/end events** — shared helper emits them on nextTick which could interfere with router dispatch tests | Verify router tests don't call `req.on('data'/'end')`. If they do, provide a `mockRouterRequest()` wrapper that suppresses emission. |
| **`staticServer.test.ts` expects `req.url` without method** — if any static-server logic inspects `req.method`, adding `'GET'` could change behaviour | Confirm `serveStatic()` only uses `req.url`. The existing tests passing after adding method confirms this. |
| **`requestUtils.test.ts` mixed migration** — importing only `MockResponse`/`mockResponse` while keeping local `mockRequest` may confuse future contributors | Add a brief inline comment: `// mockRequest kept local — tests body-parser internals requiring Buffer[] control`. |
| **DEFAULTS guard adds an unused variable warning** — `_defaultsCoverageGuard` might trigger linting | The `void _defaultsCoverageGuard` suppresses unused-var warnings. Verify with `tsc`. |
| **MAX_CLONE_DEPTH = 2_147_483_647 may be excessively permissive** — in practice no one uses depths above ~10000 | This is a warning, not a block — the value still passes through. Using git's actual limit avoids false positives. |
