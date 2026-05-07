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
- **Standing rule — credential stripping in git error output:** When credential injection is wired into future WPs (i.e., `injectCredentials()` is used to append tokens to URLs before passing to `runGit()`/`runGitOrThrow()`), all code paths that surface `GitResult.stderr` in thrown Error messages, log output, or API responses **must** apply `stripEmbeddedCredentials()` (from `src/git/git-credentials.ts`) to the stderr string first. Git may echo the credentialed URL back in error messages (e.g., `fatal: repository https://ghp_token@github.com/... not found`), which would expose the PAT. This is a non-optional security control for every credential-injection WP.
- **Credential injection lifetime contract:** `injectCredentials()` must only be called immediately before a git subprocess invocation — never stored or returned through API boundaries. The injected URL must not appear in log output, API responses, or Error messages without first passing through `stripEmbeddedCredentials()`.
- **Pre-embedded-credentials passthrough:** If a repo URL already contains embedded credentials (detected via `hasEmbeddedCredentials()`) and the URL’s host is not present in the `gitCredentials` map, `injectCredentials()` returns the URL unchanged — including its pre-existing credentials. Orchestrator implementations **must** call `hasEmbeddedCredentials()` before `injectCredentials()` and decide explicitly whether to strip and re-inject or reject the URL.- **Token masking rule (API responses):** The `gitCredentials` field in `AppConfig` / `config.json` stores **plaintext** tokens. No API handler, logger, or error message may expose a plaintext token in any response. All credential API responses must pass the map through `buildMaskedCredentials()` (in `src/server/routes/config.ts`) before serialisation — this applies `maskToken()` to every value, producing `****` + last-4-chars (e.g. `****abc1`). Tokens shorter than 4 characters are fully masked as `****`. This is a non-optional security control: any new credential endpoint **must** apply `buildMaskedCredentials()` before calling `sendJson()`.
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
