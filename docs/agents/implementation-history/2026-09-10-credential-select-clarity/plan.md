# Plan

## Summary

Fix confusing credential-selection behavior in the repository create/edit modal (`components/repository-modal.js`) and the repository detail page's Credential section (`views/repository-detail.js`). Reported directly by the user, not from a prior research/audit cycle — this is a slim, retroactively-recorded plan covering an ad-hoc bug-fix session.

## Problem

The user reported: "The credential selection in the create/edit repository dialog works strangely: In some, only 'None' is available, in others only one of the configured credentials is selectable."

Investigation (live against the running GUI) confirmed the underlying behavior is filtering by host, working as designed, but with two problems:
1. **No explanation for empty/single-option states.** The select silently shows only "None" when a repository's URL isn't HTTPS (`extractHost()` only matches `https:`) or when no configured credential matches the host — both look identical and unexplained.
2. **Auto-preselection contradicted the repositories list.** A repository with no stored `CredentialId` but exactly one host-matching credential had that credential silently pre-selected in the modal, while the repositories list still showed "No credential configured" for the same row — a direct inconsistency raised by the user as a follow-up in the same session.

## Scope

- `gui/public/js/components/repository-modal.js` — credential `<select>` behavior and a new explanatory hint.
- `gui/public/js/views/repository-detail.js` — the analogous Credential section on the repository detail page (same underlying issue, confirmed present, fixed for consistency at the user's request).
- Associated unit tests (`repository-modal.test.mjs`, `repository-detail.test.mjs`).
- `docs/agents/project-manifest/gui-frontend.md` — documentation kept in sync with the behavior change.

Out of scope: the backend host-matching/filtering logic itself (`src/server/routes/repositories.ts`, `src/git/git-credentials.ts`) — confirmed working as designed; a related host-casing gap was logged as a follow-up insight, not fixed.

## Approach

1. Add a hint `<span>` under the credential select (both surfaces) that explains empty results: non-HTTPS URL scheme vs. no host match.
2. Remove the auto-preselect fallback in `computeSelectedCredentialId()` (modal) and the equivalent logic in `buildCredentialSection()` (detail page) — only a stored credential ID pre-selects an option now.
3. Label the sole auto-matched option with a `(recommended match)` suffix in both surfaces, so the recommendation stays visible without being forced.
4. Update/add unit tests and sync the affected GUI documentation.
