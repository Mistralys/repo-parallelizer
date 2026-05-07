# Plan

## Summary

Add two user-configurable display preferences for the Notes overview (`#/notes`) — **note card height** and **column count** — exposed as server-side settings in `config.json`, served via REST API endpoints, editable in the GUI Settings view, and consumed by the notes-collected view at render time.

## Architectural Context

- **Configuration layer:** `src/config/config.types.ts` defines `AppConfig`; `src/config/config.ts` loads/saves fields; `src/config/config.constants.ts` holds validation bounds.
- **Config REST endpoints:** `src/server/routes/config.ts` registers GET/PUT routes under `/api/config/...`. Each setting section follows the same pattern: read body → validate → mutate in-memory `appConfig` → persist via `saveConfigField()` → return updated value.
- **GUI Settings view:** `gui/public/js/views/settings.js` builds per-section UI sections that each expose a `save()` function invoked by the shared "Save Settings" footer button.
- **API client:** `gui/public/js/api.js` groups config methods under `api.config.*` sub-namespaces.
- **Notes view:** `gui/public/js/views/notes-collected.js` renders note cards in a two-column CSS Grid (`.notes-main` with `grid-template-columns: repeat(2, 1fr)`). Each card has a fixed CSS `height: 220px`.
- **Styling:** `gui/public/css/styles.css` — the relevant rules are at lines ~1727 (`.notes-main` grid) and ~1749 (`.notes-card` height).

## Approach / Architecture

Introduce a new **"Notes Display"** settings section with two controls (card height and column count). The values are persisted in `config.json`, exposed via a single new REST endpoint pair (`GET` / `PUT` `/api/config/notes-display`), and applied as CSS custom properties on the `.notes-main` / `.notes-card` elements at render time.

### Data Shape

```json
{
  "notesCardHeight": 220,
  "notesColumns": 2
}
```

Both fields are optional in `config.json` (defaults apply when absent). On the `AppConfig` TypeScript interface, however, both fields are **required** — `loadConfig()` always populates them, following the established pattern for `cloneDepth`, `serverPort`, and `gitPollingIntervalSeconds`.

### Flow

1. Settings view loads current values via `GET /api/config/notes-display`.
2. User edits → shared "Save Settings" button calls `PUT /api/config/notes-display`.
3. Notes view fetches display settings once on render and applies them as inline CSS custom properties on the layout and card elements.

## Rationale

- **Server-side storage** is consistent with all existing settings (polling, webserver URL) and shares the value across all browsers hitting the same instance.
- **Single endpoint** (`/api/config/notes-display`) groups both values together — they are logically related and always used together; no need for two separate routes.
- **CSS custom property for card height** — the card height is applied as a CSS custom property (`--notes-card-height`) on the container, consumed by child `.notes-card` elements via `var()`. The column count is set as a direct inline style on `.notes-main`, overriding the stylesheet default. Both approaches avoid global stylesheet mutation and integrate naturally with the view's imperative DOM construction.
- **Validation bounds** prevent unreasonable values while still giving users flexibility.

## Detailed Steps

### Step 1 — Backend: Config Type & Constants

1. **`src/config/config.constants.ts`** — Add:
   ```typescript
   export const MIN_NOTES_CARD_HEIGHT = 120;
   export const MAX_NOTES_CARD_HEIGHT = 800;
   export const DEFAULT_NOTES_CARD_HEIGHT = 220;

   export const MIN_NOTES_COLUMNS = 1;
   export const MAX_NOTES_COLUMNS = 6;
   export const DEFAULT_NOTES_COLUMNS = 2;
   ```

2. **`src/config/config.types.ts`** — Add two **required** fields to `AppConfig` (following the pattern of `cloneDepth`, `serverPort`, and `gitPollingIntervalSeconds` — fields that `loadConfig()` always populates with defaults are non-optional on the interface):
   ```typescript
   /** Height (in px) of each note card in the notes overview. @default 220 */
   notesCardHeight: number;
   /** Number of columns in the notes overview grid. @default 2 */
   notesColumns: number;
   ```

3. **`src/config/config.ts` (`loadConfig`)** — Add the two new fields to the `DEFAULTS` object and include them in the returned `AppConfig`, falling back to the default constants when absent in the raw config.

4. **`config.dist.json`** — Add the two new fields with their default values:
   ```json
   "notesCardHeight": 220,
   "notesColumns": 2
   ```

### Step 2 — Backend: REST Endpoint

5. **`src/server/routes/config.ts`** — Register two new handlers within `registerConfigRoutes()`:

   - **`GET /api/config/notes-display`** — Returns:
     ```json
     { "notesCardHeight": <number>, "notesColumns": <number> }
     ```
     Using current `appConfig` values (which already have defaults applied).

   - **`PUT /api/config/notes-display`** — Accepts body:
     ```json
     { "notesCardHeight": <number>, "notesColumns": <number> }
     ```
     Both fields optional in the request — only the provided fields are updated.
     Validation:
     - `notesCardHeight`: integer, min 120, max 800.
     - `notesColumns`: integer, min 1, max 6.

     On success: mutate in-memory `appConfig`, persist each changed field via `saveConfigField()`, return the full current notes-display settings object.

### Step 3 — Frontend: API Client

6. **`gui/public/js/api.js`** — Add a new sub-namespace under `config`:
   ```javascript
   notesDisplay: {
       get() { return request('GET', '/api/config/notes-display'); },
       set(data) { return request('PUT', '/api/config/notes-display', data); },
   },
   ```

### Step 4 — Frontend: Settings View Section

7. **`gui/public/js/views/settings.js`** — Add a `buildNotesDisplaySection()` function (following the pattern of `buildRefreshDelaySection()`):
   - Heading: "Notes Display"
   - Description text explaining both controls.
   - Two input rows:
     - **Card Height** — `<input type="number" min="120" max="800" step="10" placeholder="220">` with a "px" unit label.
     - **Columns** — `<input type="number" min="1" max="6" step="1" placeholder="2">`.
   - Inline error messages per field.
   - A `save()` function that validates locally and calls `api.config.notesDisplay.set(...)`.
   - Wire into the `renderSettings()` entry point and include in the shared footer button's `Promise.all(...)` array.

### Step 5 — Frontend: Notes View Integration

8. **`gui/public/js/views/notes-collected.js`** — At the start of `renderNotesCollected()`, fetch display settings in parallel with `api.notes.list()`. Wrap the `Promise.all` in the existing `try/catch` block that currently wraps the `api.notes.list()` call. The `.catch(() => ({}))` on the display-settings call ensures only a notes-list failure triggers the error path:
   ```javascript
   const [rawResponse, displaySettings] = await Promise.all([
       api.notes.list(),
       api.config.notesDisplay.get().catch(() => ({})),
   ]);
   ```
   After building `.notes-main`, apply the display settings — card height as a CSS custom property consumed by `.notes-card` via `var()`, and column count as a direct inline style override:
   ```javascript
   if (displaySettings.notesColumns) {
       mainPanel.style.setProperty('grid-template-columns', `repeat(${displaySettings.notesColumns}, 1fr)`);
   }
   if (displaySettings.notesCardHeight) {
       mainPanel.style.setProperty('--notes-card-height', `${displaySettings.notesCardHeight}px`);
   }
   ```

9. **`gui/public/css/styles.css`** — Change `.notes-card` height to use the CSS variable with fallback:
   ```css
   .notes-card {
       height: var(--notes-card-height, 220px);
   }
   ```
   (No change needed for grid-template-columns since the inline style will override it.)

### Step 6 — Tests

10. Add a backend integration test for the new endpoint pair in `src/server/__tests__/` (following the pattern of existing config route tests) — cover happy-path GET/PUT, validation errors (out-of-range, non-integer), and partial updates.

## Dependencies

- No new npm packages required.
- Uses existing `saveConfigField()` persistence mechanism.
- Uses existing `request()` helper in the GUI API client.

## Required Components

| Component | Status | Action |
|---|---|---|
| `src/config/config.constants.ts` | Existing | Add new constants |
| `src/config/config.types.ts` | Existing | Add two required fields |
| `src/config/config.ts` | Existing | Add to `DEFAULTS` and parse new fields in `loadConfig()` |
| `config.dist.json` | Existing | Add default values for new fields |
| `src/server/routes/config.ts` | Existing | Register GET/PUT `/api/config/notes-display` |
| `gui/public/js/api.js` | Existing | Add `api.config.notesDisplay` namespace |
| `gui/public/js/views/settings.js` | Existing | Add Notes Display section |
| `gui/public/js/views/notes-collected.js` | Existing | Fetch + apply display settings |
| `gui/public/css/styles.css` | Existing | Use CSS variable for card height |
| `src/server/__tests__/` (new test file) | New | `config.notes-display.test.ts` |

## Assumptions

- The values are simple integers; no per-project or per-workspace overrides are needed.
- The note card height encompasses the entire card (header + textarea), matching the current `220px` CSS value.
- A page refresh or navigation back to `#/notes` is acceptable to see updated display settings (no live reactivity required from the settings page).

## Constraints

- `.js` extension required on all relative TS imports.
- Vanilla JS for all frontend code — no framework, no build step.
- DOM text set via `textContent` only (XSS safety).
- Config changes must call `saveConfigField()` for persistence + mutate `appConfig` for immediate effect.

## Out of Scope

- Per-project/per-workspace display overrides.
- Real-time reactivity (notes view re-rendering while settings view saves).
- Responsive breakpoint logic (e.g., auto-reducing columns on narrow viewports).
- The note textarea `rows` attribute in the workspace-detail view (only the notes overview is in scope).

## Acceptance Criteria

- `GET /api/config/notes-display` returns current values with correct defaults (220, 2) on a fresh config.
- `PUT /api/config/notes-display` validates bounds and persists to `config.json`.
- The Settings view shows both controls pre-populated with current values, validates client-side, and saves via the shared button.
- The Notes overview respects the configured card height and column count on render.
- Existing tests continue to pass; new endpoint tests cover validation.

## Testing Strategy

- **Backend unit/integration test:** Exercise GET (defaults), PUT (valid), PUT (partial — only one field), PUT (invalid: below min, above max, non-integer, non-number). Verify `config.json` is updated and in-memory `appConfig` reflects the change.
- **Manual GUI test:** Change settings, navigate to `#/notes`, verify visual changes.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **User sets extreme card height (e.g., 800px)** | Bounded by MAX constant; UI description communicates the range. |
| **Display settings fetch fails on notes load** | `.catch(() => ({}))` degrades gracefully to CSS defaults. |
| **Column count 1 or 6 looks bad with few/many cards** | Min/max bounds are reasonable; user chose the value intentionally. |
