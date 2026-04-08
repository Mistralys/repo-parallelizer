# Plan

## Summary

Address all actionable strategic recommendations and select known technical debt items from the Phase 6 GUI Frontend synthesis report. This rework covers seven areas: binding the HTTP server to localhost, adding security response headers, extracting duplicated normalisation helpers into a shared module, adding a type allowlist guard to `showToast()`, adding a `CSS.escape()` polyfill in `form-helpers.js`, moving toast-close inline styles to CSS, and implementing active nav-link highlighting. Together these changes harden the security posture, eliminate code duplication, and improve frontend polish.

## Architectural Context

The GUI frontend is a vanilla-JavaScript SPA served by a Node.js HTTP server. Key files and patterns relevant to this rework:

- **HTTP server entry:** `src/server/index.ts` — creates an `http.Server` via `http.createServer()`, calls `server.listen(port, callback)` without specifying a bind host (defaults to `0.0.0.0`).
- **Static file server:** `src/server/staticServer.ts` — the `serveStatic()` function streams files with `Content-Type` headers but sets no security-related response headers.
- **Toast component:** `gui/public/js/components/toast.js` — `showToast(message, type, duration)` interpolates `type` directly into a CSS class (`toast-${type}`) with no validation. The close button applies `marginLeft`, `fontSize`, and `lineHeight` as inline `style` properties despite having a `.toast-close` CSS class.
- **Form helpers:** `gui/public/js/components/form-helpers.js` — `validateRequired()` uses `CSS.escape()` which is unavailable in jsdom test environments (multiple QA test files already polyfill it externally).
- **Normalisation helpers (duplicated):**
  - `normaliseRepo()` — defined identically in `gui/public/js/views/repositories.js` (line 30) and `gui/public/js/views/project-detail.js` (line 94).
  - `normaliseProject()` — defined identically in `gui/public/js/views/project-detail.js` (line 77) and `gui/public/js/views/workspace-detail.js` (line 75).
  - `normaliseWorkspace()` — defined identically in `gui/public/js/views/project-detail.js` (line 108) and `gui/public/js/views/workspace-detail.js` (line 92).
- **Router:** `gui/public/js/router.js` — `_render()` stores cleanup callbacks synchronously; async view functions returning `Promise<cleanup>` would not register their cleanup. No current views are async, so this is documented rather than fixed.
- **Navigation:** `gui/public/index.html` has two `.nav-link` anchors. `gui/public/css/styles.css` defines a `.nav-link.active` rule (line 167), but no code ever applies the `active` class. `gui/public/js/app.js` bootstraps the router without hooking into route changes.

## Approach / Architecture

The rework is structured as independent, low-risk changes grouped into logical work packages:

1. **Server hardening** (bind address + security headers) — two small edits in `src/server/`.
2. **Normalisation extraction** — create a new shared module at `gui/public/js/utils/normalise.js`, move all three normaliser functions there, and update the three consuming views to import from it.
3. **Component polish** — three one-liner fixes across `toast.js`, `form-helpers.js`, and `styles.css`.
4. **Nav-link highlighting** — hook into the router's `hashchange` cycle to toggle `.active` on the matching nav link.

No new dependencies, no build tooling changes, no API changes.

## Rationale

- **Server bind to `127.0.0.1`:** The tool is designed for local use. Binding to all interfaces exposes the unauthenticated API to the LAN — unnecessary risk for a one-line fix.
- **Security headers:** Standard defence-in-depth headers (`X-Content-Type-Options`, `X-Frame-Options`, CSP) prevent MIME-sniffing, clickjacking, and script injection if the tool is ever exposed beyond localhost.
- **Normalisation extraction:** Three functions are duplicated across 2–3 files each. Consolidation eliminates copy-paste drift and the README already documents the canonical location (`gui/public/js/utils/normalise.js`).
- **Toast type guard:** Allowlist validation is defence-in-depth — prevents accidental or malicious CSS class injection via the `type` parameter.
- **`CSS.escape()` polyfill:** Four separate QA test files independently polyfill this function. A built-in fallback eliminates the test-environment workaround and improves browser compatibility.
- **Toast-close CSS migration:** Moves three inline style rules to the existing `.toast-close` class in `styles.css`, making them themeable.
- **Nav-link active state:** The CSS rule already exists and the visual feedback is standard SPA UX. The implementation hooks into `hashchange` to toggle the class.

## Detailed Steps

### Step 1 — Bind HTTP server to `127.0.0.1`

In `src/server/index.ts`, change the `server.listen(port, () => {` call (approximately line 143) to `server.listen(port, '127.0.0.1', () => {`.

### Step 2 — Add security response headers to static server

In `src/server/staticServer.ts`, in the `serveStatic()` function, add the following headers to the `res.writeHead(200, { ... })` call (approximately line 90):

```
'X-Content-Type-Options': 'nosniff',
'X-Frame-Options': 'DENY',
```

For HTML responses specifically (when `contentType` starts with `text/html`), also add:

```
'Content-Security-Policy': "default-src 'self'"
```

### Step 3 — Create `gui/public/js/utils/normalise.js`

Create a new file at `gui/public/js/utils/normalise.js` exporting three functions:

- `normaliseRepo(repo)` — returns `{ id, name, url }` handling both Go-capitalised and lowercase keys.
- `normaliseProject(project)` — returns `{ id, name, description, repositories }` handling both key casings.
- `normaliseWorkspace(ws)` — returns `{ id, description, createdAt }` handling both key casings.

Copy the implementations verbatim from `project-detail.js` (which has all three).

### Step 4 — Update views to import from shared normalise module

- **`gui/public/js/views/repositories.js`:** Remove the local `normaliseRepo()` function (line 30). Add `import { normaliseRepo } from '../utils/normalise.js';`.
- **`gui/public/js/views/project-detail.js`:** Remove the local `normaliseProject()` (line 77), `normaliseRepo()` (line 94), and `normaliseWorkspace()` (line 108). Add `import { normaliseProject, normaliseRepo, normaliseWorkspace } from '../utils/normalise.js';`.
- **`gui/public/js/views/workspace-detail.js`:** Remove the local `normaliseProject()` (line 75) and `normaliseWorkspace()` (line 92). Add `import { normaliseProject, normaliseWorkspace } from '../utils/normalise.js';`.

### Step 5 — Add type allowlist guard to `showToast()`

In `gui/public/js/components/toast.js`, at the top of `showToast()` (before the `getContainer()` call), add:

```js
const VALID_TYPES = new Set(['success', 'error', 'info', 'warning']);
const safeType = VALID_TYPES.has(type) ? type : 'info';
```

Replace all subsequent uses of `type` in the function with `safeType` (specifically in the `toast.className` assignment on the line `toast.className = \`toast toast-${type}\``).

### Step 6 — Add `CSS.escape()` inline polyfill in `form-helpers.js`

In `gui/public/js/components/form-helpers.js`, add a module-level constant before `validateRequired()`:

```js
const cssEscape = typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape
    : (s) => s.replace(/([^\w-])/g, '\\$1');
```

Replace both occurrences of `CSS.escape(fieldName)` inside `validateRequired()` with `cssEscape(fieldName)`.

### Step 7 — Move toast-close inline styles to CSS

In `gui/public/js/components/toast.js`, remove the four inline style assignments on the close button:
```js
closeBtn.style.marginLeft = 'auto';
closeBtn.style.fontSize = '1.1rem';
closeBtn.style.lineHeight = '1';
closeBtn.style.pointerEvents = 'auto';
```

In `gui/public/css/styles.css`, add the following rules to the existing toast section (after the `.toast.removing` block or alongside other toast styles):

```css
.toast-close {
    margin-left: auto;
    font-size: 1.1rem;
    line-height: 1;
    pointer-events: auto;
}
```

### Step 8 — Active nav-link highlighting

In `gui/public/js/app.js`, after the router is instantiated and routes are registered, add a `hashchange` listener that:

1. Reads `location.hash` (defaulting to `#/`).
2. Queries all `.nav-link` elements in the `<nav>`.
3. For each link, compares its `href` attribute (the hash portion) against the current hash.
4. Adds `.active` to the matching link, removes `.active` from all others.
5. Runs once on initial load as well.

A simple implementation:

```js
function updateActiveNavLink() {
    const hash = location.hash || '#/';
    document.querySelectorAll('.nav-link').forEach((link) => {
        const linkHash = link.getAttribute('href');
        const isActive = hash === linkHash || (linkHash !== '#/' && hash.startsWith(linkHash));
        link.classList.toggle('active', isActive);
    });
}

window.addEventListener('hashchange', updateActiveNavLink);
updateActiveNavLink();
```

### Step 9 — Update README normalisation helpers note

Update the "Known duplication" note in `README.md` (around line 1068) to reflect that the helpers have been consolidated into `gui/public/js/utils/normalise.js`.

## Dependencies

- Step 4 depends on Step 3 (shared module must exist before views can import from it).
- Step 7 (CSS changes) and Step 7 (JS changes) must be applied together.
- All other steps are independent and can be executed in any order.

## Required Components

- `src/server/index.ts` — modify `server.listen()` call (existing)
- `src/server/staticServer.ts` — add security headers to `res.writeHead()` (existing)
- `gui/public/js/utils/normalise.js` — **new file**: shared normalisation helpers
- `gui/public/js/views/repositories.js` — remove local `normaliseRepo()`, add import (existing)
- `gui/public/js/views/project-detail.js` — remove local normalisers, add import (existing)
- `gui/public/js/views/workspace-detail.js` — remove local normalisers, add import (existing)
- `gui/public/js/components/toast.js` — add type allowlist, remove inline styles (existing)
- `gui/public/js/components/form-helpers.js` — add `CSS.escape()` polyfill (existing)
- `gui/public/css/styles.css` — add `.toast-close` rules (existing)
- `gui/public/js/app.js` — add nav-link active highlighting (existing)
- `README.md` — update normalisation helpers note (existing)

## Assumptions

- The server is intended for local-only use; binding to `127.0.0.1` is the correct default.
- No existing code relies on LAN access to the server.
- The normaliser function implementations in `project-detail.js` are the canonical versions (all copies are identical — verified).
- The `VALID_TYPES` set (`success`, `error`, `info`, `warning`) covers all toast variants used across the application.
- The `.nav-link.active` CSS rule in `styles.css` (line 167) already provides the desired visual styling.

## Constraints

- No new dependencies may be added (vanilla JS, no build tools).
- Existing QA test files (`qa-wp011-tests.mjs` through `qa-wp016-tests.mjs`) that polyfill `CSS.escape` should continue to work — the inline polyfill in `form-helpers.js` makes the external polyfills redundant but not harmful.
- All 517 backend regression tests must continue to pass.

## Out of Scope

- **Async view cleanup in `router.js`:** No current views are async. This is documented as a known limitation but does not require a code change until async views are introduced.
- **Focus trap in `confirm-dialog.js`:** Acceptable for an internal developer tool.
- **Hard-coded ARIA IDs in `confirm-dialog.js`:** Concurrent dialogs are not a current use case.
- **`updateStatusTable()` missing repos added post-load:** Polling only refreshes repos present at initial render. Fixing this would require a full re-render strategy, which is out of scope for this polish pass.
- **Step 2 silent empty-input fallback in `branch-switch.js`:** The behaviour is documented with an inline comment. Changing it would alter user-facing behaviour and warrants separate UX consideration.
- **API `Content-Type` on GET/DELETE:** Harmless; not worth the change risk.
- **Raw request body echo in JSON parse errors (`requestUtils.ts`):** The first 120 chars of an invalid body are reflected in the error message. Since the server will be localhost-only after this rework, the information-exposure risk is minimal. Addressing this is deferred.
- **Audit logging for mutating API calls:** Only relevant if the tool is network-exposed; deferred.
- **Workspace ID regex duplication:** Already resolved — both `project-detail.js` and `workspace-detail.js` import `WORKSPACE_ID_PATTERN` from `form-helpers.js` (verified).
- **`gui/public/package.json` with `"type": "module"`:** Test-environment warning suppression; cosmetic.
- **Manual E2E test pass of branch-switch wizard:** Out of scope for automated implementation.

## Acceptance Criteria

- `server.listen()` in `src/server/index.ts` passes `'127.0.0.1'` as the hostname argument.
- All responses from `serveStatic()` include `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`. HTML responses additionally include `Content-Security-Policy: default-src 'self'`.
- `gui/public/js/utils/normalise.js` exists and exports `normaliseRepo`, `normaliseProject`, `normaliseWorkspace`.
- No local `normaliseRepo`, `normaliseProject`, or `normaliseWorkspace` definitions remain in `repositories.js`, `project-detail.js`, or `workspace-detail.js` — all three views import from the shared module.
- `showToast()` validates the `type` parameter against an allowlist; unrecognised values fall back to `'info'`.
- `validateRequired()` in `form-helpers.js` works without a global `CSS.escape` (i.e., passes in jsdom without an external polyfill).
- The toast close button in `toast.js` has no inline `style` assignments; the `.toast-close` CSS rule in `styles.css` contains the equivalent declarations.
- The current nav-link receives the `.active` class on initial page load and on every route change.
- All 517 existing backend tests pass without modification.
- All existing QA test suites (`qa-wp011` through `qa-wp016`) pass.

## Testing Strategy

- **Backend regression tests:** Run the full `npm test` suite after Steps 1–2 to verify server changes do not break existing tests. Server tests that bind to a port may need the `127.0.0.1` change reflected in their assertions (verify test expectations against `server.address()`).
- **Normalisation extraction:** Targeted QA tests should verify that each view still renders correctly after switching to the shared import. Existing QA test suites for WP-013, WP-014, WP-015, and WP-016 cover this.
- **Toast type guard:** Unit test that `showToast('msg', 'bogus')` produces a toast with class `toast-info` (not `toast-bogus`).
- **`CSS.escape()` polyfill:** Run `qa-wp011-tests.mjs` and `qa-wp015-tests.mjs` without the external `CSS.escape` polyfill to verify the built-in fallback works.
- **Toast-close CSS:** Visual inspection or QA test asserting the close button has no inline `style` attribute.
- **Nav-link active:** QA test asserting that after `location.hash = '#/repositories'`, the Repositories link has `.active` and the Dashboard link does not.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Server tests assume `0.0.0.0` bind address** | Review `src/server/__tests__/index.test.ts` for assertions on `server.address()` and update if needed. |
| **CSP `default-src 'self'` breaks inline scripts or styles** | The SPA uses no inline scripts (all loaded via `<script type="module">`). Inline styles on toast-close are being removed in this same plan. Verify no other inline styles exist. |
| **Normalisation function signatures differ between copies** | Verified: all copies are identical. The canonical versions from `project-detail.js` are used. |
| **Import path errors after extraction** | Relative paths from `views/` to `utils/` are `../utils/normalise.js` — standard ES module resolution. |
| **`cssEscape` polyfill regex edge cases** | The replacement regex `([^\w-])` matches the same pattern used in all four QA test polyfills. |
