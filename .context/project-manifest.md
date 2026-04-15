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

**Last generated:** 2026-04-11

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
interface AppConfig {
    projectsFolder: string;
    storageFolder: string;
    cloneDepth: number;       // default: 50
    serverPort: number;       // default: 4200
    gitPollingIntervalSeconds: number; // default: 30
    gitCredentials?: Record<string, string>; // hostname → PAT/password; absent = public repos only
    maxErrorLogEntries?: number;  // default: 500 — FIFO eviction cap for error log
}
```

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
function injectCredentials(url: string, credentials: Record<string, string>): string
function hasEmbeddedCredentials(url: string): boolean
function stripEmbeddedCredentials(input: string): string
```

> **`stripEmbeddedCredentials` contract:** Accepts an arbitrary string — not just a URL. Pure HTTPS URLs are sanitised via the WHATWG URL object (clean userinfo removal). All other inputs (non-HTTPS URLs, git prose error messages such as `"fatal: repository 'https://token@host/...' not found"`, and unparseable values) fall through to a regex scrub that replaces any `https?://…@` pattern with `https://***@`. Use this function on `gitResult.stderr` before surfaces it in API responses or logs.

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
type ErrorSeverity = 'error' | 'warning';

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
                                // limit=0 or negative → empty entries, total unaffected.
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
}

interface RepositoryStore extends BaseStore {
    Repositories: Repository[];
}
```

#### Manager (`repository.manager.ts`)

```typescript
class RepositoryManager {
    constructor(config: AppConfig)

    list(): Repository[]
    getById(id: string): Repository | undefined
    exists(id: string): boolean
    add(params: { url: string; name?: string; id?: string }): Repository
    update(id: string, params: { name: string }): Repository
    remove(id: string): void
}
```

### Project

#### Types (`project.types.ts`)

```typescript
interface ProjectWorkspace {
    Description: string;
    DateCreated: string;
    DateModified: string;
}

interface ProjectData {
    Id: string;
    Name: string;
    Description: string;
    DateCreated: string;
    DateModified: string;
    Repositories: string[];
    Workspaces: Record<string, ProjectWorkspace>;
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
    addWorkspace(projectId: string, workspaceId: string, workspace: ProjectWorkspace): ProjectData
    updateWorkspace(projectId: string, workspaceId: string, changes: Partial<{ Description: string; DateModified: string }>): ProjectData
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
}

// Re-exported from project.types.ts:
type ProjectWorkspace = import('../project/project.types.js').ProjectWorkspace;
```

#### Manager (`workspace.manager.ts`)

```typescript
class WorkspaceManager {
    constructor(projectManager: ProjectManager)

    list(projectId: string): WorkspaceInfo[]
    getById(projectId: string, workspaceId: string): WorkspaceInfo | undefined
    create(projectId: string, workspaceId: string, description?: string): WorkspaceInfo
    update(projectId: string, workspaceId: string, changes: { Description?: string }): WorkspaceInfo
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
): WorkspaceHealthReport
```

---

## Storage (`src/storage/`)

### Types (`storage.types.ts`)

```typescript
type SchemaVersion = number;

interface BaseStore {
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
    defaultValue: string,
    _ask?: typeof askQuestion,
    _confirm?: typeof askYesNo,
): Promise<string>

function _promptNumber(
    label: string,
    defaultValue: number,
    min: number,
    max: number,
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
const DEFAULTS = {
    cloneDepth: 50,
    serverPort: 4200,
    gitPollingIntervalSeconds: 30,
    storageFolder: 'data/storage',
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
function registerRepositoryRoutes(router: Router, repoManager: RepositoryManager): void

// projects.ts
function registerProjectRoutes(router: Router, projectManager: ProjectManager): void

// workspaces.ts
function registerWorkspaceRoutes(router: Router, workspaceManager: WorkspaceManager, workspaceOrchestrator: WorkspaceOrchestrator, appConfig: AppConfig): void

// branches.ts
function registerBranchRoutes(router: Router, orchestrator: BranchOrchestrator, workspaceManager: WorkspaceManager): void

// status.ts
function registerStatusRoutes(router: Router, pollingManager: PollingManager, projectManager: ProjectManager, workspaceManager: WorkspaceManager, config: AppConfig): void

// config.ts
function registerConfigRoutes(router: Router, appConfig: AppConfig, configPath?: string, pollingManager?: PollingManager): void
```

---

## GUI Client (`gui/public/js/api.js`)

Vanilla JS HTTP client for the SPA frontend. All methods return Promises and throw an `Error` (with `message` taken from the `error` field in the JSON body) on non-2xx responses.

**Import:** `import { api } from './api.js';`

### `api.config.credentials`

Manages per-host git credentials. All tokens are **always returned masked** by the API (e.g. `****abc1`) — the plaintext token is never surfaced in any response.

```js
// List all configured credentials.
// Returns: Promise<Record<string, string>>  // host → masked token
api.config.credentials.list()

// Add or update a host credential.
// data: { host: string, token: string }
// Returns: Promise<Record<string, string>>  // updated masked credentials map
api.config.credentials.set(data)

// Remove a host credential.
// host: string — URL-encoded automatically by the client
// Returns: Promise<Record<string, string>>  // updated masked credentials map after deletion
api.config.credentials.delete(host)
```

> **Token masking:** The server applies `maskToken()` before every API response. The client never receives or stores a plaintext token. The `set()` form uses `<input type="password">` in the UI.

> **Known edge case:** Hosts containing a colon (e.g. `gitlab.com:8080`) may be undeletable via the UI. `encodeURIComponent()` encodes the colon in the DELETE URL, but the server's `extractParams()` does not call `decodeURIComponent()` before the credential lookup. Tracked as a low-severity improvement for a follow-up.

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

## Type-Audit Acceptance Criterion

Any work package that adds or modifies exported types must include the following acceptance criterion:

> **Type audit:** Exported types match the plan specification — verify that each new/modified interface property name, type, and optionality align with the plan before marking the WP complete.

QA work packages that follow implementation WPs should cross-check type signatures against the plan, paying particular attention to optional (`?`) vs. required properties and union types.

## Known Input Validation Gaps

- `branchExists()` and `fetchRemote()` do not validate the `'-'` prefix guard that `createBranch()` and `switchBranch()` enforce. These are lower-risk (no data-loss path) and a guard is planned for a future cleanup.
- `branchName` in `branchExists()` is not validated against a safe refname pattern — a path-traversal value may yield a false-positive. Callers must validate before passing untrusted input.

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
  └→ ProjectOrchestrator.createProject()
       └→ ProjectManager.create()             # Validate IDs, write project JSON + index
            └→ Auto-creates STABLE workspace entry with current timestamp
       └→ WorkspaceOrchestrator.createWorkspace("STABLE")
            └→ For each repository (concurrent via Promise.all):
                 cloneRepository(url, clonePath, { depth })
            └→ generateWorkspaceFile()         # Write .code-workspace file
       └→ Return OrchestrationResult (per-repo success/failure)
```

## 4. Add a Repository to a Project

```
User → POST /api/projects/:id/repositories { repositoryId }
  └→ RepositoryOrchestrator.addRepositoryToProject()
       └→ ProjectManager.addRepository()      # Append repo ID to project data
       └→ For each workspace in the project (concurrent):
            cloneRepository(url, clonePath)    # Clone into each workspace dir
            generateWorkspaceFile()            # Regenerate .code-workspace file
       └→ Return AddRepositoryResult (per-workspace success/failure)
```

## 5. Create a Workspace

```
User → POST /api/projects/:id/workspaces { id: workspaceId }
  └→ WorkspaceOrchestrator.createWorkspace()
       └→ WorkspaceManager.create()           # Validate ID, add workspace entry
       └→ For each repository (concurrent via Promise.all):
            cloneRepository(url, clonePath)    # Clone into workspace sub-directory
       └→ generateWorkspaceFile()              # Write {project}-{workspace}.code-workspace
       └→ Return OrchestrationResult
```

## 6. Branch Switch (Multi-Repository)

```
User → POST /api/projects/:id/workspaces/:wid/branches/switch { assignments: { repoId: branchName } }
  └→ BranchOrchestrator.switchBranches()
       └→ For each repoId in assignments (concurrent via Promise.all):
            branchExists(repoPath, branchName)?
              ├→ yes: switchBranch(repoPath, branchName)   # git checkout
              └→ no:  createBranch(repoPath, branchName)   # git checkout -b
            └→ On failure: scan stderr for conflict patterns
       └→ WorkspaceManager.update() → set DateModified
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
```

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
Orchestrator (future WP) receives a repo URL (e.g. https://github.com/org/private.git)
  └→ hasEmbeddedCredentials(url)?
       ├→ true:  URL already has credentials — decide: strip-and-reinject or reject
       └→ false: proceed to injection
  └→ extractHost(url)                          # → 'github.com'
  └→ config.gitCredentials['github.com']?
       ├→ found: injectCredentials(url, config.gitCredentials)
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
- `injectCredentials()` must only be called immediately before a git subprocess call — never stored or passed through API boundaries.
- `stripEmbeddedCredentials()` must be applied to any `GitResult.stderr` and `Error.message` before the string is logged or returned in an API response.
- `hasEmbeddedCredentials()` must be checked before calling `injectCredentials()` when the URL originates from user input.

---

## 10. Workspace Setup — Clone Failure Error Propagation

```
WorkspaceOrchestrator.createWorkspace() on clone failure:
  └→ cloneRepository() → GitResult.stderr  (e.g. "fatal: Authentication failed for https://...")
       └→ [FUTURE WP — MANDATORY] stripEmbeddedCredentials(gitResult.stderr)
            # Must be applied before assigning to OrchestrationRepoResult.error
            # Prevents PAT exposure when injectCredentials() is active
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
            checkWorkspaceHealth(projectId, workspaceId, projectsFolder, repositoryIds)
              └→ Check 1: fs.existsSync(getWorkspaceFilePath(...))
                   └→ absent → issue { type: 'workspace-file-missing', severity: 'warning',
                                        fixAction: 'regenerate-workspace-file' }
              └→ Check 2: for each repoId in repositoryIds:
                   fs.existsSync(path.join(projectsFolder, projectId, wid, repoId, '.git'))
                   └→ absent → issue { type: 'repository-not-cloned', severity: 'warning',
                                        fixAction: 'setup-workspace', repositoryId }
              └→ Return WorkspaceHealthReport { healthy: issues.length === 0, issues }
            sendJson 200 WorkspaceHealthReport
```

**GUI integration:**
- `project-detail.js`: health fetched in parallel with status for all initialized workspaces via `Promise.allSettled`. Failing fetches degrade gracefully (health cell left empty).
- `workspace-detail.js`: health report fetched on initial load and every poll cycle. Unhealthy workspaces render a `.health-alert` card with per-issue rows and fix action buttons.

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

```
###  Path: `/docs/agents/project-manifest/gui-frontend.md`

```md
# GUI Frontend

The frontend is a vanilla JavaScript SPA with no build step, served as static files by the built-in HTTP server from `gui/public/`.

## Architecture

- **Routing:** Hash-based client-side router (`#/path`) with named parameter extraction (`:id`, `:wid`).
- **Module system:** Native ES modules loaded by the browser. No bundler.
- **State management:** None — every view fetches fresh data from the REST API on render. Mutations trigger a full view re-render.
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
| `#/` | `dashboard.js` | Project listing with creation form. |
| `#/repositories` | `repositories.js` | Repository CRUD table. |
| `#/projects/:id` | `project-detail.js` | Project metadata, tabbed repo/workspace/danger-zone management. The workspace table includes a **Health** column: initialized workspaces with health issues show a warning badge with issue count; healthy and uninitialized workspaces show an empty cell. Health is fetched in parallel with status for all initialized workspaces via `Promise.allSettled` (graceful degradation — fetch failures leave the health cell empty). |
| `#/projects/:id/workspaces/:wid` | `workspace-detail.js` | Live git status with countdown-based polling and manual refresh. Health report fetched in parallel on initial load and on every poll/refresh cycle. Unhealthy workspaces render a `.health-alert` card with per-issue rows and fix buttons (`Regenerate File` for `regenerate-workspace-file` issues, `Fix Setup` for `setup-workspace` issues). |
| `#/projects/:id/workspaces/:wid/branch-switch` | `branch-switch.js` | 3-step branch switch wizard. |
| `#/settings` | `settings.js` | Settings view with two sections: **Git Credentials** (add/delete per-host PATs) and **Repositories Refresh Delay** (configurable `gitPollingIntervalSeconds`). |
| `#/error-log` | `error-log.js` | Paginated, filterable error log table with expandable detail rows and "Clear All" action. |

## API Client

`api.js` exports a namespaced `api` object with six groups:

- `api.repositories` — `list()`, `get(id)`, `create(data)`, `update(id, data)`, `delete(id)`
- `api.projects` — `list()`, `get(id)`, `create(data)`, `update(id, data)`, `rename(id, newId)`, `delete(id)`, `addRepository(pid, rid)`, `removeRepository(pid, rid)`
- `api.workspaces` — `list(pid)`, `get(pid, wid)`, `create(pid, data)`, `update(pid, wid, data)`, `rename(pid, wid, newId)`, `delete(pid, wid)`, `setup(pid, wid)`, `health(pid, wid)`, `regenerateFile(pid, wid)`
- `api.branches` — `list(pid, wid)`, `switch(pid, wid, assignments)`
- `api.status` — `get(pid, wid)`, `refresh(pid, wid)`
- `api.config.credentials` — `list()`, `set(data)`, `delete(host)`
- `api.config.polling` — `get()`, `set(seconds)`
- `api.errorLog` — `list(params?)`, `get(id)`, `clear()`, `count()`

### `api.workspaces` — Health & File Methods

| Method | HTTP | Description |
|---|---|---|
| `health(pid, wid)` | `GET /api/projects/:id/workspaces/:wid/health` | Fetch the health report for an initialized workspace. Returns `{ healthy: boolean, issues: Array<{ type: string, severity: string, message: string, fixAction: string, repositoryId?: string }> }`. |
| `regenerateFile(pid, wid)` | `POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file` | Regenerate the `.code-workspace` file from the current repository list without cloning. Returns `{ success: boolean }`. |

**`health()` issue `fixAction` values:**
- `regenerate-workspace-file` — missing or stale `.code-workspace` file; surface a `Regenerate File` button.
- `setup-workspace` — uncloned repository; surface a `Fix Setup` button.

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
    severity: 'error',   // optional — 'error' | 'warning'
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
| Confirm Dialog | `components/confirm-dialog.js` | `showConfirm(title, message): Promise<void>` | Modal with Cancel/Confirm. Resolves on confirm, rejects on cancel. |
| Form Helpers | `components/form-helpers.js` | `createFormField()`, `validateRequired()`, `WORKSPACE_ID_PATTERN` | Form field generation and validation. |
| Status Badge | `components/status-badge.js` | `createStatusBadge(gitStatusInfo): HTMLElement` | Git status badge with branch pill and detail chips. |
| Theme Toggle | `components/theme-toggle.js` | `createThemeToggle(): HTMLButtonElement` | Light/dark mode toggle button. Reads/persists theme in `localStorage`. |
| Toast | `components/toast.js` | `showToast(message, type, duration): HTMLElement\|null` | Auto-dismissing notification in `#toast-container`. Message is rendered via `textContent` (not `innerHTML`) — server-controlled strings including git error output are XSS-safe to pass directly. |

## Utilities

| Utility | File | Export | Purpose |
|---|---|---|---|
| Normalise | `utils/normalise.js` | `normaliseRepo()`, `normaliseProject()`, `normaliseWorkspace()` | Maps PascalCase backend keys to camelCase frontend keys. `normaliseWorkspace` now includes `folderPath` (from `FolderPath` in the API response). |

## Theme Switching

The GUI supports manual light/dark mode switching:

- **Mechanism:** The `data-theme` attribute on `<html>` controls the active theme (`"light"` or `"dark"`). Pico CSS v2 reads this attribute for its base styling. The custom `styles.css` remaps all `--color-*` custom properties in a `:root[data-theme="dark"]` block.
- **Toggle:** A `createThemeToggle()` button in the top nav bar (`#theme-toggle-container`) switches between modes on click.
- **Persistence:** The selected theme is stored in `localStorage` under the key `"theme"` and restored on page load.
- **Default:** `"light"` when no stored preference exists.

## Key Patterns

### Router Injection (Avoiding Circular Dependencies)

Views that need `router.navigate()` export a `setRouter(router)` function. `app.js` calls `setRouter()` before `router.start()`. Views never import `router.js` directly.

Views using router injection: `dashboard.js`, `project-detail.js`, `workspace-detail.js`, `branch-switch.js`.

### Cleanup Contract

Views with side-effects (e.g. `setInterval` polling) return a synchronous cleanup function from their entry point. The router calls it before rendering the next view. The cleanup must be returned **before** any async operations, so the router can register it immediately.

Views returning cleanup: `workspace-detail.js` (clears 1-second countdown interval).

### Workspace Detail View (`workspace-detail.js`)

The workspace detail view (`#/projects/:id/workspaces/:wid`) renders live git status for all repositories in a workspace.

**Key behaviours:**

- **Initial load:** Calls `api.status.refresh()` (force-refresh via live git-fetch) instead of `api.status.get()` (cached), ensuring fresh data even when the polling cache is empty.
- **Refresh toolbar:** A `.workspace-refresh-toolbar` row between the header and the status table displays a countdown label ("Next refresh in Xs") and a "Refresh Now" button. The countdown ticks every second; when it reaches 0, an automatic poll is triggered via `api.status.get()`. The "Refresh Now" button triggers a force-refresh via `api.status.refresh()` and resets the countdown.
- **Countdown-based polling:** Replaces the previous `setInterval(fn, 10000)` approach. A 1-second `setInterval` decrements a counter. At zero it triggers `doPoll()` (cached). A `refreshInProgress` flag prevents race conditions between manual and automatic refreshes.
- **Reactive missing-repos row:** After each poll or manual refresh, the "X repositories have no data" message is re-evaluated. When all repos have status data, the row is removed. When the count changes, the text updates.
- **Setup button in-place update:** After a successful workspace setup, the setup button is removed from the DOM and `workspace.initialized` is set to `true` in the local variable. An immediate force-refresh is triggered and the countdown is started — no router re-render needed.
- **Retry Setup:** The retry button also triggers `doRefresh()` after a successful re-setup instead of reloading the page.
- **Cleanup contract:** The returned cleanup function clears the 1-second countdown interval.

### Tabbed Navigation (Project Detail)

The project detail view organises content into three tabs: **Repositories**, **Workspaces**, and **Danger Zone**. Tabs are implemented with `.tab-nav` / `.tab-btn` / `.tab-panel` CSS classes and ARIA `role="tablist"` / `role="tab"` / `role="tabpanel"` attributes. Switching is handled by a single delegated click listener on the tab nav container. Only one panel is visible at a time (`.tab-panel.active`).

### Error Log View (`error-log.js`)

The error log view (`#/error-log`) renders a paginated, filterable table of error log entries fetched from `GET /api/error-log`.

**Key behaviours:**

- **Filter bar:** Severity (`all` / `error` / `warning`) and Source dropdowns re-fetch entries on change via `api.errorLog.list()`. Source options are **fetched dynamically** from `GET /api/error-log/sources` (`api.errorLog.sources()`) on view mount and after "Clear All" — no hardcoded list. The filter bar is rebuilt after each sources fetch via `rebuildFilterBar()`.
- **Expandable detail rows:** Each data row (`<tr class="error-log-entry-row">`) is keyboard-accessible (`role="button"`, `tabindex="0"`, `aria-expanded`). Clicking or pressing Enter/Space toggles a hidden `<tr class="error-log-detail-row">` below it containing a `<pre class="error-log-detail-pre">` with the entry's `details` field.
- **Severity badges:** Rendered via `buildSeverityBadge()` using `.severity-badge .severity-error` or `.severity-badge .severity-warning` CSS classes.
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
| `PUT` | `/api/repositories/:id` | 200 | 404, 500 | Update repository metadata. Body: `{ name }`. |
| `DELETE` | `/api/repositories/:id` | 204 | 404 | Delete a repository. |

---

## Projects

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/projects` | 200 | — | List all projects (index entries). |
| `GET` | `/api/projects/:id` | 200 | 404 | Get full project data by ID. |
| `POST` | `/api/projects` | 201 | 400 | Create a new project. Body: `{ name, repositoryIds, description?, id? }`. |
| `PUT` | `/api/projects/:id` | 200 | 404 | Update project metadata. Body: `{ Name?, Description? }`. |
| `PUT` | `/api/projects/:id/rename` | 200 | 400, 404 | Rename project (change ID). Body: `{ newId }`. |
| `DELETE` | `/api/projects/:id` | 204 | 404 | Delete project and all workspace files. |
| `POST` | `/api/projects/:id/repositories` | 200 | 400, 404 | Add repository to project. Body: `{ repositoryId }`. |
| `DELETE` | `/api/projects/:id/repositories/:repoId` | 204 | 404 | Remove repository from project. |

---

## Workspaces

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/projects/:id/workspaces` | 200 | 404 | List workspaces in a project. Response includes `Initialized` boolean and `FolderPath` string. |
| `GET` | `/api/projects/:id/workspaces/:wid` | 200 | 404 | Get a single workspace. Response includes `Initialized` boolean and `FolderPath` string. |
| `POST` | `/api/projects/:id/workspaces` | 201 | 400, 404 | Create workspace. Body: `{ id, description? }`. |
| `PUT` | `/api/projects/:id/workspaces/:wid` | 200 | 400, 404 | Update workspace. Body: `{ Description? }`. |
| `PUT` | `/api/projects/:id/workspaces/:wid/rename` | 200 | 400, 404 | Rename workspace. Body: `{ newId }`. |
| `DELETE` | `/api/projects/:id/workspaces/:wid` | 204 | 404 | Delete workspace (STABLE cannot be deleted). |
| `POST` | `/api/projects/:id/workspaces/:wid/setup` | 200 | 400, 404, 500 | Initialize workspace on disk (clone repos, generate .code-workspace file). |
| `POST` | `/api/projects/:id/workspaces/:wid/regenerate-workspace-file` | 200 | 400, 404, 500 | Regenerate the `.code-workspace` file from the current repository list without cloning. Workspace folder must already exist on disk (400 if absent). Body: none. Response: `{ success: true }`. |
| `GET` | `/api/projects/:id/workspaces/:wid/health` | 200 | 404 | Fetch the health report for a workspace. Returns `{ healthy: boolean, issues: Array<{ type: string, severity: string, message: string, fixAction: string, repositoryId?: string }> }`. Uninitialized workspaces return `{ healthy: true, issues: [] }`. 404 if project or workspace ID is unknown. |

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
| `severity` | `"error" \| "warning"` | — | Filter by severity. Any other value is silently treated as no filter. |
| `source` | `string` | — | Exact-match filter on the `Source` field. No length cap or allowlist — treat as internal-use only. |
| `limit` | `integer ≥ 0` | `100` | Maximum entries to return. `limit=0` returns an empty `entries` array but `total` is still populated. Negative values are clamped to 0. |
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

Manage per-host git credentials stored in `gitCredentials` within `config.json`. Changes take effect immediately (no server restart required) and are persisted to disk.

**Token masking:** tokens are never returned in full. The response always shows `****` followed by the last 4 characters (e.g. `****abc1`). Tokens shorter than 4 characters are fully masked as `****`.

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/config/credentials` | 200 | — | List all configured credentials with masked tokens. |
| `PUT` | `/api/config/credentials` | 200 | 400 | Add or update a single host entry. Body: `{ host, token }`. |
| `DELETE` | `/api/config/credentials/:host` | 200 | 404 | Remove a single host entry. |

### Validation (PUT)

- `host`: non-empty string; must not contain path separators (`/`, `\`) or whitespace.
- `token`: non-empty string.

Both fields are required; missing or invalid fields return `400` with a descriptive error message.

### `GET /api/config/credentials` Response

```json
{
    "github.com": "****abc1",
    "gitlab.com": "****xyz9"
}
```

An empty object `{}` is returned when no credentials are configured.

### `PUT /api/config/credentials` Request / Response

**Request body:**
```json
{ "host": "github.com", "token": "ghp_fulltoken" }
```

**Response** (full masked map after update):
```json
{ "github.com": "****oken" }
```

### `DELETE /api/config/credentials/:host` Response

**Response** (full masked map after deletion — empty object when last entry removed):
```json
{}
```

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

> **Note:** No upper bound is currently enforced. Values up to `Number.MAX_SAFE_INTEGER` pass validation and would effectively disable polling for the process lifetime. A practical maximum of 86 400 seconds (24 hours) is planned as a follow-up improvement.

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
| `files` | `dist/`, `gui/public/`, `config.dist.json`, `menu.sh`, `menu.cmd` | Controls what's included in the published tarball |
| `keywords` | `git`, `repository`, `workspace`, `vscode`, `parallel`, `clone`, `branch`, `cli` | npm search discoverability |
| `repository` | `{ type: "git", url: "..." }` | Source repository link on npmjs.com |

`package.json`, `README.md`, and `LICENSE` are always included by npm automatically regardless of the `files` field.

> **Pre-publish checklist:**
> 1. Replace the placeholder `repository.url` with the actual repository URL.
> 2. Add a `.npmignore` to exclude `dist/tests/` and `dist/server/__tests__/` (compiled test artefacts add ~700kB to the unpacked tarball).
> 3. Add `menu.sh text eol=lf` to `.gitattributes` to prevent CRLF conversion on Windows checkouts.

```
---
**File Statistics**
- **Size**: 77.33 KB
- **Lines**: 1748
File: `project-manifest.md`
