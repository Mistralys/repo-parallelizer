# Public API Surface

Signatures only — no implementation logic. Organised by module.

---

## Errors (`src/errors.ts`)

```typescript
class NotFoundError extends Error {
    constructor(message: string)
}
```

---

## Configuration (`src/config/`)

### Types (`config.types.ts`)

```typescript
/** A single named Git credential entry used to authenticate against a remote host. */
interface GitCredentialEntry {
    id: string;     // unique identifier; referenced by Repository.CredentialId
    label: string;  // human-readable display name shown in the UI
    host: string;   // hostname this credential applies to (e.g. "github.com")
    token: string;  // Personal Access Token, password, or other credential string
}

interface AppConfig {
    projectsFolder: string;
    storageFolder: string;
    cloneDepth: number;       // default: 50
    serverPort: number;       // default: 4200
    gitPollingIntervalSeconds: number; // default: 30
    gitCredentials?: GitCredentialEntry[]; // named credential entries; absent or empty = public repos only
    maxErrorLogEntries?: number;  // default: 500 — FIFO eviction cap for error log
    webserverUrl?: string;  // base URL of local webserver (e.g. http://localhost:8080); absent = Browse button hidden
    notesCardHeight: number;  // height (px) of each note card; range [MIN_NOTES_CARD_HEIGHT, MAX_NOTES_CARD_HEIGHT]; default: DEFAULT_NOTES_CARD_HEIGHT (220)
    notesColumns: number;     // column count in the notes view grid; range [MIN_NOTES_COLUMNS, MAX_NOTES_COLUMNS]; default: DEFAULT_NOTES_COLUMNS (2)
}
```

> **Credential selection:** Repositories reference a specific credential via `Repository.CredentialId`. When a repository has no `CredentialId`, the tool auto-selects the sole credential whose `host` matches the repository's remote URL (if exactly one such credential exists).

### Constants (`config.ts`)

```typescript
const DEFAULTS: Readonly<Pick<AppConfig, 'cloneDepth' | 'serverPort' | 'gitPollingIntervalSeconds' | 'notesCardHeight' | 'notesColumns'>>
// Values: { cloneDepth: 50, serverPort: 4200, gitPollingIntervalSeconds: 30,
//           notesCardHeight: 220, notesColumns: 2 }
```

> **Maintenance note:** The `Pick` union must be extended whenever a new non-optional, non-required `AppConfig` field with a sensible default is added. See the inline comment in `config.ts` and the constraints guide.

### Functions (`config.ts`)

```typescript
function loadConfig(configPath?: string): AppConfig
function saveConfigField(field: string, value: unknown, configPath?: string): void
```

> **Security note — `saveConfigField` caller guard:** The `field` parameter is **not validated** inside `saveConfigField`. Any caller that passes user-supplied input for `field` (e.g. from an HTTP request body) **must** validate it against an explicit allowlist before calling this function. Example: `if (!['gitCredentials'].includes(field)) throw new Error('Invalid field')`. This guard belongs in the route handler, not in `saveConfigField` itself.

---

## Git Layer (`src/git/`)

### Types (`git.types.ts`)

```typescript
interface GitResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

interface GitStatusInfo {
    currentBranch: string | null;
    localCommits: number;
    unfetchedCommits: number;
    modifiedFiles: number;
    lastActivity: string | null;
    hasConflicts: boolean;
}

interface BranchInfo {
    name: string;
    isCurrent: boolean;
    isRemote: boolean;
    upstream?: string;
}

interface CloneOptions {
    depth?: number;
    branch?: string;
    bare?: boolean;
    timeoutMs?: number;
    filter?: 'blob:none';     // partial clone; omits blobs, fetched lazily on demand
    noCheckout?: boolean;     // skip working-tree population; pair with setSparseCheckout()
}

interface PathStatusEntry {
    code: string;  // two-char XY status code from `git status --porcelain` (e.g. "M ", "??")
    path: string;  // path relative to the repository root
}

interface RunGitOptions {
    timeoutMs?: number;
    maxBufferBytes?: number;
}
```

> **`CloneOptions.filter`/`noCheckout`:** a server that does not support partial clone (`uploadpack.allowFilter` unset) rejects a `filter`-bearing clone with a message containing `FILTER_UNSUPPORTED_WARNING` (exported from `git-clone.ts`). `noCheckout` is intended to be paired with `setSparseCheckout()` (below) so only the desired paths are ever written to disk.

### CLI (`git-cli.ts`)

```typescript
function runGit(args: string[], cwd?: string, options?: RunGitOptions): Promise<GitResult>
function runGitOrThrow(args: string[], cwd?: string): Promise<string>
```

> **`runGitOrThrow()` credential stripping:** applies `stripEmbeddedCredentials()` (from `git-credentials.ts`) to `stderr` before interpolating it into the thrown `Error` message, so a credential-embedded URL that git echoes back in a failure message (e.g. `fatal: repository https://ghp_token@host/... not found`) is never exposed to a caller that surfaces the thrown message in logs or an API response.

### Credentials (`git-credentials.ts`)

```typescript
function extractHost(url: string): string | null
function hostsEqual(a: string, b: string): boolean
function resolveCredential(url: string, credentials: GitCredentialEntry[], credentialId?: string): GitCredentialEntry | null
function injectCredentialToken(url: string, token: string): string
function hasEmbeddedCredentials(url: string): boolean
function stripEmbeddedCredentials(input: string): string
```

> **Note:** The legacy `injectCredentials()` function was removed. All call sites use the `resolveCredential()` + `injectCredentialToken()` pipeline.

**Credential resolution pipeline** — the standard call sequence for authenticated git operations:

```ts
const entry = resolveCredential(repoUrl, config.gitCredentials, repo.credentialId);
const authenticatedUrl = entry ? injectCredentialToken(repoUrl, entry.token) : repoUrl;
```

`resolveCredential` applies two strategies in order:
1. **Explicit ID** (`credentialId` provided) — returns the entry whose `id` matches, or `null` for a stale reference.
2. **Auto-selection** (`credentialId` omitted) — filters by URL hostname; returns the single match, or `null` for zero or multiple matches (ambiguous).

> **SECURITY — `resolveCredential` with explicit `credentialId`:** When a `credentialId` is supplied, no host cross-validation is performed. The caller is responsible for ensuring the URL's host is consistent with the credential's configured `host` before using the resolved token (enforce this in orchestrators, not in the utility itself).

> **Host matching is case-insensitive:** `hostsEqual(a, b)` compares hostnames ignoring case (hostnames are case-insensitive per RFC 4343). `resolveCredential`'s auto-selection path and every host-comparison site in `server/routes/repositories.ts` (`buildCredentialOptionsResponse`, the host-incoherence auto-clear, and the `PUT /:id/credential` host-coherence guard) use `hostsEqual` rather than `===`, since `extractHost()` always returns a lowercased hostname while a stored `GitCredentialEntry.host` is only trimmed. `host` is additionally lowercased at storage time (`parseGitCredentials`, `PUT /api/config/credentials`) so newly-configured credentials are canonical; the case-insensitive comparison remains as defense-in-depth for any already-persisted mixed-case data.

> **`injectCredentialToken`:** Injects a pre-resolved token string as the WHATWG URL username. Token injection uses property assignment (`parsed.username = token`), not string concatenation — special characters are automatically percent-encoded.

> **`stripEmbeddedCredentials` contract:** Accepts an arbitrary string — not just a URL. Pure HTTPS URLs are sanitised via the WHATWG URL object (clean userinfo removal). All other inputs (non-HTTPS URLs, git prose error messages such as `"fatal: repository 'https://token@host/...' not found"`, and unparseable values) fall through to a regex scrub that replaces any `https?://…@` pattern with `https://***@`. Use this function on `gitResult.stderr` before surfacing it in API responses or logs.

### Clone (`git-clone.ts`)

```typescript
const FILTER_UNSUPPORTED_WARNING = 'filtering not recognized by server'

function cloneRepository(url: string, destination: string, options?: CloneOptions): Promise<GitResult>
function setSparseCheckout(repoPath: string, paths: string[]): Promise<GitResult>
```

> **`setSparseCheckout()`:** runs `sparse-checkout set --cone -- <paths>`; rejects (without invoking git) any path starting with `-`, resolving a `GitResult` with `exitCode: 128` in that case, consistent with `createBranch()`/`switchBranch()`'s validation-failure convention in `git-branch.ts`.

### Remote (`git-remote.ts`)

```typescript
function getRemoteUrl(repoPath: string, remote?: string): Promise<string | null>                 // remote defaults to "origin"
function setRemoteUrl(repoPath: string, url: string, remote?: string): Promise<GitResult>         // remote defaults to "origin"
function fetchBranch(repoPath: string, branch: string, options?: { filter?: 'blob:none'; timeoutMs?: number }): Promise<GitResult>
function pushHead(repoPath: string, branch: string, timeoutMs?: number): Promise<GitResult>
function mergeFastForward(repoPath: string, branch: string): Promise<GitResult>
function countAheadBehind(repoPath: string, branch: string): Promise<{ ahead: number; behind: number }>
function changedPathsBetween(repoPath: string, fromRef: string, toRef: string): Promise<string[]>
function remoteUrlsMatch(a: string, b: string): boolean
```

> **Safe-refname validation:** every `branch`/`fromRef`/`toRef` argument above is validated against a shared pattern (`^[A-Za-z0-9._/-]+$`, rejecting a leading `-` and any `..` segment) before being interpolated into a refspec or passed as a positional ref argument. An invalid value resolves immediately (`GitResult` with `exitCode: 128`, or `{ ahead: 0, behind: 0 }` / `[]` for the non-`GitResult` functions) without invoking git.
>
> **`fetchBranch()`/`pushHead()`:** operate on one explicit branch via a literal refspec (`+refs/heads/<branch>:refs/remotes/origin/<branch>` for fetch, `HEAD:refs/heads/<branch>` for push) rather than git's default "whatever is configured" behavior used by `fetchRemote()` in `git-branch.ts`.
>
> **`setRemoteUrl()` — SECURITY:** when `url` embeds a credential token, that token is written to `.git/config` on disk for as long as the URL remains configured. A caller that temporarily points `origin` at an authenticated URL (to pair with `fetchBranch()`/`pushHead()`) must restore the plain URL via a second `setRemoteUrl()` call immediately afterward.
>
> **`remoteUrlsMatch()`:** normalises both URLs before comparing — strips embedded credentials, lowercases the hostname, and drops a trailing `/` and/or `.git` suffix. Handles both WHATWG-parseable URLs and SCP-style SSH URLs (`git@host:org/repo.git`).

### Branch (`git-branch.ts`)

```typescript
function listBranches(repoPath: string): Promise<BranchInfo[]>
function getCurrentBranch(repoPath: string): Promise<string | null>
function getDefaultBranch(repoPath: string): Promise<string>
function createBranch(repoPath: string, branchName: string): Promise<GitResult>
function switchBranch(repoPath: string, branchName: string): Promise<GitResult>
function branchExists(repoPath: string, branchName: string, remote?: string): Promise<boolean>
function fetchRemote(repoPath: string, remote?: string, timeoutMs?: number): Promise<GitResult>
```

### Status (`git-status.ts`)

```typescript
function getGitStatus(repoPath: string): Promise<GitStatusInfo>
function fetchAndGetStatus(repoPath: string, timeoutMs?: number): Promise<GitStatusInfo>
```

### Commit (`git-commit.ts`)

```typescript
interface CommitIdentity {
    name: string;
    email: string;
}

function getPathStatus(repoPath: string, pathspec: string): Promise<PathStatusEntry[]>
function stagePaths(repoPath: string, pathspec: string): Promise<GitResult>
function commitPaths(repoPath: string, pathspec: string, message: string, identity: CommitIdentity): Promise<GitResult>

// Milestone 2 — executable-bit fix-up and staged-index commit, used by commitAndPush() (below).
function getIndexModes(repoPath: string, pathspec: string): Promise<Map<string, string>>   // ls-files -s -z; empty map on failure/rejected pathspec
function setIndexExecutable(repoPath: string, paths: readonly string[], executable: boolean): Promise<GitResult>   // update-index --chmod=(+|-)x
function getStagedPaths(repoPath: string): Promise<string[]>   // diff --cached --name-only -z; empty array on failure
function commitStaged(repoPath: string, message: string, identity: CommitIdentity): Promise<GitResult>   // plain `commit -m`, no pathspec
```

> Unlike `getGitStatus()` (whole working tree), `getPathStatus()`/`stagePaths()`/`commitPaths()`/`getIndexModes()` are scoped to a single `pathspec` (passed to git after a literal `--` separator), for callers that manage one narrow, well-known set of files (e.g. the `.workspace/info.json` sync artifact) without being influenced by unrelated changes elsewhere in the repository.
>
> **`commitPaths()`:** runs `-c user.name=<name> -c user.email=<email> commit -m <message> -- <pathspec>` — the `identity` is a one-off config override for this single invocation only and is never written to the repository's persisted `user.name`/`user.email` config. Rejects (without invoking git, resolving `exitCode: 128`) an empty/whitespace-only `message`, or an `identity` field that is empty, contains a newline, or starts with `-`. Still exported for compatibility, but no longer called from `commitAndPush()` (Milestone 2) — see `commitStaged()`, below.
>
> **`getIndexModes()` / `setIndexExecutable()` / `getStagedPaths()` / `commitStaged()` (Milestone 2):** added so `commitAndPush()` can commit the POSIX executable bit reliably across platforms — `update-index --chmod` is an index-only change, and `commitPaths()`'s pathspec commit rebuilds the listed entries from the working tree, which discards that change under `core.filemode=false` (verified empirically against git 2.56.0: the pathspec sequence records `100644`, committing the staged index directly records `100755`). `getIndexModes()` reads the staged mode for every path under a pathspec (`ls-files -s -z`, NUL-separated so any path parses unambiguously); `setIndexExecutable()` flips `+x`/`-x` on already-staged paths, no-op success (`exitCode: 0`) for an empty `paths` array without spawning git; `getStagedPaths()` lists everything currently staged (`diff --cached --name-only -z`), used by `commitAndPush()` to guard against committing anything outside `.workspace/`; `commitStaged()` is `commitPaths()`'s pathspec-free twin — same identity/message validation, same `exitCode: 128`/`fatal: ...` rejection shape, but commits whatever is already staged. Unlike `setIndexExecutable()`/`commitStaged()` (which return a `GitResult` with `exitCode: 128` for a rejected argument), `getIndexModes()`/`getStagedPaths()` have no `GitResult` to report through and fail quiet — an empty `Map`/array — for a rejected `-`-prefixed pathspec or a failing git call, mirroring `getPathStatus()`'s existing "empty on failure" convention; `getStagedPaths()` additionally takes no path/pathspec parameter at all, so it has nothing to reject.

---

## Error Log (`src/error-log/`)

### Types (`error-log.types.ts`)

```typescript
type ErrorSeverity = 'error' | 'warning' | 'audit' | 'info';

interface ErrorLogContext {
    ProjectId?: string;
    WorkspaceId?: string;
    RepositoryId?: string;
}

interface ErrorLogEntry {
    Id: number;             // Auto-incremented unique numeric identifier
    Timestamp: string;      // ISO 8601 UTC timestamp assigned by append()
    Severity: ErrorSeverity;
    Source: string;         // Subsystem or component that produced the entry
    Operation: string;      // Operation being performed when the error occurred
    Context: ErrorLogContext;
    Message: string;
    Details?: string;       // Optional structured detail (stack trace, raw output, etc.)
}

interface ErrorLogStore extends BaseStore {
    Entries: ErrorLogEntry[];
}

const DEFAULT_MAX_ERROR_LOG_ENTRIES = 500;  // Default FIFO eviction cap — overridden by AppConfig.maxErrorLogEntries

interface ErrorLogListOptions {
    severity?: ErrorSeverity;   // Filter by severity; omit to return all
    source?: string;            // Exact-match filter on Source; omit to return all
    limit?: number;             // Max entries to return; omit to return all matching.
                                // limit=0 → empty entries, total unaffected.
                                // Negative limit: passed directly to Array.slice(0, limit) —
                                //   returns all entries *except* the final |limit| entries
                                //   (e.g. limit=-1 on 50 entries returns 49, not 0).
    offset?: number;            // Zero-based offset into filtered results (default: 0).
                                // offset ≥ total → empty entries, total unaffected.
                                // Negative offset treated as 0 (slice semantics).
}

interface ErrorLogListResult {
    entries: ErrorLogEntry[];   // Paged entries (after filtering and pagination)
    total: number;              // Total matching entries before pagination (post-filter)
}
```

### Manager (`error-log.manager.ts`)

```typescript
class ErrorLogManager {
    constructor(config: AppConfig)

    append(entry: Omit<ErrorLogEntry, 'Id' | 'Timestamp'>): ErrorLogEntry
    list(options?: ErrorLogListOptions): ErrorLogListResult
    getById(id: number): ErrorLogEntry | undefined
    sources(): string[]  // sorted distinct Source values
    clear(): void
}
```

> **No barrel index:** Import directly from the source files — `error-log.types.js` and `error-log.manager.js`. No `index.ts` exists for this module.

---

## Models (`src/models/`)

### Repository

#### Types (`repository.types.ts`)

```typescript
interface Repository {
    Id: string;
    Name: string;
    Url: string;
    credentialsStripped?: boolean; // transient — set by add(), not persisted
    LastRefreshedAt?: string;      // ISO 8601 — written by touchRefreshTimestamp(); absent until first manual refresh
    CredentialId?: string;         // references GitCredentialEntry.id; absent = auto-select by host match
    Description?: string;          // optional, user-entered; trimmed and capped at MAX_REPOSITORY_DESCRIPTION_LENGTH; absent when never set or cleared
    InfoSync?: RepositoryInfoSyncSettings; // opt-in `.workspace/info.json` sync settings; absent when never configured
}

interface RepositoryInfoSyncSettings {
    Enabled: boolean;
    LastWrittenHash?: string; // hash of the last `.workspace/info.json` content written by the tool; absent until first sync write
    LastSyncedAt?: string;    // ISO 8601 — absent until first sync write
}

interface RepositoryStore extends BaseStore {
    Repositories: Repository[];
}
```

> **Schema version note:** `CredentialId`, `Description` and `InfoSync` are optional field additions. Per the `BaseStore` versioning policy (see `storage.types.ts`), adding an optional field is backward-compatible — existing `repositories.json` files that lack the field remain valid. No `SCHEMA_VERSION` bump is required.

> **`InfoSync` grouping:** the opt-in sync settings (enabled flag, last-written hash, last-synced timestamp) are grouped under one optional `Repository.InfoSync` field rather than as flat top-level fields, so there is a single field to destructure away when clearing and a single home for any future machine-local sync setting.

#### Manager (`repository.manager.ts`)

```typescript
class RepositoryManager {
    constructor(config: AppConfig)

    list(): Repository[]
    getById(id: string): Repository | undefined
    exists(id: string): boolean
    add(params: { url: string; name?: string; id?: string; description?: string }): Repository
    update(id: string, params: { name: string; url?: string; description?: string }): Repository
    remove(id: string): void
    updateCredential(id: string, credentialId: string | null): Repository
    touchRefreshTimestamp(id: string): Repository
    setInfoSyncSettings(id: string, settings: RepositoryInfoSyncSettings | null): Repository
    recordInfoSyncWrite(id: string, hash: string): Repository
}
```

> **Private `mutate(id, operationLabel, fn)` helper:** consolidates the repeated `load → findIndex → NotFoundError → fn → save` sequence shared by `update()`, `updateCredential()`, `touchRefreshTimestamp()`, `setInfoSyncSettings()` and `recordInfoSyncWrite()`. `fn` receives `(existing, store)` — the full store is passed alongside the existing record so a mutator can run a cross-repository check (e.g. `update()`'s duplicate-URL scan) inside the same load/save transaction instead of a separate `load()` call. `operationLabel` is interpolated into the `NotFoundError` message as `` Cannot ${operationLabel}: repository with ID "${id}" does not exist. `` — each of the five mutators' error message text is unchanged from before this consolidation.

> **`setInfoSyncSettings()`:** sets the `InfoSync` group to the given `RepositoryInfoSyncSettings`, or pass `null` to remove the `InfoSync` key entirely (destructured out, not set to `undefined`), reverting the repository to the "info sync never configured" state. Throws `NotFoundError` if the repository ID does not exist.

> **`recordInfoSyncWrite()`:** records a successful `.workspace/info.json` sync write by setting `InfoSync.LastWrittenHash` to the given hash and `InfoSync.LastSyncedAt` to the current UTC timestamp, preserving `InfoSync.Enabled`. Throws `NotFoundError` if the repository ID does not exist, and a plain `Error` if the repository has no `InfoSync` settings configured — info sync must be enabled via `setInfoSyncSettings()` first.

> **`update()` preserves `InfoSync`:** since `update()`'s `mutate()` callback spreads `{ ...existing, Name: params.name, ... }`, an unrelated `Name`/`Url`/`Description` edit leaves any existing `InfoSync` group untouched.

> **`Description` handling in `add()`/`.update()`:** `params.description` is trimmed via a shared private `normalizeDescription()` helper and validated against `MAX_REPOSITORY_DESCRIPTION_LENGTH` (500, `config.constants.ts`), throwing a plain `Error` naming the limit when exceeded. In `add()`, the field is set on the new record only when the trimmed value is non-empty; omitting `description` leaves it unset. In `update()`, supplying `description` trims and stores it when non-empty, but supplying an empty or whitespace-only string **removes** the `Description` key from the record entirely (not persisted as `""`); omitting `description` leaves the existing stored value untouched. Wired through the REST layer (`POST`/`PUT /api/repositories(/:id)`, see `rest-api.md`) with a route-level `validateDescription()` pre-check, and surfaced in the GUI's repository modal, list, and detail views (`normaliseRepo()`, `showRepositoryModal`, `repositories.js`, `repository-detail.js` — see `gui-frontend.md`).

> **`updateCredential()`:** Associates or removes a named credential on a repository. Pass a `credentialId` string to pin the repository to a specific `GitCredentialEntry`; pass `null` to clear the association and revert to host-based auto-selection at runtime. When `null` is passed, the `CredentialId` key is removed entirely from `repositories.json` (not set to `undefined`) so the JSON remains clean. Throws `NotFoundError` if the repository ID does not exist. See `Repository.CredentialId` for the auto-selection fallback behaviour.

> **`update()`'s optional `url`:** When `url` is provided, it is trimmed and any embedded credentials are stripped (mirroring `add()`'s URL-handling pattern), then checked for duplicates against every other repository's `Url`, self-excluded by `Id`. Returns the repository spread with `credentialsStripped: true` when stripping occurred (transient, not persisted). Throws `NotFoundError` if the ID does not exist, or a plain `Error` if the cleaned URL duplicates another repository's URL. When `url` is omitted, behavior is unchanged (name-only update). **Known gap:** an empty or whitespace-only `url` is silently persisted with no rejection, unlike `add()`'s empty-slug guard — callers passing raw form input should validate non-empty before calling.

### Repository Files (Milestone 2)

#### Model (`repository-file.ts`) — pure module (no fs)

```typescript
// Builds on the scope-neutral rules in src/models/file-definition.ts, the same way
// project/custom-file.ts does. No re-exports of the shared helpers — a later
// orchestration WP (folder read/write) imports file-definition.ts directly.
const REPOSITORY_FILE_MAX_CONTENT_BYTES = 256 * 1024   // alias of FILE_DEFINITION_MAX_CONTENT_BYTES
const REPOSITORY_FILE_MAX_LABEL_LENGTH = 120            // alias of FILE_DEFINITION_MAX_LABEL_LENGTH
const REPOSITORY_FILE_MAX_DESCRIPTION_LENGTH = 1000     // alias of FILE_DEFINITION_MAX_DESCRIPTION_LENGTH
const REPOSITORY_FILE_MAX_COUNT = 64                    // max files per repository
const RESERVED_REPOSITORY_FILE_SEGMENTS: readonly string[]   // ['.git'] — reserved at any path depth, case-insensitive

interface RepositoryFile {
    Id: string;            // UUID, machine-local; never written to info.json
    Directory: string;     // relative to the repo's `.workspace/files/` folder, '/' separators, '' = root
    FileName: string;      // with extension; never contains a separator
    Label: string;
    Description: string;
    Content: string;       // UTF-8 text, max 256 KB
    Executable: boolean;   // explicit (unlike CustomFile); defaults from isExecutableFile() when input omits it
    ListInAgents: boolean; // default false
    DateModified: string;  // machine-local; not hashed
}
interface RepositoryFileInput { Directory: string; FileName: string; Label: string; Description: string; Content: string; Executable?: boolean; ListInAgents: boolean }

repositoryFileRelativePath(file: Pick<RepositoryFile, 'Directory' | 'FileName'>): string
validateRepositoryFileInput(input: RepositoryFileInput, others: readonly RepositoryFile[]): Omit<RepositoryFileInput, 'Executable'> & { Executable: boolean }
    // throws Error with a user-presentable message; checks (in order): others.length >= REPOSITORY_FILE_MAX_COUNT,
    // label, description, file name, directory segment rules, RESERVED_REPOSITORY_FILE_SEGMENTS (any depth,
    // case-insensitive), case-insensitive path-uniqueness against `others`, content size/binary.
    // Resolves Executable from isExecutableFile(FileName, Content) when input.Executable is undefined.
```

> **`others.length >= REPOSITORY_FILE_MAX_COUNT` invariant:** `others` always excludes the file being edited (both for `add()`, where it is every existing file, and `update()`, where it is every file except the one being renamed/edited), so the same check is correct for both operations — adding a 65th file is rejected, but editing an existing file while the repository already holds exactly 64 is not.

#### Manager (`repository-file.manager.ts`)

```typescript
interface RepositoryFileStore extends BaseStore { Files: RepositoryFile[] }   // { storageFolder}/repository-files/{repoId}.json

class RepositoryFileManager {
    constructor(config: AppConfig, repositoryManager: RepositoryManager)

    list(repoId: string): RepositoryFile[]
    get(repoId: string, fileId: string): RepositoryFile
    add(repoId: string, input: RepositoryFileInput): RepositoryFile
    update(repoId: string, fileId: string, input: RepositoryFileInput): { previous: RepositoryFile; updated: RepositoryFile }
    remove(repoId: string, fileId: string): RepositoryFile       // returns the removed definition
    replaceAll(repoId: string, files: RepositoryFile[]): void    // used by import; no per-field validation — caller must pre-validate
    removeStore(repoId: string): void                            // deletes repository-files/{repoId}.json; no-op if absent; used by the deletion cascade
}
```

> **Storage:** one JSON document per repository at `{storageFolder}/repository-files/{repoId}.json`, mirroring the `projects/{id}.json` per-aggregate pattern. `repositories.json` is never read or written by this manager — `repositoryManager` is injected solely to validate that a given `repoId` exists (via `exists()`) before every operation except `removeStore()`. Stateless like every other manager: re-reads the relevant store from disk on each call. The `repository-files/` directory is created lazily by `writeJsonFile()`.

> **Private `mutate(repoId, fileId, operationLabel, fn)` helper:** backs `update()` and `remove()`, following the `RepositoryManager.mutate()` convention (`constraints.md`). `fn` receives `(existing, store)` and returns either the replacement `RepositoryFile` or `null` to delete it; `store` is passed so `update()`'s case-insensitive path-uniqueness check (via `validateRepositoryFileInput()`) runs against the file's siblings inside the same load/save cycle. Throws `NotFoundError` (repository, then file ID) with `operationLabel` interpolated as `` Cannot ${operationLabel}: ... ``.

> **`removeStore()` skips the repository-existence check** that every other method performs — it must stay usable from the deletion cascade whether called before or after the repository record itself is removed from `repositories.json`. Because it therefore cannot rely on `assertRepositoryExists()` to guarantee `repoId` is a kebab-case value already persisted in `repositories.json` (the guarantee every other method gets for free), it validates `repoId` itself via `isValidKebabCase()` and additionally confirms the resolved store path stays lexically contained under `repository-files/` (`isLexicallyContained()`, `path-guard.ts`) before touching the filesystem — closing a path-traversal gap (CWE-22/CWE-73) flagged by security audit. Either check failing is a silent no-op, not a thrown error, matching the existing "no-op when absent" contract.

### Project

#### Types (`project.types.ts`)

```typescript
interface ProjectWorkspace {
    Description: string;
    DateCreated: string;
    DateModified: string;
    Notes?: string;         // Optional free-text notes. Absent on pre-existing records — reads as '' via WorkspaceManager.
}

interface ProjectData {
    Id: string;
    Name: string;
    Description: string;
    DateCreated: string;
    DateModified: string;
    Repositories: string[];
    Workspaces: Record<string, ProjectWorkspace>;
    CustomFiles?: CustomFile[];  // Files copied into every workspace; absent on older records (reads as []). No SCHEMA_VERSION bump.
    LastActivity?: string;  // ISO 8601 — most recent activity timestamp; updated by updateLastActivity(), does NOT affect DateModified
    SchemaVersion: number;
}

// src/models/project/custom-file.ts — pure module (no fs): type, validation, executable/line-ending policy
// Generic rules (path-segment safety, directory normalisation, label/description/content
// validation, the executable heuristic, the line-ending policy) live in the scope-neutral
// src/models/file-definition.ts (see "File Definition", below) and are re-exported here
// under their established public names — custom-file.ts no longer defines them itself.
interface CustomFile {
    Id: string;            // UUID, stable across path/name edits
    Directory: string;     // relative to workspace root, '/' separators, '' = root
    FileName: string;      // with extension; never contains a separator
    Label: string;
    Description: string;
    Content: string;       // UTF-8 text, max 256 KB
    ListInAgents: boolean; // default false — lists the file in the workspace AGENTS.md
    DateModified: string;
}
type CustomFileInput = Omit<CustomFile, 'Id' | 'DateModified'>;

validateCustomFileInput(input: CustomFileInput, repositoryIds: readonly string[], others: readonly CustomFile[]): CustomFileInput  // throws Error with a user-presentable message
normaliseDirectory(raw: string): string          // re-exported from file-definition.ts
customFileRelativePath(file: Pick<CustomFile, 'Directory' | 'FileName'>): string
isExecutableFile(fileName: string, content: string): boolean   // re-exported from file-definition.ts; .sh/.bash/.zsh/.ksh/.command or '#!' shebang
applyLineEndingPolicy(fileName: string, content: string): string // re-exported from file-definition.ts; .bat/.cmd → CRLF; executable shell files → LF; others as typed
const RESERVED_ROOT_FILE_NAMES: readonly string[]               // README.md, AGENTS.md, CLAUDE.md

// src/models/file-definition.ts — scope-neutral file-definition rules shared by every file-storing
// feature (today: project custom files; Milestone 2 adds repository-level custom files on top of
// the same module). No notion of "project" or "repository" — describes what makes a user-supplied
// file name, directory, label, description, and content safe and well-formed, independent of where
// the file is stored. Pure module (no fs).
const FILE_DEFINITION_MAX_CONTENT_BYTES = 256 * 1024
const FILE_DEFINITION_MAX_LABEL_LENGTH = 120
const FILE_DEFINITION_MAX_DESCRIPTION_LENGTH = 1000

checkPathSegment(segment: string, what: string): string | undefined   // returns an error message, or undefined when `segment` is a safe single path component on every supported OS; `what` is the human-readable label used at the start of the message (e.g. "File name", "Directory")
normaliseDirectory(raw: string): string          // trims, converts '\' to '/', strips leading './' and surrounding slashes; does not validate
joinRelativePath(directory: string, fileName: string): string   // joins a normalised directory (may be '' for the root) and fileName
validateLabel(rawLabel: string, maxLength: number): string      // throws Error when empty or over maxLength; returns the trimmed label
validateDescription(rawDescription: string, maxLength: number): string   // throws Error when over maxLength; returns the trimmed description (empty allowed)
validateFileContent(content: string, maxBytes: number): void    // throws Error on content exceeding maxBytes (UTF-8 byte size) or containing a NUL byte
isExecutableFile(fileName: string, content: string): boolean    // true for .sh/.bash/.zsh/.ksh/.command extensions, or any content starting with a '#!' shebang
applyLineEndingPolicy(fileName: string, content: string): string // .bat/.cmd → CRLF; executable shell files → LF (a CRLF shebang breaks execution); others kept as typed

> **Why limits are passed as parameters, not imported constants:** `validateLabel()`/`validateDescription()`/`validateFileContent()` take `maxLength`/`maxBytes` as call arguments rather than reading the `FILE_DEFINITION_MAX_*` constants directly, keeping the module scope-neutral so a future caller (e.g. a repository-level custom file with different limits) can pass its own. `custom-file.ts` re-exports `CUSTOM_FILE_MAX_CONTENT_BYTES`/`CUSTOM_FILE_MAX_LABEL_LENGTH`/`CUSTOM_FILE_MAX_DESCRIPTION_LENGTH` as aliases of the shared constants and passes them in at each call site; `validateCustomFileInput()`'s check order (label, description, file name, directory, path-collision, content) is unchanged from before the extraction, so every error message and its precedence stay byte-identical.

interface ProjectIndexEntry {
    Id: string;
    Name: string;
}

interface ProjectIndex extends BaseStore {
    Projects: ProjectIndexEntry[];
}
```

#### Manager (`project.manager.ts`)

```typescript
class ProjectManager {
    constructor(config: AppConfig, repositoryManager: RepositoryManager)

    list(): ProjectIndexEntry[]
    getById(id: string): ProjectData | undefined
    create(name: string, repositoryIds: string[], description?: string, id?: string): ProjectData
    update(id: string, changes: { Name?: string; Description?: string }): ProjectData
    rename(oldId: string, newId: string): ProjectData
    remove(id: string): void
    addRepository(projectId: string, repositoryId: string): ProjectData
    removeRepository(projectId: string, repositoryId: string): ProjectData
    updateLastActivity(id: string, value: string): void  // Sets LastActivity (ISO 8601 string from git commit timestamp) without touching DateModified; no-ops silently when id not found or value unchanged
    addWorkspace(projectId: string, workspaceId: string, workspace: ProjectWorkspace): ProjectData
    updateWorkspace(projectId: string, workspaceId: string, changes: Partial<Pick<ProjectWorkspace, 'Description' | 'DateModified' | 'Notes'>>): ProjectData
    removeWorkspace(projectId: string, workspaceId: string): ProjectData
    renameWorkspace(projectId: string, oldId: string, newId: string, dateModified: string): ProjectData
    listCustomFiles(projectId: string): CustomFile[]
    addCustomFile(projectId: string, input: CustomFileInput): CustomFile              // validates via validateCustomFileInput()
    updateCustomFile(projectId: string, fileId: string, input: CustomFileInput): { previous: CustomFile; updated: CustomFile }
    removeCustomFile(projectId: string, fileId: string): CustomFile                   // returns the removed definition
}
```

### Workspace

#### Types (`workspace.types.ts`)

```typescript
const STABLE_WORKSPACE_ID = 'STABLE';

interface WorkspaceInfo {
    ProjectID: string;
    WorkspaceID: string;
    Description: string;
    DateCreated: string;
    DateModified: string;
    Notes: string;          // Free-text notes. Always present as a string; defaults to '' when Notes is absent on the stored record.
}

// Re-exported from project.types.ts:
export type { ProjectWorkspace }  // from '../project/project.types.js'
```

#### Manager (`workspace.manager.ts`)

```typescript
class WorkspaceManager {
    constructor(projectManager: ProjectManager)

    list(projectId: string): WorkspaceInfo[]
    getById(projectId: string, workspaceId: string): WorkspaceInfo | undefined
    create(projectId: string, workspaceId: string, description?: string): WorkspaceInfo
    update(projectId: string, workspaceId: string, changes: { Description?: string; Notes?: string }): WorkspaceInfo
    rename(projectId: string, oldId: string, newId: string): WorkspaceInfo
    remove(projectId: string, workspaceId: string): void
    isStable(workspaceId: string): boolean
}
```

---

## Orchestration (`src/orchestration/`)

### Types (`orchestration.types.ts`)

```typescript
const CLONE_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 60_000;  // shorter than CLONE_TIMEOUT_MS (a push moves fewer files), longer than FETCH_TIMEOUT_MS (headroom for a slow/congested remote)

interface OrchestrationRepoResult {
    repositoryId: string;
    success: boolean;
    error?: string;
}

interface OrchestrationResult {
    results: OrchestrationRepoResult[];
}

interface WorkspaceCloneResult {
    workspaceId: string;
    success: boolean;
    error?: string;
}

interface AddRepositoryResult {
    workspaceResults: WorkspaceCloneResult[];
}

interface BranchSwitchRepoResult {
    success: boolean;
    conflict: boolean;
    error?: string;
}

interface BranchSwitchResult {
    results: Record<string, BranchSwitchRepoResult>;
}
```

### ProjectOrchestrator (`project-orchestrator.ts`)

```typescript
class ProjectOrchestrator {
    constructor(config: AppConfig, projectManager: ProjectManager, workspaceOrchestrator: WorkspaceOrchestrator, workspaceArtifacts: WorkspaceArtifactsOrchestrator)

    createProject(name: string, repositoryIds: string[], description?: string, id?: string): Promise<OrchestrationResult>
    deleteProject(projectId: string): void
    renameProject(oldId: string, newId: string): void
}
```

### Remote Auth (`remote-auth.ts`)

Shared credential resolve/inject/explain helper, extracted from the duplicated inline block formerly in `WorkspaceOrchestrator.createWorkspace()` and `RepositoryOrchestrator.addRepositoryToProject()`, so both orchestrators (and future managed-clone git operations) resolve a repository's git-ready remote URL through one place.

```typescript
type RemoteAuthResolution =
    | { ok: true; url: string; credential: GitCredentialEntry | null }
    | { ok: false; host: string; message: string };

function resolveRemoteAuth(repo: Repository, credentials: GitCredentialEntry[]): RemoteAuthResolution
```

> **SECURITY — `url` must not be persisted:** the success variant's `url` may carry an embedded credential token (via `injectCredentialToken()`). It must be consumed immediately by the single git call it was resolved for (`git clone`, `git remote set-url`, etc.) and never stored on disk, logged, or returned across an API/HTTP boundary. See the `RemoteAuthResolution` JSDoc in `remote-auth.ts` for the full contract.

> **Consumers:** `WorkspaceOrchestrator.createWorkspace()` and `RepositoryOrchestrator.addRepositoryToProject()` (both below) call `resolveRemoteAuth()` instead of inlining `resolveCredential()`/`extractHost()`/`injectCredentialToken()`; behavior, error message text, and error-log entries are unchanged from the former inline block.

### Repository Info Sync File (`repository-info.ts`)

Pure, filesystem-only module for the per-repository `.workspace/info.json` sync file and its companion `README.md`: rendering, parsing, hashing, diffing, and sync-state evaluation. Mirrors `workspace-index.ts`'s pure-module pattern (below) — no manager or git access; `RepositoryInfoSyncOrchestrator` (`repository-info-sync.ts`, below) resolves paths and drives git.

```typescript
const REPOSITORY_INFO_FOLDER_NAME = '.workspace'
const REPOSITORY_INFO_FILE_NAME = 'info.json'
const REPOSITORY_INFO_README_FILE_NAME = 'README.md'
const REPOSITORY_INFO_SCHEMA_VERSION = 1

interface RepositoryInfoFileEntry { Path: string; Label: string; Description: string; Executable: boolean; ListInAgents: boolean; ContentHash: string }  // ContentHash is in-memory only, from canonicalFilesForHash() — never written to info.json
type RepositoryInfoFileMetadata = Pick<RepositoryInfoFileEntry, 'Path' | 'Label' | 'Description' | 'Executable' | 'ListInAgents'>;  // the info.json Files entry shape (no ContentHash)

interface RepositoryInfoFile {
    SchemaVersion: number;
    Id: string;
    Name: string;
    Url?: string;              // informational only — never hashed, diffed, or imported
    Description: string;
    Settings: Record<string, unknown>;
    Files?: RepositoryInfoFileMetadata[];  // per-file metadata, sorted by Path; absent on an un-upgraded M1 file, treated as []
    [key: string]: unknown;    // unknown top-level keys preserved verbatim on rewrite
}

interface RepositoryInfoPayload { Id: string; Name: string; Description: string; Files?: RepositoryInfoFileEntry[] }  // the synced field set (Milestone 2); Files optional so every pre-M2 payload literal stays valid

interface RepositoryInfoReadResult {
    status: 'absent' | 'ok' | 'invalid' | 'unsupported-schema';
    payload?: RepositoryInfoPayload;  // present when status === 'ok'; Files entries' ContentHash is always '' here — info.json never stores one
    raw?: RepositoryInfoFile;         // present when status === 'ok'
    error?: string;                   // present when status === 'invalid'
}

type RepositoryInfoSyncState =
    | 'disabled' | 'main-folder-unavailable'   // caller-applied short-circuit states; never returned by evaluateRepositoryInfoSync()
    | 'in-sync' | 'write-required' | 'incoming' | 'conflict'
    | 'invalid-file' | 'id-mismatch' | 'unsupported-schema';

type RepositoryInfoImportField = 'Name' | 'Description';

interface RepositoryInfoFieldDiff { field: RepositoryInfoImportField; current: string; incoming: string }

interface RepositoryFileFieldChange { field: 'Label' | 'Description' | 'Executable' | 'ListInAgents' | 'Content'; local: string | boolean; incoming: string | boolean }

interface RepositoryFileDiff {
    path: string;
    kind: 'incoming-only' | 'local-only' | 'changed';   // incoming-only: folder-only (teammate added); local-only: data-only (removed, or not pulled yet); changed: both sides, ≥1 differing field
    changes?: RepositoryFileFieldChange[];               // present only for kind === 'changed'
}

interface EvaluateRepositoryInfoSyncParams {
    dataHash: string;
    folder: RepositoryInfoReadResult;
    lastWrittenHash?: string;
    repositoryId: string;
}

function buildRepositoryInfoPayload(repo: Repository, files: readonly RepositoryFileHashEntry[] = []): RepositoryInfoPayload   // converts canonicalFilesForHash() tuples into Files, sorted by Path
function buildInformationalUrl(repo: Repository): string                              // repo.Url with embedded credentials stripped
function hashRepositoryInfoPayload(payload: RepositoryInfoPayload): string             // SHA-256 of [Id, Name, Description]; Url excluded; see compatibility-rule note below
function readRepositoryInfoFile(mainFolder: string): RepositoryInfoReadResult
function renderRepositoryInfoFile(payload: RepositoryInfoPayload, informationalUrl: string, existingRaw?: RepositoryInfoFile): string
function renderRepositoryInfoReadme(): string                                          // fixed, machine-independent text; never affects the hash; includes the Milestone 2 files/ section
function evaluateRepositoryInfoSync(params: EvaluateRepositoryInfoSyncParams): RepositoryInfoSyncState
function diffRepositoryInfo(current: RepositoryInfoPayload, incoming: RepositoryInfoPayload): RepositoryInfoFieldDiff[]
function diffRepositoryFiles(local: readonly RepositoryInfoFileEntry[], folder: readonly RepositoryInfoFileEntry[]): RepositoryFileDiff[]   // for the import dialog; case-insensitive path matching
function writeRepositoryInfoFile(mainFolder: string, content: string): { written: boolean }
function writeRepositoryInfoReadme(mainFolder: string): { written: boolean }
function infoFolderPathspec(): string                                                  // '.workspace/' — scopes a git status/stage/commit to this module's files
```

> **`Url` is informational only:** excluded from `hashRepositoryInfoPayload()`, `diffRepositoryInfo()`, and the sync-state decision table — a file differing from Paralizer's data only in `Url` evaluates as `in-sync`. This prevents per-colleague remote-form differences (HTTPS-with-token vs. SSH vs. host alias) from manufacturing false `incoming`/`conflict` states. `buildInformationalUrl()` always strips embedded credentials via `stripEmbeddedCredentials()` before the value is written.

> **`Files` hash-compatibility rule (Milestone 2):** `hashRepositoryInfoPayload()` hashes `[Id, Name, Description]` exactly as in Milestone 1 when `payload.Files` is empty — byte-identical, with no fourth array element at all — so a repository with no files keeps its existing M1 baseline valid across the upgrade and `SchemaVersion` stays `1`. Only when `Files` is non-empty does a fourth element get appended: the sorted (`by Path`, case-insensitive) `[Path, Label, Description, Executable, ListInAgents, ContentHash]` tuples, so the hash never depends on build order. `info.json` itself never stores `ContentHash` — `readRepositoryInfoFile()` always sets it to `''` on read; a caller rebuilding the folder-side payload for hashing/diffing must re-derive it by joining with `readRepositoryFilesFolder()`/`canonicalFilesForHash()` (`repository-files.ts`).

> **`diffRepositoryFiles()`:** matches `local`/`folder` entries by case-insensitive `Path` (mirroring `readRepositoryFilesFolder()`). A path on both sides with every field equal produces no diff entry at all — because `ContentHash` already comes from `canonicalFilesForHash()`'s LF-normalised content, a CRLF-only difference never surfaces, and because `Executable` here is the metadata flag rather than a raw filesystem mode bit, a file-mode-only difference never surfaces either. A path present on both sides with a `ContentHash` difference is reported as a single `'Content'` field change (carrying the two hash strings, not file bodies).

> **`evaluateRepositoryInfoSync()` decision table** (hash-driven only):

| Folder file status | Condition | State |
|---|---|---|
| absent | — | `write-required` |
| invalid | — | `invalid-file` |
| unsupported-schema | — | `unsupported-schema` |
| ok | `Id` ≠ `repositoryId` | `id-mismatch` |
| ok | folderHash = dataHash | `in-sync` |
| ok | no baseline (`lastWrittenHash` unset) | `conflict` |
| ok | folder = baseline, data ≠ baseline | `write-required` (local edit) |
| ok | folder ≠ baseline, data = baseline | `incoming` |
| ok | folder ≠ baseline, data ≠ baseline | `conflict` |

> Recording a new baseline hash when an `in-sync` folder's hash differs from a stale `lastWrittenHash` is the caller's responsibility — this function only returns the state.

> **Write guard chain:** `writeRepositoryInfoFile()` and `writeRepositoryInfoReadme()` share a guard (lexical containment → realpath symlink-escape → directory-shape check on the `.workspace` folder, reusing `path-guard.ts`, below) and a write-only-if-changed rule (an unchanged second write leaves the file's mtime untouched). A guard failure is reported as `{ written: false }`, never throws.
>
> **`writeRepositoryInfoReadme()` is unconditional** — it has no sync-state awareness. `RepositoryInfoSyncOrchestrator.syncRepository()` (below) is responsible for calling it only when the evaluated state is not `disabled`, `main-folder-unavailable`, `id-mismatch`, `incoming`, or `conflict`.

### Repository Files Folder (`repository-files.ts`, Milestone 2)

Pure, filesystem-only module that reads and writes the managed clone's `.workspace/files/` folder — the committed-to-git counterpart of `RepositoryFileManager`'s data layer. Mirrors `custom-files.ts`'s writer pattern (same `guardedFileTarget()`/`pruneEmptyParents()` guard chain from `path-guard.ts`), but diverges where the two features differ: these files are committed, so the writer is write-only-if-changed and deletes by set difference against the data set, rather than unconditionally overwriting and tracking a single previous definition.

```typescript
const REPOSITORY_FILES_FOLDER_NAME = 'files'   // relative to REPOSITORY_INFO_FOLDER_NAME ('.workspace/files/')

interface RepositoryFileMetadataEntry { Path: string; Label: string; Description: string; Executable: boolean; ListInAgents: boolean }  // info.json Files entry shape
interface RepositoryFolderFileMetadata { Label: string; Description: string; Executable: boolean; ListInAgents: boolean }

interface RepositoryFolderFile {
    path: string;       // relative to .workspace/files/, '/'-separated
    content: string;    // UTF-8 text when `problem` is unset; latin1 (raw-byte-preserving) when `problem` is set and is not the unreadable marker; '' when unreadable
    metadata: RepositoryFolderFileMetadata;
    problem?: string;   // human-readable reason the file cannot be treated as a normal repository file
}

interface ReadRepositoryFilesFolderResult { files: RepositoryFolderFile[]; unsafeEntries: string[] }

type RepositoryFileHashEntry = [path: string, label: string, description: string, executable: boolean, listInAgents: boolean, contentHash: string];

interface WriteRepositoryFilesResult { written: string[]; removed: string[]; skipped: string[] }

readRepositoryFilesFolder(mainFolder: string, metadata: readonly RepositoryFileMetadataEntry[]): ReadRepositoryFilesFolderResult
writeRepositoryFiles(mainFolder: string, files: readonly RepositoryFile[]): WriteRepositoryFilesResult
canonicalFilesForHash(files: readonly RepositoryFolderFile[]): RepositoryFileHashEntry[]
```

> **Reader (`readRepositoryFilesFolder()`):** walks `.workspace/files/` recursively without ever following a symlink — a symlink entry (file or directory) is reported only in `unsafeEntries` and never descended into or read; any other non-regular entry (FIFO, socket, device file) is reported the same way. Every regular file is returned in `files`, joined with its `info.json` metadata entry by case-insensitive `Path`; a file without a matching entry gets defaults (`Label` = file name, empty `Description`, `Executable` from `isExecutableFile()`, `ListInAgents: false`). A metadata entry without a matching file on disk is silently ignored. A file that is unreadable, has an invalid or reserved (`.git`, any depth, case-insensitive) path segment, exceeds the size limit, or contains embedded binary data is still returned — never dropped — with `problem` set; this is what lets `canonicalFilesForHash()` detect the change rather than silently treating the file as absent.

> **Writer (`writeRepositoryFiles()`):** every target goes through the same guard chain as `custom-files.ts`'s writer, with one difference forced by the files/ root not existing yet on a repository's first write — `.workspace/files/`'s own existence can't be assumed the way `custom-files.ts`'s workspace-folder root can, so the target is resolved lexically first (to know which directory to `mkdir`), then `guardedFileTarget()` runs once the directory — and therefore the root — exists. Content and the POSIX executable mode (`chmod`, skipped on Windows) are each written only when they differ from what's already on disk, so an unchanged re-sync leaves the file's mtime untouched. The delete pass removes every regular file under `files/` not in the current data set, re-confirming each candidate with `lstat` immediately before removal; a symlink or any other non-regular entry is never removed, regardless of whether it is "expected" — it is always left in place and reported in `skipped`. Directories left empty by a deletion are pruned upward via `pruneEmptyParents()`, stopping at (never removing) `files/` itself.

> **`canonicalFilesForHash()`:** builds the order-independent representation of a repository's file set used (by a later work package) to extend `hashRepositoryInfoPayload()`. Sorted by lowercased `path`. Every entry in `files` counts, including a `problem` file, so a teammate's committed binary/oversized/invalid-path/unreadable file always changes the hash and surfaces as `incoming`/`conflict` rather than being silently ignored (and, since the delete pass only ever runs in a `write-required` state, never reaches deletion without an explicit import decision): a normal file hashes `sha256` of its LF-normalised content (so a Windows `core.autocrlf` checkout never looks like an incoming change); a `problem` file (other than unreadable) hashes `sha256` of its raw bytes via `Buffer.from(content, 'latin1')` (no line-ending normalisation); an unreadable file contributes the fixed string `'unreadable'`. `files` must already exclude symlinks/non-regular entries (`unsafeEntries`) — they are never part of this hash.

### Main Folder (`repository-main-folder.ts`)

Resolves and git-inspects the managed main folder — the Paralizer-managed partial/sparse clone that is the *only* location Paralizer ever reads or writes `.workspace/` from, kept separate from any clone the user already has under `projectsFolder`. Creation, removal, and read-only inspection of that clone all live here; `RepositoryInfoSyncOrchestrator` (`repository-info-sync.ts`, below) drives these functions together with the pure `repository-info.ts` module above.

```typescript
const MANAGED_MAIN_FOLDER_DIR = 'repositories'

function getManagedMainFolderRoot(config: Pick<AppConfig, 'storageFolder'>): string      // {storageFolder}/repositories/
function resolveMainFolderPath(config: Pick<AppConfig, 'storageFolder'>, repoId: string): string  // {storageFolder}/repositories/{repoId}/

class MainFolderGitError extends Error {}          // any git failure other than an unresolvable default branch
class MainFolderPreconditionError extends Error {} // empty remote, or default branch with no remote-tracking ref

interface MainFolderInspection {
    exists: boolean;
    isGitRepository: boolean;
    remoteUrl: string | null;        // credential-stripped; null when not a git repository
    remoteMatches: boolean;          // via remoteUrlsMatch()
    currentBranch: string | null;
    defaultBranch: string | null;
    ahead: number;
    behind: number;
    pendingChanges: string[];        // git status --porcelain, scoped to the .workspace/ info folder
}

function inspectMainFolder(folder: string, repoUrl: string): Promise<MainFolderInspection>

function deriveMainFolderIssues(inspection: MainFolderInspection): HealthIssue[]
function isMainFolderUsable(inspection: MainFolderInspection): boolean

interface CreateManagedCloneResult { path: string; defaultBranch: string; filterFallback: boolean }

function createManagedClone(config: Pick<AppConfig, 'storageFolder'>, repo: Repository, authUrl: string): Promise<CreateManagedCloneResult>
function removeManagedClone(config: Pick<AppConfig, 'storageFolder'>, repoId: string): boolean
```

> **No user-supplied path:** `resolveMainFolderPath()` deliberately accepts only `config` and `repoId` — there is no path or "mode" field anywhere in this sync feature (`RepositoryInfoSyncSettings` carries neither), so there is nothing else this function could accept without silently growing a second, unsanctioned way to point at a main folder. A user-chosen main-folder path was considered and dropped (see Deferred Items in the plan); it would have needed path validation, SSH/HTTPS remote equivalence, a wrong-branch guard, and never-reconfigure rules for little added value once import and commit-&-push both work on the managed clone.

> **`createManagedClone()` sequence:** guard the destination (reject if something already exists there) → `git clone --filter=blob:none --no-checkout` → `sparse-checkout set --cone .workspace` → resolve the default branch → verify `refs/remotes/origin/<default>` exists, throwing `MainFolderPreconditionError` when it does not → `checkout <default>`. A server that does not support partial-clone filtering does not fail the clone: git itself silently falls back to a full clone and emits `FILTER_UNSUPPORTED_WARNING` (from `git-clone.ts`) as a stderr warning with `exitCode: 0` — this is detected and reported via `filterFallback` rather than retried without `--filter` (a retry would duplicate work git already did). Any failure from the clone step onward removes the partially created destination before the error propagates, so a failed call never leaves a half-built clone on disk.

> **`removeManagedClone()` guard:** uses the same two-layer path-traversal guard (strict-descendant lexical containment, then a realpath symlink-escape check — see `path-guard.ts`, below) as `removeRepositoryFromProject()` in `repository-orchestrator.ts`. Refuses (returns `false` without touching the filesystem) rather than throwing — a guard rejection and a folder that was never created are both ordinary "nothing to do" outcomes for this boolean-returning API.

> **`deriveMainFolderIssues()` / `isMainFolderUsable()` scope:** scoped to the main folder's own git state only (missing, not a git repository, remote mismatch, wrong branch). Sync-state issues (e.g. an incoming change available for import) are derived from `evaluateRepositoryInfoSync()` above by `RepositoryInfoSyncOrchestrator`, not here. `isMainFolderUsable()` deliberately does **not** require being on the default branch — a wrong branch is reported as a warning-level issue but still permits read-only sync evaluation; only `commitAndPush()` (below) refuses outright when off the default branch.

### Repository Info Sync Orchestrator (`repository-info-sync.ts`)

Ties the pure `repository-info.ts` module and the git-backed `repository-main-folder.ts` module together into the public operations the GUI/REST layer drives (see `rest-api.md`'s **Repository Info Sync** section for the routes): a synchronous, filesystem-only sync usable from the existing artefact choke-point, plus async settings/refresh/import/commit-and-push/recreate operations, each serialised per repository.

```typescript
interface RepositoryInfoSyncResult { state: RepositoryInfoSyncState; written: boolean }  // written: info.json was (re)written this call

interface RepositoryInfoSyncStatus {
    enabled: boolean;
    mainFolder: (MainFolderInspection & { path: string }) | null;  // null only when sync is disabled
    state: RepositoryInfoSyncState;
    pendingChanges: string[];
    lastSyncedAt?: string;
    defaultCommitMessage: string;
    health: HealthReport;
}

interface RepositoryInfoSyncSettingsInput { enabled: boolean; discardPendingChanges?: boolean }
interface CommitPushResult { committed: boolean; pushed: boolean; commitSha?: string; filterFallback?: boolean }

// Per-file import diff/decision types (Milestone 2, `repository-info.ts`) — see `getImportPreview()`/`applyImport()` below.
interface RepositoryFileFieldChange { field: 'Label' | 'Description' | 'Executable' | 'ListInAgents' | 'Content'; local: string | boolean; incoming: string | boolean }
interface RepositoryFileDiff { path: string; kind: 'incoming-only' | 'local-only' | 'changed'; changes?: RepositoryFileFieldChange[]; problem?: string }
type RepositoryFileImportAction = 'add' | 'discard' | 'keep' | 'delete' | 'overwrite';
interface RepositoryFileImportSelection { path: string; action: RepositoryFileImportAction }
function defaultFileImportAction(kind: RepositoryFileDiff['kind']): RepositoryFileImportAction            // 'discard' for incoming-only, 'keep' otherwise
function resolveFileImportAction(diff: RepositoryFileDiff, requested: RepositoryFileImportAction | undefined): RepositoryFileImportAction

class SyncPreconditionError extends Error {}  // wrong state, wrong branch, nothing pending, etc.
class PendingChangesError extends Error {}    // disable/recreate would discard pending changes; opt in via discardPendingChanges
class RemoteOperationError extends Error {}   // clone/fetch/push/commit/merge failure; always credential-stripped

function buildDefaultInfoCommitMessage(repositoryId: string, pendingChanges?: readonly string[]): string  // offered by the Commit & Push dialog
function describeInfoChangeAreas(pendingChanges: readonly string[]): string[]                              // pure helper: info.json/README/files, fixed order, no duplicates

class RepositoryInfoSyncOrchestrator {
    constructor(config: AppConfig, repositoryManager: RepositoryManager, repositoryFileManager: RepositoryFileManager, errorLogManager?: ErrorLogManager)

    assertSyncEnabled(repositoryId: string): void                                  // throws SyncPreconditionError while sync is disabled
    runLocked<T>(repositoryId: string, fn: () => Promise<T>): Promise<T>           // public per-repository mutex, for mutation surfaces built on this orchestrator
    syncRepository(repositoryId: string): RepositoryInfoSyncResult                 // synchronous, filesystem-only; safe for the artefact choke-point
    getStatus(repositoryId: string): Promise<RepositoryInfoSyncStatus>             // no network calls
    saveSettings(repositoryId: string, input: RepositoryInfoSyncSettingsInput): Promise<RepositoryInfoSyncStatus>
    refresh(repositoryId: string): Promise<RepositoryInfoSyncStatus>
    getImportPreview(repositoryId: string): Promise<{ state: RepositoryInfoSyncState; fields: RepositoryInfoFieldDiff[]; files: RepositoryFileDiff[] }>
    applyImport(repositoryId: string, input: { fields: RepositoryInfoImportField[]; files?: RepositoryFileImportSelection[] }): Promise<RepositoryInfoSyncStatus>
    commitAndPush(repositoryId: string, options?: { message?: string }): Promise<CommitPushResult>
    recreateManagedClone(repositoryId: string, options?: { discardPendingChanges?: boolean }): Promise<RepositoryInfoSyncStatus>
    removeManagedFolder(repositoryId: string): void                                // synchronous; used by the deletion cascade
}
```

> **`repositoryFileManager` is a required constructor dependency (Milestone 2).** An orchestrator built without it would compute an empty file set for a repository that has files, evaluate `write-required`, and `writeRepositoryFiles()`'s delete pass would remove every committed file from the managed clone — so a missing file manager is a compile error at every construction site rather than a silent data-loss bug at runtime. All construction sites (`src/server/index.ts`, `src/cli/custom-files.ts`'s `createDefaultCustomFilesDeps()`, `src/cli/repo-files.ts`'s `createDefaultRepoFilesDeps()` (Milestone 2 — WP-011), and both orchestrator test harnesses) pass one on the same storage folder.
>
> **`syncRepository()` is the only method intended to run on every artefact regeneration;** every other method performs real git I/O and is only ever invoked from an explicit user action (settings toggle, refresh button, import dialog, commit & push, or a health-issue fix action). It never throws for an ordinary "nothing to do" outcome (disabled, no main folder yet) — only `NotFoundError` (unknown repository ID) or a genuine filesystem error escapes. It writes `info.json` only when the evaluated state is `write-required`, records the hash-only baseline (no write) when `in-sync` but `LastWrittenHash` is stale/missing, writes `.workspace/README.md` whenever it differs except in the states `disabled`, `main-folder-unavailable`, `id-mismatch`, `incoming`, `conflict`, and (Milestone 2) writes the repository's files under `.workspace/files/` after `info.json`, write-only-if-changed exactly like the info file itself.
>
> **`assertSyncEnabled(repositoryId)`:** throws `NotFoundError` for an unknown repository ID, `SyncPreconditionError` while info sync is disabled for it, and returns normally otherwise. A thin, reusable guard so the mutation surfaces built on top of this orchestrator (REST routes, CLI commands — WP-008, WP-011) enforce the same precondition every async method here already checks for itself, without duplicating the check.
>
> **Per-repository mutex (`runLocked`, public — formerly the private `withRepositoryLock`):** every git-backed mutator (`saveSettings`, `refresh`, `applyImport`, `commitAndPush`, `recreateManagedClone`) is serialised per repository via a private `Map<string, Promise<unknown>>`, so two concurrent GUI requests never race on `.git/index.lock` for the same repository. A queued operation always runs after the prior one settles regardless of success/failure; the map entry is deleted once nothing is queued behind it, so it does not grow unbounded over a long server lifetime. It is now public so mutation surfaces built on top of this orchestrator (REST routes, CLI commands) can serialise their own multi-step operations (e.g. a file add followed by a folder write) behind the same per-repository lock this orchestrator itself uses.
>
> **`saveSettings()`:** disabling refuses with `PendingChangesError` unless `discardPendingChanges` is `true`, then removes the managed clone and clears `InfoSync` entirely (so `LastWrittenHash` never survives a disable/re-enable cycle). Enabling creates the managed clone first and persists `{ Enabled: true }` (no hash) only after the clone succeeds, so a failed enable leaves no `InfoSync` setting behind. Either way, `syncRepository()` runs before the status is returned.
>
> **`getImportPreview()` / `applyImport()`:** both require state `incoming` or `conflict`, which (per `evaluateRepositoryInfoSync()`'s decision table) already guarantees the file reads `ok` and its `Id` matches — not re-checked separately. `getImportPreview()`'s `files` is `diffRepositoryFiles()`'s (`repository-info.ts`) pure path/field diff joined with `problem` data from the folder read (binary/oversized/unreadable/unsafe entries), identical files omitted. `applyImport()` re-reads and re-evaluates the state before applying (a concurrent caller serialised behind it may already have resolved it), applies the selected fields (`Name`/`Description`) through `RepositoryManager.update()` and never touches `Url` or `CredentialId`, and resolves every file diff's action via `resolveFileImportAction()` (`repository-info.ts`) up front — before any mutation — so an unknown path or a disallowed action (wrong action for the diff's `kind`, or any action but the one safe one on a `problem` diff) rejects the whole call with a plain `Error` and leaves no partial import. The per-diff action table is `incoming-only` → `add`/`discard`, `local-only` → `keep`/`delete`, `changed` → `overwrite`/`keep`; a path omitted from `input.files` defaults to the side that keeps Paralizer's own data (`discard`/`keep`/`keep` respectively — see `defaultFileImportAction()`). Resolved file actions are applied in one `RepositoryFileManager.replaceAll()` call, then folded into the same merged write/hash-record step as the field import. An empty/omitted `fields` or `files` array is valid — it keeps every local value, still rewrites the file from Paralizer's data, and resolves to `in-sync`. Writes an `audit`-severity log entry (`Source: 'workspace-info'`, `Operation: 'import'`) listing both the field list and the per-file `action: path` list (or `(none)` when there were no file diffs).
>
> **`commitAndPush()`:** refuses with `SyncPreconditionError` when the folder is unavailable, off the default branch, the state is `incoming`/`conflict`/`invalid-file`/`id-mismatch`/`unsupported-schema`, or nothing is pending. Otherwise re-points `origin`, fetches, and — when behind — refuses if the upstream change touches the info folder (`changedPathsBetween()` filtered client-side to the `.workspace/` prefix, since that function has no pathspec parameter) or fast-forwards. Changes are staged via `stagePaths()` scoped to `infoFolderPathspec()`, then (Milestone 2) `getStagedPaths()` guards that nothing outside `.workspace/` was staged (throws `SyncPreconditionError` otherwise, before any commit), then `getIndexModes()`/`setIndexExecutable()` fix up the staged index's executable bit for every repository file whose mode disagrees with `RepositoryFile.Executable`, and finally `commitStaged()` commits the staged index directly (no pathspec — see `commitStaged()`'s docs above for why a pathspec commit would drop the chmod) always carrying the fixed `INFO_COMMIT_AUTHOR_NAME`/`INFO_COMMIT_AUTHOR_EMAIL` identity (never a global git identity). Every surfaced git error is credential-stripped via `stripEmbeddedCredentials()`; a push rejected for lack of permission (`403`/`permission denied`/`denied`) gets an explanatory hint appended. Writes an `audit`-severity log entry on success.
>
> **`buildDefaultInfoCommitMessage()` / `describeInfoChangeAreas()` (Milestone 2):** with no `pendingChanges` (or none that map to a known area), the default message stays byte-identical to Milestone 1's `Update .workspace for "{repoId}" via Paralizer`; otherwise `describeInfoChangeAreas()` maps the pending paths to `info.json`/`README`/`files` (fixed order, no duplicates, based on path prefix) and the message appends them in parentheses, e.g. `Update .workspace for "{repoId}" via Paralizer (info.json, files)`. `getStatus()` and `commitAndPush()`'s own default-message fallback both pass the current `pendingChanges` so the dialog's offered message and the status's `defaultCommitMessage` field agree.
>
> **`recreateManagedClone()` / `removeManagedFolder()`:** `recreateManagedClone()` refuses with `PendingChangesError` unless discarded, then removes and re-clones, clearing `LastWrittenHash` (a fresh clone is baseline-less, so a differing file routes through the import dialog rather than being silently treated as `in-sync` against a stale hash) while preserving `LastSyncedAt`. `removeManagedFolder()` is synchronous, does no settings mutation and no git beyond the filesystem removal already performed by `removeManagedClone()` — used by `RepositoryOrchestrator.deleteRepositoryGlobally()`'s deletion cascade after the repository's data entry has already been removed.
>
> **Health report (`buildHealthReport()`, private):** remaps `deriveMainFolderIssues()`'s generic issue types onto this module's own `info-sync-*` vocabulary (`info-sync-main-folder-missing`, `info-sync-remote-mismatch`, `info-sync-wrong-branch`) rather than duplicating the underlying checks, adds sync-state-derived issues (`info-sync-behind-remote`, `info-sync-pending-changes`, `info-sync-import-available`, `info-sync-conflict`, `info-sync-invalid-file`, `info-sync-id-mismatch`, `info-sync-unsupported-schema` — only meaningful when the folder is usable), and `info-sync-credential-missing` (meaningful regardless of folder usability, since it blocks every async operation this orchestrator offers). See `rest-api.md`'s **Repository Info Sync Issue Types** table for the full severity/`fixAction` list.
>
> **Files-folder health sweep (`buildFilesHealthIssues()`, private, Milestone 2):** called only when the main folder is usable, and is purely read-only (no write, not even a dry-run `mkdir`), so calling it from `getStatus()` on every poll never mutates the managed clone. Raises `info-sync-files-unsafe-entry` for a symlink or other non-regular entry under `files/` (from `readRepositoryFilesFolder()`'s `unsafeEntries`), `info-sync-files-invalid-incoming` for a regular file under `files/` that cannot be treated as a normal repository file (binary, oversized, unreadable, or an invalid/reserved path segment — `fixAction: 'import'`, since resolving it requires looking at the incoming change), and `info-sync-files-write-skipped` when one of the repository's own files (`RepositoryFileManager.list()`) resolves to a write target the shared guard chain (`guardedFileTarget()`) refuses — the same check `writeRepositoryFiles()` itself applies before writing, run here without writing so a refusal surfaces even outside a sync. Every method that evaluates sync state (not just `syncRepository()`) — `getStatus()`, `getImportPreview()`, `applyImport()`, `commitAndPush()` — reconstructs its `dataHash`/`folderHash` from real file content via module-private helpers (`toFolderFiles()`, `buildLocalPayload()`, `withFolderFileHashes()`), since `info.json` never stores file content and so cannot supply a hash on its own.

> **Commit constants (`src/config/config.constants.ts`):** `INFO_COMMIT_AUTHOR_NAME = 'Paralizer'` and `INFO_COMMIT_AUTHOR_EMAIL = 'paralizer@mistralys.eu'` are the fixed identity `commitAndPush()` always passes to `commitStaged()` (`git-commit.ts`, Milestone 2 — `commitPaths()` before it), independent of any machine's git config. `MAX_INFO_COMMIT_MESSAGE_LENGTH = 500` bounds the trimmed `message` body field on `POST .../commit-push` (`rest-api.md`) and the commit dialog's own client-side validation (`info-commit-dialog.js`, below) — both enforce the identical limit so the dialog never accepts a message the route would reject.

### RepositoryOrchestrator (`repository-orchestrator.ts`)

```typescript
class RepositoryOrchestrator {
    constructor(config: AppConfig, projectManager: ProjectManager, repositoryManager: RepositoryManager, workspaceArtifacts: WorkspaceArtifactsOrchestrator, errorLogManager?: ErrorLogManager, repositoryInfoSync?: RepositoryInfoSyncOrchestrator, repositoryFileManager?: RepositoryFileManager)

    addRepositoryToProject(projectId: string, repositoryId: string): Promise<AddRepositoryResult>
    removeRepositoryFromProject(projectId: string, repositoryId: string): void
    deleteRepositoryGlobally(repositoryId: string): void
}
```

> **`deleteRepositoryGlobally()`'s managed-folder cleanup:** when `repositoryInfoSync` is injected, `removeManagedFolder(repositoryId)` (see `RepositoryInfoSyncOrchestrator`, above) runs once `repositoryManager.remove()` has succeeded — there is no `InfoSync` setting left to clear at that point, so this is a plain filesystem removal. A removal failure is logged as a `Severity: 'warning'`, `Source: 'workspace-info'`, `Operation: 'delete-repository-global'` entry rather than thrown, since the repository record is already gone by the time this step runs. On success, the `delete-repository-global` audit message (described below) gains a trailing "Managed main folder removed." sentence; it is omitted on failure or when no sync orchestrator was injected.
>
> **`deleteRepositoryGlobally()`'s file-store cleanup (Milestone 2, new optional trailing `repositoryFileManager` parameter):** mirrors the managed-folder cleanup immediately above — runs after `repositoryManager.remove()` succeeds, is best-effort (a thrown error is logged as a `Severity: 'warning'`, `Source: 'workspace-info'`, `Operation: 'delete-repository-global'` entry and does not block deletion or the audit entry), and appends a trailing "Repository file store removed." sentence to the same audit message when it succeeds. Like `managedFolderRemoved`, `fileStoreRemoved` becomes `true` whenever `removeStore()` does not throw — including when no store existed for that repository, since `removeStore()` silently no-ops in that case — so the audit suffix does not strictly mean a store was present, only that the best-effort removal attempt did not fail. Omitting `repositoryFileManager` (the existing 4-, 5-, and 6-argument constructor forms) makes this step a no-op, exactly as omitting `repositoryInfoSync` does for the managed-folder step.

> **`removeRepositoryFromProject()`'s association precondition:** before any clone folder is touched, the method checks `project.Repositories.includes(repositoryId)` and throws `Repository "X" is not listed in project "Y".` if it fails — hoisted above the per-workspace delete loop so an unlisted repository ID can never cause a partial, unassociated deletion. `projectManager.removeRepository()` further down re-validates the same association as defense in depth.

> **`removeRepositoryFromProject()`'s two-layer delete guard:** each clone path is validated before `fs.rmSync()` by a strict-descendant lexical check (rejects equality with `projectsFolder` itself — unlike the equality-permitting `isLexicallyContained()` in `Path Guard`, below, used by the writer path — so a malformed/persisted ID can never resolve to the projects root), followed by `escapesRootViaRealpath()` (from `Path Guard`, below) against a `projectsFolder` real path resolved once via `resolveRootRealPath()`. Either violation throws a plain `Error` with the pre-existing `"Security check failed"` message; a legitimate clone folder is still deleted when `projectsFolder` itself sits behind a symlink, since the realpath root is resolved the same way on both sides of the comparison.

> **Audit trail and the regeneration-failure boundary:** when `errorLogManager` is injected, `removeRepositoryFromProject()` emits a `Severity: 'audit'`, `Source: 'repository-audit'`, `Operation: 'unlink-repository'` entry (`Context: { ProjectId, RepositoryId }`) as soon as `projectManager.removeRepository()` succeeds — the audited event ("repository unlinked and clone folders removed") is complete at that point, so the entry is emitted **unconditionally** from there on, regardless of whether the downstream `workspaceArtifacts.regenerateProject()` call succeeds. That call runs afterward inside a `try/catch`: on failure it appends a separate `Severity: 'warning'`, `Source: 'workspace-index'`, `Operation: 'unlink-repository'` entry describing the failure and execution continues, rather than propagating and erasing the audit record of a deletion that genuinely happened. A guard failure or an unlisted repository, both checked earlier, still throw before any mutation and so still produce no entry at all. `deleteRepositoryGlobally()` collects the affected project IDs during its cascade loop and, only after `repositoryManager.remove()` also succeeds, emits one summary `Operation: 'delete-repository-global'` entry with `Details` carrying the JSON-serialized affected-project-ID list; if `repositoryManager.remove()` throws, this summary entry is never written, but the per-project `unlink-repository` entries already emitted during the cascade are left in place. All entry types are no-ops when `errorLogManager` is not injected. See `data-flows.md`'s **Global Repository Deletion Cascade** for the full ordering.

### WorkspaceOrchestrator (`workspace-orchestrator.ts`)

```typescript
class WorkspaceOrchestrator {
    constructor(config: AppConfig, projectManager: ProjectManager, workspaceManager: WorkspaceManager, repositoryManager: RepositoryManager, workspaceArtifacts: WorkspaceArtifactsOrchestrator, errorLogManager?: ErrorLogManager)

    createWorkspace(projectId: string, workspaceId: string): Promise<OrchestrationResult>
    deleteWorkspace(projectId: string, workspaceId: string): void
    renameWorkspace(projectId: string, oldId: string, newId: string): void
}
```

> **`workspaceArtifacts` (`WorkspaceArtifactsOrchestrator`) injection:** All three orchestrators above now delegate every `.code-workspace`/generated-index-file read-modify-write to the injected `WorkspaceArtifactsOrchestrator` (see `workspace-artifacts.ts`, below) instead of calling `generateWorkspaceFile()`/`removeWorkspaceFile()` directly — `RepositoryOrchestrator`'s former private `regenerateWorkspaceFile()` helper has been deleted in favour of `workspaceArtifacts.regenerateProject(projectId)`. `WorkspaceOrchestrator.renameWorkspace()` regenerates the new-ID artefact set via `regenerateWorkspace(projectId, newId, { workspaceMeta: project.Workspaces[oldId] })` (see `RegenerateWorkspaceOverrides.workspaceMeta`) before removing the old ID's artefacts. **Production reachability is asymmetric:** `WorkspaceOrchestrator` and `RepositoryOrchestrator` are both instantiated in `src/server/index.ts` — `WorkspaceOrchestrator` reachable via `POST .../setup`, `RepositoryOrchestrator` reachable via `DELETE /api/repositories/:id` (which calls `deleteRepositoryGlobally()`, see `rest-api.md`). `ProjectOrchestrator` (the class) remains uninstantiated in `index.ts`; the live project-lifecycle routes call `WorkspaceArtifactsOrchestrator` directly instead (see the Artefact Reconciliation note in `rest-api.md`).

### BranchOrchestrator (`branch-orchestrator.ts`)

```typescript
class BranchOrchestrator {
    constructor(config: AppConfig, projectManager: ProjectManager, workspaceManager: WorkspaceManager)

    getAvailableBranches(projectId: string, workspaceId: string): Promise<Map<string, BranchInfo[]>>
    compileBranchSuggestions(branchMap: Map<string, BranchInfo[]>): string[]
    switchBranches(projectId: string, workspaceId: string, branchAssignments: Record<string, string>): Promise<BranchSwitchResult>
}
```

### VS Code Workspace (`vscode-workspace.ts`)

```typescript
function getWorkspaceFilePath(projectsFolder: string, projectSlug: string, workspaceId: string): string
function generateWorkspaceFile(workspaceId: string, repoPaths: { slug: string; path: string }[], filePath: string): void
function removeWorkspaceFile(filePath: string): void
function migrateWorkspaceFiles(projectsFolder: string, projectSlugs: string[]): void  // Startup migration utility — renames legacy workspace files; called by startServer() on boot
```

### Path Guard (`path-guard.ts`)

Shared filesystem path-containment and symlink-escape guard helpers, extracted from `workspace-index.ts`'s write-guard chain (allowlist → realpath symlink-escape → shape) so the same, carefully hardened logic can be reused by a second consumer without duplicating a security-sensitive fix. Pure functions, no class state — mirrors the module shape of `vscode-workspace.ts`/`workspace-index.ts`.

```typescript
function isLexicallyContained(resolvedTarget: string, resolvedRoot: string): boolean
function bestEffortRealpath(targetPath: string, depth?: number): string
const MAX_SYMLINK_RESOLUTION_DEPTH = 40  // upper bound on symlink chain length bestEffortRealpath() will follow
function resolveRootRealPath(projectsFolder: string): string
function escapesRootViaRealpath(targetPath: string, resolvedRoot: string): boolean
function isDirectoryShaped(targetPath: string): boolean

// Composite helpers, built on the guards above
function guardedFileTarget(root: string, relativePath: string): string | null  // runs the full chain (lexical containment -> realpath symlink-escape -> directory-shape) for one '/'-separated relative path under root; returns the resolved absolute path when safe, or null to skip (target escapes root lexically or via symlink, equals root itself, or already exists as a directory)
function pruneEmptyParents(dir: string, stopAt: string): void   // prunes empty directories upward from dir, stopping at (never removing) stopAt; stops early on a non-empty directory, an escape from stopAt, or any read/remove error
```

> **`isLexicallyContained()`:** purely string-based (`resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep)`) — does not touch the filesystem, and therefore cannot see through a planted symlink. **Its equality-permitting contract suits a writer whose target may legitimately equal the root, but is wrong for a delete guard** — `RepositoryOrchestrator.removeRepositoryFromProject()` (below) deliberately does not call this helper for its lexical layer, instead keeping a bespoke strict-descendant check that rejects equality with `projectsFolder`, so a malformed persisted ID can never resolve to the projects root.

> **`bestEffortRealpath()`:** resolves a target's real path without requiring the final path component to exist, so it also resolves a *broken* symlink. `lstat`s the exact target path first — before ever asking whether it "exists" — so a symlink at the target's own leaf position is always followed explicitly, whether or not it is broken (closes a gap where `fs.existsSync()`-based ancestor walks treat a broken symlink as simply absent and silently skip over it). Follows an arbitrary symlink chain up to `MAX_SYMLINK_RESOLUTION_DEPTH` levels, then throws — callers via `escapesRootViaRealpath()` treat that as an escape.

> **`resolveRootRealPath()`:** resolves a root folder's own real path for use as the comparison root in `escapesRootViaRealpath()`. Falls back to a lexical `path.resolve()` if the root itself cannot be realpath'd (e.g. it does not exist yet) — keeps the helper crash-free even though this case should not arise in practice.

> **`escapesRootViaRealpath()`:** resolves `targetPath` via `bestEffortRealpath()` and reports whether the result escapes `resolvedRoot`; an unresolvable target (symlink cycle, permission error) is treated conservatively as an escape (`true`). Catches the one class of escape a lexical check alone cannot see: a symlink planted under an otherwise lexically-valid path that points outside the intended root.

> **`isDirectoryShaped()`:** rejects a target that already exists on disk as a directory. Applied by the write-guard chain in `writeWorkspaceIndexFiles()` (below); deliberately **not** applied by `removeRepositoryFromProject()`'s delete guard, since the delete target (a clone folder) is expected to be a directory.

> **Two distinct roots, one recurring pattern:** every consumer of this module keeps the lexical-check root (`path.resolve(root)`) and the realpath-check root (`resolveRootRealPath(root)`) as two separate values rather than unifying them — unifying them would falsely reject every legitimate write/delete whenever the configured root itself sits behind a symlink (e.g. macOS's `/tmp` → `/private/tmp`). Consumers: `workspace-index.ts`'s `writeWorkspaceIndexFiles()` guard chain (below), `repository-orchestrator.ts`'s `removeRepositoryFromProject()` clone-folder deletion guard (see `RepositoryOrchestrator`, above), `repository-main-folder.ts`'s `removeManagedClone()` guard (see `Main Folder`, above), and `custom-files.ts`'s `writeCustomFiles()`/`removeCustomFileCopy()` via the composite `guardedFileTarget()`/`pruneEmptyParents()` helpers (see `Custom Files`, below).

> **`guardedFileTarget()`:** the write-and-delete-side equivalent of `writeWorkspaceIndexFiles()`'s inline guard chain, packaged as one call for a caller whose target is always a `/`-separated relative path under a single root (rather than a fixed set of named files). Rejects equality with `root` itself — unlike `isLexicallyContained()`'s own equality-permitting contract — since a bare-root target is never a valid file. A caller that creates intermediate directories before writing (`fs.mkdirSync(..., { recursive: true })`) should call this a second time after that `mkdir`, since a directory component may have been replaced by a symlink in between the two calls — `custom-files.ts`'s `writeCustomFiles()` does exactly this.

> **`pruneEmptyParents()`:** removes now-empty directories bottom-up after a file delete, stopping at (never removing) the given root. Treats a non-empty directory, an escape from the stop root, or any `readdir`/`rmdir` failure (e.g. a permission error) as "nothing more to prune" rather than throwing — mirrors this module's existing conservative-on-error posture.

### Workspace Index Files (`workspace-index.ts`)

Stateless module that renders, merges, writes, removes, and status-probes the three generated per-workspace files — `README.md`, `AGENTS.md`, `CLAUDE.md`. Never reads `ProjectManager`/`RepositoryManager` itself; callers (the artefact choke-point in `workspace-artifacts.ts`) resolve a `WorkspaceIndexContext` from the data layer first. Mirrors `vscode-workspace.ts`'s shape: pure functions, explicit path arguments, no class state.

```typescript
const WORKSPACE_INDEX_FILE_NAMES: readonly string[] // ['README.md', 'AGENTS.md', 'CLAUDE.md']
const GENERATED_BEGIN_MARKER = '<!-- paralizer:generated:begin -->'
const GENERATED_END_MARKER = '<!-- paralizer:generated:end -->'

interface WorkspaceIndexRepositoryRow {
    id: string;
    name: string;
    description: string;  // empty string when none is set
    url: string;
}

interface WorkspaceIndexCustomFileRow { path: string; label: string; description: string }   // AGENTS.md "Custom Files" table row
interface WorkspaceIndexRepositoryFileRow { repositoryId: string; path: string; label: string; description: string }   // AGENTS.md "Repository Files" table row (Milestone 2); path is relative to the repo's .workspace/files/

interface WorkspaceIndexContext {
    projectsFolder: string;
    projectId: string;
    projectName: string;
    projectDescription: string;   // empty string when none is set
    workspaceId: string;
    workspaceDescription: string; // empty string when none is set
    workspaceNotes: string;       // empty string when none are set
    repositories: WorkspaceIndexRepositoryRow[]; // project.Repositories order
    customFiles?: WorkspaceIndexCustomFileRow[];          // ListInAgents custom files, project order; AGENTS.md "Custom Files" section, omitted when empty/absent
    repositoryFiles?: WorkspaceIndexRepositoryFileRow[];  // ListInAgents repository files from sync-enabled repos only, project.Repositories order (Milestone 2); AGENTS.md "Repository Files" section, omitted when empty/absent; built with no filesystem check
    guiUrl: string;                // built from config.serverPort
    toolVersion: string;           // from getToolVersion()
    toolRoot: string;              // from getToolRoot(); rendered into the AGENTS.md "Paralizer CLI" section
    generatedAt: string;           // ISO 8601
}

function escapeMarkdownCell(value: string): string
function renderWorkspaceReadme(ctx: WorkspaceIndexContext): string
function renderWorkspaceAgents(ctx: WorkspaceIndexContext): string                             // only file that renders customFiles/repositoryFiles — never README.md
function renderClaudePointer(): string
function mergeGeneratedContent(existing: string | null, generatedBody: string): { content: string; skipped: boolean }
function writeWorkspaceIndexFiles(ctx: WorkspaceIndexContext): { written: string[]; skipped: string[] }
function removeWorkspaceIndexFiles(projectsFolder: string, projectId: string, workspaceId: string): void
function checkIndexFileStatus(projectsFolder: string, projectId: string, workspaceId: string): { missing: string[]; unmanaged: string[] }
```

> **The marker fence:** every generated file has its regenerated region wrapped in `GENERATED_BEGIN_MARKER`/`GENERATED_END_MARKER` HTML comments. `mergeGeneratedContent()` replaces only the text between the markers on regeneration, preserving hand-added prose before/after the fence verbatim. When a file exists but contains no begin marker, it is treated as fully hand-authored: `mergeGeneratedContent()` returns it unchanged with `skipped: true`, and both `writeWorkspaceIndexFiles()` and `removeWorkspaceIndexFiles()` leave it untouched. All three behaviours (merge, write-skip, remove-skip) and the read-only `checkIndexFileStatus()` probe share one private predicate, `hasBeginMarker()`, so "managed" vs. "unmanaged" is defined exactly once in the module.

> **`escapeMarkdownCell()`:** escapes `|`, collapses CR/LF to a single space, and trims. Applied to every user-supplied string embedded in the generated body — `projectDescription`, `workspaceDescription`, `workspaceNotes`, and each repository row's `name`/`description`/`url` (`id` is not escaped, since `RepositoryManager` already restricts it to kebab-case). This exists because none of `Repository.Url`, `.Description`, or workspace `notes`/`description` are validated against `|`/newline by their respective managers — only `escapeMarkdownCell()` prevents a value containing either from corrupting the generated Markdown table or, for `url` specifically, being stored as raw unescaped content in a file designed to be committed to shared git repos (closed as a Medium-severity finding during this WP's security audit).

> **`writeWorkspaceIndexFiles()` write guards:** for each target file, runs — in order, before any read or write — a lexical containment check (`isLexicallyContained()`, `path.resolve`-based, no filesystem access), a realpath symlink-escape check (`escapesRootViaRealpath()`, built on `bestEffortRealpath()`, which `lstat`s the exact target path first so it also catches a *broken* symlink planted at the target's leaf position — a case a naive `fs.existsSync()`-based ancestor walk misses), and a directory-shape check (`isDirectoryShaped()`). All five guard functions now live in the shared `src/utils/path-guard.ts` module (see `Path Guard`, below) rather than being defined locally in this file — `repository-orchestrator.ts`'s delete-path guard reuses the same realpath/root-resolution helpers. A target that fails any guard, or that exists without the begin marker, is reported in `skipped` and never throws. **No `mkdir`:** the function is a complete no-op when the workspace folder does not exist — that absence is a meaningful signal elsewhere in the system (an uninitialised workspace is reported healthy; `POST …/regenerate-workspace-file` returns 400 when absent), so fabricating the folder here would misrepresent an uninitialised workspace as set up.

> **Two distinct roots in the guard chain:** the lexical check compares a lexically-resolved target against `path.resolve(projectsFolder)`; the realpath check compares a realpath'd target against a separately realpath'd `projectsFolder` (via `resolveRootRealPath()`). Unifying them into one resolved root causes every legitimate write to be falsely rejected whenever the configured root itself sits behind a symlink (e.g. macOS's `/tmp` → `/private/tmp`) — the same pattern reused by `RepositoryOrchestrator.removeRepositoryFromProject()`'s delete guard (see `Path Guard`, below, and `RepositoryOrchestrator`, above).

> **`checkIndexFileStatus()`:** read-only, no writes, no `mkdir`; returns both arrays empty when the workspace folder is absent. Consumed by `checkWorkspaceHealth()` (`workspace-health.ts`, below). Classifies each of the three files as missing (absent array entry), present-managed (absent from both arrays), or present-unmanaged (in `unmanaged`) — guaranteed consistent with what the writer/remover would do to the same file, since all three share `hasBeginMarker()`.

### Custom Files (`custom-files.ts`)

Stateless writer/remover for a project's custom files inside one workspace folder. Same guard chain as the index files (`path-guard.ts`), with the **workspace folder** as the containment root — consumed via the composite `guardedFileTarget()`/`pruneEmptyParents()` helpers (see `Path Guard`, above) rather than a private guard/prune implementation of its own.

```typescript
interface CustomFilesResult { written: string[]; skipped: string[] }   // workspace-relative paths

writeCustomFiles(projectsFolder: string, projectId: string, workspaceId: string, files: readonly CustomFile[], repositoryIds: readonly string[]): CustomFilesResult
removeCustomFileCopy(projectsFolder: string, projectId: string, workspaceId: string, file: CustomFile): boolean
```

- **No-op when the workspace folder does not exist** (no `mkdir` of the root), like the index files.
- **Overwrites unconditionally** — local edits to a copy are lost on the next sync; the project definition is the single source of truth.
- Skips (never throws) targets that fail lexical containment, the realpath symlink-escape check (re-run after `mkdir -p` of the sub-folder), the directory-shape check, that sit in a repository folder, or that equal a reserved root index file.
- POSIX: `chmod 755` for executable files, `644` otherwise; skipped on win32.
- `removeCustomFileCopy()` deletes only a regular file/symlink at the guarded path, then prunes directories left empty (never the workspace root).

### Workspace Artifacts Orchestrator (`workspace-artifacts.ts`)

Single choke-point for the "per-workspace artefact set": the `.code-workspace` file (via `vscode-workspace.ts`) plus the three generated index files (via `workspace-index.ts`, above). Every caller needing to create, refresh, or remove a workspace's on-disk artefacts should go through this orchestrator rather than calling `generateWorkspaceFile()`/`writeWorkspaceIndexFiles()` directly, so a future third artefact only needs wiring in one place.

```typescript
interface RegenerateWorkspaceOverrides {
    workspaceMeta?: ProjectWorkspace;  // see note below
}

class WorkspaceArtifactsOrchestrator {
    constructor(config: AppConfig, projectManager: ProjectManager, repositoryManager: RepositoryManager, repositoryInfoSync?: RepositoryInfoSyncOrchestrator, errorLogManager?: ErrorLogManager, repositoryFileManager?: RepositoryFileManager)

    regenerateWorkspace(projectId: string, workspaceId: string, overrides?: RegenerateWorkspaceOverrides): void
    regenerateProject(projectId: string): void
    regenerateForRepository(repositoryId: string): void
    removeWorkspace(projectId: string, workspaceId: string): void
    removeCustomFileCopies(projectId: string, file: CustomFile): void  // deletes a custom file's copies from every workspace (pass the PREVIOUS definition when moving/renaming)
}
```

> **Custom files:** `regenerateWorkspace()` also calls `writeCustomFiles()` (see `custom-files.ts` below), so every existing trigger of the artefact set (project/workspace/repository edits, setup, regenerate) syncs custom files too, and `WorkspaceIndexContext.customFiles` carries the `ListInAgents` rows rendered into the `AGENTS.md` "Custom Files" table (README.md is unaffected; the section is omitted when no file is listed).

> **Repository files listing (Milestone 2):** `repositoryFileManager` is an optional, last constructor parameter. When present, a private `buildRepositoryFileRows()` fills `WorkspaceIndexContext.repositoryFiles` by filtering `repositories` to `InfoSync?.Enabled === true`, listing each via `RepositoryFileManager.list()`, keeping only `ListInAgents` entries, and mapping to rows in `repositories`' own (`project.Repositories`) order — with **no filesystem check** against the workspace clone, so the "Repository Files" table in `AGENTS.md` is deterministic regardless of whether a teammate has actually pulled the file yet. `renderCliSection()` adds one `paralizer repo-files` pointer line only when `repositoryFiles` has at least one row. **Wiring status (as of WP-011):** `src/cli/custom-files.ts`'s `createDefaultCustomFilesDeps()` and `src/cli/repo-files.ts`'s `createDefaultRepoFilesDeps()` both now pass a real `RepositoryFileManager` as this argument, so the "Repository Files" table renders for both CLI paths' `regenerateProject()`/`regenerateForRepository()` calls; `src/server/index.ts` still constructs `WorkspaceArtifactsOrchestrator` without it, so the section does not yet render for GUI-triggered regeneration.

> **`.code-workspace` vs. index-file initialisation asymmetry:** `regenerateWorkspace()` preserves `generateWorkspaceFile()`'s existing unconditional-write behaviour (it writes, and `mkdir -p`s its parent, even for a workspace whose own folder does not exist yet), but `writeWorkspaceIndexFiles()` is a deliberate no-op in that same case (see `workspace-index.ts` above). Calling `regenerateWorkspace()` on an uninitialised workspace therefore still produces a `.code-workspace` file while silently skipping the three index files.

> **Repository resolution:** `regenerateWorkspace()` resolves `project.Repositories` against the live `RepositoryManager` store, silently skipping any ID no longer present (a repository can be deleted globally while still transiently listed on a project) — the deleted repository is omitted from both the `.code-workspace` folder list and the index-file repository table, never throwing.

> **`overrides.workspaceMeta`:** `WorkspaceOrchestrator.renameWorkspace()` moves the workspace folder on disk and regenerates the artefact set for the *new* workspace ID before `WorkspaceManager.rename()` updates `project.Workspaces` — at that point `project.Workspaces[newId]` does not exist yet. Passing the pre-rename `ProjectWorkspace` entry via `overrides.workspaceMeta` lets `regenerateWorkspace()` render the new artefacts without requiring the rename orchestration to reorder its own filesystem-before-metadata-validation flow. When omitted, `regenerateWorkspace()` throws if `workspaceId` is not present in `project.Workspaces`.

> **`regenerateProject()`/`regenerateForRepository()`:** the former iterates every `project.Workspaces` entry; the latter enumerates all projects via `ProjectManager.list()` + `getById()`, regenerating (via `regenerateProject()`) each project that lists the given repository ID and skipping the rest.

> **`removeWorkspace()`:** calls both `removeWorkspaceFile()` and `removeWorkspaceIndexFiles()`, each already tolerant of a missing target — no folder-existence check is needed here.

> **`.workspace/info.json` is a repository-level artefact, not a per-workspace one:** `regenerateWorkspace()` calls `RepositoryInfoSyncOrchestrator.syncRepository()` (above) for every resolved repository, and `regenerateForRepository()` also calls it once up front — independent of project membership, so a repository that belongs to no project is still synced. Both route through a private `safeSync()` helper that catches and logs any thrown error (`Severity: 'warning'`, `Source: 'workspace-info'`, `Operation: 'sync'`) rather than propagating it, so a sync failure never breaks `.code-workspace`/index-file regeneration; `safeSync()` is a no-op when `repositoryInfoSync` was not injected. Because `regenerateForRepository()` delegates to `regenerateProject()` → `regenerateWorkspace()` for every project that lists the repository, a repository that does have projects is synced more than once per call — accepted as redundant-but-cheap, since `syncRepository()` is documented as a small info-file read + a files-folder read + hash when nothing changed.
>
> **Migrated onto by all three orchestrators:** `WorkspaceOrchestrator`, `ProjectOrchestrator`, and `RepositoryOrchestrator` (above) now construct-inject this orchestrator and call it exclusively for artefact generation/removal; `repository-orchestrator.ts`'s former private `regenerateWorkspaceFile()` helper has been deleted. A source-level guard test (`workspace-artifacts-chokepoint.test.ts`) asserts no module outside this file imports `generateWorkspaceFile`/`removeWorkspaceFile`/`writeWorkspaceIndexFiles`/`removeWorkspaceIndexFiles`, and its `TEMPORARY_EXCEPTIONS` allowlist — the mechanism for recording a file that still needs migrating onto this choke-point during an intentionally-incomplete migration — is currently empty by design: `src/server/routes/workspaces.ts`'s former `regenerate-workspace-file` route handler, the allowlist's one-time entry, has since been migrated onto `workspaceArtifacts.regenerateWorkspace()` and no longer imports any guarded identifier, so the stale entry was removed. Any future entry must satisfy two conditions — the named file must exist, and it must still reference a guarded module (`workspace-index.js` or `vscode-workspace.js`) via `referencesGuardedModule()` — both now mechanically enforced by the guard test's assertion (previously an existence-only check that could not detect a stale entry). `referencesGuardedModule()` catches every import shape (named, namespace, default, side-effect, dynamic `import()`, `require()`), not just static named imports, closing the import-shape bypasses the prior identifier-inside-named-import-clause detection missed; see the Choke-Point Guard Tests entry in `constraints.md` for the identifier-vs-specifier gating rationale. `WorkspaceArtifactsOrchestrator` itself is instantiated exactly once, in `src/server/index.ts`, and injected into `WorkspaceOrchestrator`, `registerWorkspaceRoutes()`, `registerRepositoryRoutes()`, and (as of a later WP) `registerProjectRoutes()` directly — see that registrar's updated signature above. `ProjectOrchestrator` (the class) still accepts `workspaceArtifacts` via constructor but is not itself instantiated in `index.ts`; the live project-lifecycle *routes* instead call `WorkspaceArtifactsOrchestrator` directly rather than through the `ProjectOrchestrator` class (see the Artefact Reconciliation note in `rest-api.md`'s Projects/Workspaces sections for the six lifecycle routes now wired this way).

### Generic Health Types (`health.types.ts`)

```typescript
interface HealthIssue {
    type: string;
    severity: 'error' | 'warning';
    message: string;
    fixAction: string;
    repositoryId?: string;
}

interface HealthReport {
    healthy: boolean;
    issues: HealthIssue[];
}
```

> **Shared shape across health report producers:** `HealthIssue`/`HealthReport` are the generic health-check shape used by every health report producer in the orchestration layer (currently workspace health; the repository-info sync health report introduced later in this plan reuses the same shape). Keeping a single definition here avoids the GUI health-alert component and this documentation diverging across multiple near-identical per-domain types. This module has no imports and no logic — it exists purely to hold the two interfaces.

### Workspace Health (`workspace-health.ts`)

```typescript
type WorkspaceHealthIssue = HealthIssue;   // from health.types.ts
type WorkspaceHealthReport = HealthReport; // from health.types.ts

function checkWorkspaceHealth(
    projectId: string,
    workspaceId: string,
    projectsFolder: string,
    repositoryIds: string[],
    errorLogManager?: ErrorLogManager,
): WorkspaceHealthReport
```

> **`WorkspaceHealthIssue`/`WorkspaceHealthReport` are now type aliases** of the generic `HealthIssue`/`HealthReport` from `health.types.ts` (not their own interfaces) — every existing import of these two names from `workspace-health.ts` continues to compile unchanged, and `checkWorkspaceHealth()`'s logic/signature are untouched.

> **Generated index-file check (Check 3):** `checkWorkspaceHealth()` calls `checkIndexFileStatus()` (from `workspace-index.ts`, above) exactly once, side-effect free, and folds its result into up to two issues: `workspace-index-missing` (`severity: 'warning'`, `fixAction: 'regenerate-workspace-file'`) when any of the three generated files is absent, and `workspace-index-unmanaged` (`severity: 'warning'`, `fixAction: 'none'`) when any is present but hand-authored (no begin marker) — no automated fix is offered for the latter, since regenerating would either be a silent no-op or clobber deliberate user content. `checkWorkspaceHealth()` never imports `GENERATED_BEGIN_MARKER` or reads an index file's content directly; `checkIndexFileStatus()` remains the single source of truth for marker detection, shared with the writer and remover in `workspace-index.ts`. `checkIndexFileStatus()` already returns empty arrays for an uninitialised workspace, so this check needs no separate folder-existence branch.

> **Credential-missing check (Check 4):** When `errorLogManager` is supplied, `checkWorkspaceHealth` performs an additional check: it queries all `Source: 'credentials'` log entries scoped to the workspace and inspects the most recent entry per repository. A `credential-missing` health issue is surfaced only when the most recent entry has `Severity: 'error'`. A `Severity: 'info'` entry — written by `WorkspaceOrchestrator.createWorkspace()` or `RepositoryOrchestrator.addRepositoryToProject()` after a successful credential-based clone — suppresses the stale error badge without deleting history. SSH clones (`credential === null`) do not produce a credentials log entry and are not evaluated by this check.

---

## Storage (`src/storage/`)

### Types (`storage.types.ts`)

```typescript
type SchemaVersion = number;

interface BaseStore {
    /**
     * Monotonically incrementing integer that tracks structural changes to the
     * persisted JSON shape. Versioning policy: adding an optional field is
     * backward-compatible (do NOT bump); bump SCHEMA_VERSION only for breaking
     * changes (removing/renaming a required field, or changing an existing
     * field's type). All concrete store types inherit this field and policy
     * via BaseStore.
     */
    SchemaVersion: SchemaVersion;
}
```

### Functions (`json-storage.ts`)

```typescript
class FileNotFoundError extends Error {
    filePath: string;
    constructor(filePath: string)
}

function readJsonFile<T>(filePath: string): T
function writeJsonFile<T>(filePath: string, data: T): void
function ensureDirectory(dirPath: string): void
function initializeStorage(config: AppConfig): void
```

---

## Utils (`src/utils/`)

### Paths (`paths.ts`)

```typescript
interface FolderConfig {
    storageFolder: string;
    projectsFolder: string;
}

function getToolRoot(): string
function getConfigPath(): string  // Honours PARALIZER_CONFIG_PATH env var override
function getStorageFolder(config: FolderConfig): string
function getProjectsFolder(config: FolderConfig): string
```

### Slug (`slug.ts`)

```typescript
function toKebabCase(input: string): string
function isValidKebabCase(input: string): boolean
function inferSlugFromUrl(url: string): string
function isValidWorkspaceId(id: string): boolean
```

### Version (`version.ts`)

```typescript
function getToolVersion(): string
```

> No-argument accessor for the tool's own version, read from `package.json` at `getToolRoot()` (see `paths.ts`). Returns `'unknown'` — never throws — when the file is missing, unreadable, or lacks a non-empty string `version` field. Extracted specifically so callers (e.g. `registerVersionRoute()` in `src/server/routes/version.ts`) never need to know the tool's `package.json` path. The route's own `readVersion(pkgPath: string)` (private, unexported) remains separate and path-taking, since it also reads the GUI's distinct `package.json`.

---

## Custom Files CLI (`src/cli/custom-files.ts`)

Non-interactive `paralizer custom-files <list|show|add|update|delete|help>` command group. Dependency-injected for tests; mirrors the REST handlers (validate via `ProjectManager`, purge previous copies on move/rename/delete, then `regenerateProject()`).

```typescript
const EXIT_OK = 0; const EXIT_ERROR = 1; const EXIT_SYNC_FAILED = 2;   // 2 = saved, workspace sync failed
interface CustomFilesCliDeps {
    projectManager: Pick<ProjectManager, 'listCustomFiles' | 'addCustomFile' | 'updateCustomFile' | 'removeCustomFile'>;
    artifacts: Pick<WorkspaceArtifactsOrchestrator, 'regenerateProject' | 'removeCustomFileCopies'>;
    readStdin: () => Promise<string>; out: (text: string) => void; err: (text: string) => void;
}
const CUSTOM_FILES_HELP: string                                            // shown by `paralizer help` / `custom-files help`
runCustomFilesCommand(args: string[], deps: CustomFilesCliDeps): Promise<number>   // args after "custom-files"; returns exit code, never throws for user errors
createDefaultCustomFilesDeps(): CustomFilesCliDeps                          // loads config.json; throws if missing
```

> **`createDefaultCustomFilesDeps()` also wires `RepositoryInfoSyncOrchestrator`:** it constructs one (config + `RepositoryManager` + the same `RepositoryFileManager` the CLI uses, no `errorLogManager` — the CLI has none) and passes it as the 4th constructor argument to `WorkspaceArtifactsOrchestrator`, so `paralizer custom-files add/update/delete`'s `regenerateProject()` call also syncs each affected repository's `.workspace/info.json` and `.workspace/files/` via the same `safeSync()` choke-point described above.

- `<file>` references resolve by exact ID, then workspace-relative path (case-insensitive, `\` accepted), then unique ID prefix (>= 4 chars).
- Content sources for `add`/`update`: `--content-file <path>` (`-` = stdin), `--stdin`, `--content <text>` (mutually exclusive). `update` changes only the given fields.
- `paralizer help` (`src/index.ts`) prints the general usage plus `CUSTOM_FILES_HELP`; it needs no `config.json`. Workspace `AGENTS.md` files point agents at this command instead of duplicating the docs.

## File Command Helpers (`src/cli/file-command-helpers.ts`)

Milestone 2: the scope-neutral parts of `custom-files.ts`'s CLI plumbing, extracted so `repo-files.ts` (below) can reuse them without duplicating logic. Every per-scope difference (noun, list-hint text, how to render a relative path) is passed in by the caller rather than branched on internally.

```typescript
const EXIT_OK = 0; const EXIT_ERROR = 1; const EXIT_SYNC_FAILED = 2;

class UsageError extends Error {}

function parseCommandArgs(args: string[], options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>): { values: Record<string, unknown>; positionals: string[] }
function requirePositionals(positionals: string[], count: number, usage: string, commandName: string): void   // throws UsageError with a command-name-aware message when short
const FILE_FIELD_OPTIONS: Record<string, { type: 'string' | 'boolean' }>   // the add/update option schema shared by both command groups
function readContentSource(values: Record<string, unknown>, readStdin: () => Promise<string>): Promise<string | undefined>   // enforces "exactly one of --content-file/--stdin/--content"; '-' as --content-file reads stdin
function readFlagPair(values: Record<string, unknown>, name: string): boolean | undefined   // resolves a --name/--no-name pair; undefined when neither given (update keeps the existing value)
function resolveFileReference<T>(files: readonly T[], ref: string, options: { relativePath: (file: T) => string; noun: string; listHint: string }): T   // exact ID -> case-insensitive relative path -> unique ID prefix (>= 4 chars), in that order
function readStdin(): Promise<string>
```

> **Extraction boundary:** dispatch (the subcommand `switch`), help text, the post-mutation sync hook (`regenerateProject()` vs. `regenerateForRepository()`), and success/error wording stay in `custom-files.ts`/`repo-files.ts` respectively — only parsing, content-source resolution, flag-pair resolution, and reference resolution moved here. `custom-files.ts`'s behaviour (output, exit codes, `CustomFilesCliDeps`) is byte-identical before and after this extraction.
>
> **`resolveFileReference()`'s resolution order and `listHint`:** tries an exact `Id` match first, then a case-insensitive relative-path match (via the caller's `relativePath()`, with `\` accepted as well as `/`), then a unique prefix of the ID of at least 4 characters (ambiguous or too-short prefixes are rejected). `noun` and `listHint` customise the "not found"/"ambiguous" error text per caller (e.g. `'custom file'` / `'paralizer custom-files list <project-id>'` vs. `'repository file'` / `'paralizer repo-files list --repo <repo-id>'`).

## Repository Files CLI (`src/cli/repo-files.ts`)

Milestone 2: non-interactive `paralizer repo-files <list|show|add|update|delete|help>` command group, mirroring `custom-files.ts` but scoped to a single repository (`--repo <repo-id>` instead of a leading project-ID positional) and never committing or pushing — publishing a change still requires Commit & Push in the Paralizer GUI (or the next `git pull` in a workspace, once someone else has published it).

```typescript
interface RepoFilesCliDeps {
    fileManager: Pick<RepositoryFileManager, 'list' | 'add' | 'update' | 'remove'>;
    infoSync: Pick<RepositoryInfoSyncOrchestrator, 'assertSyncEnabled'>;
    artifacts: Pick<WorkspaceArtifactsOrchestrator, 'regenerateForRepository'>;
    readStdin: () => Promise<string>; out: (text: string) => void; err: (text: string) => void;
}
const REPO_FILES_HELP: string                                              // shown by `paralizer help` / `repo-files help`
runRepoFilesCommand(args: string[], deps: RepoFilesCliDeps): Promise<number>   // args after "repo-files"; returns exit code, never throws for user errors
createDefaultRepoFilesDeps(): RepoFilesCliDeps                              // loads config.json; throws if missing
```

> **Validation and sync path mirror the REST routes (WP-008):** every mutation (`add`/`update`/`delete`) calls `infoSync.assertSyncEnabled(repoId)` first — sync disabled throws `SyncPreconditionError`, mapped to exit `1` with nothing written; `list`/`show` work regardless of sync state. On success, `fileManager.add()`/`update()`/`remove()` runs the same `validateRepositoryFileInput()` validation as the REST layer (unlike `applyImport()`'s `replaceAll()` path, flagged separately on WP-006), then `artifacts.regenerateForRepository(repoId)` runs — a regeneration failure returns `EXIT_SYNC_FAILED` (`2`, "saved but regeneration failed"), matching `custom-files.ts`'s existing exit-code convention. `repo-files.ts` never shells out to git; its success/help text says "Commit & Push in the Paralizer GUI to publish" rather than describing a commit it never performs.
>
> **`createDefaultRepoFilesDeps()`:** constructs its own `RepositoryManager`/`RepositoryFileManager`/`ProjectManager`/`RepositoryInfoSyncOrchestrator`/`WorkspaceArtifactsOrchestrator` instances (no `errorLogManager`, same as `createDefaultCustomFilesDeps()`), passing the shared `RepositoryFileManager` into both `RepositoryInfoSyncOrchestrator`'s required constructor parameter and `WorkspaceArtifactsOrchestrator`'s optional trailing one, so the "Repository Files" `AGENTS.md` table (see `workspace-index.ts`, above) renders for `repo-files`-triggered regeneration too.

## CLI Terminal UI (`src/cli/`)

### Terminal UI Utilities (`terminal-ui.ts`)

Output and input helpers for the interactive CLI menu. All output functions use `picocolors` for ANSI color rendering. All interactive functions require a real TTY (`process.stdin.isTTY === true`) — callers must guard accordingly before invoking `waitForKey`, `askQuestion`, or `askYesNo` in non-TTY environments (e.g., CI).

```typescript
// Output helpers
function printHeader(text: string): void
function printOption(key: string, label: string): void
function printSuccess(text: string): void
function printError(text: string): void
function printInfo(text: string): void
function clearScreen(): void

// Interactive input (TTY required)
function waitForKey(validKeys: string[]): Promise<string>
function askQuestion(prompt: string): Promise<string>
function askYesNo(prompt: string, defaultYes?: boolean): Promise<boolean>
```

#### Function details

| Function | Output / Behavior |
|---|---|
| `printHeader(text)` | Bold cyan text → `stdout` |
| `printOption(key, label)` | Bold yellow `[key]` + default-color label → `stdout` |
| `printSuccess(text)` | Green text → `stdout` |
| `printError(text)` | Red text → `stderr` |
| `printInfo(text)` | Dim blue text → `stdout` |
| `clearScreen()` | Writes ANSI reset sequence `\x1Bc` → `stdout` |
| `waitForKey(validKeys)` | Puts `stdin` in raw mode; resolves with the lowercased key when a key in `validKeys` is pressed. Ctrl+C exits the process (`process.exit(0)`). **TTY required — rejects with `Error` if `process.stdin.isTTY` is falsy.** |
| `askQuestion(prompt)` | Line-input prompt via `node:readline`; resolves with trimmed user input. |
| `askYesNo(prompt, defaultYes?)` | Displays `[Y/n]` or `[y/N]` indicator. Empty input resolves to `defaultYes` (default: `true`). Accepts `y`/`yes` → `true`, `n`/`no` → `false`; unrecognised input silently falls back to `defaultYes`. |

---

### Setup Wizard (`setup.ts`)

```typescript
interface SetupIO {
    ask: (prompt: string) => Promise<string>;
    confirm: (prompt: string, defaultYes?: boolean) => Promise<boolean>;
}

function runSetup(io?: SetupIO): Promise<void>

// Injectable helpers (exported for testing — treat as internal)
function _promptPath(
    label: string,
    defaultValue?: string,          // optional; undefined = no default shown
    _ask?: typeof askQuestion,
    _confirm?: typeof askYesNo,
): Promise<string>

function _promptNumber(
    label: string,
    defaultValue: number,
    min?: number,                   // optional; undefined = -Infinity
    max?: number,                   // optional; undefined = Infinity
    _ask?: typeof askQuestion,
): Promise<number>
```

Runs the interactive first-time configuration wizard. Guides the user through creating a valid `config.json` step by step.

**Wizard flow:**

1. Prints the header.
2. Checks for an existing `config.json` — if found, prompts whether to overwrite (returns without changes if the user declines).
3. Prompts for `projectsFolder` (required absolute or relative path). Offers to create the directory if it does not exist.
4. Prompts for `storageFolder` (default: `"data/storage"`, relative to tool root). Same creation-on-demand behaviour.
5. Prompts for `cloneDepth` (integer ≥ 0, default: `50`).
6. Prompts for `serverPort` (integer 1–65535, default: `4200`).
7. Prompts for `gitPollingIntervalSeconds` (integer ≥ 1, default: `30`). Note: the REST API enforces a minimum of 10 s at runtime.
8. Writes `config.json` with 4-space indentation.
9. Calls `initializeStorage()` to create the storage directory structure.
10. Prints a success summary with next steps.

**Constants (module-level):**

```typescript
// UI prompt hints only — not AppConfig defaults.
// Actual config defaults are sourced from DEFAULTS imported from config.ts.
const SETUP_DEFAULTS = {
    storageFolder: 'data/storage',  // hint shown in the storage-folder prompt
}
```

**Injectable helpers:** `_promptPath` and `_promptNumber` accept optional `_ask`/`_confirm` callback overrides so tests can exercise validation and retry logic without touching stdin. The `_` prefix signals internal-but-exported intent.

---

### Documentation Generator (`docs.ts`)

```typescript
function generateDocs(): Promise<void>
```

Runs `ctx generate` from the tool root to produce the `.context/` documentation bundle.

**Behaviour:**
1. Calls `isCtxAvailable()` (private) — uses `spawnSync('ctx', ['--version'], { stdio: 'ignore' })` to check PATH. Returns `true` when no spawn error occurs **and** the exit status is non-null.
2. If `ctx` is found — spawns `ctx generate` from `getToolRoot()` with `stdio: ['ignore', 'inherit', 'inherit']` so the user sees real-time output. Resolves with a success or failure message based on the process exit code.
3. If `ctx` is not found — prints an error and installation instructions (`https://github.com/context-hub/generator`) via `printError` / `printInfo`, then returns.

**Error handling:**
- Spawn errors (e.g. permission denied after the PATH check) are caught and reported via `printError`.
- Non-zero exit codes print the code alongside the failure message.
- `exit code ?? 1` is used as a defensive fallback for SIGKILL terminations.

---

### Interactive CLI Menu (`menu.ts`)

```typescript
function showMenu(): Promise<void>
```

Runs the interactive four-option CLI menu in a `while(true)` loop until the user quits or launches the GUI.

**Menu layout:**

```
repo-parallelizer vX.Y.Z

  [S] Setup — Run the setup wizard
  [G] Launch GUI — Start server and open browser
  [D] Generate Docs — Run CTX Generator
  [Q] Quit
```

**Key dispatch table:**

| Key | Action | Loop behaviour |
|-----|--------|----------------|
| `s` | `await runSetup()` + `await pressAnyKeyToContinue()` | `break` → loops back to menu |
| `g` | `await launchGui()` | Does **not** return to menu — server keeps process alive |
| `d` | `await generateDocs()` + `await pressAnyKeyToContinue()` | `break` → loops back to menu |
| `q` | `return` | Exits `showMenu()` cleanly |

**Private helpers (not exported):**

| Helper | Description |
|--------|-------------|
| `getVersion()` | Reads `version` from `package.json` at tool root via `fs.readFileSync`. Cached after first call in a module-level `_version` variable. Returns `'unknown'` on any error. |
| `launchGui()` | Loads config (`loadConfig()`); on failure prints an error and returns to menu. Resolves `staticDir` as `<toolRoot>/gui/public`, calls `startServer()`, prints the server URL, then calls `openBrowser()`. Blocks forever via `await new Promise<never>(() => {})` — the HTTP server's event loop keeps Node.js alive. |
| `openBrowser(url)` | Spawns the OS default browser command (`open` on macOS, `cmd /c start` on Windows, `xdg-open` on Linux) with `{ detached: true, stdio: 'ignore' }` and calls `child.unref()` to prevent blocking. Browser spawn failures are silently swallowed — the URL is already visible in the terminal. |
| `pressAnyKeyToContinue()` | Prints `"Press any key to continue..."` and calls `waitForKey()` with a broad set of printable ASCII keys (a–z, 0–9, space, enter). Ctrl+C during this prompt exits the process (handled by `waitForKey`'s `\x03` guard). |

**Error handling:**
- Config load failure in `launchGui()` — caught, `printError` + `printInfo`, returns to menu.
- Server start failure in `launchGui()` — caught, `printError`, returns to menu.
- Post-start server crash — Node.js process exits; no recovery path (consistent with `src/index.ts`).

**TTY requirement:** `showMenu()` calls `waitForKey()` on every iteration — a real TTY is required. In non-TTY environments `process.stdin.setRawMode` will throw a `TypeError`. Guard with `process.stdin.isTTY` before calling.

---

## Server (`src/server/`)

### Server Lifecycle (`index.ts`)

```typescript
interface ServerConfig {
    serverPort?: number;
    staticDir: string;
    pollIntervalSeconds?: number;
    appConfig: AppConfig;
}

function startServer(config: ServerConfig): Promise<void>
function stopServer(): Promise<void>
```

### Application Launcher (`app-launcher.ts`)

> **Internal module** — not re-exported from `src/server/index.ts`. Import directly when needed:
> `import { launchApplication, launchTerminal, buildTerminalCommand } from './app-launcher.js'`

```typescript
function launchApplication(command: string, args: string[]): Promise<void>
function launchTerminal(directoryPath: string): Promise<void>
function buildTerminalCommand(
    directoryPath: string,
    platform: NodeJS.Platform,
): { command: string; args: string[]; cwd?: string }
```

`launchApplication` and `launchTerminal` both launch an external application as a detached, fire-and-forget child process (they share an internal `spawnDetached()` helper). The spawned process runs independently of the Node.js parent (`detached: true`, `stdio: 'ignore'`, `child.unref()`).

**Cross-platform behaviour:**
- **Windows (`process.platform === 'win32'`):** `shell: true` — routes through `cmd.exe` so `.cmd`/`.bat` launchers (e.g. `code.cmd`) are found on PATH.
- **All other platforms:** `shell: false` — direct process execution, no intermediate shell.

**Throws (both functions):**
- `Error('Failed to launch application: command must not be empty.')` — when the resolved command is empty or blank.
- `Error('Failed to launch application "<command>": <os-error-message>')` — when the OS-level spawn fails (e.g. command not found on PATH).

**Security note (Windows):** When `shell: true` is active, shell metacharacters in `command` or `args` elements can be interpreted by `cmd.exe`. Call sites **must** validate inputs against an allowlist of known application commands (e.g. `'code'`, `'github'`, `'open'`, `'cmd'`, `'x-terminal-emulator'`) before calling either function.

`buildTerminalCommand(directoryPath, platform)` is a pure, exported helper that resolves the platform-specific `{ command, args, cwd }` triple used by `launchTerminal()` — unit-testable without spawning a real terminal:
- `'darwin'` → `{ command: 'open', args: ['-a', 'Terminal', directoryPath] }`
- `'win32'` → `{ command: 'cmd', args: ['/c', 'start', 'cmd'], cwd: directoryPath }`
- any other platform (Linux, etc.) → `{ command: 'x-terminal-emulator', args: [], cwd: directoryPath }`

---

### Router (`router.ts`)

```typescript
type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => void | Promise<void>

class Router {
    get(pattern: string, handler: RouteHandler): this
    post(pattern: string, handler: RouteHandler): this
    put(pattern: string, handler: RouteHandler): this
    delete(pattern: string, handler: RouteHandler): this
    handle(req: IncomingMessage, res: ServerResponse): void
    /** Attaches an ErrorLogManager. When set, unhandled handler rejections are
     *  appended to the error log with source 'route-handler' and operation set
     *  to the request URL. No additional error response is sent to the client. */
    setErrorLogManager(manager: ErrorLogManager): void
}
```

### Static Server (`staticServer.ts`)

```typescript
function serveStatic(req: IncomingMessage, res: ServerResponse, baseDir: string): Promise<boolean>
```

### Polling Manager (`pollingManager.ts`)

```typescript
type FetchStatusFn = (repoPath: string) => Promise<GitStatusInfo>

class PollingManager {
    constructor(
        config: AppConfig,
        projectManager: ProjectManager,
        workspaceManager: WorkspaceManager,
        fetchStatusFn?: FetchStatusFn,
        errorLogManager?: ErrorLogManager,
    )

    start(intervalSeconds: number): void
    stop(): void
    restart(intervalSeconds: number): void  // stop() + start() — used by PUT /api/config/polling to apply a changed interval
    getStatus(repoPath: string): GitStatusInfo | null
    refreshWorkspace(projectId: string, workspaceId: string): Promise<void>
}
```

**`errorLogManager` (5th parameter, optional):** When provided, fetch failures inside `fetchWithStagger()` are logged at `warning` severity with `Source: 'polling'` and `Operation: 'status-poll'`. An in-memory dedup set (`failedPaths`) ensures at most one log entry per repo path per sweep-to-sweep cycle — repeated failures for the same path are not re-logged until the repo recovers (successful fetch clears the path from the set). When omitted, failures are silently swallowed and the manager behaves identically to prior behaviour.

### Request Utils (`requestUtils.ts`)

```typescript
function parseJsonBody(req: IncomingMessage): Promise<unknown>
function sendJson(res: ServerResponse, status: number, data: unknown): void
function sendError(res: ServerResponse, status: number, message: string): void
function extractParams(pattern: string, url: string): Record<string, string> | null
function isPlainObject(value: unknown): value is Record<string, unknown>
```

### Route Registration Functions (`routes/`)

```typescript
// repositories.ts
function registerRepositoryRoutes(
    router: Router,
    repoManager: RepositoryManager,
    appConfig: AppConfig,
    workspaceArtifactsOrchestrator: WorkspaceArtifactsOrchestrator,  // consulted by PUT /:id (regenerateForRepository()) after a successful update
    repositoryOrchestrator: RepositoryOrchestrator,  // consulted by DELETE /:id (deleteRepositoryGlobally())
    errorLogManager?: ErrorLogManager,  // optional — when provided, credential assign/clear ops and artefact-regeneration warnings emit audit/log entries
): void

// projects.ts
function registerProjectRoutes(
    router: Router,
    projectManager: ProjectManager,
    workspaceArtifacts: WorkspaceArtifactsOrchestrator,
    repositoryOrchestrator: RepositoryOrchestrator,  // consulted by DELETE /:id/repositories/:repoId (removeRepositoryFromProject()), which also deletes clone folders from every workspace and emits the unlink-repository audit entry
    errorLogManager: ErrorLogManager,
): void

// workspaces.ts
function registerWorkspaceRoutes(
    router: Router,
    workspaceManager: WorkspaceManager,
    workspaceOrchestrator: WorkspaceOrchestrator,
    appConfig: AppConfig,
    projectManager: ProjectManager,
    errorLogManager: ErrorLogManager,
    workspaceArtifactsOrchestrator: WorkspaceArtifactsOrchestrator,  // injected for future wiring; not yet consulted by any handler body
    launchFn?: (command: string, args: string[]) => Promise<void>,  // test-only; defaults to launchApplication
    launchTerminalFn?: (directoryPath: string) => Promise<void>,  // test-only; defaults to launchTerminal
): void

// branches.ts
function registerBranchRoutes(router: Router, orchestrator: BranchOrchestrator, workspaceManager: WorkspaceManager): void

// status.ts
function registerStatusRoutes(router: Router, pollingManager: PollingManager, projectManager: ProjectManager, workspaceManager: WorkspaceManager, config: AppConfig): void

// error-log.ts
function registerErrorLogRoutes(router: Router, errorLogManager: ErrorLogManager): void

// notes.ts
function registerNotesRoutes(router: Router, projectManager: ProjectManager, workspaceManager: WorkspaceManager): void

// version.ts
function registerVersionRoute(router: Router): void

// repository-info-sync.ts
function registerRepositoryInfoSyncRoutes(
    router: Router,
    repoManager: RepositoryManager,  // kept for signature symmetry; every handler's 404 comes from `infoSync` instead
    infoSync: RepositoryInfoSyncOrchestrator,
    workspaceArtifacts: WorkspaceArtifactsOrchestrator,  // consulted best-effort by POST .../import (regenerateForRepository())
    errorLogManager?: ErrorLogManager,
): void
// POST .../import's body is parsed by validateFieldsInput() into { fields?: RepositoryInfoImportField[]; files?: RepositoryFileImportSelection[] } (Milestone 2, WP-008)
// — both optional and independently allowed to be empty; an unknown files path or action disallowed for a diff's kind is
// rejected by applyImport() itself (a plain Error, special-cased to 400 by this route's handler) rather than by validateFieldsInput().

// repository-files.ts (Milestone 2, WP-008) — repository-scoped counterpart of registerProjectRoutes()'s custom-files routes
function registerRepositoryFileRoutes(
    router: Router,
    repoManager: RepositoryManager,  // kept for signature symmetry; every handler's 404 comes from `fileManager`/`infoSync` instead
    fileManager: RepositoryFileManager,
    infoSync: RepositoryInfoSyncOrchestrator,  // every mutation calls assertSyncEnabled() then runs inside runLocked()
    workspaceArtifacts: WorkspaceArtifactsOrchestrator,  // consulted best-effort on mutation (regenerateForRepository())
    errorLogManager?: ErrorLogManager,
): void

// config.ts — accepts a named-options bag
interface ConfigRoutesOptions {
    router: Router;
    appConfig: AppConfig;
    configPath?: string;        // optional — defaults to tool-root config.json
    pollingManager?: PollingManager;   // optional — when provided, PUT /api/config/polling restarts the loop
    errorLogManager?: ErrorLogManager; // optional — when provided, credential create/update/delete ops emit audit log entries
}
function registerConfigRoutes(options: ConfigRoutesOptions): void
```

---

## GUI Client (`gui/public/js/api.js`)

Vanilla JS HTTP client for the SPA frontend. All methods return Promises and throw an `Error` (with `message` taken from the `error` field in the JSON body, and an `err.status` property set to the HTTP status code) on non-2xx responses.

**Import:** `import { api } from './api.js';`

### `api.repositories`

Full CRUD plus credential methods for the repositories resource.

```js
api.repositories.list()                          // GET /api/repositories
api.repositories.get(id)                         // GET /api/repositories/:id
api.repositories.create(data)                    // POST /api/repositories
api.repositories.update(id, data)               // PUT  /api/repositories/:id
api.repositories.delete(id)                      // DELETE /api/repositories/:id
api.repositories.touchRefreshTimestamp(id)       // POST /api/repositories/:id/refresh-timestamp
api.repositories.credentialOptions(id)           // GET /api/repositories/:id/credential-options
api.repositories.credentialOptionsForUrl(url)    // GET /api/repositories/credential-options?url=
api.repositories.updateCredential(id, credentialId) // PUT /api/repositories/:id/credential
```

Credential-matching and association detail:

```js
// Fetch credentials compatible with an arbitrary (not-yet-registered or
// in-edit) repository URL's hostname, without requiring an existing
// repository record. Transforms the server's { credentials, autoSelected }
// response into a flat array.
// url: string — the Git remote URL to match credentials against
// Returns: Promise<Array<{ credentialId: string, label: string, host: string, auto: boolean }>>
api.repositories.credentialOptionsForUrl(url)

// Associate (or disassociate) a credential with a repository.
// id: string — repository ID
// credentialId: string — the credential ID to associate, or '' to clear
//   (normalized to `null` before being sent — the server expects `null`,
//   not '', to clear the association)
// Returns: Promise<Object> — the updated repository
api.repositories.updateCredential(id, credentialId)
```

> **`updateCredential` caller contract:** `credentialId` must always be a `string`. Passing `undefined` causes `JSON.stringify` to silently strip the key from the request body, producing an empty `{}` payload instead of `{ credentialId: null }`. Always pass `''` when the intent is to clear the association.

### `api.repositories.infoSync`

Opt-in `.workspace/info.json` sync methods, mirroring the server routes documented in `rest-api.md` and `RepositoryInfoSyncOrchestrator` above. Every method takes the repository ID through `encodeURIComponent`.

```js
api.repositories.infoSync.status(id)                                  // GET  /api/repositories/:id/info-sync
api.repositories.infoSync.saveSettings(id, { enabled, discardPendingChanges? })  // PUT  /api/repositories/:id/info-sync
api.repositories.infoSync.refresh(id)                                 // POST /api/repositories/:id/info-sync/refresh
api.repositories.infoSync.recreateMainFolder(id, discardPendingChanges?)  // POST /api/repositories/:id/info-sync/recreate-main-folder
api.repositories.infoSync.importPreview(id)                           // GET  /api/repositories/:id/info-sync/import
api.repositories.infoSync.applyImport(id, selections)                 // POST /api/repositories/:id/info-sync/import
api.repositories.infoSync.commitPush(id, message?)                    // POST /api/repositories/:id/info-sync/commit-push
```

- `status()`, `saveSettings()`, `refresh()`, `recreateMainFolder()`, and `applyImport()` resolve to the `InfoSyncStatus` shape (`enabled`, `mainFolder`, `state`, `pendingChanges`, `lastSyncedAt?`, `defaultCommitMessage`, `health`) — a JSDoc `@typedef {InfoSyncStatus}` above the `repositories` namespace in `api.js` documents the full field set, mirroring `RepositoryInfoSyncStatus` in `src/orchestration/repository-info-sync.ts`.
- `recreateMainFolder(id, discardPendingChanges?)` and `commitPush(id, message?)` take a plain positional optional parameter (not an options object) and build the request body internally (`{}` when the optional argument is `undefined`), keeping the no-argument call terse.
- `importPreview()` resolves to `{ state, fields: Array<{ field, current, incoming }> }` instead of `InfoSyncStatus`.
- `applyImport(id, selections)` (Milestone 2) accepts either a bare `fields` array (the pre-Milestone-2 call shape) or a `{ fields, files }` selections object — `fields` is `Array<'Name'|'Description'>`, `files` is `Array<{ path: string, action: 'add'|'discard'|'keep'|'delete'|'overwrite' }>` for the incoming `files/` diff. Only the keys actually supplied in the input end up in the request body; passing neither sends `{}` ("keep everything"). `repository-info-import-modal.js` (below) now always calls the `{ fields, files }` shape — sending `files: []` when the preview had no file diffs — and, for a selection containing at least one `discard`, awaits a `showConfirm()` confirmation naming the affected paths before calling `applyImport()`.

### `api.repositories.files`

Repository-level custom-file endpoints (Milestone 2) — the repository-scoped counterpart of `api.projects.customFiles`, below. Every mutation requires info sync to be enabled for the repository (the server responds `409` otherwise, per WP-008's routes); request bodies are camelCase, responses use the stored PascalCase `RepositoryFile` shape. Every method takes the repository/file IDs through `encodeURIComponent`.

```js
api.repositories.files.list(id)                    // GET    /api/repositories/:id/files
api.repositories.files.create(id, data)             // POST   /api/repositories/:id/files
api.repositories.files.update(id, fileId, data)      // PUT    /api/repositories/:id/files/:fileId
api.repositories.files.remove(id, fileId)            // DELETE /api/repositories/:id/files/:fileId
```

- `create()`/`update()`'s `data` shape: `{ directory?: string, fileName: string, label: string, description?: string, content: string, listInAgents?: boolean, executable?: boolean }`.
- `create()` resolves to the created file (HTTP 201); `update()` resolves to the updated file; `remove()` resolves to `void`.
- `normaliseRepositoryFile()` (`utils/normalise.js`) converts the PascalCase/camelCase `RepositoryFile` response into the camelCase shape (`id`, `directory`, `fileName`, `label`, `description`, `content`, `executable`, `listInAgents`, `dateModified`) consumed by the GUI views, mirroring `normaliseCustomFile()`'s picked-keys/default/strict-boolean-coercion pattern plus the two `RepositoryFile`-only fields (`executable`, `dateModified`).

### `api.config.credentials`

Manages named git credentials. Each credential has a unique `id`, a human-readable `label`, a `host`, and a `token`. All tokens are **always returned masked** by the API (e.g. `****abc1`) — the plaintext token is never surfaced in any response.

```js
// List all configured credentials.
// Returns: Promise<Array<{ id: string, label: string, host: string, maskedToken: string }>>
api.config.credentials.list()

// Add a new credential (no id in the request body).
// data: { label: string, host: string, token: string }
// Returns: Promise<Array<{ id: string, label: string, host: string, maskedToken: string }>>
api.config.credentials.add(data)

// Update an existing credential by ID.
// id: string — the credential ID to update
// data: { label?: string, token?: string } — omit token to leave the existing token unchanged
// Returns: Promise<Array<{ id: string, label: string, host: string, maskedToken: string }>>
api.config.credentials.update(id, data)

// Remove a credential by ID.
// id: string — URL-encoded automatically by the client
// Returns: Promise<void>
api.config.credentials.remove(id)
```

> **Token masking:** The server applies `maskToken()` before every API response. The client never receives or stores a plaintext token. The Token field uses `<input type="password">` in the UI.

> **Partial update — token retention:** When `update()` is called without a `token` key in `data` (e.g. the user edited only the label), the server retains the existing stored token unchanged. This is the expected behaviour for label-only edits during inline editing in the credentials table.

### `api.config.polling`

Read and update the server-side git polling interval. Changes take effect immediately (the background `PollingManager` is restarted).

```js
// Return the current polling interval.
// Returns: Promise<{ gitPollingIntervalSeconds: number }>
api.config.polling.get()

// Update the polling interval.
// seconds: number — must be a finite integer >= 10
// Returns: Promise<{ gitPollingIntervalSeconds: number }>
api.config.polling.set(seconds)
```

**Validation:** `set()` rejects with HTTP 400 when `seconds` is non-numeric, fractional, infinite, NaN, or below 10. On success the new interval is persisted to `config.json` and the live polling loop is restarted immediately.

### `api.config.notesDisplay`

Read and update the notes view display settings. Changes are persisted to `config.json` and take effect immediately.

```js
// Return the current notes display settings.
// Returns: Promise<NotesDisplayConfig>  // { notesCardHeight: number, notesColumns: number }
api.config.notesDisplay.get()

// Update the notes display settings (partial update — all fields optional).
// data: { notesCardHeight?: number, notesColumns?: number }
// Returns: Promise<NotesDisplayConfig>  // full settings after applying changes
api.config.notesDisplay.set(data)
```

**`NotesDisplayConfig` shape:**

| Field | Type | Range | Default | Description |
|---|---|---|---|---|
| `notesCardHeight` | `number` | `[120, 800]` | `220` | Height of each note card in pixels. |
| `notesColumns` | `number` | `[1, 6]` | `2` | Number of columns in the notes view grid. |

**Validation:** `set()` rejects with HTTP 400 when a provided field is non-numeric, non-integer, or outside its allowed range. Omitting a field leaves its current value unchanged. An empty body `{}` is valid and returns the current settings unchanged.

### `api.projects`

```js
api.projects.list()                      // GET /api/projects
api.projects.get(id)                     // GET /api/projects/:id
api.projects.create(data)               // POST /api/projects
api.projects.update(id, data)           // PUT  /api/projects/:id
api.projects.rename(id, newId)          // PUT  /api/projects/:id/rename
api.projects.delete(id)                 // DELETE /api/projects/:id
api.projects.addRepository(pid, rid)    // POST /api/projects/:id/repositories
api.projects.removeRepository(pid, rid) // DELETE /api/projects/:id/repositories/:repoId
```

### `api.workspaces`

```js
api.workspaces.list(pid)                     // GET /api/projects/:id/workspaces
api.workspaces.get(pid, wid)                 // GET /api/projects/:id/workspaces/:wid
api.workspaces.create(pid, data)             // POST /api/projects/:id/workspaces
api.workspaces.update(pid, wid, data)        // PUT  /api/projects/:id/workspaces/:wid
api.workspaces.rename(pid, wid, newId)       // PUT  /api/projects/:id/workspaces/:wid/rename
api.workspaces.delete(pid, wid)              // DELETE /api/projects/:id/workspaces/:wid
api.workspaces.setup(pid, wid)               // POST /api/projects/:id/workspaces/:wid/setup
api.workspaces.health(pid, wid)              // GET /api/projects/:id/workspaces/:wid/health
api.workspaces.regenerateFile(pid, wid)      // POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file
api.workspaces.launch.vscode(pid, wid)       // POST /api/projects/:id/workspaces/:wid/launch/vscode
api.workspaces.launch.githubDesktop(pid, wid, rid)  // POST /api/projects/:id/workspaces/:wid/launch/github-desktop/:rid
api.workspaces.launch.terminal(pid, wid)     // POST /api/projects/:id/workspaces/:wid/launch/terminal
```

### `api.branches`

```js
api.branches.list(pid, wid)            // GET /api/projects/:id/workspaces/:wid/branches
api.branches.switch(pid, wid, assignments) // POST /api/projects/:id/workspaces/:wid/branches/switch
```

### `api.status`

```js
api.status.get(pid, wid)      // GET /api/projects/:id/workspaces/:wid/status
api.status.refresh(pid, wid)  // POST /api/projects/:id/workspaces/:wid/status/refresh
```

### `api.config.webserverUrl`

```js
api.config.webserverUrl.get()       // GET /api/config/webserver-url
api.config.webserverUrl.set(url)    // PUT /api/config/webserver-url
```

### `api.errorLog`

```js
api.errorLog.list(params?)  // GET /api/error-log[?...]
api.errorLog.get(id)        // GET /api/error-log/:id
api.errorLog.clear()        // DELETE /api/error-log
api.errorLog.sources()      // GET /api/error-log/sources
api.errorLog.count()        // GET /api/error-log?limit=0 (returns { entries: [], total: N })
```

### `api.notes`

```js
api.notes.list()   // GET /api/notes — returns all workspace notes grouped by project
```

### `api.version`

```js
api.version.get()  // GET /api/version — returns { appVersion: string, guiVersion: string }
```

---

## GUI Components (`gui/public/js/components/`)

### `createModalShell` (`components/modal-shell.js`)

Shared overlay/modal DOM construction, ARIA wiring, Escape/backdrop-cancel handling, Tab/Shift+Tab focus trap, focus restoration, and busy-gating primitive used by every modal dialog (`confirm-dialog.js`; future modal consumers build on it too).

```js
import { createModalShell } from './components/modal-shell.js';

// options: {
//   titleText: string,             — text shown in the modal's title heading
//   ariaLabelledbyId: string,      — id applied to the title heading and referenced by aria-labelledby
//   ariaDescribedbyId?: string,    — id referenced by aria-describedby, when the caller has a description element
//   className?: string,           — additional class applied to the .modal element alongside the base 'modal' class
//   onCancel: () => void,         — invoked on Escape or backdrop click (while not busy)
// }
// Returns: {
//   overlay: HTMLDivElement,             — the .modal-overlay element (not yet attached to the DOM)
//   modal: HTMLDivElement,               — the .modal element, already appended to overlay; callers append their own body/actions content here
//   mount: (initialFocusEl?: HTMLElement) => void,  — attaches overlay to document.body, wires listeners, and moves focus
//   close: () => void,                   — detaches overlay, removes listeners, and restores focus to the pre-open element
//   setBusy: (busy: boolean) => void,    — toggles whether Escape/backdrop-cancel are currently no-ops
// }
const shell = createModalShell({ titleText, ariaLabelledbyId, ariaDescribedbyId, className, onCancel });
shell.modal.appendChild(bodyEl);
shell.mount(initialFocusEl);
// … later, on submit or successful confirm:
shell.close();
```

> **Caller responsibility:** the shell has no knowledge of which buttons a caller built — callers remain responsible for disabling their own Confirm/Cancel/Submit buttons in response to `setBusy()`.

### `showRepositoryModal` (`components/repository-modal.js`)

Create/edit modal for a repository. A single implementation serves both flows since they share all five fields (URL, Name, ID, Description, Credential), differing only in pre-fill values and which fields are disabled. Built on `createModalShell` with `className: 'modal--form'`.

```js
import { showRepositoryModal } from './components/repository-modal.js';

// config: {
//   mode: 'create'|'edit',
//   repo?: { id, name, url, description?, credentialId? },  — required (and only used) in 'edit' mode
// }
// Returns: Promise<Repository>  — normalised, saved repository;
//   rejects with Error('User cancelled') on Cancel/Escape/backdrop-click.
const repo = await showRepositoryModal({ mode: 'create' });
const repo = await showRepositoryModal({ mode: 'edit', repo: existingRepo });
```

- URL is required and editable in both modes; Name is optional and editable in both modes.
- ID is editable in create mode; disabled and excluded from the edit-mode `update()` payload.
- Description is an optional textarea field, editable in both modes, pre-filled from `repo.description || ''` in edit mode. The create payload omits it when blank; the update payload always includes it (even `''`) so clearing persists.
- Credential is a `<select>` repopulated after every `api.repositories.credentialOptionsForUrl()` fetch, selecting: the stored credential ID when still present among the options, else the single option flagged `auto: true` when exactly one exists, else `''` (None).
- Edit mode fetches credential options once on mount (keyed by `repo.url`); create mode skips the initial fetch. Both modes debounce (~400ms) a re-fetch on URL-field `input` events.
- Submit: create mode calls `create()` then `updateCredential()` when a credential is selected; edit mode calls `update(repo.id, { name, url })` then `updateCredential()` only when the selection differs from `repo.credentialId ?? ''`. A rejected `updateCredential()` still resolves the Promise with the pre-credential-update repository (with an error toast); a rejected primary call re-enables all controls, shows a toast, and keeps the modal open.

### `buildHealthAlert` (`components/health-alert.js`)

Shared health-alert renderer, extracted from `workspace-detail.js`'s formerly-private `buildHealthAlertSection()` so a second health-reporting view (the repository info-sync section) can reuse the same markup and fix-action dispatch. See `gui-frontend.md`'s **Health Alert Component** section for the full behaviour contract (markup/classes, the `actions` registry, the `'none'`/unrecognised-`fixAction` fallback).

```js
import { buildHealthAlert } from './components/health-alert.js';

// report: HealthReport { healthy, issues: Array<{ type, severity, message, fixAction, repositoryId? }> }
// options: {
//   title: string,
//   actions: Record<string, { label: string, loadingLabel?: string, onClick(issue): void|Promise<void> }>,
// }
// Returns: HTMLElement | null — null when report.healthy is true (nothing to render)
const healthEl = buildHealthAlert(status.health, { title: 'Workspace info sync issues', actions: { ... } });
```

### `showRepositoryInfoImportModal` (`components/repository-info-import-modal.js`)

Per-field diff/choice modal for the `incoming`/`conflict` info-sync states. Built on `createModalShell` with `className: 'modal--form'`. See `gui-frontend.md`'s **Repository Info Import Modal Component** section for the full field-row/focus/default-choice contract.

```js
import { showRepositoryInfoImportModal } from './components/repository-info-import-modal.js';

// config: { repoId: string, repoName?: string, preview: { state: 'incoming'|'conflict', fields: RepositoryInfoFieldDiff[] } }
// Returns: Promise<{ applied: boolean }> — never rejects
const { applied } = await showRepositoryInfoImportModal({ repoId, repoName, preview });
```

- Only `Name`/`Description` rows are rendered (filters defensively even though `diffRepositoryInfo()` already excludes `Url` upstream); each row is a `<fieldset>`/`<legend>` with Keep/Import radios, defaulting to Import for `incoming` and Keep for `conflict`.
- `Apply` calls `api.repositories.infoSync.applyImport(repoId, selectedFields)` itself (selecting no fields is valid — "keep all"); a rejection is shown inline in a `role="alert"` paragraph without closing the modal.

### `showInfoCommitDialog` (`components/info-commit-dialog.js`)

Commit & Push confirmation dialog that performs the commit itself. Built on `createModalShell` with `className: 'modal--form'`. See `gui-frontend.md`'s **Info Commit Dialog Component** section for the full validation/focus contract.

```js
import { showInfoCommitDialog } from './components/info-commit-dialog.js';

// config: { repoId: string, pendingFiles?: string[], defaultMessage?: string }
// Returns: Promise<{ message: string, result: CommitPushResult }|null> — the trimmed,
//   committed message plus the CommitPushResult from commitPush() (`{ committed, pushed,
//   commitSha?, filterFallback? }`) on success; null on Cancel/Escape/backdrop-click. Never rejects.
const outcome = await showInfoCommitDialog({ repoId, pendingFiles: status.pendingChanges, defaultMessage: status.defaultCommitMessage });
```

- The message textarea enforces a trimmed length of 1–`MAX_INFO_COMMIT_MESSAGE_LENGTH` (500, duplicated client-side — see the commit constants note above) with a live character counter and `aria-invalid`/`aria-describedby` wiring; the Commit button stays disabled while invalid.
- `Commit & Push` calls `api.repositories.infoSync.commitPush(repoId, trimmedMessage)` itself; a 409/502 rejection is shown inline in a `role="alert"` paragraph without closing the modal (so the caller's own inline alert is never used for Commit & Push errors — see the section builder, below).
- **Caller (Milestone 2):** `repository-info-sync-section.js`'s `doCommitPush()` reads `outcome.result.commitSha`/`outcome.result.filterFallback` to build its toast — see `rest-api.md`'s `commitPush()` entry and `data-flows.md` §16 for the exact wording — and treats a `null` outcome (cancel) as a no-op, same as Milestone 1.

---

## GUI Views (`gui/public/js/views/`)

View functions follow the router contract: `async function render*(container, params)`. Each function populates `container` with DOM elements and may return a cleanup function. All view functions are registered in `gui/public/js/app.js`.

| Export | Module | Signature | Description |
|---|---|---|---|
| `renderNotesCollected` | `views/notes-collected.js` | `async (container: Element, _params: {}) => void` | Renders the two-panel Notes Collected view. Left sidebar lists all workspaces grouped by collapsible project groups (uses `api.notes.list()` + `normaliseNotesResponse()`); workspaces with notes carry `.has-notes`. Right panel shows editable note cards — one per workspace with a non-empty note on initial load. Clicking a sidebar item for an existing card scrolls to it; clicking one without a card creates a new empty card and focuses the textarea. Each card auto-saves after 1000 ms of inactivity via `api.workspaces.update()`; saving empty text removes the card and clears the sidebar indicator. Route: `#/notes`. |

### `buildRepositoryInfoSyncSection` (`views/repository-info-sync-section.js`)

Section builder (not a routed view) mounted inside `repository-detail.js` directly after the Credential section. See `gui-frontend.md`'s **Repository Info Sync Section** for the full rendered-order, button-matrix, focus-management and accessibility contract.

```js
import { buildRepositoryInfoSyncSection } from './views/repository-info-sync-section.js';

// repo: { id: string, name?: string } — a normalised repository (normaliseRepo())
// options: {
//   onRepositoryChanged?: (updatedRepo) => void,   // called only after a successful import
//   onConfigureCredential?: () => void,            // wired by the caller to focus the Credential section
// }
// Returns: { element: HTMLElement, cleanup: () => void }
const { element, cleanup } = buildRepositoryInfoSyncSection(repo, { onRepositoryChanged, onConfigureCredential });
```

---

## GUI Utilities (`gui/public/js/utils/`)

### `utils/constants.js`

| Export | Type | Value | Description |
|---|---|---|---|
| `STABLE_WS_ID` | `string` | `'STABLE'` | The workspace ID that is always treated as the stable reference workspace. Enforced at the storage layer. Import from here — do not hardcode `'STABLE'` in views or components. |
| `APP_NAME_SHORT` | `string` | `'Paralizer'` | Short application name used in browser tab titles. Import from here — do not hardcode the string in views. |

### `utils/dom.js`

| Export | Signature | Description |
|---|---|---|
| `clearElement` | `(el: Element) => void` | Removes all child nodes from a DOM element via a `removeChild` loop. Preferred over `el.innerHTML = ''` — avoids invoking the HTML parser and is safe when children hold event listeners. |

### `utils/normalise.js`

| Export | Signature | Description |
|---|---|---|
| `normaliseRepo` | `(raw) => { id, name, url, description, credentialId, LastRefreshedAt, infoSync }` | Maps PascalCase/camelCase backend keys to a consistent camelCase shape. `infoSync` maps `raw.InfoSync` to `{ enabled, lastSyncedAt }` only — `InfoSync.LastWrittenHash` (a machine-local sync-detection detail) is never exposed, and `infoSync` is left `undefined` when the backend omits `InfoSync` (sync never configured for that repository). |
| `normaliseProject` | `(raw) => { id, name, description, repositories }` | Normalises project objects. |
| `normaliseWorkspace` | `(raw) => { id, description, initialized, folderPath, notes }` | Normalises workspace objects. `notes` maps `raw.Notes ?? raw.notes ?? ''`. |
| `normaliseNotesResponse` | `(response) => { projects: Array<{ projectId, projectName, workspaces: Array<{ workspaceId, notes }> }> }` | Transforms the PascalCase `GET /api/notes` response into a camelCase structure grouped by project. |
