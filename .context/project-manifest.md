# Project - Manifest Documentation
_SOURCE: Agent project manifest — tech stack, API surface, constraints, data flows, REST API, GUI frontend_
# Agent project manifest — tech stack, API surface, constraints, data flows, REST API, GUI frontend
```
// Structure of documents
└── docs/
    └── agents/
        └── project-manifest/
            └── README.md
            └── api-surface.md
            └── constraints.md
            └── curation-log.md
            └── data-flows.md
            └── gui-frontend.md
            └── rest-api.md
            └── tech-stack.md

```
###  Path: `/docs/agents/project-manifest/README.md`

```md
# Project Manifest — repo-parallelizer

> **Source of Truth** for AI agent sessions. Describes the codebase structure, public API surface, data flows, and conventions without reproducing implementation logic.

| Section | File | Description |
|---|---|---|
| Tech Stack & Patterns | [tech-stack.md](tech-stack.md) | Runtime, language, frameworks, architectural patterns, build tools. |
| File Tree | [project-folder-structure.md](../../.context/project-folder-structure.md) | Directory structure (CTX-generated via `ctx generate`). |
| Public API Surface | [api-surface.md](api-surface.md) | Exported types, classes, and function signatures — no implementations. |
| Key Data Flows | [data-flows.md](data-flows.md) | Main interaction paths through the system. |
| Constraints & Conventions | [constraints.md](constraints.md) | Established rules, conventions, and non-obvious gotchas. |
| REST API | [rest-api.md](rest-api.md) | HTTP endpoints served by the built-in server. |
| GUI Frontend | [gui-frontend.md](gui-frontend.md) | SPA architecture, views, components, and routing. |
| Curation Log | [curation-log.md](curation-log.md) | Standing decisions and verification history. |

```
###  Path: `/docs/agents/project-manifest/api-surface.md`

```md
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

```
###  Path: `/docs/agents/project-manifest/constraints.md`

```md
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

```
###  Path: `/docs/agents/project-manifest/curation-log.md`

```md

# Curation Log

Why this manifest looks the way it does, and when it was last verified.
Read freely — Standing Decisions explains the deliberate gaps and conventions.
Written by the manifest curator and reviewer only; no other agent edits this file.

## Standing Decisions

| Date | Decision | Rationale |
|---|---|---|

## History

### 2026-09-09 · Update · Manifest Curator v3.4.0

**Scope:** All six manifest section documents (`tech-stack.md`, `constraints.md`, `data-flows.md`, `api-surface.md`, `rest-api.md`, `gui-frontend.md`), the manifest index (`README.md`), and the out-of-manifest `AGENTS.md` (dispatched to AGENTS.md Curator v2.1.0).
**Commit:** `ddacee5` (branch `feature-repo-dialog`; working tree held the two finding-sink artefacts as uncommitted files — no source changes since the review passes)
**Baselines:** Commit `ddacee5`; every manifest document was treated as fully verified prose from the preceding Manifest Reviewer passes. This pass made no new discovery — it drew solely on the reconciled finding sinks.
**Coverage:** All 31 findings across both finding sinks reconciled and applied. No new claim verification was attempted beyond re-reading each finding's cited evidence pointer before editing. Cross-document propagation checked for each corrected subject (configure-credential nav, Operation labels, storage layout, negative-limit semantics). `constraints.md`, `api-surface.md`, `rest-api.md`, and `gui-frontend.md` sections not touched by a finding were not re-verified this pass.
**Changes:** `tech-stack.md` — corrected `files` field row to the curated per-subdirectory list; removed the stale `.npmignore` checklist item (findings 1, 2). `constraints.md` — added `MIN/MAX_CLONE_DEPTH` and `MIN/MAX_SERVER_PORT` rows to the Config Validation Constants table (finding 3). `data-flows.md` — rewrote flows 3, 4, 5 to remove false orchestrator invocations from plain HTTP endpoints; amended flow 6 DateModified condition; documented the missing `hasEmbeddedCredentials()` pre-check gap in flow 9; added `error-log.json` to the storage layout (flow 11); corrected credential success-log Operation labels in flow 14; fixed `configure-credential` navigation note in §12 (findings 7–13, 30 propagation). `api-surface.md` — corrected `ErrorLogListOptions.limit` negative-value semantics; added `PollingManager.restart()`; added `migrateWorkspaceFiles()`; fixed `ProjectWorkspace` re-export declaration; fixed `_promptPath`/`_promptNumber` parameter optionality; added `registerErrorLogRoutes`, `registerNotesRoutes`, `registerVersionRoute`; expanded GUI client section to document all namespaces including `api.version.get()` and `api.errorLog.sources()` (findings 14–20). `rest-api.md` — corrected polling upper-bound note; corrected negative-limit semantics; added `POST /api/repositories/:id/refresh-timestamp`; corrected workspace-create body field (`workspaceId`); added 400 to `PUT /api/projects/:id`; removed false filesystem-cleanup claim from `DELETE /api/projects/:id`; corrected `DELETE /api/projects/:id/workspaces/:wid` error codes; removed nonexistent 400 from workspace setup endpoint; added `GET /api/version` section (findings 5, 6, 21–27). `gui-frontend.md` — qualified "full re-render" claim; removed hardcoded API group count; corrected `configure-credential` navigation; added `api.errorLog.sources()` and `api.version.get()` to the client inventory (findings 28–31). `README.md` (manifest index) — removed stale `Last generated` date; added `curation-log.md` link (finding 6). `AGENTS.md` — dispatched to AGENTS.md Curator v2.1.0; "Architecture" Project Stats row corrected to include Error Log layer and separate Server/CLI (finding 4). Finding sinks `findings-gpt-terra.md` and `findings-claude-sonnet-5.md` retained — not deleted, as the user did not instruct deletion.
**Findings:** 7 high, 21 medium, 1 low — all 31 reconciled from the two external sinks. No findings rejected on re-verification (claude-sonnet-5 Pass 2 confirmed all gpt-terra findings held). Headline findings reconciled: false orchestrator flows in project/repository/workspace creation (7–9); credential guard gap (11); wrong credential-success operation labels (12); missing storage file (13); negative-limit semantics wrong in both `api-surface.md` and `rest-api.md` (14, 6); polling missing upper bound (5); multiple REST endpoint omissions and wrong error codes (21–27); GUI architecture overstated; configure-credential loses repo context (30).
**Notes:** Conditional Standing Decisions check: no conditional decisions exist — check declined. Finding sinks not deleted per instruction omission; curator will delete them on the user's instruction. `AGENTS.md` edit confirmed by dispatched agent.

### 2026-09-09 · Review · Manifest Reviewer v5.2.0

**Scope:** Continuation of the resolved manifest scope, focused on all `gui-frontend.md` architecture, router, route, API client, reusable component, utility, theme, lifecycle, title, and view-behavior claims against their JavaScript owners.
**Commit:** `ddacee5` (branch `feature-repo-dialog`; working tree had uncommitted CTX output and review artefacts)
**Baselines:** Commit `ddacee5`; `gui-frontend.md` contained partly verified unread prose from earlier passes, and this pass verified the remaining document against `gui/public/js/`. No commits exist in `ddacee5..HEAD`.
**Coverage:** Complete frontend-claim coverage for `gui-frontend.md`. Remaining work: `constraints.md`, cross-document contradiction/register/omission checks, class-naming documents, and root-document scope-drift checks.
**Changes:** none — review only.
**Findings:** 1 high, 2 medium, 1 low — 4 originated, 0 confirmed. Headline findings: `configure-credential` opens the repository list instead of the affected repository; the architecture falsely states all mutations re-render; the API group count is wrong; and live `sources`/`version` client methods are omitted.
**Notes:** Conditional Standing Decisions remain declined by the user; none exist. This source-review pass did not change application code.

### 2026-09-09 · Review · Manifest Reviewer v5.2.0

**Scope:** Continuation of the resolved manifest scope, focused on `rest-api.md`: every endpoint table, detailed request/response branch, and registered route across repositories, projects, workspaces, launch, branches, status, error log, credentials, polling, webserver URL, notes display, notes, and version.
**Commit:** `ddacee5` (branch `feature-repo-dialog`; working tree had uncommitted CTX output and review artefacts)
**Baselines:** Commit `ddacee5`; `rest-api.md` was previously partly reviewed and this pass verified its remaining claims against all source route statements. No commits exist in `ddacee5..HEAD`.
**Coverage:** Complete REST endpoint/table and described-branch coverage for `rest-api.md`. GUI behavioral claims, remaining constraints, class-naming documents, and cross-document register/omission/contradiction audits remain uncovered.
**Changes:** none — review only.
**Findings:** 1 high, 6 medium, 0 low — 7 originated, 0 confirmed. Headline findings: refresh-timestamp and version endpoints are omitted; workspace create uses `workspaceId`, not `id`; project deletion does not clean workspace files; and multiple endpoint table error-code lists do not match their handlers.
**Notes:** Conditional Standing Decisions remain declined by the user; none exist. This source-review pass did not change application code.

### 2026-09-09 · Review · Manifest Reviewer v5.2.0

**Scope:** Continuation of the resolved manifest scope, focused on the complete exported declaration inventory in `api-surface.md`: configuration, Git, Error Log, models, orchestration, storage, utilities, CLI, server, route registration, and GUI client.
**Commit:** `ddacee5` (branch `feature-repo-dialog`; working tree had uncommitted CTX output and review artefacts)
**Baselines:** Commit `ddacee5`; `api-surface.md` was partly verified in the prior passes and this pass checked its remaining declaration claims against their owning exported statements. No commits exist in `ddacee5..HEAD`.
**Coverage:** Complete declaration and signature coverage for `api-surface.md`. Deep behavioral verification, the cross-document contradiction sweep, source-wide register/omission checks, and remaining `rest-api.md`/`gui-frontend.md`/`constraints.md` claims remain uncovered.
**Changes:** none — review only.
**Findings:** 0 high, 7 medium, 0 low — 7 originated, 0 confirmed. Headline findings: ErrorLog negative-limit behavior is wrong; public polling restart and workspace migration APIs are omitted; workspace type re-export and setup helper optionality are misdocumented; route registrations and most GUI client APIs are omitted.
**Notes:** Conditional Standing Decisions remain declined by the user; none exist. This declaration-focused pass did not run a code-mutating command.

### 2026-09-09 · Review · Manifest Reviewer v5.2.0

**Scope:** Continuation of the resolved manifest scope, focused on fully verifying all 14 flows in `data-flows.md` against their owning CLI, server, route, orchestration, git, storage, model, and GUI statements.
**Commit:** `ddacee5` (branch `feature-repo-dialog`; working tree had uncommitted CTX output and review artefacts)
**Baselines:** Commit `ddacee5`; `data-flows.md` was previously explicitly unverified. No commits exist in `ddacee5..HEAD`.
**Coverage:** All `data-flows.md` endpoint, control-flow, branch, literal, and storage-layout claims were verified. The broader Pass 1 gaps in `api-surface.md`, `rest-api.md`, `gui-frontend.md`, `constraints.md`, class-naming documents, register, omission, and contradiction audits remain.
**Changes:** none — review only.
**Findings:** 4 high, 3 medium, 0 low — 7 originated, 0 confirmed. Headline findings: the project/repository/workspace creation flows incorrectly claim their ordinary HTTP endpoints invoke filesystem orchestrators; credential injection is active but its documented guard is absent; the branch timestamp and credential success-operation claims are wrong; and the storage layout omits `error-log.json`.
**Notes:** Conditional Standing Decisions remain declined by the user; none exist. `npm test` passed during this continuation.

### 2026-09-08 · Review · Manifest Reviewer v5.2.0

**Scope:** Resolved: manifest documents `README.md`, `tech-stack.md`, `api-surface.md`, `data-flows.md`, `constraints.md`, `rest-api.md`, and `gui-frontend.md`; routed `AGENTS.md`, `CLAUDE.md`, and `.context/project-folder-structure.md`; class-naming documentation candidates under `docs/agents/implementation-history/`; no diagrams found. Covered: the manifest index, packaging, config-validation, polling, credential-options, routing, architecture-stat, CTX, and limited unread-prose claims. Uncovered documents and categories are stated in the report.
**Commit:** `ddacee5` (branch `feature-repo-dialog`; working tree had uncommitted CTX output and review artefacts)
**Baselines:** Commit `ddacee5`; unread prose established by `git diff main...HEAD -- docs/agents/project-manifest`: `api-surface.md`, `gui-frontend.md`, and `rest-api.md` were new relative to `main` and received targeted checks. Other manifest prose was not treated as unread solely because an earlier pass exists.
**Coverage:** Partial. Claim inventory and targeted source verification covered `README.md`, `tech-stack.md`, `constraints.md`, `rest-api.md`, parts of `api-surface.md`/`gui-frontend.md`, and `AGENTS.md`; `data-flows.md`, the remaining claim categories, contradiction comparison, and class-naming history documents were not reached.
**Changes:** none — review only.
**Findings:** 4 high, 1 medium, 1 low — 2 originated, 4 confirmed from the independent `claude-sonnet-5` finding sink. Headline findings: the documented npm `files` field and `.npmignore` checklist are stale; `AGENTS.md` omits the Error Log architecture layer; config validation bounds are omitted; polling's documented missing maximum contradicts the route; and the manifest index retains superseded date metadata.
**Notes:** Conditional Standing Decisions were declined by the user; no conditional decisions exist. `ddacee5..HEAD` contains zero commits, so the preceding review's commit baseline was not invalidated; no reverted-decision leads appeared in `main..HEAD`.

### 2026-09-08 · Review · Manifest Reviewer v5.2.0

**Scope:** Resolved scope: the manifest directory (all 7 documents plus this log, which did not yet exist), the change set since `main` (`api-surface.md`, `gui-frontend.md`, `rest-api.md`), and routed documents (`AGENTS.md`/`CLAUDE.md`). No diagrams or other class-naming documents were found. Covered in full: `tech-stack.md`, `AGENTS.md`. Covered in part: `constraints.md`, `api-surface.md`, `rest-api.md`, `gui-frontend.md`, `README.md` (link/existence check only). Not covered: `data-flows.md`.
**Commit:** ddacee5 (branch `feature-repo-dialog`; working tree had uncommitted changes limited to `.context/`-generated files, not manifest source)
**Baselines:** Commit `ddacee5`. Unread prose established by diffing the manifest against `main` (merge-base `11ff152`): `api-surface.md`, `gui-frontend.md`, and `rest-api.md` carry genuinely new, never-reviewed prose; `tech-stack.md`, `constraints.md`, `data-flows.md`, and `README.md` were unchanged since `main` but treated as fully unread in this pass since no prior `curation-log.md` entry existed to certify otherwise.
**Changes:** none — review only.
**Findings:** 3 high, 1 medium, 0 low — 4 originated, 0 confirmed. Headline findings: (1) `tech-stack.md`'s `files`-field table row no longer matches `package.json` — the actual field is a curated per-subdirectory list that already excludes compiled test artefacts; (2) `tech-stack.md`'s pre-publish checklist tells an agent to add a `.npmignore` that already exists with the exact content requested; (3) `constraints.md`'s Config Validation Constants table omits the `MIN`/`MAX_CLONE_DEPTH` and `MIN`/`MAX_SERVER_PORT` constants that gate `cloneDepth`/`serverPort` in `loadConfig()`; (4) `AGENTS.md`'s Project Stats "Architecture" row drops the Error Log layer that `tech-stack.md`'s own Layered Architecture section lists as the 3rd of 7 layers.
**Notes:** First pass — no prior `curation-log.md` existed, so this entry establishes the baseline for future passes. Conditional Standing Decisions: none exist yet, so the pre-pass check was not applicable (nothing to ask about). `data-flows.md` (all 14 flows) was not verified against source and remains the largest coverage gap for a follow-up pass. The report and this pass's finding sink (`findings-claude-sonnet-5.md`) are scaffolding for the user to dispatch fixes from and delete afterward — nothing in the manifest depends on either.

```
###  Path: `/docs/agents/project-manifest/data-flows.md`

```md
# Key Data Flows

## 1. Application Startup (CLI)

```
index.ts (entry point)
  └→ loadConfig()                         # Read config.json from tool root
  └→ initializeStorage(config)            # Create storage dirs + seed files (idempotent)
  └→ Instantiate managers:
       RepositoryManager(config)
       ProjectManager(config, repoManager)
       WorkspaceManager(projectManager)
       ErrorLogManager(config)
  └→ Instantiate orchestrators:
       WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager)
       ProjectOrchestrator(config, projectManager, workspaceOrch)
       RepositoryOrchestrator(config, projectManager, repoManager)
       BranchOrchestrator(config, projectManager, workspaceManager)
  └→ Interactive CLI menu loop
```

## 2. Application Startup (GUI Server)

```
startServer(serverConfig)
  └→ Instantiate managers (same as CLI, including ErrorLogManager(config))
  └→ Instantiate Router
  └→ Register all REST routes via register*Routes() helpers
  └→ PollingManager.start(intervalSeconds)    # Begin periodic git status polling
  └→ http.createServer() → Router.handle() + serveStatic()
  └→ Listen on serverPort (default 4200)
```

## 3. Create a Project

```
User → POST /api/projects { name, repositoryIds, description?, id? }
  └→ ProjectManager.create()                  # Validate IDs, write project JSON + index
       └→ Auto-creates STABLE workspace entry with current timestamp
  └→ Return persisted ProjectData record
```

> **Filesystem setup is separate:** `POST /api/projects` only persists the project record — it does not clone repositories or write workspace files. Call `POST /api/projects/:id/workspaces/:wid/setup` afterward to initialize the workspace on disk.

## 4. Add a Repository to a Project

```
User → POST /api/projects/:id/repositories { repositoryId }
  └→ ProjectManager.addRepository()           # Append repo ID to project data
  └→ Return updated ProjectData record
```

> **No clone or workspace regeneration here:** `POST .../repositories` only appends the repository ID to the project's data record. Cloning and workspace-file regeneration are performed by `RepositoryOrchestrator.addRepositoryToProject()`, which is invoked by a separate orchestration path (not by this REST endpoint).  
> To clone the newly-added repository into existing workspaces after adding it, use the workspace setup endpoint for each workspace.

## 5. Create a Workspace

```
User → POST /api/projects/:id/workspaces { workspaceId, description? }
  └→ WorkspaceManager.create()                # Validate ID, add workspace entry
  └→ Return persisted WorkspaceInfo record
```

> **Filesystem setup is separate:** `POST /api/projects/:id/workspaces` only persists the workspace record. Call `POST /api/projects/:id/workspaces/:wid/setup` to clone repositories and generate the `.code-workspace` file on disk. That endpoint invokes `WorkspaceOrchestrator.createWorkspace()`, which runs the clones and generates the file.

## 6. Branch Switch (Multi-Repository)

```
User → POST /api/projects/:id/workspaces/:wid/branches/switch { assignments: { repoId: branchName } }
  └→ BranchOrchestrator.switchBranches()
       └→ For each repoId in assignments (concurrent via Promise.all):
            branchExists(repoPath, branchName)?
              ├→ yes: switchBranch(repoPath, branchName)   # git checkout
              └→ no:  createBranch(repoPath, branchName)   # git checkout -b
            └→ On failure: scan stderr for conflict patterns
       └→ WorkspaceManager.update() → set DateModified  (only when at least one switch succeeded)
       └→ Return BranchSwitchResult { results: { [repoId]: { success, conflict, error? } } }
```

## 7. Git Status Polling

```
PollingManager.start(intervalSeconds)
  └→ setInterval:
       └→ For each project in ProjectManager.list():
            For each workspace in WorkspaceManager.list():
              For each repository in project.Repositories:
                fetchAndGetStatus(repoPath)    # git fetch + status snapshot
                └→ Store result in internal Map keyed by repoPath
       └→ persistLastActivity()               # post-sweep: compute max lastActivity per
                                              # project and call updateLastActivity(); no-ops
                                              # for projects with all-null lastActivity values
```

`refreshWorkspace()` (on-demand polling) also calls `persistLastActivity()` after its fetch sweep so that `ProjectData.LastActivity` stays current after any single-workspace refresh.

> **Timestamp comparison note:** `persistLastActivity()` finds the maximum `lastActivity` via lexicographic string comparison, which is correct only when all ISO 8601 timestamps share a consistent timezone offset (always `Z` for git commit timestamps normalised by the git layer). Do not mix timezone offsets without updating this method.

```
User → GET /api/projects/:id/workspaces/:wid/status
  └→ For each repository in project:
       pollingManager.getStatus(repoPath)      # Return cached GitStatusInfo or null
  └→ Response: { [repoId]: GitStatusInfo | null }
```

## 8. GUI SPA Navigation

```
Browser → hash change (e.g. #/projects/my-app)
  └→ Router._resolve(hash)
       └→ Match against registered patterns
       └→ Extract named params (e.g. { id: "my-app" })
       └→ Router._render(viewFn, params)
            └→ Call previous view's cleanup function (if any)
            └→ Clear #app container
            └→ viewFn(container, params)        # View builds DOM + fetches API data
            └→ Store returned cleanup function (if any)
```

## 9. Credential-Bearing Git Operation (Private Repository)

```
Orchestrator receives a repo URL (e.g. https://github.com/org/private.git)
  └→ resolveCredential(url, config.gitCredentials, repo.credentialId)?
       │  # Looks up GitCredentialEntry[] by credentialId, or auto-selects
       │  # the sole entry whose host matches extractHost(url)
       ├→ found: injectCredentialToken(url, credential.token)
       │         # Returns https://ghp_token@github.com/org/private.git
       │         # Token injected via WHATWG URL API (percent-encoded, not string concat)
       └→ absent: pass original URL (auth will fail fast — GIT_ASKPASS=echo)
  └→ cloneRepository(injectedUrl, destination, options)
       └→ runGit(['clone', injectedUrl, ...])
            └→ spawn() env: { GIT_TERMINAL_PROMPT:'0', GIT_ASKPASS:'echo' }
  └→ On error (result.stderr contains 'auth'):
       └→ stripEmbeddedCredentials(result.stderr)  ← REQUIRED before surfacing
            # Removes ghp_token from error string before logging / API response
```

**Credential injection rules (standing constraints):**
- `injectCredentialToken()` must only be called immediately before a git subprocess call — never stored or passed through API boundaries.
- `stripEmbeddedCredentials()` must be applied to any `GitResult.stderr` and `Error.message` before the string is logged or returned in an API response.
- **`hasEmbeddedCredentials()` pre-check requirement (constraint, not yet enforced):** When the URL may already carry embedded credentials (e.g. from user input), callers should invoke `hasEmbeddedCredentials(url)` before calling `resolveCredential()` + `injectCredentialToken()` and decide explicitly whether to strip and re-inject or reject. The active clone orchestrators (`WorkspaceOrchestrator`, `RepositoryOrchestrator`) currently skip this check and proceed directly to `resolveCredential()`.

---

## 10. Workspace Setup — Clone Failure Error Propagation

```
WorkspaceOrchestrator.createWorkspace() on clone failure:
  └→ cloneRepository() → GitResult.stderr  (e.g. "fatal: Authentication failed for https://...")
       └→ [FUTURE WP — MANDATORY] stripEmbeddedCredentials(gitResult.stderr)
            # Must be applied before assigning to OrchestrationRepoResult.error
            # Prevents PAT exposure when credential injection is active
       └→ OrchestrationRepoResult.error = (sanitised) stderr string
  └→ API response: { failures: [{ repositoryId, error }] }
  └→ Browser (project-detail.js):
       for (const failure of failures):
         showToast(`Failed to clone "${failure.repositoryId}": ${failure.error}`, 'error', 8000)
         # message set via textContent — NOT innerHTML — so server-controlled strings are XSS-safe
```

**Standing security rule:** Once credential injection is active, `stripEmbeddedCredentials()` (from
`src/git/git-credentials.ts`) **must** be applied to `gitResult.stderr` in
`workspace-orchestrator.ts` and `repository-orchestrator.ts` before the string is assigned to
`OrchestrationRepoResult.error` / `WorkspaceCloneResult.error`. This is a blocking prerequisite for
the credential injection WP — without it, PATs will appear in API JSON responses and the browser
toast UI.

---

## 11. Storage File Layout

```
{storageFolder}/
  ├── repositories.json              # { Repositories: [...], SchemaVersion: 1 }
  ├── projects-index.json            # { Projects: [{ Id, Name }], SchemaVersion: 1 }
  ├── error-log.json                 # { Entries: [...], SchemaVersion: 1 }
  └── projects/
       └── {project-id}.json         # Full ProjectData (workspaces embedded)

{projectsFolder}/
  └── {project-id}/
       ├── {project-id}-STABLE.code-workspace    # VS Code workspace file
       ├── {project-id}-DEV.code-workspace       # (per workspace)
       └── STABLE/
            ├── {repo-slug}/                      # Git clone
            └── ...
       └── DEV/
            ├── {repo-slug}/                      # Git clone
            └── ...
```

---

## 12. Workspace Health Check

```
User → GET /api/projects/:id/workspaces/:wid/health
  └→ projectManager.getById(projectId)          # 404 if project unknown
  └→ workspaceManager.getById(projectId, wid)   # 404 if workspace unknown
  └→ fs.existsSync(workspaceFolder)?
       ├→ false (uninitialized): sendJson 200 { healthy: true, issues: [] }
       └→ true (initialized):
            checkWorkspaceHealth(projectId, workspaceId, projectsFolder, repositoryIds,
                                 errorLogManager)
              └→ Check 1: fs.existsSync(getWorkspaceFilePath(...))
                   └→ absent → issue { type: 'workspace-file-missing', severity: 'warning',
                                        fixAction: 'regenerate-workspace-file' }
              └→ Check 2: for each repoId in repositoryIds:
                   fs.existsSync(path.join(projectsFolder, projectId, wid, repoId, '.git'))
                   └→ absent → issue { type: 'repository-not-cloned', severity: 'warning',
                                        fixAction: 'setup-workspace', repositoryId }
              └→ Check 3 (when errorLogManager provided):
                   errorLogManager.list({ source: 'credentials' })
                   └→ Filter to entries scoped to this workspace (matching ProjectId + WorkspaceId)
                   └→ De-duplicate by RepositoryId, keeping only the most recent entry per repo
                        (list() returns entries newest-first)
                   └→ For each most-recent entry:
                        ├→ Severity: 'error'  → issue { type: 'credential-missing',
                        │                               severity: 'warning',
                        │                               fixAction: 'configure-credential',
                        │                               repositoryId }
                        └→ Severity: 'info'   → suppress (stale badge resolved — see §14)
              └→ Return WorkspaceHealthReport { healthy: issues.length === 0, issues }
            sendJson 200 WorkspaceHealthReport
```

**GUI integration:**
- `project-detail.js`: health fetched in parallel with status for all initialized workspaces via `Promise.allSettled`. Failing fetches degrade gracefully (health cell left empty).
- `workspace-detail.js`: health report fetched on initial load and every poll cycle. Unhealthy workspaces render a `.health-alert` card with per-issue rows and fix action buttons. A `credential-missing` issue renders a **"Configure"** button (`fixAction: 'configure-credential'`) that navigates to `#/repositories` (the repositories list — the affected repository ID is not preserved in the navigation).

---

## 13. Regenerate Workspace File

```
User → POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file
  └→ projectManager.getById(projectId)          # 404 if project unknown
  └→ workspaceManager.getById(projectId, wid)   # 404 if workspace unknown
  └→ fs.existsSync(workspaceFolder)?
       └→ absent → sendError 400 "Workspace folder does not exist. Run setup first."
  └→ Build repoPaths: project.Repositories.map(repoId → { slug: repoId, path: ... })
  └→ getWorkspaceFilePath(projectsFolder, projectId, workspaceId) → wsFilePath
  └→ generateWorkspaceFile(workspaceId, repoPaths, wsFilePath)   # writes .code-workspace
  └→ sendJson 200 { success: true }
```

**No git operations are performed.** This endpoint only writes the `.code-workspace` JSON file. All repository clones remain untouched. Use `POST .../setup` to clone missing repositories.

---

## 14. Credential Success Log Entry and Stale Badge Suppression

When a workspace setup or repository addition completes a **credential-based clone** (i.e. a credential was resolved and injected), both `WorkspaceOrchestrator.createWorkspace()` and `RepositoryOrchestrator.addRepositoryToProject()` write a success entry to the error log. The `Operation` value differs by call site:

```
Successful credential-based clone — WorkspaceOrchestrator:
  └→ errorLogManager.append({
         Severity: 'info',
         Source:   'credentials',
         Operation: 'workspace-setup',
         Context:  { ProjectId, WorkspaceId, RepositoryId },
         Message:  'Credential used successfully for clone.',
     })

Successful credential-based clone — RepositoryOrchestrator:
  └→ errorLogManager.append({
         Severity: 'info',
         Source:   'credentials',
         Operation: 'add-repository',
         Context:  { ProjectId, WorkspaceId, RepositoryId },
         Message:  'Credential used successfully for clone.',
     })
```

This entry serves as a **badge-suppression signal** for `checkWorkspaceHealth()` (§12, Check 3). The flow from clone to badge resolution is:

```
1. User assigns credential → PUT /api/repositories/:id/credential
2. User runs setup        → POST /api/projects/:id/workspaces/:wid/setup
3. Clone succeeds with credential
     └→ Orchestrator writes Source: 'credentials', Severity: 'info' entry
4. GET /api/projects/:id/workspaces/:wid/health
     └→ checkWorkspaceHealth checks most-recent Source: 'credentials' entry per repo
          ├→ Severity: 'info'  → suppress credential-missing badge (badge cleared)
          └→ Severity: 'error' → surface credential-missing badge (badge shown)
```

**SSH clones are excluded:** when `resolveCredential()` returns `null` (e.g. SSH URL, no matching credential), no credentials log entry is written for that repository. The badge-suppression mechanism only applies to repositories that have undergone at least one credential-based clone attempt.

```
###  Path: `/docs/agents/project-manifest/gui-frontend.md`

```md
# GUI Frontend

The frontend is a vanilla JavaScript SPA with no build step, served as static files by the built-in HTTP server from `gui/public/`.

## Architecture

- **Routing:** Hash-based client-side router (`#/path`) with named parameter extraction (`:id`, `:wid`).
- **Module system:** Native ES modules loaded by the browser. No bundler.
- **State management:** None — every view fetches fresh data from the REST API on render. Most mutations trigger a full view re-render; however, some views perform targeted in-place DOM updates without a full re-render (e.g. `workspace-detail.js` inserts the "Open in VS Code" button and updates the status/health DOM in place on each poll cycle).
- **Styling:** Pico CSS (classless variant) as base layer, with a custom `styles.css` override layer using CSS custom properties. Light/dark theme switching via `data-theme` attribute on `<html>`.

## Router

The `Router` class (`gui/public/js/router.js`) manages view lifecycle:

1. Listens for `hashchange` events.
2. Matches the hash against registered patterns.
3. Calls the previous view's cleanup function (if returned).
4. Clears the `#app` container.
5. Calls the matched view function with `(container, params)`.
6. Stores any cleanup function returned by the view.

## Routes

| Hash Pattern | View | Description |
|---|---|---|
| `#/` | `dashboard.js` | Project listing with a filter/sort toolbar and a "Create Project" form. The toolbar (`.project-filter-toolbar`) sits between the page header and the project list and contains three labelled controls — each has a visible `<label class="filter-label">` with a `for`/`id` binding: a debounced search input (`id="project-filter-search"`, `type="search"`, ~250 ms), a repository filter `<select id="project-filter-repo">` populated from `api.repositories.list()` (always rendered; disabled with a "No repositories" placeholder when no repos exist or when the fetch fails — a toast is shown on failure), and a sort `<select id="project-filter-sort">` with `alpha` (Alphabetical, default) and `activity` (Last Activity) options. All three controls fire an `onFilterChange(FilterState)` callback on change. The current filter state (`{ search, repoId, sort }`) is maintained in `renderDashboard` and flows into `buildFilterToolbar`, `applyFiltersAndSort`, and `renderProjectGrid`. `applyFiltersAndSort(filterState, allProjects)` is a pure exported function — it receives the project list as an explicit parameter (no closure over module state) and can be unit-tested without DOM involvement. Filter changes re-apply the current state to the in-memory `_allProjects` cache without re-fetching; creating a new project re-fetches all project data from the API and re-applies the current filter/sort state. An empty-state message — "No projects match the current filters." vs "No projects yet." — distinguishes filtered-empty from truly-empty lists. |
| `#/repositories` | `repositories.js` | Repository CRUD table. Each row's **Name** column renders as a clickable `<a class="repo-name-display repo-name-link">` element linking to `#/repositories/${encodeURIComponent(repo.id)}`. Both create and edit use a single shared modal component, `showRepositoryModal({ mode, repo })` (`components/repository-modal.js`): a "+ Add Repository" button opens it in create mode (URL required, Name/ID optional, ID auto-inferred from the URL when left blank), and each row's Edit button opens it in edit mode, pre-filled with the row's URL/Name/ID/Credential — URL and Name are editable in edit mode, but the ID field is disabled (repository IDs cannot be renamed post-creation). The Credential field is present in both modes (previously only settable from the Repository Detail page), populated via `api.repositories.credentialOptionsForUrl(url)` and re-fetched on URL edits. A **Credential** column shows a CSS-styled badge built by `buildCredentialBadge()` from `utils/dom.js`: `.credential-badge.credential-badge--set` (green checkmark, `aria-label="Credential configured"`) when a credential is associated, or `.credential-badge.credential-badge--none` (muted dash, `aria-label="No credential configured"`) when none is set. |
| `#/repositories/:id` | `repository-detail.js` | Repository overview: a **Credential** section followed by a table of every workspace across every project that contains the given repository. The Credential section (built by `buildCredentialSection(repoId, storedCredentialId)`) fetches `GET /api/repositories/:id/credential-options` asynchronously and renders a `<select>` dropdown with a "None" option plus each matching credential as `label (host)`. The sole option matching with `auto=true` (when exactly one exists) is labeled with a "(recommended match)" suffix but is never pre-selected on its own — only a stored `credentialId` pre-selects an option, so a repository with no stored credential keeps showing "None", matching the repositories list's "No credential configured" badge. Changes call `PUT /api/repositories/:id/credential` to persist the selection. The workspace table rows show Project (link to `#/projects/:pid`), Workspace (link to `#/projects/:pid/workspaces/:wid`), and the shared Branch/Status/Actions cells from `buildRepoStatusCells`. STABLE workspace rows show plain-text branch names; all other rows have a clickable branch-switch trigger. A "Refresh" button re-discovers the full project/workspace set (calls `api.projects.list()` + the full fan-out) and diffs against the existing rows: new rows are appended, removed rows are dropped, and existing rows are updated in-place via `api.status.refresh()` — protected by a `refreshInProgress` mutex. A 404 response for the repository renders a "not found" message with a link back to `#/repositories`. An empty-state message is shown when no projects contain the repository. Individual project/workspace fetch failures are handled gracefully via `Promise.allSettled` — partial results are displayed and a warning toast is shown when any fetch failed. The webserver URL is fetched once during initial load; the "Browse" button is shown only when `webserverUrl` is configured. `buildRepoStatusCells` is called with an `onError` callback (`(msg) => showToast(msg, 'error')`) so Git GUI button failures are surfaced as toasts without a dynamic `import('./toast.js')` inside the component. |
| `#/projects/:id` | `project-detail.js` | Project metadata, tabbed repo/workspace/danger-zone management. The workspace table includes a **Health** column: initialized workspaces with health issues show a warning badge with issue count; healthy and uninitialized workspaces show an empty cell. Health is fetched in parallel with status for all initialized workspaces via `Promise.allSettled` (graceful degradation — fetch failures leave the health cell empty). The project's repository table (`buildRepositoriesSection`) includes a **Credential** column built by `buildCredentialBadge()` from `utils/dom.js`: `.credential-badge.credential-badge--set` when a credential is associated, `.credential-badge.credential-badge--none` when none is set. |
| `#/projects/:id/workspaces/:wid` | `workspace-detail.js` | Live git status with countdown-based polling and manual refresh. Health report fetched in parallel on initial load and on every poll/refresh cycle. Unhealthy workspaces render a `.health-alert` card with per-issue rows and fix buttons (`Regenerate File` for `regenerate-workspace-file` issues, `Fix Setup` for `setup-workspace` issues, `Configure` for `configure-credential` issues — navigates to `#/repositories`, losing the affected repository context; the user must locate the repository manually to assign a credential). The header management row includes an **"Open in VS Code"** button followed by an **"Open in Terminal"** button (both shown only when `workspace.initialized` is `true`; both dynamically inserted after a successful Setup without a full re-render — "Open in Terminal" is inserted immediately after "Open in VS Code"). The repository status table has a 4th **"Actions"** column; each repository row contains a **"Browse"** button (shown only when `webserverUrl` is configured, opens `{webserverUrl}/{projectId}/{workspaceId}/{repoId}/` in a new tab via `window.open`) followed by a **"Git GUI"** button that calls `api.workspaces.launch.githubDesktop()`. The webserver URL is fetched once during the initial data load (in parallel with other requests) via `api.config.webserverUrl.get()`. In non-STABLE workspaces, each **Branch** cell is a clickable trigger (`<button class="branch-switch-trigger">`) that opens an inline quick-switch popover via `showBranchQuickSwitch()`. STABLE workspace branch cells remain plain text. `buildRepoStatusCells` is called with an `onError` callback so Git GUI button failures show as toasts. DOM clearing uses `clearElement()` from `utils/dom.js` throughout (no `innerHTML = ''` assignments). A **Notes** section (built by `buildNotesSection()`) is appended below the repository status table: it contains a `<textarea id="workspace-notes-textarea">` pre-populated from `workspace.notes`, a 1000 ms debounced `input` listener that calls `api.workspaces.update()`, and an `aria-live="polite"` status span that shows "Saving…" / "Saved" / "Save failed." feedback. **Credential-error badge:** when a clone fails because no credential is configured, the view replaces the generic "No data" badge with an amber `<a class="status-badge status-badge-credential">` (built by the internal `buildMissingCredentialBadge(repoId)`) that links to `#/repositories/:id`. This badge is distinct from the `buildCredentialBadge()` span in `utils/dom.js` (`.credential-badge--set` / `.credential-badge--none`), which shows *assignment status* in the repository and project-detail lists — not a clone-failure indicator. |
| `#/projects/:id/workspaces/:wid/branch-switch` | `branch-switch.js` | 3-step branch switch wizard. |
| `#/settings` | `settings.js` | Settings view with four sections: **Git Credentials** (add, inline-edit, and delete named per-host PATs; each credential has a Label, Host, and Token; the credentials table renders columns Label / Host / Token / Actions; clicking Edit enables inline editing of Label and Token — Host is read-only; clicking Save calls `PUT /api/config/credentials` with the credential id; clicking Delete calls `DELETE /api/config/credentials/:id` with a confirmation dialog that warns about affected repositories), **Repositories Refresh Delay** (configurable `gitPollingIntervalSeconds`), **Webserver URL** (base URL of the local webserver; enables the "Browse" button in the workspace-detail view), and **Notes Display** (card height in px and column count for the notes grid, backed by `GET/PUT /api/config/notes-display`). All non-credentials sections share a single **"Save Settings"** footer button that calls each section's `save()` function in parallel via `Promise.all()`. The Notes Display section is built by `buildNotesDisplaySection()`, which uses CSS classes `notes-display-section` (section wrapper), `notes-display-input-row` (flex row for label + input + unit), `notes-display-label` (label element), `notes-display-input` (number input), and `notes-display-unit` (unit span, e.g. "px"). |
| `#/error-log` | `error-log.js` | Paginated, filterable error log table with expandable detail rows and "Clear All" action. Severity filter options: **All Severities** / **Error** / **Warning** / **Audit** / **Info**. Each option corresponds to a `.severity-{value}` CSS badge class applied to the severity column. |
| `#/notes` | `notes-collected.js` | Two-panel notes view: a left sidebar listing all workspaces grouped by collapsible project groups (workspaces with notes carry a `.has-notes` class and a blue dot indicator), and a right scrollable main panel of editable note cards. On initial load only workspaces with non-empty notes show cards. Clicking a sidebar item for a workspace with a card scrolls the main panel to it; clicking one without a card creates a new empty card and focuses the textarea. Each card header contains a clickable workspace ID link to `#/projects/:pid/workspaces/:wid`. Textareas auto-save after 1000 ms of inactivity via `api.workspaces.update()`; saving empty text removes the card and clears the sidebar indicator. A `.notes-empty-state` message is shown when no cards are present. |

> **Maintainer note — Settings sections:** `settings.js` has a module-level JSDoc block (at the top of the file) that lists all active settings sections. When adding or removing a `build*Section()` factory from `settings.js`, update that JSDoc list to keep it in sync with the route description in this table.

## API Client

`api.js` exports a namespaced `api` object with the following top-level groups:

- `api.repositories` — `list()`, `get(id)`, `create(data)`, `update(id, data)`, `delete(id)`, `touchRefreshTimestamp(id)`, `credentialOptions(id)`, `credentialOptionsForUrl(url)`, `updateCredential(id, credentialId)`
- `api.projects` — `list()`, `get(id)`, `create(data)`, `update(id, data)`, `rename(id, newId)`, `delete(id)`, `addRepository(pid, rid)`, `removeRepository(pid, rid)`
- `api.workspaces` — `list(pid)`, `get(pid, wid)`, `create(pid, data)`, `update(pid, wid, data)`, `rename(pid, wid, newId)`, `delete(pid, wid)`, `setup(pid, wid)`, `health(pid, wid)`, `regenerateFile(pid, wid)`, `launch.vscode(pid, wid)`, `launch.githubDesktop(pid, wid, rid)`, `launch.terminal(pid, wid)`
- `api.branches` — `list(pid, wid)`, `switch(pid, wid, assignments)`
- `api.status` — `get(pid, wid)`, `refresh(pid, wid)`
- `api.config.credentials` — `list()`, `add(data)`, `update(id, data)`, `remove(id)`
- `api.config.polling` — `get()`, `set(seconds)`
- `api.config.webserverUrl` — `get()`, `set(url)`
- `api.config.notesDisplay` — `get()`, `set(data)`
- `api.errorLog` — `list(params?)`, `get(id)`, `clear()`, `sources()`, `count()`
- `api.notes` — `list()`
- `api.version` — `get()`

### `api.repositories` — Credential Methods

| Method | HTTP | Description |
|---|---|---|
| `credentialOptions(id)` | `GET /api/repositories/:id/credential-options` | Fetch credentials compatible with the repository's URL hostname. Returns an array of `{ credentialId, label, host, auto }` objects. An empty array is returned when no credentials match or the URL is non-HTTPS (e.g. SSH). |
| `credentialOptionsForUrl(url)` | `GET /api/repositories/credential-options?url=` | Fetch credentials compatible with an arbitrary (not-yet-registered or in-edit) URL's hostname, without requiring an existing repository. Transforms the server's `{ credentials, autoSelected }` response into the same flat `{ credentialId, label, host, auto }[]` array as `credentialOptions(id)`. Used by the create/edit repository modal. |
| `updateCredential(id, credentialId)` | `PUT /api/repositories/:id/credential` | Associate a credential with the repository, or clear the association. Pass `''` (empty string) to clear — the client normalizes it to `null` before sending, which is what the server expects. Returns the updated repository object. |

**`updateCredential` caller contract:** `credentialId` must always be a `string`. Passing `undefined` causes `JSON.stringify` to silently strip the key from the request body, producing an empty `{}` payload instead of `{ credentialId: null }`. Always pass `''` when the intent is to clear the association — the client converts it to `null` internally.

**`credentialOptions` auto-match semantics:** Each returned option includes an `auto` boolean, `true` only on the sole entry when exactly one credential matches the host. The GUI never pre-selects on `auto` alone — it only labels that option with a `(recommended match)` suffix (same wording in both the create/edit modal and the repository detail page's Credential section). Only a stored `CredentialId`/`credentialId` pre-selects an option; a repository with none stored always shows "None" selected, regardless of how many (if any) options are auto-matched.

---

### `api.workspaces` — Health & File Methods

| Method | HTTP | Description |
|---|---|---|
| `health(pid, wid)` | `GET /api/projects/:id/workspaces/:wid/health` | Fetch the health report for an initialized workspace. Returns `{ healthy: boolean, issues: Array<{ type: string, severity: string, message: string, fixAction: string, repositoryId?: string }> }`. |
| `regenerateFile(pid, wid)` | `POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file` | Regenerate the `.code-workspace` file from the current repository list without cloning. Returns `{ success: boolean }`. |

**`health()` issue `fixAction` values:**
- `regenerate-workspace-file` — missing or stale `.code-workspace` file; surface a `Regenerate File` button.
- `setup-workspace` — uncloned repository; surface a `Fix Setup` button.

### `api.workspaces.launch` — External-App Launch Methods

External-application launchers are grouped under the `api.workspaces.launch` sub-namespace. New launcher methods should be added here rather than as flat methods on `api.workspaces`.

| Method | HTTP | Description |
|---|---|---|
| `launch.vscode(pid, wid)` | `POST /api/projects/:id/workspaces/:wid/launch/vscode` | Open the workspace's `.code-workspace` file in VS Code. No request body. Returns `{ success: boolean }`. 400 if the workspace file does not exist on disk (run setup first). 500 on OS-level spawn failure (logged under Source: `'app-launcher'`, Operation: `'launch-vscode'`). |
| `launch.githubDesktop(pid, wid, rid)` | `POST /api/projects/:id/workspaces/:wid/launch/github-desktop/:rid` | Open a repository's local clone directory in GitHub Desktop. No request body. Returns `{ success: boolean }`. 400 if the repository directory does not exist on disk (run setup first). 500 on OS-level spawn failure (logged under Source: `'app-launcher'`, Operation: `'launch-github-desktop'`). |
| `launch.terminal(pid, wid)` | `POST /api/projects/:id/workspaces/:wid/launch/terminal` | Open the workspace's root folder in a native terminal window. No request body. Returns `{ success: boolean }`. 400 if the workspace's on-disk root folder does not exist (run setup first). 500 on OS-level spawn failure (logged under Source: `'app-launcher'`, Operation: `'launch-terminal'`). |

**Caller contract:** All path parameters (`pid`, `wid`, `rid`) are passed through `encodeURIComponent` inside `api.js`. Callers are responsible for validating that these values are not `undefined`/`null` before invoking these methods — `encodeURIComponent` will coerce them to the strings `'undefined'`/`'null'` rather than throwing.

### `api.errorLog` Reference

| Method | HTTP | Description |
|---|---|---|
| `list(params?)` | `GET /api/error-log[?...]` | Fetch error log entries with optional filtering and pagination. |
| `get(id)` | `GET /api/error-log/:id` | Fetch a single entry by numeric ID. |
| `clear()` | `DELETE /api/error-log` | Delete all entries. Resolves with `undefined` on HTTP 204. |
| `count()` | `GET /api/error-log?limit=0` | Fetch only the total count (no entries payload). Useful for badges. |

**`list()` params shape:**

```js
api.errorLog.list({
    severity: 'error',   // optional — 'error' | 'warning' | 'audit' | 'info'
    source:   'clone',   // optional — exact-match on Source field
    limit:    10,        // optional — max entries to return (default 100 server-side)
    offset:   0,         // optional — zero-based page offset
})
```

All params are optional. Omitting `params` entirely (or passing `undefined`) sends a bare `GET /api/error-log`.

**`clear()` 204 contract:** The underlying `request()` helper resolves with `undefined` when the server returns HTTP 204 (no body). Callers should not try to read a response value from `clear()`.

**`count()` pattern:** Sends `GET /api/error-log?limit=0`. The server returns `{ entries: [], total: N }`. Read `response.total` for the count. This is the recommended approach for polling a badge counter without transferring entry data.

### `api.config.polling` Reference

| Method | HTTP | Description |
|---|---|---|
| `get()` | `GET /api/config/polling` | Fetch the current polling interval. Resolves with `{ gitPollingIntervalSeconds: number }`. |
| `set(seconds)` | `PUT /api/config/polling` | Update the polling interval. `seconds` must be a finite integer ≥ 10. Resolves with `{ gitPollingIntervalSeconds: number }`. |

**Used by:** `settings.js` (`buildRefreshDelaySection()`) to populate the number input on mount and to persist the updated value on save.

## Reusable Components

| Component | File | Export | Purpose |
|---|---|---|---|
| Branch Quick Switch | `components/branch-quick-switch.js` | `showBranchQuickSwitch(options): Promise<{ switched: boolean, newBranch?: string }>` | Inline popover anchored below a branch cell. Fetches available branches via `api.branches.list()`, shows a filterable list with a text input, and calls `api.branches.switch()` on confirm. `options`: `{ anchorEl, projectId, wid, repoId, currentBranch }`. Dynamically imported on first click via `import()` to avoid loading for STABLE workspaces. |
| Confirm Dialog | `components/confirm-dialog.js` | `showConfirm(title, message): Promise<void>` | Modal with Cancel/Confirm. Resolves on confirm, rejects on cancel. Built on the shared `modal-shell.js` primitive (overlay/modal/ARIA DOM, Escape/backdrop-cancel, focus trap, focus restoration); `showConfirm()` supplies its own body/actions content and passes `confirmBtn` as the initial-focus target. |
| Form Helpers | `components/form-helpers.js` | `createFormField()`, `validateRequired()`, `WORKSPACE_ID_PATTERN` | Form field generation and validation. |
| Modal Shell | `components/modal-shell.js` | `createModalShell(options): { overlay, modal, mount(initialFocusEl?), close(), setBusy(busy) }` | Shared overlay/modal DOM construction, Escape/backdrop-cancel wiring, Tab/Shift+Tab focus trap, focus restoration, and busy-gating primitive. `options`: `{ titleText, ariaLabelledbyId, ariaDescribedbyId?, className?, onCancel }`. Callers append their own body/actions content to `modal`, then call `mount()`/`close()`. Used by `confirm-dialog.js` and `repository-modal.js`. |
| Repo Status Cells | `components/repo-status-cells.js` | `buildRepoStatusCells(opts)`, `makeBranchTrigger(branchName, ariaLabel)`, `updateRepoStatusCells(row, repoId, statusInfo, isStable, onBranchCellClick)` | Shared factory for the Branch, Status badge, and Actions `<td>` cells used across repository rows. See [Repo Status Cells Component](#repo-status-cells-component) below. |
| Repository Modal | `components/repository-modal.js` | `showRepositoryModal({ mode, repo }): Promise<Repository>` | Create/edit modal for a repository (URL, Name, ID, Credential). Built on `modal-shell.js` with `className: 'modal--form'`. See [Repository Modal Component](#repository-modal-component) below. |
| Status Badge | `components/status-badge.js` | `createStatusBadge(gitStatusInfo): HTMLElement` | Git status badge with branch pill and detail chips. |
| Theme Toggle | `components/theme-toggle.js` | `createThemeToggle(): HTMLButtonElement` | Light/dark mode toggle button. Reads/persists theme in `localStorage`. |
| Toast | `components/toast.js` | `showToast(message, type, duration): HTMLElement\|null` | Auto-dismissing notification in `#toast-container`. Message is rendered via `textContent` (not `innerHTML`) — server-controlled strings including git error output are XSS-safe to pass directly. |

### Repo Status Cells Component

`components/repo-status-cells.js` encapsulates the reusable Branch, Status badge, and Actions cell-building logic shared between the workspace-detail and repository-detail views. It exports three named functions:

#### `buildRepoStatusCells(opts)`

Builds the three shared status `<td>` cells for a single repository row.

| Option | Type | Required | Description |
|---|---|---|---|
| `repoId` | `string` | Yes | Unique repository identifier. |
| `repoName` | `string` | Yes | Human-readable display name; used in aria-labels. Falls back to `repoId` when no richer name is available. |
| `statusInfo` | `Object\|null` | Yes | `GitStatusInfo` from the API, or `null` when no status data is available yet. |
| `projectId` | `string` | Yes | ID of the parent project. |
| `wid` | `string` | Yes | ID of the parent workspace. |
| `isStable` | `boolean` | No | When `true`, the branch cell renders as plain text (no clickable trigger). |
| `onBranchCellClick` | `function` | No | Callback `(anchorEl, repoId, currentBranch)` wired to the branch trigger button. Only active when `isStable` is falsy. |
| `webserverUrl` | `string\|null` | No | Base URL of the local webserver. When truthy, a "Browse" button is inserted before the "Git GUI" button inside `actionsCell`. |
| `onError` | `function` | No | Callback `(message: string) => void` invoked when the "Git GUI" button's click handler fails. When omitted the error is silently swallowed. Consumer views should pass `(msg) => showToast(msg, 'error')`. |

**Returns:** `{ branchCell: HTMLTableCellElement, badgeCell: HTMLTableCellElement, actionsCell: HTMLTableCellElement }`

- `branchCell` carries class `repo-branch-cell`.
- `badgeCell` carries class `repo-badge-cell`; its inner `<div data-repo-id>` wrapper is the polling target.
- `actionsCell` carries class `repo-actions-cell`; contains a "Git GUI" button (always present) and an optional "Browse" button.

#### `makeBranchTrigger(branchName, ariaLabel)`

Builds a `<button class="branch-switch-trigger">` styled as inline text. Extracted to avoid duplicating setup in both `buildRepoStatusCells` (initial render) and `updateRepoStatusCells` (polling updates). The click handler is wired by the caller.

**Returns:** `HTMLButtonElement`

#### `updateRepoStatusCells(row, repoId, statusInfo, isStable, onBranchCellClick)`

Updates an existing repository row's Branch and badge cells in-place.

| Param | Type | Description |
|---|---|---|
| `row` | `HTMLTableRowElement` | The `<tr>` to update. |
| `repoId` | `string` | Repository identifier (used to find the `div[data-repo-id]` badge wrapper). |
| `statusInfo` | `Object\|null` | New `GitStatusInfo` from the API, or `null`. |
| `isStable` | `boolean` | When `true`, the branch cell is rebuilt as plain text. |
| `onBranchCellClick` | `function` | Wired to the branch trigger button in non-STABLE workspaces. |

Cells are located by CSS class (`.repo-branch-cell`) and badge wrapper attribute (`div[data-repo-id]`) — **not** by hardcoded cell indices — so callers can prepend additional cells without breaking this function.

> **aria-label fallback:** The branch trigger button aria-label is constructed as `"Switch branch for <name>"` where `<name>` is `row.dataset.repoName` when present on the `<tr>`, falling back to `repoId` when the attribute is absent or empty.

> **Error handling:** The "Git GUI" button calls `opts.onError(message)` when provided, or silently swallows the error when `onError` is absent. The button is disabled during the async call and re-enabled in the `finally` block regardless of outcome. The previous dynamic `import('./toast.js')` inside the click handler has been removed; callers inject the error handler via the `onError` option.

### Repository Modal Component

`components/repository-modal.js` exports `showRepositoryModal({ mode, repo })`, a single component serving both the "Add Repository" and "Edit Repository" flows — the two modes share all four fields (URL, Name, ID, Credential), differing only in pre-fill and which fields are disabled.

| Param | Type | Description |
|---|---|---|
| `mode` | `'create'\|'edit'` | Which flow to render. |
| `repo` | `{ id, name, url, credentialId? }` | Required (and only used) when `mode === 'edit'`. Supplies the pre-fill values and the baseline `credentialId` used for the unchanged-selection comparison at submit. |

**Returns:** `Promise<Repository>` — resolves with the normalised, saved repository; rejects with `Error('User cancelled')` on Cancel/Escape/backdrop-click.

**Fields:**
- **URL** — required in both modes, always editable.
- **Name** — optional in both modes, always editable.
- **ID** — editable in create mode; disabled (via `.disabled = true`, since `createFormField()` has no `disabled` option) and excluded from the edit-mode payload.
- **Credential** — a `<select>` scaffolded with a "None" option, repopulated after every `credentialOptionsForUrl()` fetch, plus a hint `<span>` below it (hidden unless there is something to explain).

**Credential selection priority:** after each fetch, the select's value is chosen by `computeSelectedCredentialId(options, storedCredentialId)`: (1) the stored credential ID when still present among the fetched options, (2) `''` (None) otherwise. The sole option flagged `auto: true` (when exactly one exists) is never auto-selected — its label is decorated with a `(recommended match)` suffix instead, so a repository with no stored `CredentialId` always shows "None" selected, consistent with the repositories list's "No credential configured" badge. `storedCredentialId` is `repo.credentialId ?? ''` in edit mode and `''` in create mode, fixed for the lifetime of the modal instance.

**Empty-state hint:** when the fetched `options` array is empty, the hint `<span>` explains why: "Credentials can only be matched to HTTPS URLs…" when the URL's scheme isn't `https:` (mirroring the server's `extractHost()` HTTPS-only check), or "No saved credential is configured for this URL's host." otherwise. The hint is cleared when the URL is blank or `options` is non-empty.

**Fetch timing:** edit mode fetches `credentialOptionsForUrl(repo.url)` once on mount; create mode skips the initial fetch (no repository exists yet to match credentials against). In both modes, an `input` listener on the URL field debounces (~400ms) a re-fetch and rebuild of the select whenever the URL changes.

**Submit sequencing:** `validateRequired(form, ['url'])` guards the call; a single `resolvedRepo` variable is reassigned as each call succeeds. Create mode: `api.repositories.create()` → `normaliseRepo()`, then `api.repositories.updateCredential()` when a credential is selected. Edit mode: `api.repositories.update(repo.id, { name, url })` → `normaliseRepo()`, then `updateCredential()` only when the selection differs from `storedCredentialId`. A rejected `updateCredential()` call is caught independently — it shows an error toast but still resolves the Promise with the pre-credential-update `resolvedRepo`, since the primary save already succeeded. A rejected primary `create()`/`update()` call re-enables Submit/Cancel/Escape/backdrop-click, shows an error toast, and keeps the modal open without resolving/rejecting.

**Busy-gating:** while any of the three API calls is in flight, `shell.setBusy(true)` disables Escape/backdrop-cancel and the component separately disables the Submit/Cancel buttons (the shell has no knowledge of caller-specific buttons — see the Modal Shell entry above).

---

## Utilities

| Utility | File | Export | Purpose |
|---|---|---|---|
| Normalise | `utils/normalise.js` | `normaliseRepo()`, `normaliseProject()`, `normaliseWorkspace()`, `normaliseNotesResponse()` | Maps PascalCase backend keys to camelCase frontend keys. `normaliseWorkspace` includes `folderPath` (from `FolderPath`) and `notes` (from `Notes ?? notes ?? ''`). `normaliseNotesResponse()` transforms the `GET /api/notes` PascalCase response into a camelCase `{ projects: [...] }` structure. |
| Constants | `utils/constants.js` | `STABLE_WS_ID`, `APP_NAME_SHORT`, `CREDENTIAL_MISSING_SENTINEL` | Shared GUI constants. `STABLE_WS_ID = 'STABLE'` is the canonical definition; `APP_NAME_SHORT = 'Paralizer'` is the short app name used in browser tab titles; `CREDENTIAL_MISSING_SENTINEL = 'requires a credential for host'` is the sentinel substring matched against orchestrator clone-error messages to detect missing-credential failures (imported by `workspace-detail.js`). Import from here instead of hardcoding the strings in views. |
| DOM | `utils/dom.js` | `clearElement(el)`, `buildCredentialBadge(credentialId)` | DOM utilities. `clearElement` removes all children from an element via `removeChild` loop (preferred over `innerHTML = ''`). `buildCredentialBadge(credentialId)` builds a CSS-styled `<span>` with `.credential-badge` and either `.credential-badge--set` (green checkmark, credential present) or `.credential-badge--none` (muted dash, no credential); always includes an `aria-label` for accessibility. Used by `repositories.js` and `project-detail.js` to eliminate duplicated badge construction code. |

## Theme Switching

The GUI supports manual light/dark mode switching:

- **Mechanism:** The `data-theme` attribute on `<html>` controls the active theme (`"light"` or `"dark"`). Pico CSS v2 reads this attribute for its base styling. The custom `styles.css` remaps all `--color-*` custom properties in a `:root[data-theme="dark"]` block.
- **Toggle:** A `createThemeToggle()` button in the top nav bar (`#theme-toggle-container`) switches between modes on click.
- **Persistence:** The selected theme is stored in `localStorage` under the key `"theme"` and restored on page load.
- **Default:** `"light"` when no stored preference exists.

## Key Patterns

### Router Injection (Avoiding Circular Dependencies)

Views that need `router.navigate()` export a `setRouter(router)` function. `app.js` calls `setRouter()` before `router.start()`. Views never import `router.js` directly.

Views using router injection: `dashboard.js`, `project-detail.js`, `workspace-detail.js`, `branch-switch.js`, `repository-detail.js`.

### Cleanup Contract

Views with side-effects (e.g. `setInterval` polling) return a synchronous cleanup function from their entry point. The router calls it before rendering the next view. The cleanup must be returned **before** any async operations, so the router can register it immediately.

Views returning cleanup: `workspace-detail.js` (clears 1-second countdown interval).

### Page Title Convention

Every view sets `document.title` using `APP_NAME_SHORT` from `utils/constants.js`. The router's `_render()` method resets the title to `APP_NAME_SHORT` before calling each view, preventing stale titles from carrying over during async data loads.

- **Static views** (dashboard, repositories, settings, error-log, branch-switch): Set `document.title` synchronously at the top of the render function using the pattern `'{Section Name} - ' + APP_NAME_SHORT`.
- **Entity-detail views** (project-detail, repository-detail, workspace-detail): Set `document.title` inside the `.then()` callback after the data fetch resolves, once the entity name is available.

| View | Title format |
|---|---|
| Dashboard | `Dashboard - Paralizer` |
| Repositories | `Repositories - Paralizer` |
| Repository Detail | `{repo.name} - Paralizer` |
| Project Detail | `{project.name} - Paralizer` |
| Workspace Detail | `{project.name} {wid} - Paralizer` |
| Branch Switch | `Branch Switch - Paralizer` |
| Settings | `Settings - Paralizer` |
| Error Log | `Error Log - Paralizer` |

### Workspace Detail View (`workspace-detail.js`)

The workspace detail view (`#/projects/:id/workspaces/:wid`) renders live git status for all repositories in a workspace.

**Key behaviours:**

- **Initial load:** Calls `api.status.refresh()` (force-refresh via live git-fetch) instead of `api.status.get()` (cached), ensuring fresh data even when the polling cache is empty.
- **Refresh toolbar:** A `.workspace-refresh-toolbar` row between the header and the status table displays a countdown label ("Next refresh in Xs") and a "Refresh Now" button. The countdown ticks every second; when it reaches 0, an automatic poll is triggered via `api.status.get()`. The "Refresh Now" button triggers a force-refresh via `api.status.refresh()` and resets the countdown.
- **Countdown-based polling:** Replaces the previous `setInterval(fn, 10000)` approach. A 1-second `setInterval` decrements a counter. At zero it triggers `doPoll()` (cached). A `refreshInProgress` flag prevents race conditions between manual and automatic refreshes.
- **Reactive missing-repos row:** After each poll or manual refresh, the "X repositories have no data" message is re-evaluated. When all repos have status data, the row is removed. When the count changes, the text updates.
- **Setup button in-place update:** After a successful workspace setup, the DOM is mutated in-place: the setup button is removed from `mgmtRow`, an "Open in VS Code" button (`buildOpenVscodeButton`) followed by an "Open in Terminal" button (`buildOpenTerminalButton`) are each inserted before the Rename button, and `workspace.initialized` is set to `true` in the local variable. Only after these DOM mutations does `onSetupSuccess()` fire, triggering an immediate force-refresh and starting the countdown — no router re-render needed.
- **Retry Setup:** The retry button also triggers `doRefresh()` after a successful re-setup instead of reloading the page.
- **Per-repo quick branch switch:** In non-STABLE workspaces, each branch cell in the status table renders a `<button class="branch-switch-trigger">` (styled as inline text with a dotted underline). Clicking it expands an inline popover via `showBranchQuickSwitch()` (dynamically imported from `components/branch-quick-switch.js`), anchored below the clicked cell. The popover shows a filterable list of local branches and a text input pre-filled with the current branch; confirming calls `api.branches.switch()` with a single-entry assignment and triggers `doRefresh()`. STABLE workspace branch cells are plain text with no click behaviour. Both `buildStatusTableSection()` and the inlined polling-update loop receive `isStable` and `onBranchCellClick` parameters so polling updates preserve the clickable style.
- **Repo status cells:** The Branch, Status badge, and Actions `<td>` cells for each repository row are built and updated via `buildRepoStatusCells()` and `updateRepoStatusCells()` from `components/repo-status-cells.js`. These functions locate cells by CSS class (`.repo-branch-cell`, `div[data-repo-id]`) rather than by hardcoded cell indices, so additional cells can be prepended to a row without breaking polling updates.
- **Cleanup contract:** The returned cleanup function clears the 1-second countdown interval.
- **Notes section:** Appended below the repository status table by `buildNotesSection(initialNotes, onSave)`. See [`buildNotesSection()`](#buildnotessection) below.

#### `buildNotesSection(initialNotes, onSave)`

Builds a `<section class="workspace-notes-section">` containing a labelled textarea and a debounced auto-save mechanism. Internal helper — not exported from `workspace-detail.js`.

| Parameter | Type | Description |
|---|---|---|
| `initialNotes` | `string` | Pre-populated value from `workspace.notes`; written directly to `textarea.value`. |
| `onSave` | `(notes: string) => Promise<void>` | Called with the current textarea value after a 1000 ms debounce. Should persist the notes (typically `api.workspaces.update(projectId, wid, { notes })`). |

**Returns:** `HTMLElement` — the `<section>` element ready to be appended to the view container.

**DOM structure:**

```
<section class="workspace-notes-section">
  <label for="workspace-notes-textarea" class="workspace-notes-label">Notes</label>
  <textarea id="workspace-notes-textarea" class="workspace-notes-textarea">…</textarea>
  <span class="workspace-notes-status" aria-live="polite" hidden>…</span>
</section>
```

**Layout:** `.workspace-notes-section` uses a CSS grid (`grid-template-columns: 1fr auto`): the Notes label (`.workspace-notes-label`) and save-status span (`.workspace-notes-status`) share row 1 — label left, status right-aligned — and the textarea spans both columns in row 2. This ensures the save-status indicator is always adjacent to the label rather than appearing below the textarea.

**Behaviour:**

- A `debounceTimer` (closure-scoped) is cleared and rescheduled on every `input` event; the `onSave` call fires after 1000 ms of inactivity.
- Before `await onSave(...)`: sets `statusEl.textContent = 'Saving…'` and makes the span visible.
- On success: sets `statusEl.textContent = 'Saved'`; hides the span after 3 seconds.
- On error: sets `statusEl.textContent = 'Save failed.'` (span remains visible).
- The `aria-live="polite"` attribute ensures screen readers announce status changes without interrupting current speech.

### Tabbed Navigation (Project Detail)

The project detail view organises content into three tabs: **Repositories**, **Workspaces**, and **Danger Zone**. Tabs are implemented with `.tab-nav` / `.tab-btn` / `.tab-panel` CSS classes and ARIA `role="tablist"` / `role="tab"` / `role="tabpanel"` attributes. Switching is handled by a single delegated click listener on the tab nav container. Only one panel is visible at a time (`.tab-panel.active`).

### Error Log View (`error-log.js`)

The error log view (`#/error-log`) renders a paginated, filterable table of error log entries fetched from `GET /api/error-log`.

**Key behaviours:**

- **Filter bar:** Severity and Source dropdowns re-fetch entries on change via `api.errorLog.list()`. The severity dropdown is driven by `SEVERITY_OPTIONS` in `error-log.js` and contains five entries: `all` ("All Severities"), `error` ("Error"), `warning` ("Warning"), `audit` ("Audit"), `info` ("Info"). Source options are **fetched dynamically** from `GET /api/error-log/sources` (`api.errorLog.sources()`) on view mount and after "Clear All" — no hardcoded list. The filter bar is rebuilt after each sources fetch via `rebuildFilterBar()`.
- **Expandable detail rows:** Each data row (`<tr class="error-log-entry-row">`) is keyboard-accessible (`role="button"`, `tabindex="0"`, `aria-expanded`). Clicking or pressing Enter/Space toggles a hidden `<tr class="error-log-detail-row">` below it containing a `<pre class="error-log-detail-pre">` with the entry's `details` field.
- **Severity badges:** Rendered via `buildSeverityBadge()` as a `<span class="severity-badge severity-{value}">` element. Supported CSS classes and their visual semantics:
  - `.severity-error` — red/danger (`--badge-error` / `--badge-error-bg`)
  - `.severity-warning` — amber/warning (`--color-warning` / `--color-warning-light`)
  - `.severity-audit` — blue/indigo (`--badge-ahead` / `--badge-ahead-bg`)
  - `.severity-info` — neutral/grey (`--color-text-muted` / `--color-border-light`)
  - Unknown severities fall back to no colour modifier (`.severity-badge` base styles only).
- **Timestamps:** Displayed as relative time (e.g. "3 min ago") with the full ISO timestamp in the `title` tooltip. Falls back to the raw string on parse failure.
- **Clear All:** Prompts a `showConfirm()` dialog before calling `api.errorLog.clear()` (HTTP DELETE). Resets filters and reloads on success.
- **XSS safety:** All dynamic text is set via `textContent`, never `innerHTML`.
- **No router injection:** `error-log.js` does not export `setRouter()` — it never needs to navigate away programmatically.
- **No cleanup function:** `renderErrorLog` returns no cleanup — there is no polling or other side-effect to tear down.
- **Shared time utility:** `relativeTime()` is imported from `utils/time.js` (shared with `status-badge.js`'s `formatLastActivity()`).

**Nav badge:** The `#error-log-badge` span inside the "Error Log" nav link displays a live error count. `nav-badge.js` polls `api.errorLog.count()` every 30 seconds and hides the badge when the count is 0. The error-log view calls `refreshNavBadge()` after "Clear All".

```
###  Path: `/docs/agents/project-manifest/rest-api.md`

```md
# REST API

All endpoints are served by the built-in HTTP server on `serverPort` (default `4200`). Request and response bodies are JSON. The GUI SPA is served as static files from the same server.

---

## Repositories

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/repositories` | 200 | — | List all repositories. |
| `GET` | `/api/repositories/:id` | 200 | 404 | Get a single repository by ID. |
| `POST` | `/api/repositories` | 201 | 400 | Register a new repository. Body: `{ url, name?, id? }`. |
| `PUT` | `/api/repositories/:id` | 200 | 400, 404 | Update repository metadata. Body: `{ name, url? }`. |
| `DELETE` | `/api/repositories/:id` | 204 | 404 | Delete a repository. |
| `PUT` | `/api/repositories/:id/credential` | 200 | 400, 404 | Assign or clear a git credential for a repository. Body: `{ credentialId: string \| null }`. |
| `GET` | `/api/repositories/:id/credential-options` | 200 | 404 | List credentials compatible with the repository's host, with tokens masked. |
| `POST` | `/api/repositories/:id/refresh-timestamp` | 200 | 404 | Persist the repository's manual refresh timestamp to the current UTC time and return the updated `Repository` object. Used by the repository-detail view's Refresh button. |
| `GET` | `/api/repositories/credential-options` | 200 | 400 | List credentials compatible with an arbitrary URL's host (no existing repository required), with tokens masked. Query: `?url=`. |

### `PUT /api/repositories/:id` — Update Repository Metadata

Updates a repository's `Name` and, optionally, its `Url`.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | **Yes** | New display name. Must be a non-empty string after trimming. |
| `url` | `string` | No | New remote URL. When provided, must be a non-empty string after trimming. Embedded credentials are stripped before storage, mirroring `POST /api/repositories`. The repository `Id` is never affected by a URL change. |

**400 cases:**
- `name` is missing, not a string, or empty after trimming.
- `url` is present but not a string, or empty after trimming.
- `url` (after credential-stripping) duplicates another repository's URL — the manager's error message is returned verbatim, e.g. `A repository with URL "https://github.com/org/repo.git" already exists (ID: "repo").`.

**404:** repository not found.

**200 Response:** the full updated `Repository` object.

> **Host-incoherence auto-clear:** when `url` is provided and changes the repository's host (as computed by `extractHost()`), any existing `CredentialId` that no longer matches the new host is automatically cleared — the response reflects the repository with `CredentialId` removed. An audit log entry is appended with `Source: 'credential-audit'` and `Operation: 'clear-credential'` (same shape as `PUT /:id/credential`'s clear operation). The auto-clear is skipped when the URL edit keeps the same host, or when the new URL is an SSH URL (`extractHost()` returns `null`) — SSH auth is not handled by credential tokens, so the association is left untouched.

### `PUT /api/repositories/:id/credential` — Assign or Clear a Credential

Associates a configured git credential with a repository, or clears any existing association.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `credentialId` | `string \| null` | **Yes** | ID of the credential to assign. Pass `null` to clear the current association. Must reference an entry in `appConfig.gitCredentials` when a string. |

**400 cases:**
- `credentialId` is not a string and not `null` (e.g. missing field, number, boolean, object).
- `credentialId` is a string that does not match any configured credential ID.
- `credentialId` references a credential whose `host` does not match the repository URL's hostname (host-coherence guard). Example error: `Credential "my-cred" is configured for host "gitlab.com" but repository URL resolves to "github.com".`

**404:** repository not found.

**200 Response:** the full updated `Repository` object.

> **Null-clear semantics:** when `credentialId` is `null`, the `CredentialId` field is **removed** from the persisted repository record entirely — it is not stored as `null`. A repository with no credential has no `CredentialId` key in its JSON.

> **Host-coherence guard:** when assigning a credential, the API verifies that `credential.host` matches the hostname extracted from the repository URL. The check is skipped for SSH URLs (where `extractHost()` returns `null`) and when `credentialId` is `null` (clearing the association is always allowed). This prevents misrouted credential injection where a token for one host would be injected into git operations targeting a different host.

> **Audit logging:** each successful assign or clear operation emits an audit log entry with `Source: 'credential-audit'` and `Operation: 'assign-credential'` or `'clear-credential'`. The `Context` field includes `{ RepositoryId: id }`. The credential token is never included in the audit entry.

**Request body (assign):**
```json
{ "credentialId": "github-personal" }
```

**Request body (clear):**
```json
{ "credentialId": null }
```

**Response (200):**
```json
{
    "Id": "my-repo",
    "Url": "https://github.com/org/my-repo.git",
    "Name": "my-repo",
    "CredentialId": "github-personal"
}
```

---

### `GET /api/repositories/:id/credential-options` — List Compatible Credentials

Returns the subset of configured git credentials whose `host` matches the repository's remote URL hostname. Tokens are always masked before being sent to the client.

**404:** repository not found.

**200 Response shape:**

```json
{
    "credentials": [
        { "id": "github-personal", "label": "GitHub personal account", "host": "github.com", "token": "***" }
    ],
    "autoSelected": "github-personal"
}
```

| Field | Type | Description |
|---|---|---|
| `credentials` | `GitCredentialEntry[]` | Credentials whose `host` matches the repository URL's hostname. Tokens are replaced with `"***"`. Empty array `[]` when no credentials match or when the repository uses a non-HTTPS URL (e.g. SSH). |
| `autoSelected` | `string` *(optional)* | ID of the sole matching credential. **Present only when `credentials` contains exactly one entry.** Omitted when zero or two-or-more credentials match. |

> **SSH / non-HTTPS URLs:** repositories whose URL is not an HTTPS URL (e.g. `git@github.com:org/repo.git`) always return `{ "credentials": [] }` with no `autoSelected`. The host cannot be extracted from SSH URLs, so no credentials are ever shown for them.

> **Known inconsistency — token mask format:** this endpoint masks tokens with the hardcoded string `"***"` (3 asterisks), while `GET /api/config/credentials` uses the `maskToken()` helper which produces `"****"` + last-4 characters (4 asterisks prefix, e.g. `"****abc1"`). Both surfaces guarantee the full token is never exposed; the format difference is a pre-existing inconsistency and will be unified in a future cleanup pass.

---

### `GET /api/repositories/credential-options` — List Compatible Credentials for an Arbitrary URL

Returns the subset of configured git credentials whose `host` matches the hostname extracted from the `url` query parameter — without requiring an existing repository record. Used by the create/edit repository modal to match credentials live as the user types or edits a URL, before the repository exists (create mode) or as the URL field is edited in place (edit mode). Tokens are always masked before being sent to the client.

**Query parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | `string` | **Yes** | The Git remote URL to match credentials against. `400` when missing or empty. |

**400:** `url` query parameter is missing or an empty/whitespace-only string.

**200 Response shape:** identical to `GET /:id/credential-options` above — `{ credentials: GitCredentialEntry[], autoSelected?: string }`.

> **Shared computation:** this endpoint and `GET /:id/credential-options` both delegate the filter/mask/`autoSelected` computation to the same internal helper, so their behavior cannot drift apart. The only difference is how each derives the hostname to match against — from a repository's stored URL (`:id` variant) versus the raw `url` query parameter (this variant).

> **SSH / non-HTTPS URLs:** as with the by-ID variant, a `url` from which no host can be extracted (e.g. an SSH URL) always returns `{ "credentials": [] }` with no `autoSelected`.

> **Known inconsistency — token mask format:** same `"***"` masking convention and pre-existing inconsistency with `GET /api/config/credentials` noted above.

---

## Projects

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/projects` | 200 | — | List all projects (index entries). |
| `GET` | `/api/projects/:id` | 200 | 404 | Get full project data by ID. Response includes an optional `LastActivity?: string` field (ISO 8601) when the project has recorded git activity via the polling layer; absent on projects that have never been polled. |
| `POST` | `/api/projects` | 201 | 400 | Create a new project. Body: `{ name, repositoryIds, description?, id? }`. |
| `PUT` | `/api/projects/:id` | 200 | 400, 404 | Update project metadata. Body: `{ Name?, Description? }`. 400 when body is not a valid JSON object or contains no recognized updatable fields. |
| `PUT` | `/api/projects/:id/rename` | 200 | 400, 404 | Rename project (change ID). Body: `{ newId }`. |
| `DELETE` | `/api/projects/:id` | 204 | 404 | Delete project data record. Does not remove workspace folders or `.code-workspace` files from disk. |
| `POST` | `/api/projects/:id/repositories` | 200 | 400, 404 | Add repository to project. Body: `{ repositoryId }`. |
| `DELETE` | `/api/projects/:id/repositories/:repoId` | 204 | 404 | Remove repository from project. |

---

## Workspaces

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/projects/:id/workspaces` | 200 | 404 | List workspaces in a project. Response includes `Initialized` boolean and `FolderPath` string. |
| `GET` | `/api/projects/:id/workspaces/:wid` | 200 | 404 | Get a single workspace. Response includes `Initialized` boolean and `FolderPath` string. |
| `POST` | `/api/projects/:id/workspaces` | 201 | 400, 404 | Create workspace. Body: `{ workspaceId, description? }`. |
| `PUT` | `/api/projects/:id/workspaces/:wid` | 200 | 400, 404 | Update workspace description and/or notes. Body: `{ description?, notes? }` — at least one field required. 400 if neither field is present or body is not a valid JSON object. Response includes a `Notes` field on the returned `WorkspaceInfo`. |
| `PUT` | `/api/projects/:id/workspaces/:wid/rename` | 200 | 400, 404 | Rename workspace. Body: `{ newId }`. |
| `DELETE` | `/api/projects/:id/workspaces/:wid` | 204 | 400, 404 | Delete workspace. 400 when attempting to delete the STABLE workspace. 404 when the project or workspace is not found. |
| `POST` | `/api/projects/:id/workspaces/:wid/setup` | 200 | 404, 500 | Initialize workspace on disk (clone repos, generate .code-workspace file). 404 when the project or workspace is not found. 500 on orchestrator failure. |
| `POST` | `/api/projects/:id/workspaces/:wid/regenerate-workspace-file` | 200 | 400, 404, 500 | Regenerate the `.code-workspace` file from the current repository list without cloning. Workspace folder must already exist on disk (400 if absent). Body: none. Response: `{ success: true }`. |
| `GET` | `/api/projects/:id/workspaces/:wid/health` | 200 | 404 | Fetch the health report for a workspace. Returns `{ healthy: boolean, issues: Array<{ type: string, severity: string, message: string, fixAction: string, repositoryId?: string }> }`. Uninitialized workspaces return `{ healthy: true, issues: [] }`. 404 if project or workspace ID is unknown. See **Health Issue Types** below. |

### Health Issue Types

The `GET .../health` endpoint returns an `issues` array where each element has:

| Field | Type | Description |
|---|---|---|
| `type` | `string` | Issue type identifier. |
| `severity` | `'error' \| 'warning'` | Severity level. |
| `message` | `string` | Human-readable description. |
| `fixAction` | `string` | Suggested fix action identifier (used by the GUI to render a fix button). |
| `repositoryId` | `string` *(optional)* | Present when the issue is scoped to a specific repository. |

Known issue types:

| `type` | `fixAction` | Description |
|---|---|---|
| `workspace-file-missing` | `regenerate-workspace-file` | The `.code-workspace` file for the workspace is absent on disk. |
| `repository-not-cloned` | `setup-workspace` | A repository directory has no `.git` entry (not yet cloned). Includes `repositoryId`. |
| `credential-missing` | `configure-credential` | The most recent setup run for this workspace failed because no credential is configured for the repository's host. Includes `repositoryId`. The error is sourced from error log entries with `Source: 'credentials'` scoped to this workspace. |

---

### `PUT /api/projects/:id/workspaces/:wid` — Request Body

At least one field is required. Both fields may be sent together.

| Field | Type | Required | Description |
|---|---|---|---|
| `description` | `string` | No | Human-readable description for the workspace. |
| `notes` | `string` | No | Free-text notes for the workspace. |

**400 cases:**
- Body is not a valid JSON object.
- Body contains neither a `description` nor a `notes` field (or both values are non-string types).

**200 Response:** the full updated `WorkspaceInfo` object, including the `Notes` field (always present as a string; empty string `""` when no notes have been set).

---

## Launch

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `POST` | `/api/projects/:id/workspaces/:wid/launch/vscode` | 200 | 400, 404, 500 | Open the workspace's `.code-workspace` file in VS Code. 404 if the workspace is unknown. 400 with `"Workspace file does not exist. Run setup first."` if the file is missing from disk. 500 + error log entry (Source: `'app-launcher'`, Operation: `'launch-vscode'`) if the OS-level spawn fails. Response: `{ success: true }`. |
| `POST` | `/api/projects/:id/workspaces/:wid/launch/github-desktop/:rid` | 200 | 400, 404, 500 | Open a repository directory in GitHub Desktop. 404 if the workspace, project, or repository is unknown. 400 with `"Repository directory does not exist. Run setup first."` if the repo directory is missing from disk. 500 + error log entry (Source: `'app-launcher'`, Operation: `'launch-github-desktop'`) if the OS-level spawn fails. Response: `{ success: true }`. |
| `POST` | `/api/projects/:id/workspaces/:wid/launch/terminal` | 200 | 400, 404, 500 | Open the workspace's root folder in a native terminal window. 404 if the workspace or its parent project is unknown. 400 with `"Workspace directory does not exist. Run setup first."` if the workspace's on-disk root folder is missing. 500 + error log entry (Source: `'app-launcher'`, Operation: `'launch-terminal'`) if the OS-level spawn fails (e.g. the platform's terminal command is not installed). Response: `{ success: true }`. |

---

## Branches

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/projects/:id/workspaces/:wid/branches` | 200 | 404, 500 | Get all branches per repository + suggestion list. |
| `POST` | `/api/projects/:id/workspaces/:wid/branches/switch` | 200 | 400, 404, 500 | Switch branches. Body: `{ assignments: { [repoId]: branchName } }`. |

### `GET .../branches` Response Shape

```json
{
    "branches": {
        "repo-id": [
            { "name": "main", "isCurrent": true, "isRemote": false, "upstream": "origin/main" }
        ]
    },
    "suggestions": ["main", "develop", "feature/xyz"]
}
```

### `POST .../branches/switch` Response Shape

```json
{
    "results": {
        "repo-id": { "success": true, "conflict": false },
        "other-repo": { "success": false, "conflict": true, "error": "merge conflict..." }
    }
}
```

---

## Status

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/projects/:id/workspaces/:wid/status` | 200 | 404 | Get cached git status for all repos in workspace. |
| `POST` | `/api/projects/:id/workspaces/:wid/status/refresh` | 200 | 404, 500 | Force-refresh git status (fetch + poll). |

### `GET .../status` Response Shape

```json
{
    "repo-id": {
        "currentBranch": "main",
        "localCommits": 0,
        "unfetchedCommits": 2,
        "modifiedFiles": 3,
        "lastActivity": "2026-04-08T12:00:00Z",
        "hasConflicts": false
    }
}
```

---

## Error Log

Four endpoints for reading and managing the runtime error log. The log is backed by `{storageFolder}/error-log.json` and capped at `AppConfig.maxErrorLogEntries` entries (default: 500, FIFO eviction).

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/error-log` | 200 | — | List error log entries, newest first. Supports filtering and pagination via query params. |
| `GET` | `/api/error-log/sources` | 200 | — | Return sorted distinct `Source` values in the store. |
| `GET` | `/api/error-log/:id` | 200 | 400, 404 | Get a single entry by numeric ID. |
| `DELETE` | `/api/error-log` | 204 | — | Clear all entries. |

> **Route ordering note:** `/api/error-log/sources` is registered **before** `/api/error-log/:id` so the literal segment `"sources"` is not captured as an `:id` parameter.

### `GET /api/error-log` — Query Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `severity` | `"error" \| "warning" \| "audit" \| "info"` | — | Filter by severity. Any other value is silently treated as no filter. |
| `source` | `string` | — | Exact-match filter on the `Source` field. No length cap or allowlist — treat as internal-use only. |
| `limit` | `integer ≥ 0` | `100` | Maximum entries to return. `limit=0` returns an empty `entries` array but `total` is still populated. Negative values are passed directly to `Array.slice(0, limit)` — a negative `limit` of −N returns all entries except the last N (e.g. `limit=-1` on 50 entries returns 49). Treat negative values as unsupported; use `limit=0` for count-only queries. |
| `offset` | `integer ≥ 0` | `0` | Zero-based offset into the filtered result set. Negative values are treated as 0. |

> **Note on `limit=0`:** Passing `limit=0` returns `{ entries: [], total: N }`. This is intentional — it is useful for polling the current count without fetching entries. It does **not** mean "return all entries"; omit the parameter entirely to get the default 100.

### `GET /api/error-log` Response Shape

```json
{
    "entries": [
        {
            "Id": 42,
            "Timestamp": "2026-04-11T09:00:00.000Z",
            "Severity": "error",
            "Source": "clone",
            "Operation": "cloneRepository",
            "Context": { "RepositoryId": "my-repo" },
            "Message": "git clone failed",
            "Details": "fatal: repository not found"
        }
    ],
    "total": 1
}
```

`total` is the post-filter, pre-pagination count (i.e. how many entries match the filters before `limit`/`offset` are applied).

### `GET /api/error-log/:id` — ID Validation

The `:id` segment must be a **positive integer** (digits only). The following return `400`:

| Input | Reason |
|---|---|
| `abc` | Non-numeric |
| `12abc` | Mixed alphanumeric |
| `1.5` | Float |
| `0` | ID 0 is invalid; IDs start at 1 |

### `DELETE /api/error-log` — Security Note

> ⚠️ **No authentication or authorisation guard.** Any caller that can reach the HTTP server can permanently clear all diagnostic data.
>
> This is acceptable because the server is scoped to `localhost` only. **Do not expose this server beyond localhost without adding an authentication layer** (e.g. a reverse-proxy ACL or an API-key header guard) in front of the DELETE endpoint.

---

## Credentials (`/api/config/credentials`)

Manage named git credential entries stored in the `gitCredentials` array within `config.json`. Each entry has a unique `id`, a human-readable `label`, a `host`, and a `token`. Changes take effect immediately (no server restart required) and are persisted to disk.

**Token masking:** tokens are never returned in full. The response always shows `****` followed by the last 4 characters (e.g. `****abc1`). Tokens shorter than 4 characters are fully masked as `****`.

**Audit logging:** when the server is started with an `ErrorLogManager` (always the case in production), every credential mutation is recorded as an `audit`-severity audit log entry with `Source: 'credential-audit'`. The entry includes the credential `id`, `label`, and `host`, but never the token. See [Audit log entries for credential mutations](#audit-log-entries-for-credential-mutations) below.

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/config/credentials` | 200 | — | List all configured credentials with masked tokens. |
| `PUT` | `/api/config/credentials` | 200 | 400 | Add or update a single credential entry. Body: `{ id?, label, host?, token? }`. |
| `DELETE` | `/api/config/credentials/:id` | 200 | 404 | Remove a single entry by its `id`. |

### `PUT /api/config/credentials` — Request Body

| Field | Type | Required | Description |
|---|---|---|
| `id` | `string` | No | Unique identifier for the entry. When omitted, an ID is auto-generated from `label` as a kebab-case string (e.g. `"My Token"` → `"my-token"`). When the generated ID is already in use, a numeric suffix is appended (`-2`, `-3`, …). When provided and it matches an existing entry, that entry is **updated in-place** (upsert) — on this update path `host` and `token` are optional and default to the existing stored values. When provided and no existing entry matches, a new entry is created with that ID (create-with-explicit-id path — `host` and `token` are required). |
| `label` | `string` | **Yes** | Human-readable display name (e.g. `"GitHub personal account"`). Must be a non-empty string. |
| `host` | `string` | **Yes (create)** / No (update) | Hostname this credential applies to (e.g. `"github.com"`). Must be a non-empty string. Must not contain `/`, `\`, null bytes, or whitespace — these characters are rejected with HTTP 400. Omitting `host` on the update path retains the existing value. See [constraints § Hostname Format](constraints.md#hostname-format-host-field). |
| `token` | `string` | **Yes (create)** / No (update) | Personal Access Token or other credential string. Must be a non-empty string. Omitting `token` on the update path retains the existing value. |

**400 cases:** missing or invalid `label`; missing `host` or `token` on the create path; `host` contains `/`, `\`, null bytes, or whitespace; `id` present but empty or not a string.

### `GET /api/config/credentials` Response

Returns a `GitCredentialEntry[]` array with tokens masked. An empty array `[]` is returned when no credentials are configured.

```json
[
    { "id": "github-personal", "label": "GitHub personal account", "host": "github.com", "token": "****abc1" },
    { "id": "gitlab-work",     "label": "GitLab work account",     "host": "gitlab.com", "token": "****xyz9" }
]
```

### `PUT /api/config/credentials` Request / Response

**Request body (create — no `id`, auto-generates ID from label; `host` and `token` required):**
```json
{ "label": "GitHub personal account", "host": "github.com", "token": "ghp_fulltoken" }
```

**Request body (upsert — explicit `id` updates the matching entry in-place; `host` and `token` optional):**
```json
{ "id": "github-personal", "label": "GitHub personal account", "host": "github.com", "token": "ghp_newtoken" }
```

**Request body (label-only update — retain existing host and token):**
```json
{ "id": "github-personal", "label": "My Renamed Token" }
```

**Response** (full masked array after update):
```json
[
    { "id": "github-personal", "label": "GitHub personal account", "host": "github.com", "token": "****oken" }
]
```

### `DELETE /api/config/credentials/:id` Response

**Response** (full masked array after deletion — empty array `[]` when the last entry is removed):
```json
[]
```

**404** is returned when no entry with the given `id` exists.

### Audit log entries for credential mutations

When `ErrorLogManager` is present (always in production), each mutation emits an audit entry with the following shape:

| Field | Value |
|---|---|
| `Severity` | `"audit"` |
| `Source` | `"credential-audit"` |
| `Operation` | `"create-credential"`, `"update-credential"`, or `"delete-credential"` |
| `Context` | `{}` (empty — credential mutations are not scoped to a project or workspace) |
| `Message` | Human-readable summary including `id`, `label`, and `host` — **never the token** |

> **Filtering in the error log GUI:** audit entries use `Severity: 'audit'`. To isolate audit events, filter by `Source: 'credential-audit'` via `GET /api/error-log?source=credential-audit`, or filter by `?severity=audit` to retrieve all audit-severity entries across all sources.

---

## Polling (`/api/config/polling`)

Read and update the git polling interval at runtime, without a server restart. Changes take effect immediately (the polling manager is restarted with the new interval) and are persisted to `config.json`.

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/config/polling` | 200 | — | Return the current polling interval. |
| `PUT` | `/api/config/polling` | 200 | 400 | Update the polling interval. Body: `{ seconds }`. |

### Validation (PUT)

- `seconds`: must be a finite integer **≥ 10**. Fractional values, strings, `null`, `Infinity`, and `NaN` all return `400`.

### `GET /api/config/polling` Response

```json
{ "gitPollingIntervalSeconds": 30 }
```

### `PUT /api/config/polling` Request / Response

**Request body:**
```json
{ "seconds": 60 }
```

**Response** (updated value):
```json
{ "gitPollingIntervalSeconds": 60 }
```

> **Upper bound:** `seconds` must also be ≤ 86,400 (24 hours = `MAX_POLLING_INTERVAL_SECONDS`). Values above this limit are rejected with HTTP 400.

---

## Webserver URL (`/api/config/webserver-url`)

Read and update the base URL of the local webserver that serves workspace repositories. When set, the workspace-detail view shows a "Browse" button for each repository row, opening `{webserverUrl}/{projectId}/{workspaceId}/{repoId}/` in a new browser tab. Changes are persisted to `config.json` and take effect immediately.

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/config/webserver-url` | 200 | — | Return the current webserver URL (or `null` when not configured). |
| `PUT` | `/api/config/webserver-url` | 200 | 400 | Update the webserver URL. Body: `{ url }`. Empty string clears the setting. |

### Validation (PUT)

- `url`: must be a string. Non-string values return `400`.
- Dangerous schemes (`javascript:`, `data:`, `vbscript:`) are rejected with `400` (defence-in-depth — `window.open('javascript:...')` can execute code in some browsers).
- An empty string (or whitespace-only string) clears the setting (`webserverUrl` is removed from `config.json`; the Browse button is hidden).
- Trailing slashes are stripped before persisting to prevent double-slash in constructed URLs.

### `GET /api/config/webserver-url` Response

```json
{ "webserverUrl": "http://localhost:8080" }
```

Returns `null` when not configured:
```json
{ "webserverUrl": null }
```

### `PUT /api/config/webserver-url` Request / Response

**Request body (set):**
```json
{ "url": "http://localhost:8080" }
```

**Response:**
```json
{ "webserverUrl": "http://localhost:8080" }
```

**Request body (clear):**
```json
{ "url": "" }
```

**Response:**
```json
{ "webserverUrl": null }
```

---

## Notes Display (`/api/config/notes-display`)

Read and update the notes view display settings at runtime, without a server restart. Changes take effect immediately (in-memory `appConfig` is mutated) and are persisted to `config.json` via `saveConfigField()`.

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/config/notes-display` | 200 | — | Return the current notes display settings. |
| `PUT` | `/api/config/notes-display` | 200 | 400 | Update notes display settings. Body: `{ notesCardHeight?, notesColumns? }` — all fields optional (partial update). |

### Validation (PUT)

All fields are optional. Omitting a field leaves the current value unchanged.

| Field | Type | Range | Description |
|---|---|---|---|
| `notesCardHeight` | integer | `[120, 800]` | Height of each note card in pixels. |
| `notesColumns` | integer | `[1, 6]` | Number of columns in the notes view grid. |

**400 cases (per field, when provided):**
- Value is not a number → `'Field "notesCardHeight" must be a number.'`
- Value is not a finite integer (e.g. float, `NaN`, `Infinity`) → `'Field "notesCardHeight" must be a finite integer.'`
- Value below minimum → `'Field "notesCardHeight" must be at least 120. Received: N.'`
- Value above maximum → `'Field "notesCardHeight" must be at most 800. Received: N.'`
- Body is not a valid JSON object → `'Request body must be a JSON object.'`

Same error patterns apply to `notesColumns` (range `[1, 6]`).

### `GET /api/config/notes-display` Response

```json
{ "notesCardHeight": 220, "notesColumns": 2 }
```

### `PUT /api/config/notes-display` Request / Response

**Full update:**
```json
{ "notesCardHeight": 300, "notesColumns": 3 }
```

**Partial update (height only):**
```json
{ "notesCardHeight": 400 }
```

**Response** (always returns the full current settings after applying changes):
```json
{ "notesCardHeight": 400, "notesColumns": 2 }
```

> **Partial update semantics:** Fields absent from the request body are left unchanged. An empty body `{}` is valid — it returns the current settings with no modifications.

---

## Notes

Aggregate endpoint that returns the `Notes` field for every workspace across all projects in a single request. Intended for use by the GUI to display workspace notes without fetching individual workspace records.

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/notes` | 200 | 500 | Return all workspace notes grouped by project. |

**Behaviour:**
- All projects and all their workspaces are always included unconditionally — there is no filtering by project or workspace.
- Workspaces with no notes stored have `Notes: ""` in the response.
- Returns `{ Projects: [] }` when no projects exist.
- Returns `500` if reading from storage fails (file I/O error, JSON parse failure, etc.).

### `GET /api/notes` Response Shape

```json
{
    "Projects": [
        {
            "ProjectId": "my-project",
            "ProjectName": "My Project",
            "Workspaces": [
                { "WorkspaceId": "STABLE", "Notes": "" },
                { "WorkspaceId": "DEV",    "Notes": "some notes" }
            ]
        }
    ]
}
```

---

## Version (`/api/version`)

Returns the running application version strings.

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/version` | 200 | — | Return the application and GUI version strings. |

### `GET /api/version` Response Shape

```json
{
    "appVersion": "1.0.0",
    "guiVersion": "1.0.0"
}
```

Both fields are read from `package.json` at server startup. `guiVersion` is read from `gui/package.json`.

```
###  Path: `/docs/agents/project-manifest/tech-stack.md`

```md
# Tech Stack & Patterns

## Runtime & Language

| Item | Value |
|---|---|
| Runtime | Node.js >= 18 |
| Language | TypeScript 5.4+ (strict mode) |
| Target | ES2022 |
| Module system | Node16 (ESM with `.js` extensions in imports) |
| Module resolution | Node16 |

## Dependencies

### Production

| Package | Version | Purpose |
|---|---|---|
| `picocolors` | ^1.x | Terminal color output for the CLI menu and setup wizard. Zero transitive dependencies. |

> Runtime dependencies are permitted when vetted for size, security, and zero transitive dependencies.

### Dev Dependencies

| Package | Purpose |
|---|---|
| `typescript` ^5.4.0 | TypeScript compiler |
| `@types/node` ^25.5.1 | Node.js type definitions |
| `@picocss/pico` ^2.1.1 | Classless CSS framework — base styling layer for the GUI |
| `jsdom` ^29.0.2 | DOM simulation for GUI component tests |

## External Tools

| Tool | Min Version | Purpose |
|---|---|---|
| Git | >= 2.28 | All repository operations — spawned via `child_process.spawn()` with `shell: false` |
| npm | >= 9 | Package management |

## GUI Browser Requirements

The web GUI uses `color-mix()` (CSS Color Level 5) in `gui/public/css/styles.css` for focus-state background blending. The following minimum browser versions are required:

| Browser | Minimum version |
|---|---|
| Chromium / Chrome / Edge | 111 |
| Firefox | 113 |
| Safari | 16.2 |

> The tool targets single-developer local use; no legacy browser support is intended.

## Architectural Patterns

### Layered Architecture

The backend follows a strict layered architecture, bottom to top:

1. **Storage** (`src/storage/`) — JSON file I/O primitives.
2. **Models** (`src/models/`) — Stateless CRUD managers (Repository, Project, Workspace). Each re-reads from disk on every call.
3. **Error Log** (`src/error-log/`) — Stateless, bounded error log manager (`ErrorLogManager`). Persists runtime faults and warnings to `error-log.json` with FIFO eviction at 500 entries.
4. **Git** (`src/git/`) — Stateless functions wrapping Git CLI subprocess calls.
5. **Orchestration** (`src/orchestration/`) — Composes models + git for high-level multi-step operations (clone, branch switch, workspace creation).
6. **Server** (`src/server/`) — HTTP server with a custom `Router`, REST API route handlers, static file serving, and a `PollingManager` for periodic git status polling.
7. **CLI** (`src/index.ts`) — Interactive menu entry point.

### Stateless Managers

All managers (`RepositoryManager`, `ProjectManager`, `WorkspaceManager`, `ErrorLogManager`) are **stateless** — they re-read their backing JSON files from disk on every public method call. This ensures concurrent writes from other processes are always reflected.

### Dependency Injection

Orchestrators and managers receive their dependencies via constructor injection. No service locator or DI container is used.

### GUI — Vanilla SPA

The frontend is a **vanilla JavaScript SPA** (no framework) using:
- Hash-based routing (`#/path`)
- ES modules loaded natively by the browser
- A custom `Router` class with parameter extraction
- Dependency injection of the router into views via `setRouter()` to avoid circular imports

## Build & Scripts

| Script | Command | Description |
|---|---|---|
| `build` | `tsc` | One-shot TypeScript compilation to `dist/` |
| `dev` | `tsc --watch` | Watch mode — recompile on save |
| `start` | `node dist/index.js` | Run compiled CLI |
| `test` | `tsc && node --test dist/tests/*.test.js dist/server/__tests__/*.test.js dist/server/__tests__/**/*.test.js` | Compile then run all tests with Node.js built-in test runner |
| `test:gui` | `node --test 'gui/public/js/**/*.test.mjs'` | Run all GUI frontend unit tests (auto-discovers all `.test.mjs` files under `gui/public/js/`) |
| `copy-vendor` | `mkdir -p gui/public/css/vendor && cp ...pico.classless.min.css gui/public/css/vendor/` | Copy Pico CSS from node_modules to gui vendor directory |
| `postinstall` | `npm run copy-vendor` | Auto-runs `copy-vendor` after `npm install` |

## Test Framework

Node.js built-in test runner (`node --test`). No external test framework.

## CLI Distribution

### Binary

The `paralizer` binary is declared in `package.json` `"bin"` and can be installed globally via `npm link` or `npm install -g`.

### Launcher Scripts

Two convenience launcher scripts are provided for running the CLI menu without `npm link`:

| File | Platform | Invocation |
|---|---|---|
| `menu.sh` | Unix / macOS | `./menu.sh [command] [options]` |
| `menu.cmd` | Windows | `menu.cmd [command] [options]` |

Both scripts `cd` to their own directory before invoking `node dist/index.js menu "$@"` / `node dist\index.js menu %*`, ensuring the tool resolves paths correctly regardless of the caller's working directory.

> **Note:** `menu.sh` uses `dirname "$0"` (not `realpath`) — if the script is symlinked, the `cd` will target the symlink's location, not the real file's location.

### npm Package Distribution

`package.json` is configured for `npm publish` with the following fields:

| Field | Value | Purpose |
|---|---|---|
| `main` | `dist/index.js` | Entry point for `require('repo-parallelizer')` |
| `files` | Curated per-subdirectory list: `dist/cli/`, `dist/config/`, `dist/git/`, `dist/models/`, `dist/orchestration/`, `dist/server/*.js[.map]`, `dist/server/routes/`, `dist/storage/`, `dist/utils/`, `dist/errors.js[.map]`, `dist/index.js[.map]`, `gui/public/`, `config.dist.json`, `menu.sh`, `menu.cmd` | Controls what's included in the published tarball. Compiled test artefacts (`dist/tests/`, `dist/server/__tests__/`) are excluded by this curated list and by `.npmignore`. |
| `keywords` | `git`, `repository`, `workspace`, `vscode`, `parallel`, `clone`, `branch`, `cli` | npm search discoverability |
| `repository` | `{ type: "git", url: "..." }` | Source repository link on npmjs.com |

`package.json`, `README.md`, and `LICENSE` are always included by npm automatically regardless of the `files` field.

> **Pre-publish checklist:**
> 1. Replace the placeholder `repository.url` with the actual repository URL.
> 2. Add `menu.sh text eol=lf` to `.gitattributes` to prevent CRLF conversion on Windows checkouts.

```
---
**File Statistics**
- **Size**: 178.96 KB
- **Lines**: 2870
File: `project-manifest.md`
