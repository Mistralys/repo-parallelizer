## Synthesis

### Completion Status
- Status: COMPLETE
- Completed by: Standalone Developer Agent

### Implementation Summary
- **Server bind to `127.0.0.1`:** Changed `server.listen(port, ...)` to `server.listen(port, '127.0.0.1', ...)` in `src/server/index.ts`, restricting the HTTP server to localhost-only access.
- **Security response headers:** Added `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` to all static file responses in `src/server/staticServer.ts`. HTML responses additionally receive `Content-Security-Policy: default-src 'self'`.
- **Normalisation extraction:** Created `gui/public/js/utils/normalise.js` with three exported functions (`normaliseRepo`, `normaliseProject`, `normaliseWorkspace`). Removed duplicate definitions from `repositories.js`, `project-detail.js`, and `workspace-detail.js`; all three views now import from the shared module.
- **Toast type allowlist:** `showToast()` now validates the `type` parameter against `['success', 'error', 'info', 'warning']`, falling back to `'info'` for unknown values. Prevents CSS class injection via the type parameter.
- **`CSS.escape()` polyfill:** Added a module-level `cssEscape` fallback in `form-helpers.js` that uses `CSS.escape` when available and a regex-based replacement otherwise. Both `CSS.escape(fieldName)` calls in `validateRequired()` now use this.
- **Toast-close CSS migration:** Removed four inline style assignments (`marginLeft`, `fontSize`, `lineHeight`, `pointerEvents`) from `toast.js` and added a `.toast-close` rule in `styles.css` with the equivalent declarations.
- **Active nav-link highlighting:** Added a `hashchange` listener and an initial call in `app.js` that toggles `.active` on `.nav-link` elements based on the current hash. Uses prefix matching for sub-routes (e.g. `#/repositories` stays active on child views).

### Documentation Updates
- Updated `README.md` normalisation helpers table: changed module column from per-view files to `utils/normalise.js`.
- Replaced the "Known duplication" note with a "Consolidated" note confirming the shared module location.
- Updated per-view key-casing paragraphs in the Project Detail, Repositories, and Workspace Detail sections to reference the shared import.

### Verification Summary
- Tests run: `npm test` (517 tests via `node --test`)
- Static analysis: `tsc --noEmit` (zero errors)
- Result: 517/517 pass, 0 fail
- Note: The EADDRINUSE test in `src/server/__tests__/index.test.ts` required a one-line fix — the blocker server now binds to `127.0.0.1` to match the updated `startServer()` bind address.

### Code Insights
- [low] (convention) `gui/public/js/views/workspace-detail.js`: The local `normaliseWorkspace()` that was removed had a slightly different return shape (no `createdAt` field) compared to the canonical version in `project-detail.js` (which includes `createdAt`). The shared module uses the richer shape from `project-detail.js`. Any code consuming only `id` and `description` will continue to work; the extra `createdAt` field is harmless.
- [low] (refactor) `gui/public/js/views/workspace-detail.js`: `extractRepoId()` and `extractRepoName()` remain local because they are only used by workspace-detail. If another view needs them, they should be moved to `utils/normalise.js`.
- [low] (improvement) `gui/public/js/app.js`: The `updateActiveNavLink()` function uses a simple prefix match (`hash.startsWith(linkHash)`) which works correctly for the current two-link nav. If deeper nested routes are added that share a prefix with an unrelated nav link, the matching logic may need refinement.
- [low] (debt) `src/server/staticServer.ts`: The `Content-Security-Policy` header is set to `default-src 'self'` which is strict. If future frontend features require inline scripts, external fonts, or CDN resources, this policy will need to be relaxed. Currently all assets are self-hosted, so this is correct.
- [low] (convention) `gui/public/js/components/form-helpers.js`: The `cssEscape` polyfill uses a simplified regex (`/([^\w-])/g`) that handles common field name characters but is not a full CSS.escape spec implementation. For the current usage (escaping simple field names like `name`, `description`, `url`), this is sufficient.

### Additional Comments
- The QA test files that previously polyfilled `CSS.escape` externally will continue to work — the inline polyfill in `form-helpers.js` makes those external polyfills redundant but not harmful.
- No new dependencies were introduced. All changes are vanilla JS/CSS/TypeScript.
