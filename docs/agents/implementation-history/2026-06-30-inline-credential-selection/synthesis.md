## Synthesis

### Completion Status
- Date: 2026-06-30
- Status: COMPLETE
- Completed by: Standalone Developer Agent
- Archived in Ledger: 2026-09-09

### Implementation Summary
- Added inline credential selection to the `#/repositories` table edit mode.
- When clicking **Edit** on a repository row, the read-only credential badge is now replaced by a `<select class="repo-credential-select">` dropdown. Options are fetched lazily from `GET /api/repositories/:id/credential-options` on first edit (cached for subsequent edits without re-fetching).
- Auto-select semantics match `repository-detail.js`: a single option with `auto: true` is pre-selected when no stored credential exists; a stored `credentialId` takes priority.
- **Save** fires both `api.repositories.update` (name) and `api.repositories.updateCredential` (credential) in parallel via `Promise.all`. On success, the badge is replaced with a fresh `buildCredentialBadge()` reflecting the new state.
- **Cancel** restores the badge and hides the select without persisting any changes.
- A concurrent-load guard (`credentialsLoading` flag) prevents duplicate in-flight fetches if the user quickly cycles edit→cancel→edit before the first fetch completes.

### Documentation Updates
- `docs/agents/project-manifest/gui-frontend.md`: updated the `#/repositories` route entry to describe the credential select in edit mode, auto-select semantics, and badge replacement on save.

### Verification Summary
- Tests run: `gui/public/js/views/repositories.test.mjs` (full suite, including new credential edit-mode tests)
- Full suite: `npm test` (941 tests)
- Static analysis run: none (frontend is vanilla JS, no type checker applies to GUI)
- Result: PASS — 941/941, 0 failures

### Code Insights
- [low] (improvement) `gui/public/js/views/repositories.js` → `buildRepoRow`: credential options are fetched per-row on first edit. If many repositories are listed and the user edits several in one session, this results in N separate `/credential-options` calls. Fetching all credentials once via `api.config.credentials.list()` and filtering client-side (as `buildCredentialSection` in repository-detail.js also could do) would reduce round-trips, but the per-repo host-matching on the server is authoritative. The current design is correct and simple; this is a minor efficiency note.
- [low] (convention) `gui/public/js/views/repositories.js` → `buildRepoRow`: the `loadCredentialOptions` inner function is defined between the credential cell construction and the actions cell construction. This is slightly unusual — in the rest of the file, all behavior wiring happens in the "Behaviour" section below the DOM setup. Moving the function declaration there would be more consistent with the module's existing layout.

### Additional Comments
- The `credentialSelect.value` assignment after populating options relies on `<select>` value-setting falling back silently to the first option when the value is not found — this matches the `repository-detail.js` precedent and is acceptable behavior.

---

## Synthesis

### Completion Status
- Date: 2026-06-30
- Status: COMPLETE
- Completed by: Standalone Developer Agent
- Archived in Ledger: 2026-09-09

### Implementation Summary
- Fixed a bug where inline-editing an existing credential in the Settings GUI always failed with "Missing or invalid field 'host': must be a non-empty string."
- Root cause: the `PUT /api/config/credentials` server handler always required `host` and `token` as non-empty fields, but the inline-edit row only submits `{ id, label, [token] }` — `host` is intentionally display-only (not an input), and `token` is intentionally optional ("leave blank to keep current").
- Fix: when `id` is provided and matches an existing credential entry (update path), `host` and `token` are now optional. Omitting either retains the existing stored value. Only `label` is always required. For create paths (no `id`, or `id` with no existing match), both fields remain required as before.

### Documentation Updates
- `src/server/routes/config.ts`: updated inline JSDoc and comment block on the PUT handler to document partial-update semantics.
- `gui/public/js/api.js`: corrected the `credentials.update()` JSDoc — previously claimed "server retains the current token when no `token` key is present" (which was false); now accurate.
- `docs/agents/project-manifest/rest-api.md`: updated the `PUT /api/config/credentials` table entry, request-body field table (host/token now marked required-for-create / optional-for-update), and added a label-only update example.

### Verification Summary
- Tests run: `dist/server/__tests__/routes/config.test.js` (full suite)
- Static analysis run: `tsc` (TypeScript compiler, strict mode)
- Result: PASS — 0 failures, clean build

### Code Insights
- [low] (debt) `src/server/routes/config.ts`: The `PUT /api/config/credentials` handler pre-dates partial-update support and was structured with a flat, create-only validation style. Now that update-path semantics are needed, the early "resolve existing entry" pattern introduced here is a reliable pattern to follow for any future partial-update endpoints.
- [low] (improvement) `gui/public/js/views/settings.js` → `buildCredentialRow` save handler: after this fix the client sends `{ id, label, [token] }` and the server correctly retains host. This is clean. However, passing `host: cred.host` explicitly in the update payload would make the intent self-documenting at the call site (the server would use it rather than retaining it, but the result is identical). This is a purely cosmetic option.
- [medium] (debt) `gui/public/js/api.js` → `credentials.update()` JSDoc: the prior comment stated behaviour that was never implemented on the server ("server retains the current token when no `token` key is present"). This was a stale/aspirational comment that masked the bug. Consider adding a linting or documentation-verification step for API client docs.

### Additional Comments
- The host format validation (rejects `/`, `\`, null bytes, whitespace) still applies when `host` is explicitly provided on an update — this is intentional and correct.
- Existing tests for "returns 400 when host/token is missing" were renamed to make explicit they apply to the create path only (no `id`). Their assertions are unchanged.
