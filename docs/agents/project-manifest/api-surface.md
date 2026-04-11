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
7. Prompts for `gitPollingIntervalSeconds` (integer ≥ 1, default: `30`).
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
    constructor(config: AppConfig, projectManager: ProjectManager, workspaceManager: WorkspaceManager, fetchStatusFn?: FetchStatusFn)

    start(intervalSeconds: number): void
    stop(): void
    getStatus(repoPath: string): GitStatusInfo | null
    refreshWorkspace(projectId: string, workspaceId: string): Promise<void>
}
```

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
function registerConfigRoutes(router: Router, appConfig: AppConfig): void
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
