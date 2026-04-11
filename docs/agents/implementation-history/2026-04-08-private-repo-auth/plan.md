# Plan

## Summary

Add support for cloning and fetching private repositories over HTTPS by introducing an optional `gitCredentials` host-to-token mapping in `config.json`, injecting credentials into clone URLs at the orchestrator layer, preventing silent authentication hangs, improving clone-failure visibility in the GUI, and providing a **GUI Settings view** for managing credentials without editing JSON files. The solution is fully cross-platform (Windows, macOS, Linux).

## Architectural Context

The tool's git operations follow a strict layered architecture:

1. **`runGit()`** ([src/git/git-cli.ts](src/git/git-cli.ts)) — spawns `git` with `shell: false` and `stdio: ['ignore', 'pipe', 'pipe']`. Inherits `process.env` (no explicit `env` override), so SSH agents and credential helpers are available. However, `stdin: 'ignore'` means Git cannot prompt interactively for credentials — it silently fails.

2. **`cloneRepository()`** ([src/git/git-clone.ts](src/git/git-clone.ts)) — validates URLs against an allowlist of safe transport protocols, builds the `git clone` argument array, and delegates to `runGit()`. Accepts `CloneOptions` (depth, branch, bare, timeoutMs).

3. **`fetchRemote()`** ([src/git/git-branch.ts](src/git/git-branch.ts#L189)) — runs `git fetch origin` in a cloned repo directory. Reads the remote URL from the clone's `.git/config`, so authentication persisted in the remote URL at clone time carries forward automatically.

4. **Orchestrators** ([src/orchestration/](src/orchestration/)) — `WorkspaceOrchestrator.createWorkspace()` and `RepositoryOrchestrator.addRepositoryToProject()` call `cloneRepository()` with `repo.Url` from the data model.

5. **PollingManager** ([src/server/pollingManager.ts](src/server/pollingManager.ts)) — periodically calls `fetchAndGetStatus()` → `fetchRemote()` → `git fetch origin`. Uses the remote URL already in the clone's `.git/config`.

6. **Data model** — `Repository.Url` is stored in `data/storage/repositories.json`, which is **tracked in git** (not gitignored). `config.json` **is** gitignored.

7. **GUI error surfacing** — Workspace setup clone failures are shown as a warning toast with failed repo names, but the actual git error message (e.g. "Authentication failed") is not displayed to the user. The GUI's project-detail view ([gui/public/js/views/project-detail.js](gui/public/js/views/project-detail.js)) only shows repository IDs, not the `error` string from `OrchestrationRepoResult`.

8. **GUI architecture** — Vanilla JS SPA with hash-based routing ([gui/public/js/router.js](gui/public/js/router.js)). Views are registered in [gui/public/js/app.js](gui/public/js/app.js) via `router.register(pattern, viewFunction)`. Navigation links live in the `<nav class="nav-links">` section of [gui/public/index.html](gui/public/index.html). The API client ([gui/public/js/api.js](gui/public/js/api.js)) centralises all backend HTTP calls. Currently five route groups exist (dashboard, repositories, project-detail, workspace-detail, branch-switch) — there is no settings or configuration view.

9. **Config system** — `loadConfig()` in [src/config/config.ts](src/config/config.ts) reads `config.json` once at startup and returns an immutable `AppConfig` object. There is no runtime update capability and no REST API for configuration. The `writeJsonFile()` utility in [src/storage/json-storage.ts](src/storage/json-storage.ts) is available for persisting JSON data to disk.

### Current authentication status

| Method | Works today? | Notes |
|--------|-------------|-------|
| SSH URL (`git@github.com:...`) with loaded SSH agent | Yes | `git@` is in the URL allowlist; `SSH_AUTH_SOCK` inherited via `process.env` |
| HTTPS with macOS Keychain / credential helper | Yes | Credential helper runs non-interactively |
| HTTPS with embedded PAT (`https://TOKEN@github.com/...`) | Yes | Works but token ends up in `repositories.json` (tracked in git — **security risk**) |
| HTTPS without credential helper | **No** | `stdin: 'ignore'` kills the interactive prompt; Git hangs until the 2-minute clone timeout |

### Cross-platform considerations

| Aspect | Windows | macOS | Linux | Impact on this plan |
|--------|---------|-------|-------|---------------------|
| `GIT_TERMINAL_PROMPT=0` | Supported (Git 2.3+) | Supported | Supported | No platform branching needed |
| `process.env` spreading in `spawn()` | Works — Node.js handles env internally | Works | Works | No platform branching needed |
| `shell: false` in `spawn()` | Works — Node.js spawns directly | Works | Works | Already used, no change |
| Token in process args (`ps`) | Hard to inspect (no `ps` equivalent by default) | Visible via `ps auxww` | Visible via `ps auxww` | Acceptable for local dev tool |
| `config.json` path resolution | `path.resolve()` handles `\` separators | Works | Works | Existing `getConfigPath()` uses `path.join()` — already cross-platform |
| URL parsing (`new URL()`) | Standard V8 implementation | Same | Same | Safe to use for hostname extraction |
| Credential helpers (Git system-level) | Git Credential Manager (GCM) | macOS Keychain via `osxkeychain` | `libsecret` / `store` / none | Our feature fills the gap when no system helper is available |

## Approach / Architecture

### Core idea: credential injection at the orchestrator layer

Store per-host tokens in `config.json` (already gitignored). At clone time, the orchestrator layer resolves credentials for the target URL's hostname and rewrites the URL to embed the token before passing it to `cloneRepository()`. The data model (`repositories.json`) always stores the clean, token-free URL.

This approach is chosen because:
- **Fetch/poll operations need zero changes.** Once cloned with a token-bearing URL, the remote URL in `.git/config` retains the token. All subsequent `git fetch origin` calls (from `PollingManager` and branch operations) authenticate automatically without any code changes.
- **The git layer stays credential-agnostic.** No changes to `runGit()`, `cloneRepository()`, or `fetchRemote()` signatures.
- **Security is maintained.** Tokens live only in `config.json` (gitignored) and in cloned repos' `.git/config` (in the user's local projects folder, not in the tool's repo).
- **Cross-platform by design.** URL rewriting via `new URL()` and `GIT_TERMINAL_PROMPT=0` work identically on Windows, macOS, and Linux. No platform-specific credential helper scripts or OS keychain integration required.

### GUI credential management

A new **Settings** view in the GUI provides a user-friendly interface for managing `gitCredentials` entries without manually editing `config.json`:

- **REST API endpoints** (`GET /api/config/credentials`, `PUT /api/config/credentials`) allow reading (with masked tokens) and updating the credential map.
- **Settings view** ([gui/public/js/views/settings.js](gui/public/js/views/settings.js)) renders a table of configured hosts, an add-entry form, and per-entry delete actions.
- **Config persistence** — Changes are written to both the in-memory `AppConfig` and the `config.json` file on disk, taking effect immediately for subsequent clone operations without a server restart.

### Complementary measures

1. **`GIT_TERMINAL_PROMPT=0`** — Set in the spawned git environment to make Git fail fast with a clear error instead of hanging for 2 minutes when no credentials are available. Works on all platforms.
2. **GUI error detail** — Show the actual git stderr message in the clone failure toast, not just the repo name.
3. **URL credential stripping** — When adding a repository, strip embedded credentials from the URL before storing it, and log a warning directing the user to Settings or `config.json`.

## Rationale

- **URL rewriting vs. `GIT_ASKPASS` / `GIT_CONFIG_COUNT` env vars:** URL rewriting is simpler and self-contained. The token persists in the clone's `.git/config`, so fetch/poll operations work without modification. `GIT_ASKPASS` would require a platform-specific helper script (`.sh` on Unix, `.cmd` on Windows) and passing credentials for every git operation, including background polling — significantly more invasive and not uniformly cross-platform.
- **Per-host vs. per-repository credentials:** Per-host is simpler and covers the common case (one account per forge). Per-repo support could be added later if needed.
- **Storing credentials in `config.json` vs. a separate secrets file:** `config.json` is already gitignored and is the established location for user-specific configuration. A separate file adds complexity without meaningful security benefit for a local developer tool.
- **GUI Settings view vs. manual JSON editing:** The user explicitly requested GUI-integrated configuration for easy setup. A dedicated Settings view is the natural fit with the existing SPA architecture and follows the same patterns as the Repositories view (CRUD table + form).
- **Masked tokens in GET response:** The `GET /api/config/credentials` endpoint returns only the last 4 characters of each token (e.g. `"••••xxxx"`). This prevents token leakage via the browser's network inspector or accidental screenshots while still allowing the user to identify which token is configured. The server binds to `127.0.0.1` only, but defense-in-depth is appropriate for secrets.

## Detailed Steps

### Step 1: Extend `AppConfig` with `gitCredentials`

Add an optional `gitCredentials` field to the `AppConfig` interface in [src/config/config.types.ts](src/config/config.types.ts):

```typescript
/**
 * Optional mapping of hostnames to personal access tokens for HTTPS
 * authentication with private repositories. The key is the hostname
 * (e.g. "github.com"), the value is the token string.
 *
 * Tokens are injected into clone URLs at runtime and are never stored
 * in the repository data model. This field should only be set in
 * config.json (which is gitignored).
 */
gitCredentials?: Record<string, string>;
```

### Step 2: Load `gitCredentials` in `loadConfig()`

Update [src/config/config.ts](src/config/config.ts) to read and validate the new field:
- When present, verify it is a plain object with string keys and string values.
- When absent, default to `undefined`.
- No empty-string token values allowed.

### Step 3: Add `saveConfigField()` to config module

Add a new function to [src/config/config.ts](src/config/config.ts):

```typescript
/**
 * Reads the current `config.json` from disk, updates a single field,
 * and writes the file back. Uses `readJsonFile()` / `writeJsonFile()`
 * for atomic read-modify-write.
 *
 * This is intentionally field-granular (not full-config) to avoid
 * accidentally overwriting unrelated fields or editorial comments.
 */
export function saveConfigField(fieldName: string, value: unknown, configPath?: string): void;
```

This function:
- Reads the raw `config.json` (preserving all fields including `_instructions`).
- Sets or deletes the specified field.
- Writes back via `writeJsonFile()`.

### Step 4: Update `config.dist.json`

Add the field with an empty object:

```json
"gitCredentials": {}
```

### Step 5: Create credential resolution utility

New file: `src/git/git-credentials.ts`

```typescript
/**
 * Extracts the hostname from a Git remote URL.
 * Supports HTTPS (`https://github.com/...`) and SSH (`git@github.com:...`).
 * Returns null for local paths and unsupported schemes.
 *
 * Uses `new URL()` for HTTPS (cross-platform, no OS-specific parsing).
 * Falls back to regex for SSH `git@host:path` format.
 */
export function extractHost(url: string): string | null;

/**
 * Returns a clone-ready URL with the token embedded for HTTPS URLs whose
 * host has a matching entry in the credentials map.
 *
 * - HTTPS match: `https://github.com/user/repo` → `https://TOKEN@github.com/user/repo`
 * - No match or non-HTTPS: returns the original URL unchanged.
 * - URLs that already contain embedded credentials are returned unchanged
 *   (the existing credentials take precedence).
 */
export function injectCredentials(url: string, credentials: Record<string, string>): string;

/**
 * Returns true when the given URL already contains embedded credentials
 * (e.g. `https://user:pass@host/...` or `https://token@host/...`).
 */
export function hasEmbeddedCredentials(url: string): boolean;

/**
 * Strips embedded credentials from an HTTPS URL.
 * `https://token@github.com/user/repo` → `https://github.com/user/repo`
 * `https://user:pass@github.com/user/repo` → `https://github.com/user/repo`
 * Non-HTTPS URLs are returned unchanged.
 */
export function stripEmbeddedCredentials(url: string): string;
```

### Step 6: Set `GIT_TERMINAL_PROMPT=0` in `runGit()`

Modify [src/git/git-cli.ts](src/git/git-cli.ts) to add `GIT_TERMINAL_PROMPT=0` to the environment of every spawned git process. This prevents Git from attempting interactive authentication prompts (which would hang since `stdin` is `'ignore'`).

```typescript
const proc = spawn('git', args, {
    shell: false,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    ...(controller ? { signal: controller.signal } : {}),
});
```

This is a standalone safety improvement — even without configured credentials, it makes auth failures produce an immediate, clear error message (`fatal: could not read Username for 'https://github.com': terminal prompts disabled`) instead of a 2-minute timeout. The `GIT_TERMINAL_PROMPT` env var is supported since Git 2.3 (Feb 2015) and works identically on Windows, macOS, and Linux.

### Step 7: Inject credentials in orchestrators

Modify the clone call sites in:
- `WorkspaceOrchestrator.createWorkspace()` ([src/orchestration/workspace-orchestrator.ts](src/orchestration/workspace-orchestrator.ts))
- `RepositoryOrchestrator.addRepositoryToProject()` ([src/orchestration/repository-orchestrator.ts](src/orchestration/repository-orchestrator.ts))

Before calling `cloneRepository()`, resolve credentials:

```typescript
const cloneUrl = this.config.gitCredentials
    ? injectCredentials(repo.Url, this.config.gitCredentials)
    : repo.Url;

const gitResult = await cloneRepository(cloneUrl, destination, { ... });
```

### Step 8: Strip embedded credentials from URLs at add-time

Modify `RepositoryManager.add()` ([src/models/repository/repository.manager.ts](src/models/repository/repository.manager.ts)) to detect and strip embedded credentials from the URL before storing:

```typescript
if (hasEmbeddedCredentials(params.url)) {
    console.warn(
        'Warning: embedded credentials detected in the repository URL and have been stripped. ' +
        'Configure authentication via the Settings view or the "gitCredentials" field in config.json.'
    );
    params.url = stripEmbeddedCredentials(params.url);
}
```

### Step 9: Improve clone error visibility in the GUI

Update the workspace setup handler in [gui/public/js/views/project-detail.js](gui/public/js/views/project-detail.js) to include the error detail in the failure toast:

Currently:
```javascript
const names = failures.map((f) => f.repositoryId).join(', ');
showToast(`Setup complete with errors. Failed to clone: ${names}`, 'warning', 8000);
```

Change to show the error message alongside each failed repo name:
```javascript
const details = failures.map((f) => `${f.repositoryId}: ${f.error || 'unknown error'}`).join('\n');
showToast(`Setup complete with errors:\n${details}`, 'warning', 12000);
```

### Step 10: Create REST API endpoints for credential management

New file: `src/server/routes/config.ts`

```typescript
export function registerConfigRoutes(
    router: Router,
    appConfig: AppConfig,
    configPath: string,
): void;
```

**`GET /api/config/credentials`**
- Returns the credential map with **masked tokens** (only last 4 characters visible).
- Response: `{ "github.com": "••••abcd", "gitlab.example.com": "••••ef01" }`
- If no credentials configured, returns `{}`.

**`PUT /api/config/credentials`**
- Body: `{ "host": "github.com", "token": "ghp_xxxxxxxxx" }`
- Validates: `host` is a non-empty string; `token` is a non-empty string; `host` does not contain path separators or whitespace.
- Updates both the in-memory `appConfig.gitCredentials` map and the `config.json` on disk via `saveConfigField()`.
- Returns the updated masked credential map (same shape as GET).
- The endpoint adds or replaces a single entry; existing entries for other hosts are preserved.

**`DELETE /api/config/credentials/:host`**
- Removes the credential entry for the specified host.
- Updates both in-memory and disk.
- Returns the updated masked credential map.
- Returns 404 if the host is not in the map.

### Step 11: Wire config routes into the server

Update [src/server/index.ts](src/server/index.ts):

- Import `registerConfigRoutes` from `./routes/config.js`.
- Call `registerConfigRoutes(router, config.appConfig, configPath)` alongside the other route registrations.
- The `configPath` is resolved using the same `getConfigPath()` used by `loadConfig()`. This needs to be threaded through `startServer()` by adding an optional `configPath` field to `ServerConfig` (defaulting to `getConfigPath()`).

### Step 12: Add API client methods for credentials

Update [gui/public/js/api.js](gui/public/js/api.js) — add a new `config` namespace:

```javascript
const config = {
    /**
     * Get all configured git credential hosts with masked tokens.
     * @returns {Promise<Record<string, string>>}
     */
    getCredentials() {
        return request('GET', '/api/config/credentials');
    },

    /**
     * Add or update a git credential entry.
     * @param {string} host
     * @param {string} token
     * @returns {Promise<Record<string, string>>} Updated masked credential map.
     */
    setCredential(host, token) {
        return request('PUT', '/api/config/credentials', { host, token });
    },

    /**
     * Remove a git credential entry.
     * @param {string} host
     * @returns {Promise<Record<string, string>>} Updated masked credential map.
     */
    deleteCredential(host) {
        return request('DELETE', `/api/config/credentials/${encodeURIComponent(host)}`);
    },
};
```

Export as part of the `api` object: `export const api = { repositories, projects, workspaces, branches, status, config };`

### Step 13: Create Settings view

New file: `gui/public/js/views/settings.js`

```javascript
export function renderSettings(container, _params) { ... }
```

The view displays:

1. **Page heading:** "Settings"

2. **Section: Git Credentials**
   - **Description text:** "Configure personal access tokens for cloning private repositories over HTTPS. Tokens are stored locally in config.json (not committed to version control)."
   - **Credentials table** with columns: Host, Token (masked), Actions.
     - Each row shows the hostname and the masked token (`••••abcd`).
     - Delete button per row (with `showConfirm()` dialog).
   - **Add credential form** below the table:
     - Hostname input (text, placeholder: `github.com`)
     - Token input (password type, placeholder: `ghp_xxxxxxxxxxxx`)
     - "Add" button
   - On successful add/delete, the table refreshes via `api.config.getCredentials()` and a success toast is shown.
   - The token input uses `type="password"` so the token is not visible on screen while typing.

The view follows the same patterns as [gui/public/js/views/repositories.js](gui/public/js/views/repositories.js): fetch data on render, full re-render on mutations, use `showToast()` and `showConfirm()` for feedback.

### Step 14: Register Settings view in the GUI

**[gui/public/index.html](gui/public/index.html):** Add a "Settings" link to the `<nav class="nav-links">` section:

```html
<nav class="nav-links">
    <a href="#/" class="nav-link">Dashboard</a>
    <a href="#/repositories" class="nav-link">Repositories</a>
    <a href="#/settings" class="nav-link">Settings</a>
</nav>
```

**[gui/public/js/app.js](gui/public/js/app.js):**
- Import `renderSettings` from `./views/settings.js`.
- Register route: `router.register('#/settings', renderSettings);`
- No `setRouter()` injection needed — the Settings view does not need programmatic navigation.

### Step 15: Tests

- **`git-credentials.test.ts`** (new) — Unit tests for `extractHost()`, `injectCredentials()`, `hasEmbeddedCredentials()`, `stripEmbeddedCredentials()`:
  - HTTPS URLs: with/without path, with/without `.git` suffix, with port
  - SSH URLs: `git@host:user/repo.git`
  - Existing embedded credentials: not double-injected
  - No-match host: URL returned unchanged
  - Non-HTTPS URL (SSH): returned unchanged
  - Edge cases: empty string, malformed URLs

- **`config.test.ts`** — Add tests for:
  - `gitCredentials` loading: valid object, missing field → `undefined`, invalid type → error, empty token → error
  - `saveConfigField()`: writes field to disk, preserves existing fields, handles missing config gracefully

- **`repository.manager.test.ts`** — Add tests for credential stripping:
  - URL with embedded token → stripped and stored without token
  - URL without credentials → stored as-is

- **Config route tests** (new file `src/server/__tests__/routes/config.test.ts`):
  - `GET /api/config/credentials` — returns masked tokens
  - `PUT /api/config/credentials` — adds/updates entry, persists to disk
  - `DELETE /api/config/credentials/:host` — removes entry, returns 404 for unknown host
  - Input validation: empty host, empty token, host with path separators

### Step 16: Update manifest documents

- **`api-surface.md`** — Add `git-credentials.ts` exports and `saveConfigField()`.
- **`rest-api.md`** — Add the three new `/api/config/credentials` endpoints.
- **`gui-frontend.md`** — Add the Settings route and view description.
- **`constraints.md`** — Note that credential tokens are masked in API responses.

## Dependencies

- Git >= 2.3 (for `GIT_TERMINAL_PROMPT` support; the project already requires >= 2.28)
- No new npm dependencies

## Required Components

### New files
- `src/git/git-credentials.ts` — credential resolution utilities
- `src/tests/git-credentials.test.ts` — tests for the above
- `src/server/routes/config.ts` — REST API for credential management
- `src/server/__tests__/routes/config.test.ts` — tests for config routes
- `gui/public/js/views/settings.js` — Settings GUI view

### Modified files
- `src/config/config.types.ts` — add `gitCredentials` to `AppConfig`
- `src/config/config.ts` — load/validate `gitCredentials`, add `saveConfigField()`
- `src/git/git-cli.ts` — add `GIT_TERMINAL_PROMPT=0` to spawn env
- `src/orchestration/workspace-orchestrator.ts` — inject credentials before clone
- `src/orchestration/repository-orchestrator.ts` — inject credentials before clone
- `src/models/repository/repository.manager.ts` — strip embedded credentials from URLs
- `src/server/index.ts` — wire config routes, thread `configPath`
- `gui/public/js/api.js` — add `config` namespace with credential methods
- `gui/public/js/app.js` — register Settings route
- `gui/public/index.html` — add Settings nav link
- `gui/public/js/views/project-detail.js` — show clone error detail
- `config.dist.json` — document the new field
- `src/tests/config.test.ts` — tests for new config field and `saveConfigField()`
- `src/tests/repository.manager.test.ts` — tests for credential stripping
- `docs/agents/project-manifest/api-surface.md` — new exports
- `docs/agents/project-manifest/rest-api.md` — new endpoints
- `docs/agents/project-manifest/gui-frontend.md` — new view
- `docs/agents/project-manifest/constraints.md` — token masking constraint

## Assumptions

- Private repositories use HTTPS URLs. SSH-based private repos already work when the user has an SSH agent with loaded keys.
- One token per hostname is sufficient (single account per forge). Multi-account scenarios are out of scope.
- Tokens stored in cloned repositories' `.git/config` files (in the user's local projects folder) are an acceptable security posture for a local developer tool.
- Token rotation requires re-cloning affected workspaces (delete + re-setup).
- The server only binds to `127.0.0.1` (localhost) — the credential API is not exposed to the network.

## Constraints

- `repositories.json` is **tracked in git** — tokens must never be written to it.
- `config.json` is **gitignored** — this is the only safe location for secrets.
- The `redactUrl()` function in `RepositoryManager` already handles `//token@` patterns — no changes needed there.
- All relative imports must use `.js` extensions (Node16 ESM).
- Token values must be masked (last 4 chars only) in all API responses — never return full tokens over HTTP.

## Out of Scope

- Per-repository credential overrides (beyond host-level mapping)
- OAuth flows or interactive browser-based authentication
- Token rotation tooling (auto-update remote URLs in existing clones)
- SSH key management or passphrase prompting
- Credential encryption at rest in `config.json`
- Git LFS authentication
- OS-level keychain integration (macOS Keychain, Windows Credential Manager, libsecret)
- The unused `RepositoryOrchestrator` not being wired into the server (separate bug — the `POST /api/projects/:id/repositories` route calls `projectManager.addRepository()` directly instead of using the orchestrator)

## Acceptance Criteria

- A user can add git credentials via the GUI Settings view and successfully clone private HTTPS repositories without any other system-level Git configuration.
- A user can alternatively add `"gitCredentials": { "github.com": "ghp_..." }` to `config.json` manually and achieve the same result.
- The Settings view shows configured hosts with masked tokens and allows adding/removing entries.
- Credentials added via the Settings view take effect immediately for subsequent clone operations (no server restart required).
- The solution works identically on Windows, macOS, and Linux.
- Tokens are never stored in `repositories.json` or any tracked file.
- Tokens are never returned in full via the REST API (masked to last 4 characters).
- Clone operations for private repos without configured credentials fail immediately with a clear error message (not a 2-minute timeout).
- The GUI displays the actual Git error message when a clone fails during workspace setup.
- Existing public-repo workflows are unaffected (no regressions).
- All new code has unit tests.
- **Type audit:** Exported types match the plan specification — verify that each new/modified interface property name, type, and optionality align with the plan before marking the WP complete.

## Testing Strategy

- **Unit tests** for the credential utility functions (`extractHost`, `injectCredentials`, `hasEmbeddedCredentials`, `stripEmbeddedCredentials`) — pure functions, no I/O.
- **Unit tests** for config loading with the new optional field and `saveConfigField()`.
- **Unit tests** for `RepositoryManager.add()` credential stripping.
- **Integration tests** for the config REST API endpoints (GET, PUT, DELETE) including token masking, input validation, and persistence verification.
- **Integration check:** Manual test with a real private GitHub repo (HTTPS URL + PAT configured via Settings view) to verify end-to-end clone and subsequent fetch/poll. Test on at least one Windows and one Unix-based system.
- **Regression check:** Existing test suite passes (`npm test`).

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Token leakage in error messages** | `redactUrl()` already strips `//token@` from error messages. The new `cloneUrl` (with token) is only used for the `cloneRepository()` call and is never written to the data model or exposed in API responses. |
| **Token leakage via REST API** | `GET /api/config/credentials` returns masked tokens (last 4 chars only). The server binds to `127.0.0.1` — not exposed to the network. |
| **Token visible in process arguments** | The token appears in the `git clone https://TOKEN@host/...` process args, visible via `ps` on Unix. Acceptable for a local developer tool. Could be upgraded to `GIT_CONFIG_COUNT` env vars in a future iteration if needed. |
| **Token persisted in `.git/config` of clones** | Clones are in the user's local projects folder (not in the tool's repo). This is the same security posture as manually cloning a private repo. |
| **Breaking existing setups** | `gitCredentials` is optional with no default. `GIT_TERMINAL_PROMPT=0` only affects processes that would have hung anyway. No behavioral change for public repos or repos with existing credential helpers. |
| **Git version incompatibility** | `GIT_TERMINAL_PROMPT` is supported since Git 2.3 (Feb 2015). The project already requires Git >= 2.28. No risk. |
| **Concurrent config writes** | `saveConfigField()` uses read-modify-write on `config.json`. The server is single-threaded (Node.js event loop) and all writes are synchronous via `writeJsonFile()`, so no race conditions within the process. External edits to `config.json` while the server is running could be overwritten — documented as a known limitation. |
| **Windows path handling in config** | All paths use `path.join()` / `path.resolve()` which handle `\` separators correctly. `new URL()` for hostname extraction is platform-agnostic. No risk. |
