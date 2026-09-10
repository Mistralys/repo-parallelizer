# Constraints & Conventions

## TypeScript Import Extensions

All relative imports **must** include the `.js` extension:

```typescript
// Correct
import { MyClass } from './my-module.js';

// Wrong — compile error + runtime failure
import { MyClass } from './my-module';
```

This is a strict requirement of the `Node16` module resolution setting. TypeScript maps `.js` → `.ts` at compile time and emits `.js` unchanged for Node.js at runtime.

## Git Subprocess Security

- All Git commands use `shell: false` — no shell expansion, globbing, or metacharacter processing.
- Arguments are passed as a typed `string[]` directly to `spawn()`.
- Error messages use only `args[0]` (the subcommand name), never the full args array, to avoid leaking credential-bearing URLs.
- `RepositoryManager.add()` redacts embedded credentials from URLs before interpolating into error messages.
- `runGit()` always sets `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=echo` on every spawned subprocess. This prevents interactive credential prompts and credential-helper (osxkeychain, libsecret) blocking on unauthenticated requests. Do not remove either env var.
- **Standing rule — credential stripping in git error output:** When credential injection is wired into future WPs (i.e., `injectCredentialToken()` is used to append tokens to URLs before passing to `runGit()`/`runGitOrThrow()`), all code paths that surface `GitResult.stderr` in thrown Error messages, log output, or API responses **must** apply `stripEmbeddedCredentials()` (from `src/git/git-credentials.ts`) to the stderr string first. Git may echo the credentialed URL back in error messages (e.g., `fatal: repository https://ghp_token@github.com/... not found`), which would expose the PAT. This is a non-optional security control for every credential-injection WP.
- **Credential injection lifetime contract:** `injectCredentialToken()` must only be called immediately before a git subprocess invocation — never stored or returned through API boundaries. The injected URL must not appear in log output, API responses, or Error messages without first passing through `stripEmbeddedCredentials()`.
- **Pre-embedded-credentials passthrough:** If a repo URL already contains embedded credentials (detected via `hasEmbeddedCredentials()`) orchestrator implementations **must** call `hasEmbeddedCredentials()` before invoking `resolveCredential()` + `injectCredentialToken()` and decide explicitly whether to strip and re-inject or reject the URL.- **Token masking rule (API responses):** The `gitCredentials` field in `AppConfig` / `config.json` stores **plaintext** tokens. No API handler, logger, or error message may expose a plaintext token in any response. All credential API responses must pass the array through `buildMaskedCredentials()` (in `src/server/routes/config.ts`) before serialisation — this applies `maskToken()` to every `token` field in each `GitCredentialEntry`, producing `****` + last-4-chars (e.g. `****abc1`). Tokens shorter than 4 characters are fully masked as `****`. This is a non-optional security control: any new credential endpoint **must** apply `buildMaskedCredentials()` before calling `sendJson()`.
## Credential Field Validation

### Hostname Format (`host` field)

The `host` field in a `GitCredentialEntry` must not contain `/`, `\`, null bytes (`\0`), or whitespace characters. These characters are invalid in a hostname and are rejected with HTTP 400 by `PUT /api/config/credentials`. The validation regex is `/[/\\\0\s]/`. Valid examples: `github.com`, `gitlab.example.com`.

**Case-insensitivity:** `host` is lowercased at storage time by both `parseGitCredentials()` (config file load/migration) and `PUT /api/config/credentials` (API create/update) — hostnames are case-insensitive per RFC 4343. Every host-comparison call site (`resolveCredential()`, `buildCredentialOptionsResponse()`, the host-incoherence auto-clear, and the `PUT /:id/credential` host-coherence guard) additionally compares via `hostsEqual()` rather than `===`, as defense-in-depth for any already-persisted mixed-case data.

### Per-Field Length Limits

| Field | Maximum length |
|---|---|
| `id` | 100 characters |
| `label` | 200 characters |
| `host` | 253 characters |
| `token` | 500 characters |

These limits are enforced both at the API boundary (`PUT /api/config/credentials` → HTTP 400 on violation) and during config file parsing (`parseGitCredentials()` → `Error` thrown on violation). Values exactly at each limit are accepted.

**API whitespace normalization:** `PUT /api/config/credentials` trims leading and trailing whitespace from `id`, `label`, and `token` before storage. This is intentional UX normalization (e.g., clipboard pastes with trailing newlines). The stored value may therefore differ from what was submitted. The `host` field is handled differently: whitespace is rejected outright (HTTP 400) rather than stripped, because whitespace is structurally invalid in a hostname.

**Config parser trim-on-parse:** `parseGitCredentials()` trims leading and trailing whitespace from all four credential fields before returning. Specifically:
- **New-format array entries** (`GitCredentialEntry[]`): all four fields (`id`, `label`, `host`, `token`) are trimmed in the final `.map()` pass before the array is returned.
- **Legacy-format entries** (`Record<string, string>` hostname→token map): all three of `label`, `host`, and `token` are trimmed when constructing each `GitCredentialEntry`. `label` is derived from the hostname key after trimming, consistent with the new-format path.

The in-memory `GitCredentialEntry[]` returned by `parseGitCredentials()` therefore always contains normalized (trimmed) values for all fields in both formats. The API route handler also produces and stores clean (trimmed) values, ensuring consistency between programmatically created credentials and those loaded from a manually edited `config.json`.

### Host/Credential Coherence (`PUT /api/repositories/:id/credential`)

When assigning a credential to a repository, the API validates that `credential.host` matches the hostname extracted from the repository's URL via `extractHost()`. If they do not match, the request is rejected with HTTP 400 and a descriptive error message indicating both the credential's host and the repository URL's host. This guard prevents silent credential misrouting. The check is skipped when:
- `credentialId` is `null` (clearing the association is always allowed).
- The repository URL is not an HTTPS URL (SSH URLs return `null` from `extractHost()`).

## Stateless Managers

All model managers (`RepositoryManager`, `ProjectManager`, `WorkspaceManager`) re-read their backing JSON file from disk on **every** public method call. There is no in-memory cache. This ensures concurrent writes from other processes are always reflected.

## ID Validation Rules

| Entity | Format | Validation Function |
|---|---|---|
| Repository ID | Lowercase kebab-case (`a-z0-9`, segments separated by `-`) | `isValidKebabCase()` |
| Project ID | Lowercase kebab-case | `isValidKebabCase()` |
| Workspace ID | 2–10 uppercase ASCII letters (`A-Z`) | `isValidWorkspaceId()` |

Path-traversal sequences, uppercase characters (for kebab-case IDs), spaces, and other invalid formats are rejected with a descriptive error.

## The STABLE Workspace Invariant

Every project has exactly one workspace with ID `"STABLE"`. It is auto-created when a project is created and **cannot be removed or renamed**. The STABLE workspace is intended for the remote's default branch.

## Path Resolution

Both `storageFolder` and `projectsFolder` in `config.json` accept relative or absolute paths:

- **Relative paths** are resolved against the tool root (directory containing `package.json`), regardless of the current working directory when the tool is invoked.
- **Absolute paths** are used as-is.

## Configuration

- `config.json` is created by copying `config.dist.json`. It is not committed (gitignored).
- The `_instructions` key in `config.dist.json` is an editorial note and is not a valid config field. Remove it from `config.json`.
- `initializeStorage()` is idempotent — re-running it does not overwrite existing files.
- **`DEFAULTS` Pick maintenance:** The exported `DEFAULTS` constant in `src/config/config.ts` is typed as `Pick<AppConfig, 'cloneDepth' | 'serverPort' | 'gitPollingIntervalSeconds' | 'notesCardHeight' | 'notesColumns'>`. When a new non-optional, non-required `AppConfig` field with a sensible default is added, **three** coordinated changes are required: (1) add the field key to the `Pick` union, (2) add the field's default value to the `DEFAULTS` object literal, and (3) add the fallback guard in `loadConfig()` (e.g. `typeof raw['field'] === 'number' ? raw['field'] : DEFAULTS.field`). Omitting step (1) is a TypeScript compile error; omitting steps (2)–(3) causes the field to be `undefined` at runtime for configs that predate the new field.
- **`_defaultsCoverageGuard` pattern:** Immediately after `DEFAULTS`, a `const _defaultsCoverageGuard: AppConfig = { ...DEFAULTS, projectsFolder: '', storageFolder: '' } satisfies AppConfig` expression is declared and voided. The `satisfies AppConfig` clause is a compile-time completeness guard: if a new required field is added to `AppConfig` without a corresponding entry in `DEFAULTS` or the guard literal, TypeScript emits a type error at that exact line. Do not remove this guard — it is the automated enforcement mechanism for the DEFAULTS maintenance rule above.

## Schema Version Policy

The `SchemaVersion` field on `BaseStore` tracks structural changes to persisted JSON store files. The rule is defined in `src/storage/storage.types.ts`:

- **Do NOT bump `SCHEMA_VERSION`** when adding an **optional** field. Existing JSON files that lack the field are still valid — no migration is required.
- **Do bump `SCHEMA_VERSION`** (and add a migration step) for breaking changes: removing a required field, renaming a field, or changing the type of an existing field in a way that would cause older JSON files to fail validation or produce incorrect behaviour.

**Example:** `Repository.CredentialId` is an optional field addition — existing `repositories.json` files remain valid without it. No `SCHEMA_VERSION` bump was needed for this change.

## Test Conventions

- **Test runner:** Node.js built-in test runner (`node --test`).
- **Cleanup:** All tests creating temporary files must register a `process.on('exit')` handler for synchronous cleanup, in addition to `afterAll`. The `'exit'` event fires on `SIGINT` or crash.
- **Network tests:** Tests requiring outbound internet set `SKIP_NETWORK_TESTS=1` to self-skip.
- **Fake-git binary pattern:** To test CLI argument construction (e.g., verifying credential-injected URLs are passed correctly to `cloneRepository()`), use a fake git binary stub rather than module mocking or network calls. The stub is a shell script placed in a uniquely-prefixed temp directory that is prepended to `process.env.PATH` for the test duration; it writes all received arguments to a capture file and exits with a non-zero code. The original PATH is always restored in a `finally` block. This approach is necessary because modern git (2.x/libcurl) strips embedded credentials from its own error messages, making the injected-URL string unavailable in `stderr`. The shared implementation lives in `src/tests/test-helpers.ts` (`setupFakeGit()`). **Note:** PATH mutation is not concurrency-safe — this pattern is safe only because the test runner executes test files sequentially.

## GUI Frontend Conventions

- **Router injection:** Views needing programmatic navigation export `setRouter(router)` and receive the router via dependency injection from `app.js`. Direct imports of `router.js` from views are forbidden (circular dependency).
- **Cleanup contract:** Views with side-effects (intervals, event listeners) must return a cleanup function from their render entry point. The router calls it before rendering the next view.
- **No framework:** Vanilla JavaScript with ES modules. No build step for the frontend.
- **JSON key normalisation:** The backend uses PascalCase keys (`Id`, `Name`, `Url`). The `normalise.js` utility maps them to camelCase for frontend use.

## Vendor CSS Assets

The `gui/public/css/vendor/` directory contains CSS files copied from `node_modules` by the `copy-vendor` npm script. These are **generated artifacts** and must not be committed to version control (gitignored). After cloning the repo, run `npm install` — the `postinstall` hook will automatically populate the vendor directory. Currently contains `pico.classless.min.css` from `@picocss/pico`.

## Build Output

- Compiled output goes to `dist/`. Source maps are generated alongside each `.js` file.
- `dist/` is excluded from version control.
- `dist/index.js` does not carry the executable bit after `tsc`. Use `npm link` or `node dist/index.js`.

## Request Body Limit

`parseJsonBody()` enforces a **1 MB** request body size limit.

## Timeout Constants

| Constant | Value | Used By |
|---|---|---|
| `CLONE_TIMEOUT_MS` | 120,000 ms (2 min) | `cloneRepository()` via orchestrators |
| `FETCH_TIMEOUT_MS` | 30,000 ms (30 sec) | `fetchRemote()` via polling and branch operations |

## Config Validation Constants

All validation bounds for `AppConfig` fields are defined in `src/config/config.constants.ts` and imported by route handlers. Route-level validation enforces integer-only values within these ranges; `loadConfig()` applies defaults but does not clamp out-of-range values.

| Constant | Value | Field | Description |
|---|---|---|---|
| `MIN_CLONE_DEPTH` | 0 | `cloneDepth` | Minimum clone depth (unbounded history) |
| `MAX_CLONE_DEPTH` | 2,147,483,647 | `cloneDepth` | Maximum clone depth |
| `MIN_SERVER_PORT` | 1 | `serverPort` | Minimum server port |
| `MAX_SERVER_PORT` | 65,535 | `serverPort` | Maximum server port |
| `MIN_POLLING_INTERVAL_SECONDS` | 10 | `gitPollingIntervalSeconds` | Minimum polling interval (seconds) |
| `MAX_POLLING_INTERVAL_SECONDS` | 86,400 | `gitPollingIntervalSeconds` | Maximum polling interval (24 hours) |
| `MIN_NOTES_CARD_HEIGHT` | 120 | `notesCardHeight` | Minimum note card height (px) |
| `MAX_NOTES_CARD_HEIGHT` | 800 | `notesCardHeight` | Maximum note card height (px) |
| `DEFAULT_NOTES_CARD_HEIGHT` | 220 | `notesCardHeight` | Default note card height (px) |
| `MIN_NOTES_COLUMNS` | 1 | `notesColumns` | Minimum column count in the notes view grid |
| `MAX_NOTES_COLUMNS` | 6 | `notesColumns` | Maximum column count in the notes view grid |
| `DEFAULT_NOTES_COLUMNS` | 2 | `notesColumns` | Default column count in the notes view grid |

## Type-Audit Acceptance Criterion

Any work package that adds or modifies exported types must include the following acceptance criterion:

> **Type audit:** Exported types match the plan specification — verify that each new/modified interface property name, type, and optionality align with the plan before marking the WP complete.

QA work packages that follow implementation WPs should cross-check type signatures against the plan, paying particular attention to optional (`?`) vs. required properties and union types.

## Known Input Validation Gaps

- `branchExists()` and `fetchRemote()` do not validate the `'-'` prefix guard that `createBranch()` and `switchBranch()` enforce. These are lower-risk (no data-loss path) and a guard is planned for a future cleanup.
- `branchName` in `branchExists()` is not validated against a safe refname pattern — a path-traversal value may yield a false-positive. Callers must validate before passing untrusted input.
