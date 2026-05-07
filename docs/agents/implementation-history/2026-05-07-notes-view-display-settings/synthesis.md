# Synthesis Report — Notes View Display Settings

**Plan:** `2026-05-07-notes-view-display-settings`
**Generated:** 2026-05-07
**Status:** COMPLETE — All 6 work packages passed all 4 pipeline stages.

---

## Executive Summary

This session delivered end-to-end user-configurable display settings for the Notes overview view (`#/notes`). Users can now control **note card height** (120–800 px) and **column count** (1–6 columns) through the GUI Settings panel, with values persisted server-side in `config.json` and applied dynamically to the notes grid at render time.

The feature was implemented across the full stack in 6 sequential work packages:

| WP | Scope | Result |
|----|-------|--------|
| WP-001 | Backend config layer: constants, types, defaults, `loadConfig()` | ✅ COMPLETE |
| WP-002 | REST API: `GET`/`PUT /api/config/notes-display` | ✅ COMPLETE |
| WP-003 | Frontend API client: `api.config.notesDisplay.get()` / `.set()` | ✅ COMPLETE |
| WP-004 | Integration test suite: `config.notes-display.test.ts` | ✅ COMPLETE |
| WP-005 | GUI Settings view: `buildNotesDisplaySection()` | ✅ COMPLETE |
| WP-006 | Notes Collected view: dynamic CSS layout application | ✅ COMPLETE |

---

## Metrics

### Test Suite

| Milestone | Tests Passing | Tests Failed |
|-----------|--------------|--------------|
| After WP-001 | 786 | 0 |
| After WP-002 | 808 | 0 |
| After WP-003 | 36 (api-layer) | 0 |
| After WP-004 | 834 | 0 |
| After WP-005 | 46 (GUI layer) | 0 |
| After WP-006 | 834 | 0 |

**Total net new tests added:** 60+ (6 config unit tests, 22 route unit tests, 6 api-layer tests, 26 integration tests, plus manual QA edge-case verification across all WPs).

**Zero regressions introduced across all work packages.**

### Pipeline Health

- **6/6 WPs** passed all 4 stages: `implementation → qa → code-review → documentation`
- **0 rework cycles** (all pipelines passed on first attempt)
- **0 BLOCKED states** encountered
- **TypeScript build:** clean at every stage (`tsc --noEmit` exits 0 throughout)

### Acceptance Criteria

- **34/34 acceptance criteria** met across all 6 work packages (100%)

---

## What Was Built

### Architecture

```
config.constants.ts     ← MIN/MAX/DEFAULT constants for card height & columns
config.types.ts         ← AppConfig extended with notesCardHeight, notesColumns (required)
config.ts               ← loadConfig() defaults via DEFAULTS object
config.dist.json        ← Distributed config template updated

src/server/routes/config.ts           ← GET + PUT /api/config/notes-display
src/server/__tests__/config.notes-display.test.ts  ← 26 integration tests

gui/public/js/api.js                  ← api.config.notesDisplay.get() / .set()
gui/public/js/views/settings.js       ← buildNotesDisplaySection() UI section
gui/public/js/views/notes-collected.js ← Parallel fetch + CSS custom property application
gui/public/css/styles.css             ← .notes-card uses var(--notes-card-height, 220px)
```

### Key Design Decisions

1. **Required fields on `AppConfig`** — `notesCardHeight` and `notesColumns` are non-optional on the TypeScript interface. `loadConfig()` always populates them with defaults, following the established pattern of `cloneDepth`/`serverPort`. This eliminates optional chaining in consumers.

2. **Single endpoint, two fields** — `GET`/`PUT /api/config/notes-display` handles both values together. They are logically related and always consumed together by the view.

3. **CSS custom property for card height** — `--notes-card-height` is set as an inline style on `.notes-main` at render time. The `.notes-card` rule uses `var(--notes-card-height, 220px)`, preserving the CSS default when JS has not applied a value. This avoids global stylesheet mutation.

4. **Graceful degradation in the Notes view** — The display settings fetch uses a scoped `.catch(() => ({}))` inside `Promise.all`, isolating the non-critical settings fetch from the critical notes list fetch. If the settings API fails, the view renders with CSS defaults.

5. **Partial updates on PUT** — The endpoint accepts any subset of `{notesCardHeight, notesColumns}`, only persisting and mutating fields that are provided.

---

## Files Modified

| File | WP | Change |
|------|----|--------|
| `src/config/config.constants.ts` | WP-001 | 6 new exported constants |
| `src/config/config.types.ts` | WP-001 | 2 new required `AppConfig` fields + JSDoc with constant links |
| `src/config/config.ts` | WP-001 | `DEFAULTS` object extended, `loadConfig()` returns new fields |
| `config.dist.json` | WP-001 | New default values added |
| `src/cli/setup.ts` | WP-001 | Manual `AppConfig` builder updated with new fields |
| `src/tests/config.test.ts` | WP-001 | 6 new tests |
| 13× test fixture files | WP-001 | Required `AppConfig` fields added |
| `src/server/routes/config.ts` | WP-002 | 2 new route handlers + JSDoc table update |
| `src/server/__tests__/routes/config.test.ts` | WP-002 | 22 new tests |
| `docs/agents/project-manifest/rest-api.md` | WP-002 | Full Notes Display API section added |
| `docs/agents/project-manifest/constraints.md` | WP-002 | Config Validation Constants table added |
| `gui/public/js/api.js` | WP-003 | `api.config.notesDisplay` sub-namespace + `NotesDisplayConfig` typedef |
| `gui/public/js/api.config.test.mjs` | WP-003 | 6 new tests |
| `docs/agents/project-manifest/api-surface.md` | WP-001/WP-003 | `AppConfig` and `api.config.notesDisplay` sections added |
| `docs/agents/project-manifest/gui-frontend.md` | WP-003/WP-005 | API surface list + 4-section settings description |
| `src/server/__tests__/config.notes-display.test.ts` | WP-004 | New file — 26 integration tests |
| `gui/public/js/views/settings.js` | WP-005 | `buildNotesDisplaySection()` + JSDoc header update |
| `gui/public/css/styles.css` | WP-005/WP-006 | Notes Display CSS classes + `var(--notes-card-height, 220px)` |
| `gui/public/js/views/notes-collected.js` | WP-006 | Parallel fetch + CSS custom property application |
| `.context/*` (project-manifest, modules) | WP-001/WP-003/WP-005 | CTX regenerated at each doc pass |

---

## Strategic Recommendations ("Gold Nuggets")

### 🔴 High Priority — Address Before Next Required `AppConfig` Field

**AppConfig test fixture duplication (medium-priority tech debt)**
Flagged independently by the Developer (WP-001), confirmed by QA, and escalated by the Reviewer. Adding two required fields to `AppConfig` required touching 13 test fixture files. A shared `makeTestConfig()` factory exported from `src/tests/test-helpers.ts` would reduce this to a single-file change for all future additions. This is the single highest-impact refactor available before the next interface extension.

> **Recommendation:** Create `src/tests/test-helpers.ts` with a `makeTestConfig(overrides?: Partial<AppConfig>): AppConfig` factory that returns a fully-populated config object using the `DEFAULT_*` constants, before the next feature that extends `AppConfig`.

---

### 🟡 Medium Priority — Code Quality

**Duplicated mock HTTP helpers in test files (flagged in WP-004)**
`mockRequest`, `mockResponse`, `MockResponse`, and the temp-dir teardown are duplicated verbatim between `routes/config.test.ts` and `config.notes-display.test.ts`. A shared utility at `src/server/__tests__/helpers/mock-http.ts` would eliminate this and ease future route test authoring. A TODO comment was added in the WP-004 Reviewer pass to track this.

**`src/cli/setup.ts` manually enumerates `AppConfig` fields**
The CLI setup builder constructs the initial `AppConfig` object by hand (lines 217–223) without reading from the `DEFAULTS` constants. Each new required field must be added in two places: `config.ts` (DEFAULTS) and `setup.ts` (manual list). Deriving the initial config from `loadConfig()` after writing the file would be more robust.

**Settings sections inconsistency in `renderSettings()`**
The credentials section is built inline in `renderSettings()` rather than via a `buildCredentialsSection()` factory function like the other three sections. Extracting it would make the settings composition pattern fully uniform and reduce the body of `renderSettings()`.

---

### 🟢 Low Priority — Future Consideration

**Input validation: `Number.isInteger()` guard for `loadConfig()`**
`loadConfig()` uses `typeof === 'number'` guards for `notesCardHeight` and `notesColumns`, which allows float values (e.g. `220.5`). Both fields are inherently integer concepts. Adding `Number.isInteger()` alongside `typeof` would tighten the contract at the config parsing level and match the validation already enforced by the REST API layer.

**Config bounds clamping in `loadConfig()`**
Currently, out-of-range values (e.g. `notesCardHeight: 1500`) are stored as-is — clamping is deferred to the UI/API layer. A `console.warn` when values fall outside `[MIN, MAX]` in `loadConfig()` would catch misconfigured `config.json` files earlier during server startup, without changing the existing behaviour.

**`isValidFiniteInteger()` extraction in `config.ts` route handler**
The PUT handler splits integer validation into two sequential conditions (`Number.isFinite` then `Number.isInteger`), matching the existing polling handler pattern. If more integer-validated fields are added, a small shared helper would reduce boilerplate across handlers.

**`DEFAULTS` Pick type in `config.ts`**
The `DEFAULTS` object uses a `Pick<AppConfig, ...>` type that explicitly enumerates defaulted fields. This is a strong pattern (discoverable, type-checked) but requires manual extension for each new defaulted field. The Reviewer noted this as well-considered — flagged only for awareness.

---

## Remaining Known Issues / Non-Issues

| Issue | Severity | Status |
|-------|----------|--------|
| `config.notes-display.test.ts` placed at `src/server/__tests__/` (flat) vs. `src/server/__tests__/routes/` (nested) | Low | By WP spec design — no action required unless team chooses to reorganise |
| GUI `notes-collected.test.mjs` hangs in sandbox | Pre-existing | Not caused by this feature; confirmed on unmodified codebase |
| WP-004 ledger metadata has `work_package_file: 'work/WP-006.md'` (cosmetic mismatch) | Cosmetic | Logged by PM — actual spec file `work/WP-004.md` is correct |
| `notesCardHeight` appends `px` unconditionally in `notes-collected.js` | Low | Safe per current API contract (`notesCardHeight` is always an integer) — inline comment added to document the assumption |

---

## Next Steps for the Planner / Manager

1. **Prioritize the `makeTestConfig()` refactor** — this is the clear near-term action to prevent the 13-file fixture-update pattern from recurring on the next `AppConfig` extension.

2. **Extract shared mock HTTP helpers** — `src/server/__tests__/helpers/mock-http.ts` is a small, self-contained improvement that will pay off immediately in the next route test file.

3. **Consider `loadConfig()` integer guards and bounds warnings** — low effort, improves developer experience when `config.json` is misconfigured in production.

4. **Notes view QA** — The `notes-collected.test.mjs` GUI test suite is known to hang in the sandbox environment. If end-to-end GUI tests are needed for the notes view (e.g. verifying the dynamic column/height CSS application), a dedicated browser-based integration test or Playwright spec would be the appropriate vehicle.

5. **Future settings sections** — If a fifth+ settings section is added, introduce a `buildNumberInputRow(labelText, opts, unitText)` helper in `settings.js` to eliminate the repeated label/input/unit construction pattern.

---

*Synthesis generated by Head of Operations (OPS). All data sourced from the project ledger via `central_pm` MCP server.*
