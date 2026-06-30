# Plan

## Plan Audit Cycles
- Audits: none — Plan Auditor v1.5.0
- Architectural Reviews: 1 — Plan Architect Reviewer v1.6.0

## Prior Project Context
The repository has 19 prior projects, all completed and archived. The credential system was introduced with `gitCredentials?: Record<string, string>` in `AppConfig` and has credential injection via `injectCredentials()`, credential stripping via `stripEmbeddedCredentials()`, and a settings UI for per-host PAT management. The current design assumes one token per hostname, which is insufficient for users who operate multiple accounts on the same host (e.g., personal + company GitHub accounts).

## Summary
Extend the Git credentials system from a single-token-per-host model (`Record<string, string>`) to a multi-credential model that supports duplicate hosts with user-specified labels. Add a per-repository credential association so each repository can specify which stored credential to use. When a repository's host matches exactly one credential, auto-select it. Surface clear error messages when repositories fail operations due to missing or unselected credentials.

## Architectural Context

### Current Credential Data Model
- **`AppConfig.gitCredentials`** (`src/config/config.types.ts`): `Record<string, string> | undefined` — maps hostname to PAT. One entry per host.
- **`injectCredentials()`** (`src/git/git-credentials.ts`): Looks up `credentials[hostname]` and injects the token as the WHATWG URL username.
- **`extractHost()`** (`src/git/git-credentials.ts`): Extracts hostname from an HTTPS URL.
- **`parseGitCredentials()`** (`src/config/config.ts`): Validates the `Record<string, string>` shape on config load.

### Credential Consumers
- **`WorkspaceOrchestrator.createWorkspace()`** (`src/orchestration/workspace-orchestrator.ts`, line 136): Calls `injectCredentials(repo.Url, this.config.gitCredentials ?? {})` before `cloneRepository()`.
- **`RepositoryOrchestrator.addRepositoryToProject()`** (`src/orchestration/repository-orchestrator.ts`, line 125): Same pattern.
- **`PollingManager`** (`src/server/pollingManager.ts`): Calls `fetchAndGetStatus()` which calls `fetchRemote()` — currently no credential injection (fetches use whatever remote URL is configured in the clone's `.git/config`).

### REST API for Credentials
- `GET /api/config/credentials` — returns masked `Record<string, string>`
- `PUT /api/config/credentials` — body `{ host, token }` — adds/updates one entry
- `DELETE /api/config/credentials/:host` — removes one entry
- All in `src/server/routes/config.ts`.

### GUI Settings View
- `gui/public/js/views/settings.js` — `buildCredentialsSection()` renders a table with columns [Host, Token, Actions] and an "Add / Update Credential" form with host + token fields.
- Tests in `gui/public/js/views/settings.test.mjs`.

### Repository Model
- `Repository` type (`src/models/repository/repository.types.ts`): `{ Id, Name, Url, credentialsStripped?, LastRefreshedAt? }` — no credential association field.
- `RepositoryManager` (`src/models/repository/repository.manager.ts`): CRUD over `repositories.json`.

### Error Handling
- Clone failures are captured per-repository in `OrchestrationRepoResult` and logged via `ErrorLogManager`.
- The GUI (`workspace-detail.js`) shows toast notifications for clone failures listing the failed repository IDs.

## Approach / Architecture

### 1. New Credential Data Model

Replace the flat `Record<string, string>` with an **array of credential entries**:

```typescript
interface GitCredentialEntry {
    id: string;       // Unique identifier (kebab-case, auto-generated or user-specified)
    label: string;    // User-friendly display name (e.g., "Personal GitHub", "Company GitHub")
    host: string;     // Hostname (e.g., "github.com") — duplicates allowed across entries
    token: string;    // PAT / password (stored in plaintext in config.json, masked in API responses)
}
```

`AppConfig.gitCredentials` changes from `Record<string, string> | undefined` to `GitCredentialEntry[] | undefined`.

### 2. Per-Repository Credential Association

Add an optional `CredentialId` field to the `Repository` type:

```typescript
interface Repository {
    Id: string;
    Name: string;
    Url: string;
    CredentialId?: string;           // References GitCredentialEntry.id
    credentialsStripped?: boolean;   // (existing transient field)
    LastRefreshedAt?: string;        // (existing field)
}
```

### 3. Credential Resolution Logic

A new function `resolveCredentialForRepo()` in `src/git/git-credentials.ts` will handle the resolution:

1. If the repository has a `CredentialId`, look it up in the credentials array. If found, use it. If not found (stale reference), treat as "no credential".
2. If no `CredentialId` is set, find all credentials matching the repository's host. If exactly one match, use it (auto-selection). If zero or multiple matches, return `null` (no credential — requires user selection).

### 4. Updated `injectCredentials()`

The existing `injectCredentials()` function signature changes to accept the resolved token directly rather than the full credentials map. A new overload or companion function will handle the array-based lookup. The actual injection mechanism (WHATWG URL username assignment) remains unchanged.

### 5. Credential-Missing Error Surfacing

When credential resolution returns `null` (ambiguous or absent) during clone/fetch:
- The operation fails fast with a descriptive error message: `"Repository '<name>' requires a credential for host '<host>'. Please select a credential in the repository settings."`
- The error is logged via `ErrorLogManager` with source `'credentials'`.
- The workspace detail view shows these errors clearly — the existing per-repository error reporting in `OrchestrationRepoResult` already surfaces through the toast + health system.

### 6. Backward Compatibility (config.json Migration)

`parseGitCredentials()` in `src/config/config.ts` will accept **both** the old `Record<string, string>` format and the new `GitCredentialEntry[]` format:
- If it encounters a plain object (old format), it auto-migrates each `{ host: token }` entry to a `GitCredentialEntry` with `id` auto-generated from the host (e.g., `github-com`), `label` set to the host, `host` set to the key, and `token` set to the value.
- If it encounters an array (new format), it validates each entry.
- The migrated array is written back to `config.json` on the next `saveConfigField()` call.

## Rationale

- **Array instead of nested map (e.g., `Record<string, Array<{label, token}>>`)**:  An array with explicit `id` fields is simpler to index, reference from repositories, and serialise. A nested map would require compound keys (host + index) for repository references, which is fragile and harder to display in the UI.
- **`CredentialId` on Repository (not on Project or Workspace)**: Credentials are tied to the remote URL, which is a repository-level concern. Different projects reuse the same repository, so the credential binding belongs on the repository.
- **Auto-migration rather than breaking change**: Users have existing `config.json` files. Silent migration preserves backward compatibility without requiring manual intervention.
- **Fail-fast on ambiguous credentials**: Rather than silently picking the first match or falling back to unauthenticated, the system explicitly requires user selection when multiple credentials match. This prevents confusing auth failures.

## Considered Alternatives

| Decision | Chosen Shape | Alternatives Considered | Trade-Off Summary |
|----------|--------------|-------------------------|-------------------|
| Credential storage format | `GitCredentialEntry[]` array with explicit `id` | `Record<string, Array<{label, token}>>` (host-keyed map of arrays) | Array is simpler to index by `id` and reference from Repository; map would need composite keys for references and is harder to iterate in the GUI |
| Credential reference on Repository | `CredentialId?: string` optional field | Credential stored inline on repository; credential resolved purely by host matching | Explicit reference gives deterministic resolution; inline storage duplicates tokens; pure host matching breaks with multiple same-host credentials |
| Backward compatibility | Auto-migrate old format on parse, persist on next save | Breaking change requiring manual migration; separate migration script | Auto-migration is seamless and matches the stateless-read-from-disk pattern already used by all managers |
| Ambiguous credential handling | Fail-fast with descriptive error | Pick first match; prompt during clone | Fail-fast is safest and forces explicit user configuration; prompting is impractical in automated/server contexts |

## Pattern Alignment

- **Stateless managers** (`src/models/*/`): The new `CredentialId` field on `Repository` follows the existing pattern of flat, persisted fields. `RepositoryManager` remains stateless and re-reads on every call.
- **Config field with DEFAULTS** (`src/config/config.ts`): `gitCredentials` is already optional and has no default in `DEFAULTS`. The type change does not require updating the `DEFAULTS` Pick union.
- **Kebab-case IDs** (`src/utils/slug.ts`): Credential IDs will use the same kebab-case validation as repository and project IDs.
- **Token masking in API responses** (`src/server/routes/config.ts`): `buildMaskedCredentials()` will be updated to handle the array format, applying `maskToken()` to each entry's token.
- **`saveConfigField()` caller guard** (`src/config/config.ts`): The route handler already validates the `field` parameter against an allowlist. No departure from this pattern.
- **Error logging pattern** (`src/error-log/`): Credential-missing errors will use the existing `ErrorLogManager.append()` pattern with a new source string `'credentials'`.

## Detailed Steps

### Step 1: Define `GitCredentialEntry` type
- Add `GitCredentialEntry` interface to `src/config/config.types.ts`.
- Change `AppConfig.gitCredentials` from `Record<string, string> | undefined` to `GitCredentialEntry[] | undefined`.

### Step 2: Add `CredentialId` to Repository type
- Add optional `CredentialId?: string` field to `Repository` in `src/models/repository/repository.types.ts`.

### Step 3: Update `RepositoryManager` for credential association
- Add `updateCredential(id: string, credentialId: string | null): Repository` method to `RepositoryManager` in `src/models/repository/repository.manager.ts`. Setting `null` clears the association.
- The `update()` method signature stays unchanged — `CredentialId` changes go through the new dedicated method.

### Step 4: Update config parsing and migration
- Rewrite `parseGitCredentials()` in `src/config/config.ts` to accept both `Record<string, string>` (old) and `GitCredentialEntry[]` (new).
- Old-format entries are auto-migrated: host becomes `id` (sanitised to kebab-case via `inferSlugFromUrl()` or a simple hostname-to-slug transform, e.g., `github.com` → `github-com`), `label` defaults to the host value, `host` and `token` are preserved.
- Validate new-format entries: each must have non-empty `id`, `label`, `host`, and `token` strings; `id` must be valid kebab-case; no duplicate `id` values.

### Step 5: Update `config.dist.json`
- Change `"gitCredentials": {}` to `"gitCredentials": []`.

### Step 6: Update credential resolution in `git-credentials.ts`
- Add new exported function `resolveCredential(url: string, credentials: GitCredentialEntry[], credentialId?: string): GitCredentialEntry | null`.
  - If `credentialId` is provided, find the entry with that `id`. Return it if found, `null` if not.
  - If `credentialId` is not provided, find all entries matching the URL's host. Return the entry if exactly one match, `null` if zero or multiple matches.
- Update `injectCredentials()` signature to accept a single token string instead of a map, or add a new companion function `injectCredentialToken(url: string, token: string): string` that injects a single resolved token. Keep the old `injectCredentials()` signature as a deprecated wrapper during migration, or replace all call sites.
  - **Decision:** Replace call sites. The old map-based signature is removed. The new signature is `injectCredentialToken(url: string, token: string): string`.

### Step 7: Update orchestrators
- **`WorkspaceOrchestrator.createWorkspace()`** (`src/orchestration/workspace-orchestrator.ts`):
  - For each repository, call `resolveCredential(repo.Url, this.config.gitCredentials ?? [], repo.CredentialId)`.
  - If resolution returns `null` and the URL is HTTPS, report a credential-missing error in the `OrchestrationRepoResult` with a descriptive message including the host and a directive to select a credential.
  - If resolution returns a credential, call `injectCredentialToken(repo.Url, credential.token)`.
  - SSH URLs bypass credential injection entirely (existing behaviour).
- **`RepositoryOrchestrator.addRepositoryToProject()`** (`src/orchestration/repository-orchestrator.ts`): Same changes as above.

### Step 8: Update REST API — credential endpoints
- **`GET /api/config/credentials`**: Return `GitCredentialEntry[]` with tokens masked (apply `maskToken()` to each entry's `token` field). Response shape changes from `Record<string, string>` to `Array<{ id, label, host, token }>`.
- **`PUT /api/config/credentials`**: Body changes from `{ host, token }` to `{ id?, label, host, token }`. If `id` is omitted, auto-generate from label (kebab-case). If the generated ID already exists in the array, append a numeric suffix (`-2`, `-3`, …) until a free slot is found. Validate no duplicate `id`. Replace the entry if `id` already exists (upsert semantics).
- **`DELETE /api/config/credentials/:host`** → **`DELETE /api/config/credentials/:id`**: Delete by credential `id` instead of host. The route parameter changes from `:host` to `:id`.

### Step 9: Add REST API — repository credential association
- Add the two new routes to the existing `registerRepositoryRoutes()` in `src/server/routes/repositories.ts` (this file already exists).
- **Update the function signature** to accept `appConfig` in addition to the existing `router` and `repoManager` parameters, since credential validation and lookup require access to `appConfig.gitCredentials`. Do **not** add `configPath` — neither new route calls `saveConfigField()`; both write through `repoManager` or read from `appConfig` only.
- **Update the wiring** in `src/server/index.ts` where `registerRepositoryRoutes(router, repoManager)` is called — pass `config.appConfig` as the additional argument.
- **`PUT /api/repositories/:id/credential`**: Body `{ credentialId: string | null }`. Sets or clears the credential association. Validates that `credentialId` references an existing credential entry in `appConfig.gitCredentials`. Returns the updated repository.
- **`GET /api/repositories/:id/credential-options`**: Returns the list of credentials matching the repository's host (for the GUI dropdown). Response: `{ credentials: GitCredentialEntry[] (masked), autoSelected?: string (id of auto-selected credential if exactly one match) }`.

### Step 10: Update GUI — settings credentials section
- **Table columns**: Change from [Host, Token, Actions] to [Label, Host, Token, Actions].
- **Add form**: Add a "Label" field (required). Keep Host and Token fields. Remove the "Add / Update" toggle wording — the form now always creates a new entry (no upsert by host). Change button text to "Add Credential".
- **Edit (inline)**: Add an "Edit" button per credential row in the Actions column (matching the inline-edit pattern used in the repositories table in `gui/public/js/views/repositories.js`). Clicking "Edit" switches the Label cell to an inline `<input>` and shows a Token `<input type="password">` field. Host is read-only (changing the host would be a new credential). Clicking "Save" calls `PUT /api/config/credentials` with the existing `id` to update the entry.
- **Delete**: Delete by credential `id` instead of host.
- **renderCredentialsTable()**: Iterate over the array instead of `Object.entries()`.
- **API client rename**: Rename `api.config.credentials.set()` to `api.config.credentials.add()` in `gui/public/js/api.js` to reflect that it always creates a new entry rather than upserting by host. Add `api.config.credentials.update(id, data)` for inline edits. Update the JSDoc return type from `Record<string, string>` to array format.

### Step 11: Update `normaliseRepo()` utility
- Update `normaliseRepo()` in `gui/public/js/utils/normalise.js` to map the `CredentialId` field to `credentialId` (following the existing Go-capitalised → camelCase normalisation pattern for `Id` → `id`, `Name` → `name`, etc.). Without this, the repository detail view's credential selector won't see the stored credential association.

### Step 12: Update GUI — repository credential selector
- In the **repository list view** (`gui/public/js/views/repositories.js`) or **repository detail view** (`gui/public/js/views/repository-detail.js`): Add a credential selector UI.
- Best location: **repository detail view** (`#/repositories/:id`). Add a "Credential" section showing:
  - A `<select>` dropdown populated from `GET /api/repositories/:id/credential-options`. Options: "None" + each matching credential (shown as `label (host)`).
  - If auto-selected (exactly one host match), pre-select it and show an "(auto)" indicator.
  - If manually selected (stored `CredentialId`), pre-select that entry.
  - On change, call `PUT /api/repositories/:id/credential` to persist the selection.
- Also show the current credential status in the **repository list view** table: a small indicator (e.g., a lock icon or text) showing whether a credential is assigned.
- **Consistency — project-detail repository table:** `gui/public/js/views/project-detail.js` renders its own repository table (Name, ID, Actions) in `buildRepositoriesSection()`. Add the same credential status indicator to each row there. This gives users visibility into missing credentials at the point where they configure the project — before they trigger a workspace setup that would fail. The indicator can be the same badge/icon used in the repositories list view.

### Step 13: Update GUI — credential deletion warning
- In `gui/public/js/views/settings.js`, when the user clicks "Delete" on a credential row, before showing the confirmation dialog, call `GET /api/repositories` to check if any repositories have `CredentialId` matching the credential being deleted.
- If referencing repositories exist, augment the confirmation dialog message: _"Remove credential '{label}'? {N} repository/repositories currently use this credential and will lose their credential association."_
- If no repositories reference the credential, use the simpler message: _"Remove credential '{label}' for host '{host}'? This action cannot be undone."_

### Step 14: Update GUI — credential-missing error display
- In **workspace-detail.js**, the existing `runSetup()` function already surfaces per-repo clone failures via toast. Enhance the error message to specifically mention credential issues when the error message contains the credential-missing sentinel text.
- In the **workspace status table**, if a repository's clone error indicates a credential issue, show a distinctive error state (e.g., "Missing Credential" badge with a link to the repository detail view where the user can fix it).

### Step 15: Update `buildMaskedCredentials()` helper
- Change `buildMaskedCredentials()` in `src/server/routes/config.ts` to accept `GitCredentialEntry[] | undefined` and return `GitCredentialEntry[]` with masked tokens.

### Step 16: Update existing tests
- **`src/tests/git-credentials.test.ts`**: Update tests for `injectCredentials()` → `injectCredentialToken()` rename. Add tests for `resolveCredential()`.
- **`src/server/__tests__/routes/config.test.ts`**: Update credential route tests for new request/response shapes.
- **`gui/public/js/views/settings.test.mjs`**: Update for new table columns and form fields.

### Step 17: Add new tests
- **`src/tests/git-credentials.test.ts`** — `resolveCredential()`:
  - Returns the credential when `credentialId` matches.
  - Returns `null` when `credentialId` does not match any entry.
  - Returns the single credential when host matches exactly one entry (no `credentialId`).
  - Returns `null` when host matches zero entries (no `credentialId`).
  - Returns `null` when host matches multiple entries (no `credentialId`).
- **`src/tests/config.test.ts`**: Add tests for `parseGitCredentials()` migration from old `Record<string, string>` format to new `GitCredentialEntry[]` format.
- **`src/tests/repository.manager.test.ts`**: Add tests for `updateCredential()`.
- **`src/server/__tests__/routes/config.test.ts`**: Add tests for the new credential CRUD flow with array format.
- **Orchestrator tests**: Add tests verifying credential-missing error propagation for repos without assigned credentials when multiple same-host credentials exist.

## Dependencies
- No external dependencies are introduced. All changes use existing infrastructure (Node.js built-in test runner, TypeScript, vanilla JS for GUI).

## Required Components

### Modified Files
- `src/config/config.types.ts` — new `GitCredentialEntry` type, changed `AppConfig.gitCredentials`
- `src/config/config.ts` — updated `parseGitCredentials()`, migration logic
- `src/models/repository/repository.types.ts` — new `CredentialId` field
- `src/models/repository/repository.manager.ts` — new `updateCredential()` method
- `src/git/git-credentials.ts` — new `resolveCredential()`, renamed `injectCredentialToken()`
- `src/orchestration/workspace-orchestrator.ts` — updated credential injection calls
- `src/orchestration/repository-orchestrator.ts` — updated credential injection calls
- `src/server/routes/config.ts` — updated credential endpoints and `buildMaskedCredentials()`
- `config.dist.json` — `gitCredentials` value changed from `{}` to `[]`
- `gui/public/js/api.js` — updated `api.config.credentials` methods, new `api.repositories.updateCredential()` / `api.repositories.credentialOptions()`
- `gui/public/js/views/settings.js` — updated credentials section
- `gui/public/js/views/repository-detail.js` — new credential selector section
- `gui/public/js/views/repositories.js` — credential status indicator in list
- `gui/public/js/views/project-detail.js` — credential status indicator in the project repositories table (`buildRepositoriesSection()`)
- `gui/public/js/views/workspace-detail.js` — enhanced credential-missing error display
- `src/server/routes/repositories.ts` — new credential routes added to existing `registerRepositoryRoutes()`, updated function signature
- `src/server/index.ts` — updated `registerRepositoryRoutes()` call to pass `config.appConfig`
- `gui/public/js/utils/normalise.js` — `normaliseRepo()` updated to map `CredentialId` → `credentialId`

### Modified Test Files
- `src/tests/git-credentials.test.ts`
- `src/tests/config.test.ts`
- `src/tests/repository.manager.test.ts`
- `src/server/__tests__/routes/config.test.ts`
- `src/server/__tests__/routes/repositories.test.ts`
- `gui/public/js/views/settings.test.mjs`
- `gui/public/js/views/repository-detail.test.mjs` — add tests for the credential selector section added in Step 12
- `gui/public/js/views/repositories.test.mjs` — add tests for the credential status indicator column added in Step 12
- `gui/public/js/__tests__/normalise.test.mjs` — add a test asserting `normaliseRepo()` maps `CredentialId` → `credentialId`
- `gui/public/js/api.config.test.mjs` — add tests for the new/renamed credential client methods: `add()`, `update(id, data)`, `remove(id)`; and `api.repositories.updateCredential()` / `credentialOptions()` (currently no credential coverage in this file)

## Assumptions
- Credential IDs are globally unique within the `gitCredentials` array. Two credentials cannot share the same `id` even if they have different hosts.
- The `CredentialId` on a repository is a soft reference — if the referenced credential is deleted, the field becomes a stale pointer and is treated as "no credential" (graceful degradation, not an error).
- SSH URLs continue to bypass the entire credential injection system. Only HTTPS URLs participate.
- The polling manager (`fetchAndGetStatus`) does not need credential injection because the remote URL in `.git/config` already has credentials embedded at clone time by `injectCredentialToken()`. The `fetch` command uses whatever URL is stored in the git config.
- Users can have credentials with duplicate hosts but not duplicate IDs. Labels are not required to be unique (two credentials may share the same label, e.g. two entries both named "GitHub" for different tokens).

## Constraints
- **Token masking rule**: All API responses returning credential data must mask tokens via `maskToken()`. No plaintext tokens in API responses, logs, or error messages.
- **Credential injection lifetime contract**: `injectCredentialToken()` must only be called immediately before a git subprocess invocation — never stored or returned through API boundaries.
- **`stripEmbeddedCredentials()` on stderr**: All code paths surfacing `GitResult.stderr` in thrown Error messages, log output, or API responses must apply `stripEmbeddedCredentials()` to the stderr string first. (Existing constraint — unchanged.)
- **No duplicate credential IDs**: The credentials array must not contain two entries with the same `id`. Enforced at both `parseGitCredentials()` and the PUT endpoint.
- **Config migration must be idempotent**: Re-running `loadConfig()` on an already-migrated config must produce the same result.

## Out of Scope
- SSH key management or SSH credential injection.
- Credential encryption at rest (tokens remain plaintext in `config.json`, as they are today).
- OAuth flows or interactive credential prompts.
- Credential validation (testing that a token actually works against the host).
- Multi-user / multi-tenant credential isolation.
- Credential injection into the polling manager's `fetchRemote()` calls (the git remote URL already contains the token from clone time).

## Acceptance Criteria
- AC1: Multiple credentials can be stored for the same host (e.g., two entries for `github.com` with different labels and tokens).
- AC2: Each credential has a unique `id` and a user-specified `label` for differentiation.
- AC3: Repositories have an optional `CredentialId` field that associates them with a specific stored credential.
- AC4: When a repository's host matches exactly one stored credential, the credential is auto-selected in the GUI dropdown.
- AC5: When a repository's host matches multiple credentials and no `CredentialId` is set, clone/fetch operations fail with a descriptive error message directing the user to select a credential.
- AC6: The workspace detail view clearly surfaces credential-missing errors for repositories that fail to initialize.
- AC7: Existing `config.json` files with the old `Record<string, string>` format are seamlessly migrated to the new `GitCredentialEntry[]` format on load.
- AC8: API responses never expose plaintext tokens — all credential listing endpoints return masked tokens.
- AC9: The GUI settings page allows adding, viewing, editing, and deleting credentials with label, host, and token fields.
- AC10: The repository detail view provides a credential selection dropdown for choosing among matching credentials.
- AC11: Existing credential label and token can be edited inline from the settings credentials table without deleting and re-creating the entry.
- AC12: When deleting a credential that is referenced by one or more repositories, the confirmation dialog warns the user about affected repositories.

## Testing Strategy

Testing follows the existing project patterns: Node.js built-in test runner for backend, jsdom-based tests for GUI.

**Unit tests** cover the core credential resolution logic (`resolveCredential()`), config migration (`parseGitCredentials()` with old and new formats), repository credential association (`updateCredential()`), and the renamed `injectCredentialToken()`.

**Integration tests** cover the REST API endpoints (credential CRUD with array format, repository credential association endpoint) using the existing mock HTTP pattern in `src/server/__tests__/`.

**GUI tests** cover the updated settings credentials section (new table columns, add form with label field) and the repository detail credential selector.

## Test Plan

- `src/tests/git-credentials.test.ts` — `resolveCredential()` returns matching credential when `credentialId` matches — AC3
- `src/tests/git-credentials.test.ts` — `resolveCredential()` returns `null` when `credentialId` references a non-existent entry — AC5
- `src/tests/git-credentials.test.ts` — `resolveCredential()` returns the sole credential when host matches exactly one entry and no `credentialId` is provided — AC4
- `src/tests/git-credentials.test.ts` — `resolveCredential()` returns `null` when host matches zero entries — AC5
- `src/tests/git-credentials.test.ts` — `resolveCredential()` returns `null` when host matches multiple entries and no `credentialId` is provided — AC5
- `src/tests/git-credentials.test.ts` — `injectCredentialToken()` injects the token as a URL username (replaces old `injectCredentials()` tests) — AC3
- `src/tests/config.test.ts` — `parseGitCredentials()` migrates old `Record<string, string>` format to `GitCredentialEntry[]`, preserving host and token — AC7
- `src/tests/config.test.ts` — `parseGitCredentials()` migration is idempotent (re-parsing an already-migrated array produces the same result) — AC7
- `src/tests/config.test.ts` — `parseGitCredentials()` rejects arrays with duplicate `id` values — AC2
- `src/tests/config.test.ts` — `parseGitCredentials()` rejects entries with empty required fields — AC2
- `src/tests/repository.manager.test.ts` — `updateCredential()` sets `CredentialId` on the repository and persists it — AC3
- `src/tests/repository.manager.test.ts` — `updateCredential()` clears `CredentialId` when called with `null` — AC3
- `src/server/__tests__/routes/config.test.ts` — `GET /api/config/credentials` returns `GitCredentialEntry[]` with masked tokens — AC8
- `src/server/__tests__/routes/config.test.ts` — `PUT /api/config/credentials` with a new `id` adds a new entry — AC1, AC2
- `src/server/__tests__/routes/config.test.ts` — `PUT /api/config/credentials` with an existing `id` updates the entry — AC11
- `src/server/__tests__/routes/config.test.ts` — `DELETE /api/config/credentials/:id` removes the entry by `id` — AC9
- `src/server/__tests__/routes/repositories.test.ts` — `PUT /api/repositories/:id/credential` sets `CredentialId` and validates it references an existing credential — AC3
- `src/server/__tests__/routes/repositories.test.ts` — `GET /api/repositories/:id/credential-options` returns credentials matching the repository host with `autoSelected` id when exactly one match — AC4
- `src/tests/workspace-orchestrator.test.ts` / `src/tests/repository-orchestrator.test.ts` — clone fails with a descriptive credential-missing error when multiple same-host credentials exist and no `CredentialId` is set — AC5, AC6
- `gui/public/js/views/settings.test.mjs` — credentials table renders Label, Host, Token, Actions columns — AC9
- `gui/public/js/views/settings.test.mjs` — add credential form includes a Label field — AC9
- `gui/public/js/views/settings.test.mjs` — delete confirmation dialog includes affected-repository count when repositories reference the credential — AC12
- `gui/public/js/views/repository-detail.test.mjs` — credential selector section renders a dropdown with matching credentials — AC10
- `gui/public/js/views/repository-detail.test.mjs` — dropdown pre-selects the stored `CredentialId` entry when one is set — AC10
- `gui/public/js/views/repositories.test.mjs` — credential status indicator renders in the repository row when `credentialId` is set — AC3
- `gui/public/js/__tests__/normalise.test.mjs` — `normaliseRepo()` maps `CredentialId` → `credentialId` — AC3
- `gui/public/js/api.config.test.mjs` — `api.config.credentials.add()` sends `PUT /api/config/credentials` with correct body — AC9
- `gui/public/js/api.config.test.mjs` — `api.config.credentials.update(id, data)` sends `PUT /api/config/credentials` with the existing `id` — AC11
- `gui/public/js/api.config.test.mjs` — `api.config.credentials.remove(id)` sends `DELETE /api/config/credentials/:id` — AC9
- `gui/public/js/api.config.test.mjs` — `api.repositories.updateCredential(id, credentialId)` sends `PUT /api/repositories/:id/credential` — AC3

## Documentation Updates

- `docs/agents/project-manifest/api-surface.md` — add `GitCredentialEntry` interface; document `resolveCredential()` export; record `injectCredentials()` → `injectCredentialToken()` rename; add `RepositoryManager.updateCredential()` method
- `docs/agents/project-manifest/rest-api.md` — update `PUT /api/config/credentials` body shape; update `DELETE /api/config/credentials/:host` → `DELETE /api/config/credentials/:id`; update `GET /api/config/credentials` response shape from `Record<string, string>` to `GitCredentialEntry[]`; add `PUT /api/repositories/:id/credential` and `GET /api/repositories/:id/credential-options` endpoints
- `docs/agents/project-manifest/data-flows.md` — add credential resolution as a named step in the workspace creation and repository clone data flows (after URL extraction, before `injectCredentialToken()`)
- `.context/project-folder-structure.md` — no new directories are added; re-run `ctx generate` only if the dev confirms a new file is placed in a location not already covered

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Stale `CredentialId` after credential deletion** | Resolution treats a non-matching `CredentialId` as "no credential" (graceful degradation). The deletion confirmation dialog warns the user which repositories will lose their association (Step 13), giving them the opportunity to reassign before deleting. |
| **Config migration writes back unexpected data** | `parseGitCredentials()` migration is pure (read-only transform); the migrated array is only persisted on the next `saveConfigField()` call triggered by a user action. No background rewrite occurs silently. |
| **Duplicate IDs introduced by migration** | Auto-generated IDs from hostnames (e.g., `github-com`) are deterministic. If two entries share the same host in the old format, they produce the same candidate ID; the migration must de-duplicate by appending a counter suffix (e.g., `github-com-2`). Add this to `parseGitCredentials()` and cover with a test. |
| **PUT `/api/config/credentials` upsert confusion** | The endpoint uses the `id` field as the upsert key. The GUI "Add Credential" form always omits an existing `id`, ensuring new entries are always created. The "Edit" inline form always includes the existing `id`. This separation prevents accidental overwrites. |
| **`injectCredentialToken()` token exposure in git subprocess error output** | The `stripEmbeddedCredentials()` call on `GitResult.stderr` is already required by the existing constraint. No new exposure path is introduced because the injection point is the same as before — only the API shape changes. |
| **`normaliseRepo()` change breaks views that destructure the result** | `normaliseRepo()` only adds a new optional `credentialId` field; existing destructuring in `workspace-detail.js`, `repositories.js`, and `project-detail.js` is unaffected. The `__tests__/normalise.test.mjs` test addition will confirm no regression. |

**Manual testing** for the full end-to-end flow: add two credentials for the same host, create a repository for that host, observe the credential selector, select a credential, set up a workspace, verify successful clone.

## Test Plan

- `src/tests/git-credentials.test.ts` — `resolveCredential()` returns correct entry by credentialId — AC3
- `src/tests/git-credentials.test.ts` — `resolveCredential()` returns null for unknown credentialId — AC5
- `src/tests/git-credentials.test.ts` — `resolveCredential()` auto-selects single host match — AC4
- `src/tests/git-credentials.test.ts` — `resolveCredential()` returns null for zero host matches — AC5
- `src/tests/git-credentials.test.ts` — `resolveCredential()` returns null for multiple host matches without credentialId — AC5
- `src/tests/git-credentials.test.ts` — `injectCredentialToken()` injects token into HTTPS URL — AC3
- `src/tests/git-credentials.test.ts` — `injectCredentialToken()` returns original for non-HTTPS URL — AC3
- `src/tests/config.test.ts` — `parseGitCredentials()` migrates old Record format to GitCredentialEntry[] — AC7
- `src/tests/config.test.ts` — `parseGitCredentials()` validates new array format — AC2
- `src/tests/config.test.ts` — `parseGitCredentials()` rejects duplicate IDs — AC2
- `src/tests/config.test.ts` — `parseGitCredentials()` passes through valid array unchanged — AC7
- `src/tests/repository.manager.test.ts` — `updateCredential()` sets CredentialId on repository — AC3
- `src/tests/repository.manager.test.ts` — `updateCredential()` clears CredentialId when null — AC3
- `src/server/__tests__/routes/config.test.ts` — GET /api/config/credentials returns masked array — AC8
- `src/server/__tests__/routes/config.test.ts` — PUT /api/config/credentials creates new entry with auto-generated id — AC1, AC2
- `src/server/__tests__/routes/config.test.ts` — PUT /api/config/credentials rejects duplicate id — AC2
- `src/server/__tests__/routes/config.test.ts` — DELETE /api/config/credentials/:id removes entry by id — AC1
- `src/server/__tests__/routes/repositories.test.ts` — PUT /api/repositories/:id/credential sets credential association — AC3
- `src/server/__tests__/routes/repositories.test.ts` — GET /api/repositories/:id/credential-options returns matching credentials — AC4
- `gui/public/js/views/settings.test.mjs` — Credentials table renders Label, Host, Token, Actions columns — AC9
- `gui/public/js/views/settings.test.mjs` — Add credential form includes Label field — AC9
- `gui/public/js/views/settings.test.mjs` — Edit button on credential row enables inline label/token editing — AC11
- `gui/public/js/views/settings.test.mjs` — Delete credential shows warning when repositories reference the credential — AC12
- `src/server/__tests__/routes/repositories.test.ts` — PUT /api/repositories/:id/credential validates credentialId exists — AC3
- `src/server/__tests__/routes/repositories.test.ts` — GET /api/repositories/:id/credential-options returns only host-matching credentials — AC4

## Documentation Updates

- `docs/agents/project-manifest/api-surface.md` — Add `GitCredentialEntry` type, update `AppConfig.gitCredentials` type, add `resolveCredential()` and `injectCredentialToken()` signatures, add `RepositoryManager.updateCredential()`, update `Repository` type with `CredentialId`
- `docs/agents/project-manifest/rest-api.md` — Update credential endpoint request/response shapes, add `PUT /api/repositories/:id/credential` and `GET /api/repositories/:id/credential-options` endpoints
- `docs/agents/project-manifest/data-flows.md` — Update "Credential-Bearing Git Operation" flow diagram to show `resolveCredential()` step and credential-missing error path
- `docs/agents/project-manifest/gui-frontend.md` — Update settings view description (new table columns, label field, inline edit), add repository detail credential selector description, update `api.config.credentials` method signatures (`.set()` → `.add()` + new `.update()`), add `api.repositories.updateCredential()` and `api.repositories.credentialOptions()`, document `normaliseRepo()` CredentialId mapping
- `docs/agents/project-manifest/constraints.md` — Update token masking rule to reference array format, add constraint for no duplicate credential IDs
- `.context/project-folder-structure.md` — Re-run `ctx generate` if new source files are added

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Config migration breaks existing setups** | `parseGitCredentials()` accepts both formats and only writes the new format on the next `saveConfigField()` call. Existing configs continue to work until the user modifies a credential via the GUI. Unit tests cover both migration paths. |
| **Stale `CredentialId` references after credential deletion** | `resolveCredential()` returns `null` for unknown IDs, which triggers the same credential-missing error path as having no credential set. The GUI credential selector reflects the actual state by fetching fresh data. The deletion confirmation dialog warns users about affected repositories so they can reassign credentials proactively. |
| **Breaking API change for `GET /api/config/credentials`** | The response shape changes from `Record<string, string>` to `Array<{id, label, host, token}>`. Since the only consumer is the GUI (same codebase), this is a coordinated change with no external API consumers at risk. |
| **Credential-missing errors confuse users** | Error messages include the specific host and a directive to select a credential in the repository settings. The workspace detail view links to the repository detail view where the fix can be applied. |
| **Duplicate credential IDs during migration** | If the old format has multiple hosts that sanitise to the same kebab-case ID (unlikely but possible, e.g., `github.com` and `github-com` as literal keys), append a numeric suffix to disambiguate. |
