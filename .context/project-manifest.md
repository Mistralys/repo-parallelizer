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
            └── file-tree.md
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
| File Tree | [file-tree.md](file-tree.md) | Annotated directory structure of the project. |
| Public API Surface | [api-surface.md](api-surface.md) | Exported types, classes, and function signatures — no implementations. |
| Key Data Flows | [data-flows.md](data-flows.md) | Main interaction paths through the system. |
| Constraints & Conventions | [constraints.md](constraints.md) | Established rules, conventions, and non-obvious gotchas. |
| REST API | [rest-api.md](rest-api.md) | HTTP endpoints served by the built-in server. |
| GUI Frontend | [gui-frontend.md](gui-frontend.md) | SPA architecture, views, components, and routing. |

**Last generated:** 2026-04-08

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
}
```

### Functions (`config.ts`)

```typescript
function loadConfig(configPath?: string): AppConfig
```

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
function registerWorkspaceRoutes(router: Router, workspaceManager: WorkspaceManager): void

// branches.ts
function registerBranchRoutes(router: Router, orchestrator: BranchOrchestrator, workspaceManager: WorkspaceManager): void

// status.ts
function registerStatusRoutes(router: Router, pollingManager: PollingManager, projectManager: ProjectManager, workspaceManager: WorkspaceManager, config: AppConfig): void
```

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

## Stateless Managers

All model managers (`RepositoryManager`, `ProjectManager`, `WorkspaceManager`) re-read their backing JSON file from disk on **every** public method call. There is no in-memory cache. This ensures concurrent writes from other processes are always reflected.

## ID Validation Rules

| Entity | Format | Validation Function |
|---|---|---|
| Repository ID | Lowercase kebab-case (`a-z0-9`, segments separated by `-`) | `isValidKebabCase()` |
| Project ID | Lowercase kebab-case | `isValidKebabCase()` |
| Workspace ID | 2–6 uppercase ASCII letters (`A-Z`) | `isValidWorkspaceId()` |

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
  └→ Instantiate managers (same as CLI)
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

## 9. Storage File Layout

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

```
###  Path: `/docs/agents/project-manifest/file-tree.md`

```md
# File Tree

```
repo-parallelizer/
├── package.json                    # Project metadata, scripts, bin declaration, npm distribution fields
├── tsconfig.json                   # TypeScript compiler config (ES2022, Node16)
├── config.dist.json                # Template config — copy to config.json
├── config.json                     # (gitignored) Runtime config with user paths
├── context.yaml                    # CTX Generator root config — imports all modules
├── menu.sh                         # Unix/macOS launcher script — `./menu.sh [command]`
├── menu.cmd                        # Windows launcher script — `menu.cmd [command]`
├── README.md                       # Project overview and full API docs
├── CONTRIBUTING.md                 # Developer guide and conventions
├── CHANGELOG.md                    # Release history
├── LICENSE                         # Project license
│
├── .context/                       # (generated) CTX output — auto-generated Markdown docs
│
├── src/                            # TypeScript source (rootDir)
│   ├── index.ts                    # CLI entry point — interactive menu
│   ├── errors.ts                   # Shared error classes (NotFoundError)
│   │
│   ├── config/                     # Configuration loading & types
│   │   ├── module-context.yaml     # CTX module config
│   │   ├── README.md               # Module overview (sourced by CTX)
│   │   ├── config.ts               # loadConfig() — reads and validates config.json
│   │   └── config.types.ts         # AppConfig interface
│   │
│   ├── git/                        # Git CLI wrapper layer (stateless functions)
│   │   ├── module-context.yaml     # CTX module config
│   │   ├── README.md               # Module overview (sourced by CTX)
│   │   ├── git.types.ts            # GitResult, GitStatusInfo, BranchInfo, CloneOptions, RunGitOptions
│   │   ├── git-cli.ts              # runGit(), runGitOrThrow() — subprocess execution
│   │   ├── git-clone.ts            # cloneRepository()
│   │   ├── git-branch.ts           # listBranches(), createBranch(), switchBranch(), etc.
│   │   └── git-status.ts           # getGitStatus(), fetchAndGetStatus()
│   │
│   ├── models/                     # Stateless data managers (CRUD, disk-backed JSON)
│   │   ├── module-context.yaml     # CTX module config
│   │   ├── README.md               # Module overview (sourced by CTX)
│   │   ├── project/
│   │   │   ├── project.types.ts    # ProjectData, ProjectWorkspace, ProjectIndexEntry
│   │   │   └── project.manager.ts  # ProjectManager class
│   │   ├── repository/
│   │   │   ├── repository.types.ts # Repository, RepositoryStore
│   │   │   └── repository.manager.ts # RepositoryManager class
│   │   └── workspace/
│   │       ├── workspace.types.ts  # WorkspaceInfo, STABLE_WORKSPACE_ID constant
│   │       └── workspace.manager.ts # WorkspaceManager class
│   │
│   ├── orchestration/              # High-level composite operations
│   │   ├── module-context.yaml     # CTX module config
│   │   ├── README.md               # Module overview (sourced by CTX)
│   │   ├── orchestration.types.ts  # OrchestrationResult, BranchSwitchResult, etc.
│   │   ├── project-orchestrator.ts # ProjectOrchestrator — create/delete/rename projects
│   │   ├── repository-orchestrator.ts # RepositoryOrchestrator — add/remove repos from projects
│   │   ├── workspace-orchestrator.ts  # WorkspaceOrchestrator — create/delete/rename workspaces
│   │   ├── branch-orchestrator.ts  # BranchOrchestrator — multi-repo branch operations
│   │   └── vscode-workspace.ts     # VS Code .code-workspace file generation
│   │
│   ├── storage/                    # JSON persistence primitives
│   │   ├── module-context.yaml     # CTX module config
│   │   ├── README.md               # Module overview (sourced by CTX)
│   │   ├── storage.types.ts        # BaseStore, SchemaVersion
│   │   └── json-storage.ts         # readJsonFile(), writeJsonFile(), initializeStorage()
│   │
│   ├── utils/                      # Shared helpers
│   │   ├── module-context.yaml     # CTX module config
│   │   ├── README.md               # Module overview (sourced by CTX)
│   │   ├── paths.ts                # getToolRoot(), getConfigPath(), folder resolution
│   │   └── slug.ts                 # toKebabCase(), isValidKebabCase(), inferSlugFromUrl(), isValidWorkspaceId()
│   │
│   ├── cli/                        # Interactive CLI — terminal UI, setup wizard, menu, docs
│   │   ├── terminal-ui.ts          # printHeader, printOption, printSuccess, printError, printInfo, waitForKey, askQuestion, askYesNo, clearScreen
│   │   ├── setup.ts                # runSetup() — interactive first-time config wizard
│   │   ├── docs.ts                 # generateDocs() — runs `ctx generate`; falls back to install instructions
│   │   └── menu.ts                 # showMenu() — interactive main menu (Setup / Launch GUI / Docs / Quit)
│   │
│   ├── server/                     # Built-in HTTP server
│   │   ├── module-context.yaml     # CTX module config
│   │   ├── README.md               # Module overview (sourced by CTX)
│   │   ├── index.ts                # startServer(), stopServer()
│   │   ├── router.ts               # Router class with method-based registration
│   │   ├── staticServer.ts         # serveStatic() — serves gui/public/
│   │   ├── pollingManager.ts       # PollingManager — periodic git status polling
│   │   ├── requestUtils.ts         # parseJsonBody(), sendJson(), sendError(), extractParams()
│   │   ├── routes/                 # REST API endpoint handlers
│   │   │   ├── repositories.ts     # /api/repositories CRUD
│   │   │   ├── projects.ts         # /api/projects CRUD + rename + repo management
│   │   │   ├── workspaces.ts       # /api/projects/:id/workspaces CRUD + rename
│   │   │   ├── branches.ts        # /api/projects/:id/workspaces/:wid/branches
│   │   │   └── status.ts           # /api/projects/:id/workspaces/:wid/status
│   │   └── __tests__/              # Server-specific test files
│   │       ├── index.test.ts
│   │       ├── pollingManager.test.ts
│   │       ├── requestUtils.test.ts
│   │       └── routes/             # Per-route handler tests
│   │
│   └── tests/                      # Core module test files
│       ├── config.test.ts
│       ├── git-cli.test.ts
│       ├── git-clone.test.ts
│       ├── git-branch.test.ts
│       ├── git-status.test.ts
│       ├── json-storage.test.ts
│       ├── storage-init.test.ts
│       ├── paths.test.ts
│       ├── slug.test.ts
│       ├── project.manager.test.ts
│       ├── repository.manager.test.ts
│       ├── workspace.manager.test.ts
│       ├── project-orchestrator.test.ts
│       ├── repository-orchestrator.test.ts
│       ├── workspace-orchestrator.test.ts
│       ├── branch-orchestrator.test.ts
│       └── vscode-workspace.test.ts
│
├── gui/                            # Frontend SPA (served by staticServer)
│   ├── module-context.yaml         # CTX module config
│   ├── README.md                   # Module overview (sourced by CTX)
│   └── public/
│       ├── index.html              # HTML shell with #app container
│       ├── css/
│       │   ├── vendor/             # (gitignored) Generated vendor CSS assets
│       │   │   └── pico.classless.min.css  # Pico CSS classless — copied by `npm run copy-vendor`
│       │   └── styles.css          # Full stylesheet with CSS variables
│       └── js/
│           ├── app.js              # App bootstrap — route registration
│           ├── router.js           # Hash-based SPA router
│           ├── api.js              # REST API client (namespaced: repositories, projects, workspaces, branches, status)
│           ├── views/              # Page-level view functions
│           │   ├── dashboard.js    # Project listing and creation
│           │   ├── repositories.js # Repository CRUD table
│           │   ├── project-detail.js # Project editing, repo/workspace management
│           │   ├── workspace-detail.js # Live status with polling, rename/delete
│           │   └── branch-switch.js # 3-step branch switch wizard
│           ├── components/         # Reusable UI components
│           │   ├── confirm-dialog.js # Modal confirmation dialog
│           │   ├── form-helpers.js # Form field generation and validation
│           │   ├── status-badge.js # Git status badge rendering
│           │   ├── theme-toggle.js # Light/dark theme toggle button
│           │   └── toast.js        # Toast notification system
│           └── utils/
│               ├── nav-highlight.js # Active nav-link highlighting on hash change
│               └── normalise.js    # JSON key normalisation (PascalCase ↔ camelCase)
│
├── dist/                           # (gitignored) Compiled JS output
├── node_modules/                   # (gitignored) Dependencies
│
└── docs/
    ├── projects/
    │   └── tool-description.md     # Original project spec and data schemas
    └── agents/
        ├── project-manifest/       # This manifest
        ├── implementation-history/ # Phase-by-phase implementation logs
        ├── plans/                  # Planned work packages
        └── research/               # Agent research documents
```

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
| `#/projects/:id` | `project-detail.js` | Project metadata, repo/workspace management. |
| `#/projects/:id/workspaces/:wid` | `workspace-detail.js` | Live git status with 10s polling. |
| `#/projects/:id/workspaces/:wid/branch-switch` | `branch-switch.js` | 3-step branch switch wizard. |

## API Client

`api.js` exports a namespaced `api` object with five groups:

- `api.repositories` — `list()`, `get(id)`, `create(data)`, `update(id, data)`, `delete(id)`
- `api.projects` — `list()`, `get(id)`, `create(data)`, `update(id, data)`, `rename(id, newId)`, `delete(id)`, `addRepository(pid, rid)`, `removeRepository(pid, rid)`
- `api.workspaces` — `list(pid)`, `get(pid, wid)`, `create(pid, data)`, `update(pid, wid, data)`, `rename(pid, wid, newId)`, `delete(pid, wid)`
- `api.branches` — `list(pid, wid)`, `switch(pid, wid, assignments)`
- `api.status` — `get(pid, wid)`, `refresh(pid, wid)`

## Reusable Components

| Component | File | Export | Purpose |
|---|---|---|---|
| Confirm Dialog | `components/confirm-dialog.js` | `showConfirm(title, message): Promise<void>` | Modal with Cancel/Confirm. Resolves on confirm, rejects on cancel. |
| Form Helpers | `components/form-helpers.js` | `createFormField()`, `validateRequired()`, `WORKSPACE_ID_PATTERN` | Form field generation and validation. |
| Status Badge | `components/status-badge.js` | `createStatusBadge(gitStatusInfo): HTMLElement` | Git status badge with branch pill and detail chips. |
| Theme Toggle | `components/theme-toggle.js` | `createThemeToggle(): HTMLButtonElement` | Light/dark mode toggle button. Reads/persists theme in `localStorage`. |
| Toast | `components/toast.js` | `showToast(message, type, duration): HTMLElement\|null` | Auto-dismissing notification in `#toast-container`. |

## Utilities

| Utility | File | Export | Purpose |
|---|---|---|---|
| Normalise | `utils/normalise.js` | `normaliseRepo()`, `normaliseProject()`, `normaliseWorkspace()` | Maps PascalCase backend keys to camelCase frontend keys. |

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

Views returning cleanup: `workspace-detail.js` (clears 10-second polling interval).

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
| `GET` | `/api/projects/:id/workspaces` | 200 | 404 | List workspaces in a project. |
| `GET` | `/api/projects/:id/workspaces/:wid` | 200 | 404 | Get a single workspace. |
| `POST` | `/api/projects/:id/workspaces` | 201 | 400, 404 | Create workspace. Body: `{ id, description? }`. |
| `PUT` | `/api/projects/:id/workspaces/:wid` | 200 | 400, 404 | Update workspace. Body: `{ Description? }`. |
| `PUT` | `/api/projects/:id/workspaces/:wid/rename` | 200 | 400, 404 | Rename workspace. Body: `{ newId }`. |
| `DELETE` | `/api/projects/:id/workspaces/:wid` | 204 | 404 | Delete workspace (STABLE cannot be deleted). |

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
3. **Git** (`src/git/`) — Stateless functions wrapping Git CLI subprocess calls.
4. **Orchestration** (`src/orchestration/`) — Composes models + git for high-level multi-step operations (clone, branch switch, workspace creation).
5. **Server** (`src/server/`) — HTTP server with a custom `Router`, REST API route handlers, static file serving, and a `PollingManager` for periodic git status polling.
6. **CLI** (`src/index.ts`) — Interactive menu entry point.

### Stateless Managers

All model managers (`RepositoryManager`, `ProjectManager`, `WorkspaceManager`) are **stateless** — they re-read their backing JSON files from disk on every public method call. This ensures concurrent writes from other processes are always reflected.

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
- **Size**: 46.32 KB
- **Lines**: 1197
File: `project-manifest.md`
