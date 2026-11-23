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
- **Credential injection lifetime contract:** `injectCredentialToken()` must only be called immediately before a git subprocess invocation — never stored or returned through API boundaries. The injected URL must not appear in log output, API responses, or Error messages without first passing through `stripEmbeddedCredentials()`. `src/orchestration/remote-auth.ts`'s `resolveRemoteAuth()` is the shared helper that performs the resolve/inject sequence for `WorkspaceOrchestrator` and `RepositoryOrchestrator` (and is intended for managed-clone git operations); its `RemoteAuthResolution.url` success value carries this same contract — callers must consume it immediately and never persist, log, or return it across an API boundary.
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

### Single-record mutator consolidation (`mutate()` pattern)

When a manager accumulates multiple single-record mutators that each repeat the same `load → findIndex → NotFoundError → produce-replacement → save` sequence, consolidate them behind a private `mutate(id, operationLabel, fn)` helper rather than leaving each mutator to re-implement the sequence inline. `fn` should receive `(existing, store)` — not just `existing` — so a mutator needing a cross-record check (e.g. a duplicate-URL scan against every other record) can run it against `store` inside the same load/save transaction instead of issuing a separate `load()` call. `operationLabel` is interpolated into the shared `NotFoundError` message; when retrofitting this pattern onto existing mutators, the label text must reproduce each mutator's pre-existing error message byte-for-byte. See `RepositoryManager.mutate()` (`repository.manager.ts`) for the reference implementation, migrated onto by `update()`, `updateCredential()`, `touchRefreshTimestamp()`, `setInfoSyncSettings()` and `recordInfoSyncWrite()`.

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

## Custom Files

- A project's `CustomFiles` are copied into **every** workspace folder (relative to the workspace root) and overwritten on each sync — never treat a copy as a source of truth.
- Targets must stay inside the workspace folder: validated on save (`validateCustomFileInput`) **and** re-guarded on every write/delete (`custom-files.ts` reuses `path-guard.ts`'s `guardedFileTarget()`/`pruneEmptyParents()` helpers). Never write a custom file without going through `writeCustomFiles()`.
- The generic, scope-neutral file rules (path-segment safety, directory normalisation, label/description/content validation, the executable heuristic, the line-ending policy) live in `src/models/file-definition.ts`, not in `custom-file.ts` — `custom-file.ts` re-exports them under its established public names. A future scope that stores its own files (e.g. a repository-level custom file) should build on `file-definition.ts` directly rather than duplicating these rules.
- Reserved at the workspace root: `README.md`, `AGENTS.md`, `CLAUDE.md`. Repository folder names (first path segment) are off limits. Paths are unique case-insensitively (cross-OS).
- Text only (UTF-8, no NUL, max 256 KB). Line endings: `.bat`/`.cmd` CRLF, executable shell files LF, all else as typed. Executable bit (POSIX only) for `.sh/.bash/.zsh/.ksh/.command` or a `#!` first line.
- **CLI/REST parity:** `paralizer custom-files` (`src/cli/custom-files.ts`) must keep the same mutation sequence as the REST handlers in `routes/projects.ts` (validate via `ProjectManager`, purge previous copies when moved/renamed/deleted, then `regenerateProject()`). Never write workspace copies directly from the CLI.
- **Agent pointer, not docs:** the generated workspace `AGENTS.md` carries a short "Paralizer CLI" section (installation path + `paralizer help`). Command documentation lives only in `CUSTOM_FILES_HELP` / `printUsage()`; do not duplicate it into generated files.
- Adding `CustomFiles` was an optional-field addition: no `SCHEMA_VERSION` bump.

## Repository Custom Files (Milestone 2)

Conventions for the repository-level counterpart to project custom files (`src/models/repository/repository-file.ts`, `repository-file.manager.ts`, `src/orchestration/repository-files.ts`). See `data-flows.md` §11 for the storage layout and `api-surface.md` for the model/manager/orchestration signatures.

- **Untrusted content — output-encode at render time.** `Label`, `Description`, and `Content` on a `RepositoryFile` can originate from a teammate's git commit (via the sync's incoming-change path), not only from Paralizer's own REST/CLI validation — treat them as untrusted input. Any GUI, REST, or CLI surface that renders these fields (Milestone 2's later work packages) must apply output encoding appropriate to its rendering context (HTML-escape for the GUI, no raw `innerHTML`/template interpolation) rather than assuming `validateRepositoryFileInput()` at save time makes the content safe to render as-is downstream.
- **Reader/writer never follow symlinks.** `readRepositoryFilesFolder()` classifies every symlink (file or directory) and any other non-regular entry as `unsafeEntries` instead of descending into or reading it; `writeRepositoryFiles()`'s delete pass re-confirms each deletion candidate with `lstat` immediately before `unlink` and never removes a symlink or non-regular entry, reporting it in `skipped` instead.
- **Hash is content-shape-aware, not best-effort.** `canonicalFilesForHash()` must change when a binary, oversized, or unreadable regular file is added or modified (via a raw-byte hash or a fixed `unreadable` marker) so sync conflict detection cannot be bypassed by a problem file; a symlink or other non-regular entry never contributes to the hash. The hash branches on `RepositoryFolderFile.contentKind` (how the content was decoded: `'text'` / `'raw'` / `'unreadable'`), never on whether `problem` is set — a `'text'` file that also carries a problem must hash identically to the same file without it.
- **Incoming metadata violations and case collisions are problem files, not silently dropped.** `readRepositoryFilesFolder()` flags a `'text'` folder file whose joined/defaulted metadata fails `repositoryFileMetadataProblem()` (over-length/empty `Label`, over-length `Description`), and a `'text'` folder file whose path collides with another folder file's once both are lowercased, with `problem` set — same treatment as the existing binary/oversized/invalid-path/unreadable problem sources (returned, never dropped, contributing to the sync hash). Both checks run only on a `'text'` file with no earlier problem, after the existing unreadable → path-segment → oversized → binary checks, and leave `content`/`contentKind` as `'text'` unchanged.
- **CLI/REST parity, scoped to the repository (Milestone 2).** `paralizer repo-files` (`src/cli/repo-files.ts`) must keep the same validate-then-sync sequence as the REST handlers (`assertSyncEnabled()` first, then `RepositoryFileManager.add()`/`update()`/`remove()`, then `regenerateForRepository()`), reusing the scope-neutral parsing/content-source/reference-resolution logic in `src/cli/file-command-helpers.ts` (also used by `custom-files.ts`) rather than duplicating it. Unlike `custom-files`, `repo-files` never commits or pushes — that remains a separate, explicit Commit & Push action.
- **`replaceAll()` validates the full set.** `RepositoryFileManager.replaceAll()` — the bulk mutator used by `applyImport()` after a diff is resolved — runs the entire incoming set through `validateRepositoryFileSet()` (the 64-file count cap, case-insensitive path uniqueness, and every per-file `validateRepositoryFileInput()` rule) before writing anything; a rejected set leaves the on-disk store untouched. This closes the gap left open at the end of Milestone 2, where `replaceAll()` trusted its caller to have already validated. Any future caller of `replaceAll()` gets the same guarantee for free — see `api-surface.md`.
- **`applyImport()` validates before mutating, gated on whether the import actually mutates files (WP-004).** `applyImport()` runs `validateRepositoryFileSet()` on the resulting file set, and calls `replaceAll()`, only when at least one resolved file action is `add`, `overwrite` or `delete` — the same `filesMutated` condition gates both, so the pre-check and the `replaceAll()` choke point always agree on when the set needs validating. That validation runs **before** the `Name`/`Description` field update (`RepositoryManager.update()`), so a rejected set never leaves a partial import (fields applied, files not) — the repository's fields, file store, managed clone, and recorded hash are all left untouched, and the error names the offending file even when it is an untouched, already-stored one. A field-only import (every file action `keep`/`discard`) skips this validation and never rewrites the file store — it cannot introduce an invalid file, and validating the untouched stored set unconditionally would make it fail on an unrelated legacy row it never touches.
- **Files write-pass logging (WP-004).** `RepositoryInfoSyncOrchestrator.logFilesWriteOutcome()` appends an error-log entry for a `writeRepositoryFiles()` result's non-empty `skipped` (a `warning`, listing the refused write targets) and non-empty `removed` (an `info`, listing the deleted paths), both `Source: 'workspace-info'` with `Context.RepositoryId` set, and `Operation` set to `'sync-files'` (from `syncRepository()`) or `'import'` (from `applyImport()`). It does nothing when both lists are empty or no `errorLogManager` was injected — this logs the write transition itself, not a health issue's first appearance, so no persisted "last seen" state is needed.
- **Case-only duplicate `Files` paths make `info.json` invalid.** `readRepositoryInfoFile()` rejects (`status: 'invalid'`, mapped to `invalid-file` by `evaluateRepositoryInfoSync()`) an `info.json` whose `Files` array has two entries sharing the same lowercased `Path`, naming both colliding `Path` strings in the error message — such a file would otherwise collapse silently in every downstream lowercased-path map.

## Repository Info Sync

Conventions for the opt-in `.workspace/info.json` sync (`src/orchestration/repository-info.ts`, `repository-main-folder.ts`, `repository-info-sync.ts`; routes in `src/server/routes/repository-info-sync.ts`). See `data-flows.md` §16 for the full decision table and trigger flow.

- **No credentials in the info file, ever.** `info.json` never carries a token or `CredentialId`. The file's `Url` field is written via `buildInformationalUrl()`, which always passes the repository's registered `Url` through `stripEmbeddedCredentials()` first.
- **PascalCase keys.** `SchemaVersion`, `Id`, `Name`, `Url`, `Description`, `Settings`, `Files` — consistent with every other Paralizer-persisted file (`repositories.json`, `projects.json`). No camelCase mapping layer for this file. Each `Files` entry carries exactly `Path`, `Label`, `Description`, `Executable`, `ListInAgents` — never a `ContentHash` or `Id` (content lives under `.workspace/files/`, not in `info.json`; see `repository-files.ts` in `api-surface.md`).
- **Unknown-key preservation.** `renderRepositoryInfoFile()` preserves unknown top-level keys and unknown `Settings` keys already present in `existingRaw` when re-rendering, so an older Paralizer version never strips data written by a newer one. `Files` is a known top-level key (`KNOWN_TOP_LEVEL_KEYS`) rendered once from the payload — it is never also preserved as an "unknown" key, avoiding duplication.
- **Schema version policy for the info file:** `REPOSITORY_INFO_SCHEMA_VERSION` (currently `1`) is a plain number comparison in `readRepositoryInfoFile()` — `SchemaVersion > REPOSITORY_INFO_SCHEMA_VERSION` classifies the file as `unsupported-schema` (health issue, no write). This is a separate versioning scheme from `Repository.InfoSync` itself, which follows the normal optional-field, no-bump `storage.types.ts` policy (see Schema Version Policy, above). `SchemaVersion` was **not** bumped for Milestone 2's `Files` addition — it is additive and M1 readers already preserve unknown top-level keys, so a bump would make an M1 installation misclassify the file as `unsupported-schema` and stop syncing.
- **`Url` is informational only.** It is excluded from `hashRepositoryInfoPayload()`, from `diffRepositoryInfo()`, and is rejected (400) as an `applyImport()` field. A file that differs from Paralizer's data only in `Url` evaluates as `in-sync` and is never rewritten for that reason alone — see AC-02b in the plan and the decision table in `data-flows.md` §16. `Files`, by contrast, **does** participate in `hashRepositoryInfoPayload()` — but only when non-empty, so a repository with no files keeps its exact Milestone 1 hash across the upgrade (see `hashRepositoryInfoPayload()`'s compatibility-rule note in `api-surface.md`).
- **Write-only-if-changed.** Both `writeRepositoryInfoFile()` and `writeRepositoryInfoReadme()` compare the rendered bytes against the file's current bytes (when present) and skip the write when identical. This is a deliberate departure from `writeWorkspaceIndexFiles()`'s unconditional-write convention (see Pattern Alignment in the plan) — the info folder is committed to git, so churn there is user-visible and shows up as a spurious pending change.
- **Managed-only main folder.** The main folder is always `{storageFolder}/repositories/{repoId}/`, computed by `resolveMainFolderPath()`. No REST body field, GUI control, or `RepositoryInfoSyncSettings` property ever accepts a folder path override — see Deferred Item 5 in the plan if that changes later.
- **Managed clone token-at-rest convention.** The managed clone's `origin` remote holds the token-injected URL, matching every other workspace clone — a clean `origin` would break partial-clone lazy blob fetches for private HTTPS repositories. `origin` is re-set to the current authenticated URL before every fetch/push so credential rotation takes effect immediately (`RepositoryInfoSyncOrchestrator`'s private re-auth step before `fetchBranch()`/`pushHead()`).
- **Pathspec-limited staging, staged-index commit (updated, Milestone 2).** `commitAndPush()` always *stages* via `infoFolderPathspec()` (the info folder name with a trailing `/`) — `git add -A -- <pathspec>` — then `getStagedPaths()` guards that nothing staged lies outside that folder (`SyncPreconditionError` otherwise, before any commit), so a hand-edited file elsewhere in the managed clone is never swept into the commit even if someone edits the clone by hand. The commit itself (`commitStaged()`) takes **no pathspec** — it commits whatever is currently staged directly, rather than `commitPaths()`'s pathspec-scoped commit used before Milestone 2 — because a pathspec commit rebuilds the listed entries from the working tree and discards an index-only `update-index --chmod` change under `core.filemode=false` (see `commitStaged()`'s docs in `api-surface.md`).
- **Default-branch-only push.** `commitAndPush()` refuses (`SyncPreconditionError`, 409) unless the managed clone's current branch equals its resolved default branch — defensive, since the managed clone should never be manually checked out to another branch.
- **Refname validation for the new git functions.** `git-remote.ts`'s branch-accepting functions (`fetchBranch()`, `pushHead()`, `mergeFastForward()`, `countAheadBehind()`) and `git-commit.ts`'s `commitPaths()`/`commitStaged()` identity fields all reject a leading `-` and (for refnames) anything outside `^[A-Za-z0-9._/-]+$` with no `..` — see Known Input Validation Gaps, below, for the pre-existing functions this does **not** yet cover.
- **The 502 convention.** Routes in `repository-info-sync.ts` map `RemoteOperationError`/`MainFolderGitError` (remote git failures — fetch/push/clone rejected or unreachable) to HTTP 502, distinguishing them from 500 (internal/orchestrator bug) used by every other route module. Every message reaching a 502 response is credential-stripped; a permission-denied push additionally carries a "credential needs write access" hint.

## Test Conventions

- **Test runner:** Node.js built-in test runner (`node --test`).
- **Cleanup:** All tests creating temporary files must register a `process.on('exit')` handler for synchronous cleanup, in addition to `afterAll`. The `'exit'` event fires on `SIGINT` or crash.
- **Network tests:** Tests requiring outbound internet set `SKIP_NETWORK_TESTS=1` to self-skip.
- **Fake-git binary pattern:** To test CLI argument construction (e.g., verifying credential-injected URLs are passed correctly to `cloneRepository()`), use a fake git binary stub rather than module mocking or network calls. The stub is a shell script placed in a uniquely-prefixed temp directory that is prepended to `process.env.PATH` for the test duration; it writes all received arguments to a capture file and exits with a non-zero code. The original PATH is always restored in a `finally` block. This approach is necessary because modern git (2.x/libcurl) strips embedded credentials from its own error messages, making the injected-URL string unavailable in `stderr`. The shared implementation lives in `src/tests/test-helpers.ts` (`setupFakeGit()`). **Note:** PATH mutation is not concurrency-safe — this pattern is safe only because the test runner executes test files sequentially.
- **Choke-point guard tests (identifier vs. specifier gating):** Tests that scan `src/` for unauthorized access to a guarded module (e.g. `src/tests/workspace-artifacts-chokepoint.test.ts`) should gate on the *module specifier* (the import path string), not just an identifier name, so that every import shape — named, namespace, default, side-effect, dynamic `import()`, and `require()` — is caught by a single shared detection function used by both the main scan and any allowlist-entry validity check. Within that function, apply two tiers: for **static named-import clauses**, still require a guarded identifier to actually appear in the clause (`GUARDED_IDENTIFIERS`), since the module file may also export unrelated, non-guarded members that legitimate callers import; for **opaque forms** (namespace, default, side-effect, dynamic `import()`, `require()`), gate on specifier match alone, since these forms give no statically-visible identifier to filter on. A retained identifier-level match may be kept solely to enrich the offender message — it must never gate the assertion itself. Prove the detection function with synthetic fixtures (one per import shape, plus a negative control on an unrelated module), each cleaned up via `process.on('exit')`. See `referencesGuardedModule()` / `namedGuardedIdentifiers()` in `src/tests/workspace-artifacts-chokepoint.test.ts` for the reference implementation.

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
| `PUSH_TIMEOUT_MS` | 60,000 ms (1 min) | `pushHead()` (`git-remote.ts`), consumed by `RepositoryInfoSyncOrchestrator.commitAndPush()` |

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
- By contrast, the new repository-info-sync git functions (`git-remote.ts`'s `fetchBranch()`, `pushHead()`, `mergeFastForward()`, `countAheadBehind()`, and `git-commit.ts`'s `commitPaths()` identity fields) **do** validate every branch/identity argument against a `-`-prefix guard and, for refnames, the safe pattern above — see Repository Info Sync, above. `branchExists()`/`fetchRemote()` are not retrofitted onto the same validator by this plan; that remains the pre-existing gap described in the previous two bullets.
- `repository-main-folder.ts` itself still logs nothing for create/remove; `RepositoryInfoSyncOrchestrator` (`repository-info-sync.ts`) now logs around every call site that creates or removes the managed clone (`saveSettings()`, `recreateManagedClone()`), but at `Severity: 'info'`/`'warning'` (`Operation: 'clone-main-folder'`/`'remove-main-folder'`), not `Severity: 'audit'` like the `unlink-repository`/`delete-repository-global` entries below — a future touchback could raise these to `audit` severity for parity.

> **Resolved:** `repository-main-folder.ts`'s `createManagedClone()` destination guard previously used only `fs.existsSync()`, not the two-layer lexical+realpath guard its own `removeManagedClone()` used. Both functions now share one private `guardedManagedFolderDestination()` helper (the strict-descendant lexical check plus `escapesRootViaRealpath()`, moved out of `removeManagedClone()` unchanged); `createManagedClone()` throws `MainFolderPreconditionError` on refusal before ever reaching git, and `removeManagedClone()` keeps its pre-existing `false`-on-refusal behaviour. See `api-surface.md` and `data-flows.md` §16 for the `ensureRootExists` mechanism this extraction also required.

> **Resolved:** `RepositoryOrchestrator.removeRepositoryFromProject()`'s clone-path containment check now uses a two-layer guard — a strict-descendant lexical check (rejecting equality with `projectsFolder` itself, unlike the equality-permitting `isLexicallyContained()` used by the writer path) followed by a realpath symlink-escape check (`escapesRootViaRealpath()`, from the shared `src/utils/path-guard.ts` module) that catches a planted symlink a lexical check alone cannot see through. Both `removeRepositoryFromProject()` and `deleteRepositoryGlobally()` now also emit `Severity: 'audit'` entries via the injected `errorLogManager` (`Operation: 'unlink-repository'` per affected project, `Operation: 'delete-repository-global'` as a cascade summary carrying every affected project ID in `Details`), closing the OWASP A09 audit-trail gap on the system's most destructive operation. See `api-surface.md` for signatures.
