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
}

interface RunGitOptions {
    timeoutMs?: number;
    maxBufferBytes?: number;
}
```

### CLI (`git-cli.ts`)

```typescript
function runGit(args: string[], cwd?: string, options?: RunGitOptions): Promise<GitResult>
function runGitOrThrow(args: string[], cwd?: string): Promise<string>
```

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
function cloneRepository(url: string, destination: string, options?: CloneOptions): Promise<GitResult>
```

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
}

interface RepositoryStore extends BaseStore {
    Repositories: Repository[];
}
```

> **Schema version note:** `CredentialId` is an optional field addition. Per the `BaseStore` versioning policy (see `storage.types.ts`), adding an optional field is backward-compatible — existing `repositories.json` files that lack the field remain valid. No `SCHEMA_VERSION` bump is required.

#### Manager (`repository.manager.ts`)

```typescript
class RepositoryManager {
    constructor(config: AppConfig)

    list(): Repository[]
    getById(id: string): Repository | undefined
    exists(id: string): boolean
    add(params: { url: string; name?: string; id?: string }): Repository
    update(id: string, params: { name: string; url?: string }): Repository
    remove(id: string): void
    updateCredential(id: string, credentialId: string | null): Repository
    touchRefreshTimestamp(id: string): Repository
}
```

> **`updateCredential()`:** Associates or removes a named credential on a repository. Pass a `credentialId` string to pin the repository to a specific `GitCredentialEntry`; pass `null` to clear the association and revert to host-based auto-selection at runtime. When `null` is passed, the `CredentialId` key is removed entirely from `repositories.json` (not set to `undefined`) so the JSON remains clean. Throws `NotFoundError` if the repository ID does not exist. See `Repository.CredentialId` for the auto-selection fallback behaviour.

> **`update()`'s optional `url`:** When `url` is provided, it is trimmed and any embedded credentials are stripped (mirroring `add()`'s URL-handling pattern), then checked for duplicates against every other repository's `Url`, self-excluded by `Id`. Returns the repository spread with `credentialsStripped: true` when stripping occurred (transient, not persisted). Throws `NotFoundError` if the ID does not exist, or a plain `Error` if the cleaned URL duplicates another repository's URL. When `url` is omitted, behavior is unchanged (name-only update). **Known gap:** an empty or whitespace-only `url` is silently persisted with no rejection, unlike `add()`'s empty-slug guard — callers passing raw form input should validate non-empty before calling.

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
    LastActivity?: string;  // ISO 8601 — most recent activity timestamp; updated by updateLastActivity(), does NOT affect DateModified
    SchemaVersion: number;
}

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
    constructor(config: AppConfig, projectManager: ProjectManager, workspaceOrchestrator: WorkspaceOrchestrator)

    createProject(name: string, repositoryIds: string[], description?: string, id?: string): Promise<OrchestrationResult>
    deleteProject(projectId: string): void
    renameProject(oldId: string, newId: string): void
}
```

### RepositoryOrchestrator (`repository-orchestrator.ts`)

```typescript
class RepositoryOrchestrator {
    constructor(config: AppConfig, projectManager: ProjectManager, repositoryManager: RepositoryManager)

    addRepositoryToProject(projectId: string, repositoryId: string): Promise<AddRepositoryResult>
    removeRepositoryFromProject(projectId: string, repositoryId: string): void
    deleteRepositoryGlobally(repositoryId: string): void
}
```

### WorkspaceOrchestrator (`workspace-orchestrator.ts`)

```typescript
class WorkspaceOrchestrator {
    constructor(config: AppConfig, projectManager: ProjectManager, workspaceManager: WorkspaceManager, repositoryManager: RepositoryManager)

    createWorkspace(projectId: string, workspaceId: string): Promise<OrchestrationResult>
    deleteWorkspace(projectId: string, workspaceId: string): void
    renameWorkspace(projectId: string, oldId: string, newId: string): void
}
```

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

### Workspace Health (`workspace-health.ts`)

```typescript
interface WorkspaceHealthIssue {
    type: string;
    severity: 'error' | 'warning';
    message: string;
    fixAction: string;
    repositoryId?: string;
}

interface WorkspaceHealthReport {
    healthy: boolean;
    issues: WorkspaceHealthIssue[];
}

function checkWorkspaceHealth(
    projectId: string,
    workspaceId: string,
    projectsFolder: string,
    repositoryIds: string[],
    errorLogManager?: ErrorLogManager,
): WorkspaceHealthReport
```

> **Credential-missing check:** When `errorLogManager` is supplied, `checkWorkspaceHealth` performs an additional Check 3: it queries all `Source: 'credentials'` log entries scoped to the workspace and inspects the most recent entry per repository. A `credential-missing` health issue is surfaced only when the most recent entry has `Severity: 'error'`. A `Severity: 'info'` entry — written by `WorkspaceOrchestrator.createWorkspace()` or `RepositoryOrchestrator.addRepositoryToProject()` after a successful credential-based clone — suppresses the stale error badge without deleting history. SSH clones (`credential === null`) do not produce a credentials log entry and are not evaluated by this check.

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

---

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
> `import { launchApplication } from './app-launcher.js'`

```typescript
function launchApplication(command: string, args: string[]): Promise<void>
```

Launches an external application as a detached, fire-and-forget child process. The spawned process runs independently of the Node.js parent (`detached: true`, `stdio: 'ignore'`, `child.unref()`).

**Cross-platform behaviour:**
- **Windows (`process.platform === 'win32'`):** `shell: true` — routes through `cmd.exe` so `.cmd`/`.bat` launchers (e.g. `code.cmd`) are found on PATH.
- **All other platforms:** `shell: false` — direct process execution, no intermediate shell.

**Throws:**
- `Error('Failed to launch application: command must not be empty.')` — when `command` is empty or blank.
- `Error('Failed to launch application "<command>": <os-error-message>')` — when the OS-level spawn fails (e.g. command not found on PATH).

**Security note (Windows):** When `shell: true` is active, shell metacharacters in `command` or `args` elements can be interpreted by `cmd.exe`. Call sites **must** validate inputs against an allowlist of known application commands (e.g. `'code'`, `'github'`) before calling this function.

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
    errorLogManager?: ErrorLogManager,  // optional — when provided, credential assign/clear ops emit audit log entries
): void

// projects.ts
function registerProjectRoutes(router: Router, projectManager: ProjectManager): void

// workspaces.ts
function registerWorkspaceRoutes(
    router: Router,
    workspaceManager: WorkspaceManager,
    workspaceOrchestrator: WorkspaceOrchestrator,
    appConfig: AppConfig,
    projectManager: ProjectManager,
    errorLogManager: ErrorLogManager,
    launchFn?: (command: string, args: string[]) => Promise<void>,  // test-only; defaults to launchApplication
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

Create/edit modal for a repository. A single implementation serves both flows since they share all four fields (URL, Name, ID, Credential), differing only in pre-fill values and which fields are disabled. Built on `createModalShell` with `className: 'modal--form'`.

```js
import { showRepositoryModal } from './components/repository-modal.js';

// config: {
//   mode: 'create'|'edit',
//   repo?: { id, name, url, credentialId? },  — required (and only used) in 'edit' mode
// }
// Returns: Promise<Repository>  — normalised, saved repository;
//   rejects with Error('User cancelled') on Cancel/Escape/backdrop-click.
const repo = await showRepositoryModal({ mode: 'create' });
const repo = await showRepositoryModal({ mode: 'edit', repo: existingRepo });
```

- URL is required and editable in both modes; Name is optional and editable in both modes.
- ID is editable in create mode; disabled and excluded from the edit-mode `update()` payload.
- Credential is a `<select>` repopulated after every `api.repositories.credentialOptionsForUrl()` fetch, selecting: the stored credential ID when still present among the options, else the single option flagged `auto: true` when exactly one exists, else `''` (None).
- Edit mode fetches credential options once on mount (keyed by `repo.url`); create mode skips the initial fetch. Both modes debounce (~400ms) a re-fetch on URL-field `input` events.
- Submit: create mode calls `create()` then `updateCredential()` when a credential is selected; edit mode calls `update(repo.id, { name, url })` then `updateCredential()` only when the selection differs from `repo.credentialId ?? ''`. A rejected `updateCredential()` still resolves the Promise with the pre-credential-update repository (with an error toast); a rejected primary call re-enables all controls, shows a toast, and keeps the modal open.

---

## GUI Views (`gui/public/js/views/`)

View functions follow the router contract: `async function render*(container, params)`. Each function populates `container` with DOM elements and may return a cleanup function. All view functions are registered in `gui/public/js/app.js`.

| Export | Module | Signature | Description |
|---|---|---|---|
| `renderNotesCollected` | `views/notes-collected.js` | `async (container: Element, _params: {}) => void` | Renders the two-panel Notes Collected view. Left sidebar lists all workspaces grouped by collapsible project groups (uses `api.notes.list()` + `normaliseNotesResponse()`); workspaces with notes carry `.has-notes`. Right panel shows editable note cards — one per workspace with a non-empty note on initial load. Clicking a sidebar item for an existing card scrolls to it; clicking one without a card creates a new empty card and focuses the textarea. Each card auto-saves after 1000 ms of inactivity via `api.workspaces.update()`; saving empty text removes the card and clears the sidebar indicator. Route: `#/notes`. |

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
| `normaliseRepo` | `(raw) => { id, name, url }` | Maps PascalCase/camelCase backend keys to a consistent camelCase shape. |
| `normaliseProject` | `(raw) => { id, name, description, repositories }` | Normalises project objects. |
| `normaliseWorkspace` | `(raw) => { id, description, initialized, folderPath, notes }` | Normalises workspace objects. `notes` maps `raw.Notes ?? raw.notes ?? ''`. |
| `normaliseNotesResponse` | `(response) => { projects: Array<{ projectId, projectName, workspaces: Array<{ workspaceId, notes }> }> }` | Transforms the PascalCase `GET /api/notes` response into a camelCase structure grouped by project. |
