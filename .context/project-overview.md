# Project - Overview
```
// Structure of documents
└── README.md
└── docs/
    ├── agents/
    │   └── implementation-history/
    │       ├── README.md
    │   └── project-manifest/
    │       └── README.md
└── gui/
    ├── README.md
└── src/
    └── config/
        ├── README.md
    └── error-log/
        ├── README.md
    └── git/
        ├── README.md
    └── models/
        ├── README.md
    └── orchestration/
        ├── README.md
    └── server/
        ├── README.md
    └── storage/
        ├── README.md
    └── utils/
        └── README.md

```
###  Path: `README.md`

```md
# repo-parallelizer

Parallelization of VS Code workspaces with multiple local git repositories.

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **git** >= 2.28

## Installation

### From npm (once published)

```bash
npm install -g repo-parallelizer
paralizer
```

### From source (development)

```bash
npm install
npm run build
```

This compiles TypeScript to `dist/` and makes the `paralizer` CLI available.

## Usage

### Global install from source (recommended for development)

```bash
npm link
paralizer
```

### Run directly

```bash
node dist/index.js
```

> **Note:** `dist/index.js` does not have the executable bit set after compilation. Use `node dist/index.js` or `npm link` for local execution — not `./dist/index.js` directly.

### Launcher scripts (no npm link required)

Cross-platform convenience scripts are provided in the project root for running the interactive menu without installing globally:

**Unix / macOS:**

```bash
./menu.sh
# or pass a subcommand:
./menu.sh setup
./menu.sh serve
```

**Windows:**

```cmd
menu.cmd
rem or pass a subcommand:
menu.cmd setup
menu.cmd serve
```

Both scripts `cd` to their own directory before invoking `node dist/index.js menu`, so they work correctly regardless of your current working directory.

> **Note:** `menu.sh` uses `dirname "$0"` — if the script is symlinked, it will `cd` to the symlink's directory rather than the real file's directory.

### npm scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript (`tsc`) |
| `npm run dev` | Watch mode — recompile on save (`tsc --watch`) |
| `npm start` | Run compiled output via `node dist/index.js` |

### Interactive CLI menu

Running `paralizer` (or `node dist/index.js`) with no subcommand drops into the interactive menu — the primary day-to-day interface for the tool.

```
repo-parallelizer vX.Y.Z

  [S] Setup — Run the setup wizard
  [G] Launch GUI — Start server and open browser
  [D] Generate Docs — Run CTX Generator
  [Q] Quit
```

Press the highlighted key to select an action:

| Key | Action | Behaviour |
|-----|--------|-----------|
| `S` | **Setup** | Runs the interactive setup wizard (`runSetup()`). Returns to the menu when finished. |
| `G` | **Launch GUI** | Loads `config.json`, starts the HTTP server, prints the server URL, and attempts to open the default browser. The process stays alive (server keeps the event loop running). Press **Ctrl+C** to stop. |
| `D` | **Generate Docs** | Runs `ctx generate` from the tool root if [CTX Generator](https://github.com/context-hub/generator) is on PATH. Prints installation instructions otherwise. Returns to the menu when finished. |
| `Q` | **Quit** | Exits the menu cleanly. |

> **Note:** The menu requires a real TTY. Running in a non-interactive environment (piped stdin, CI) will produce a `setRawMode` error because `waitForKey()` depends on `process.stdin.setRawMode`.

### CLI subcommands

Individual actions can also be invoked directly, bypassing the menu:

| Command | Description |
|---------|-------------|
| `paralizer menu` | Open the interactive CLI menu (same as running with no arguments). |
| `paralizer serve` | Start the GUI server directly (requires `config.json`). |
| `paralizer setup` | Run the setup wizard directly. |
| `paralizer docs` | Generate documentation directly (requires `ctx` on PATH). |

Any unrecognised command prints the usage summary and exits with code 1:

```
Usage: paralizer [command]

Commands:
  menu    Interactive CLI menu (default)
  serve   Start the GUI server directly
  setup   Run the setup wizard
  docs    Generate CTX documentation

Options:
  --verbose  Show detailed configuration (with 'serve')
```

### Start Server Directly (`paralizer serve`)

The **serve** command starts the HTTP server without going through the interactive menu. It requires a valid `config.json` at the tool root.

```bash
paralizer serve
paralizer serve --verbose
```

**Behaviour:**

1. Calls `loadConfig()` to read `config.json`. If the file is absent or invalid, prints an error to stderr and suggests running `paralizer setup`, then exits with code 1.
2. Resolves the static GUI directory (`gui/public/`) relative to the tool root via `getToolRoot()`.
3. Calls `startServer()` with the loaded config. Prints the server URL on success:
   ```
   repo-parallelizer: Server listening on http://localhost:<port>
   ```
4. The server keeps the process alive until **Ctrl+C**.

**`--verbose` flag:** When passed (position-independent), prints all five config fields before starting the server:

```
repo-parallelizer: Configuration loaded successfully.
  projectsFolder:            /Users/me/projects
  storageFolder:             data/storage
  cloneDepth:                50
  serverPort:                4200
  gitPollingIntervalSeconds: 30
```

> **Note:** `paralizer serve` replicates the behaviour of the tool prior to Phase 7 (direct server launch without a menu). Use it in scripts or CI environments where a TTY is not available.

### Generate Docs (`paralizer docs`)

The **Generate Docs** action (available via the menu or `paralizer docs`) runs [CTX Generator](https://github.com/context-hub/generator) (`ctx generate`) from the tool root to produce the `.context/` documentation bundle.

**Prerequisites:** CTX Generator must be installed and available on `PATH`:

```bash
# Install via npm (example — see the CTX Generator README for the canonical install method)
npm install -g @context-hub/generator
```

**Behaviour:**

1. Checks whether `ctx` is on `PATH` using `spawnSync('ctx', ['--version'])`.
2. If available — runs `ctx generate` from the tool root with real-time terminal output (stdout/stderr piped to the terminal).
3. If not found — prints an error and the CTX Generator install URL, then returns to the menu.

**Exit codes:** success (`0`) prints a confirmation; any other exit code prints a failure message with the code.

## Configuration

At runtime the tool reads a `config.json` file located at the tool root (next to `package.json`). This file is **not committed** — create it locally before running the tool.

### Setup

#### Option A — Interactive setup wizard (recommended)

Run the built-in setup wizard to be guided through creating a valid `config.json` interactively:

```bash
paralizer setup
```

The wizard will:

1. Detect whether a `config.json` already exists and offer to overwrite it.
2. Prompt for `projectsFolder` — the root directory where repositories are cloned. Relative paths are resolved against the tool root. Non-existent directories are offered for automatic creation.
3. Prompt for `storageFolder` — the directory for internal data files (default: `data/storage`, relative to tool root). Same creation-on-demand behaviour as above.
4. Prompt for numeric settings with validated defaults:

   | Setting | Default | Constraint |
   |---------|---------|------------|
   | `cloneDepth` | `50` | integer ≥ 0 (0 = full clone) |
   | `serverPort` | `4200` | integer 1–65535 |
   | `gitPollingIntervalSeconds` | `30` | integer ≥ 10 |

5. Write `config.json` (4-space indented) and call `initializeStorage()` to create the storage directory structure.
6. Print a confirmation summary with next steps.

> **Tip:** Press **Enter** at any numeric prompt to accept the default value shown in brackets.

#### Option B — Manual setup

1. Copy `config.dist.json` to `config.json`:
   ```bash
   cp config.dist.json config.json
   ```
2. Open `config.json` and fill in the two required fields (`projectsFolder` and `storageFolder`).
3. **Remove the `_instructions` key** — it is an editorial note in the template and is not a valid config field. Leaving it in is harmless at runtime but may cause warnings with strict JSON schema validators.

A minimal `config.json` looks like this:

```json
{
  "projectsFolder": "/Users/me/projects",
  "storageFolder": "data/storage"
}
```

### config.json schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `projectsFolder` | `string` | ✅ | — | Root directory that contains the git repositories to parallelise. |
| `storageFolder` | `string` | ✅ | — | Directory used for internal storage. On first run, `repositories.json`, `projects-index.json`, and `error-log.json` are created here automatically. |
| `cloneDepth` | `number` | | `50` | Depth passed to `git clone --depth`. Use `0` for a full clone. |
| `serverPort` | `number` | | `4200` | TCP port the built-in HTTP server listens on. |
| `gitPollingIntervalSeconds` | `number` | | `30` | How often (in seconds) the tool polls git remotes for new commits. Can be changed at runtime without a restart via `PUT /api/config/polling` (minimum 10 s). |
| `gitCredentials` | `object` | | `{}` | Map of hostname → Personal Access Token (or password) for private repository access, e.g. `{ "github.com": "ghp_..." }`. Absent or empty means public repos only. |

### Private repository authentication

`gitCredentials` stores credentials **in plaintext** inside `config.json`. This is an accepted trade-off for a single-user local tool, but take these steps to limit exposure:

1. **Restrict file permissions** — run `chmod 600 config.json` after creating the file so only your user account can read it.
2. **Never commit `config.json`** — it is already listed in `.gitignore`, but verify this if you fork or copy the project to a new location.
3. **Use scoped PATs** — create tokens with the minimum required scope (typically read-only repository access) so that a leaked token has limited blast radius.

Example `gitCredentials` block:

```json
"gitCredentials": {
  "github.com": "ghp_your_token_here",
  "gitlab.company.com": "glpat-your_token_here"
}
```

Credentials are matched by hostname and injected into the clone/fetch URL at runtime. They are never written to log files or error messages.

### Storage structure

On first run, the tool calls `initializeStorage()` automatically. This creates the following structure under `storageFolder` (directories and seed files are created only if they do not already exist):

```
{storageFolder}/
  repositories.json       # { "Repositories": [], "SchemaVersion": 1 }
  projects-index.json     # { "Projects": [], "SchemaVersion": 1 }
  error-log.json          # { "Entries": [], "SchemaVersion": 1 }
  projects/               # per-project working directories (created by later phases)
{projectsFolder}/         # root directory for git repositories (must exist before first run)
```

> **Note:** `initializeStorage()` is idempotent — calling it again (e.g. on subsequent runs) does not overwrite or modify existing files.

### Repository management

`RepositoryManager` (`src/models/repository/repository.manager.ts`) provides stateless CRUD access to `repositories.json`. Every public method re-reads the file from disk on each call so that concurrent writes from other processes are always reflected.

#### Constructor

```typescript
new RepositoryManager(config: AppConfig)
```

`AppConfig` comes from `src/config/config.types.ts`; use `loadConfig()` to obtain it at runtime.

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `list` | `list(): Repository[]` | Returns all repositories in the store. |
| `getById` | `getById(id: string): Repository \| undefined` | Returns the repository with the given ID, or `undefined`. |
| `exists` | `exists(id: string): boolean` | Returns `true` when a repository with the given ID is in the store. |
| `add` | `add(params): Repository` | Adds a new repository. See parameters below. |
| `update` | `update(id: string, params: { name: string }): Repository` | Updates the `Name` of an existing repository. Throws if the ID does not exist. |
| `remove` | `remove(id: string): void` | Removes a repository by ID. Throws if the ID does not exist. |

#### `add()` parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | `string` | ✅ | Remote Git URL (HTTPS or SSH). |
| `name` | `string` | | Human-readable display name. Defaults to the resolved ID. |
| `id` | `string` | | Explicit repository ID. Validated via `isValidKebabCase()` after trimming (must be lowercase alphanumeric segments separated by single hyphens). When omitted, the ID is inferred from `url` via `inferSlugFromUrl()`. |

`add()` throws when:
- The explicit `id` is not valid kebab-case.
- `id` is omitted and the URL produces an empty slug.
- A repository with the same ID already exists.
- A repository with the same URL already exists.

### Path resolution rules

Both `storageFolder` and `projectsFolder` accept **relative or absolute paths**:

- **Relative path** — resolved against the tool root (the directory containing `package.json`), regardless of the current working directory when the tool is invoked.
- **Absolute path** — used as-is; no transformation is applied.

Examples:

| Value | Resolved to |
|-------|-------------|
| `"data/storage"` | `<toolRoot>/data/storage` |
| `"../shared/projects"` | `<toolRoot>/../shared/projects` (normalised by `path.resolve`) |
| `"/Users/me/projects"` | `/Users/me/projects` |

> **Note:** Path traversal sequences (e.g. `"../"`) in relative values are silently normalised by `path.resolve`. They may resolve to a directory outside the tool root — this is intentional for developer flexibility.

---

### Project management

`ProjectManager` (`src/models/project/project.manager.ts`) provides stateless CRUD access to per-project JSON files and the shared project index. Every public method re-reads from disk on each call.

#### Storage layout

`ProjectManager` uses a dual-file strategy:

```
{storageFolder}/
  projects-index.json     # lightweight listing: [{ Id, Name }, ...]
  projects/
    {id}.json             # full project data for each project
```

On first call the index file is created automatically if it does not exist.

#### Constructor

```typescript
new ProjectManager(config: AppConfig, repositoryManager: RepositoryManager)
```

`RepositoryManager` is injected for repository-existence validation inside `create()` and `addRepository()`.

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `list` | `list(): ProjectIndexEntry[]` | Returns all projects from the index. |
| `getById` | `getById(id: string): ProjectData \| undefined` | Returns full project data, or `undefined` if not found. |
| `create` | `create(name, repositoryIds, description?, id?): ProjectData` | Creates a new project. See parameters below. |
| `update` | `update(id, changes): ProjectData` | Updates `Name` and/or `Description`. Keeps the index in sync. |
| `rename` | `rename(oldId, newId): ProjectData` | Changes the project ID and renames the project file on disk. |
| `remove` | `remove(id): void` | Deletes the project file and removes the index entry. |
| `addRepository` | `addRepository(projectId, repositoryId): ProjectData` | Appends a repository ID to the project. |
| `removeRepository` | `removeRepository(projectId, repositoryId): ProjectData` | Removes a repository ID from the project. |

#### `create()` parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | ✅ | Human-readable project name. Used to generate the ID when `id` is omitted. |
| `repositoryIds` | `string[]` | ✅ | IDs of repositories to associate with the project. All must exist in RepositoryManager. |
| `description` | `string` | | Optional description text. Defaults to `''`. |
| `id` | `string` | | Explicit project ID. Validated via `isValidKebabCase()` after trimming (must be lowercase alphanumeric segments separated by single hyphens). When omitted, the ID is generated from `name` via `toKebabCase()`. |

`create()` throws when:
- The explicit `id` is not valid kebab-case.
- `id` is omitted and `name` produces an empty slug.
- Any repository ID in `repositoryIds` does not exist.
- A project with the resolved ID already exists.

`create()` auto-creates a `STABLE` workspace with the current ISO 8601 timestamp.

#### `rename()` parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `oldId` | `string` | ✅ | ID of the project to rename. |
| `newId` | `string` | ✅ | New project ID. Validated via `isValidKebabCase()` after trimming (must be lowercase alphanumeric segments separated by single hyphens). |

`rename()` throws when:
- `newId` is not valid kebab-case.
- No project with `oldId` exists.
- A project with `newId` already exists.

`rename()` writes the new file before deleting the old one, so no data is lost if the process is interrupted between the two disk operations.

---

### Workspace management

`WorkspaceManager` (`src/models/workspace/workspace.manager.ts`) provides stateless CRUD access to the Workspaces collection embedded inside each project's JSON file. All persistence is delegated to `ProjectManager` — `WorkspaceManager` has no storage files of its own.

#### The STABLE workspace invariant

Every project is guaranteed to have exactly one workspace with the ID `"STABLE"`. This workspace is auto-created when a project is created and **cannot be removed or renamed**:

- `remove()` throws if `workspaceId` is `"STABLE"`.
- `rename()` throws if `oldId` is `"STABLE"`.

The `isStable()` helper captures the definition of the reserved ID in a single place.

#### Constructor

```typescript
new WorkspaceManager(projectManager: ProjectManager)
```

`ProjectManager` is injected for all storage operations.

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `list` | `list(projectId: string): WorkspaceInfo[]` | Returns all workspaces for the project as flat `WorkspaceInfo` objects. |
| `getById` | `getById(projectId: string, workspaceId: string): WorkspaceInfo \| undefined` | Returns a single workspace, or `undefined` if not found. |
| `create` | `create(projectId, workspaceId, description?): WorkspaceInfo` | Creates a new workspace. See parameters below. |
| `update` | `update(projectId, workspaceId, changes): WorkspaceInfo` | Updates the `Description` of an existing workspace. |
| `rename` | `rename(projectId, oldId, newId): WorkspaceInfo` | Renames a workspace by changing its ID. Cannot be used on the STABLE workspace. |
| `remove` | `remove(projectId, workspaceId): void` | Removes a workspace. Cannot be used on the STABLE workspace. |
| `isStable` | `isStable(workspaceId: string): boolean` | Returns `true` if and only if `workspaceId` is `"STABLE"`. |

#### `create()` parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | `string` | ✅ | ID of the project to add the workspace to. |
| `workspaceId` | `string` | ✅ | ID for the new workspace. Must be 2–10 uppercase ASCII letters (A–Z), no digits or special characters (e.g. `"DEV"`, `"PROD"`). Validated via `isValidWorkspaceId()`. |
| `description` | `string` | | Optional description text. Defaults to `''`. |

`create()` throws when:
- `workspaceId` does not match the required format.
- The project does not exist.
- A workspace with the same ID already exists in the project.

#### `rename()` parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | `string` | ✅ | ID of the project containing the workspace. |
| `oldId` | `string` | ✅ | Current workspace ID. Must not be `"STABLE"`. |
| `newId` | `string` | ✅ | New workspace ID. Must be 2–10 uppercase ASCII letters; must not already exist in the project. |

`rename()` throws when:
- `oldId` is `"STABLE"`.
- `newId` does not match the required format.
- The project does not exist.
- The workspace with `oldId` does not exist.
- A workspace with `newId` already exists.

All mutations (`create`, `update`, `rename`, `remove`) update `DateModified` on the affected workspace entry.

---

### ID validation

All three managers validate explicit IDs at the storage layer:

- `ProjectManager.create(name, repos, desc, id?)` — the optional `id` parameter is validated via `isValidKebabCase()` after trimming.
- `ProjectManager.rename(oldId, newId)` — the `newId` parameter is validated via `isValidKebabCase()` after trimming.
- `RepositoryManager.add({ url, name, id? })` — the optional `id` parameter is validated via `isValidKebabCase()` after trimming.
- `WorkspaceManager.create()` / `WorkspaceManager.rename()` — workspace IDs are validated via `isValidWorkspaceId()`.

When an ID is omitted, it is derived automatically from the input string (`toKebabCase()` / `inferSlugFromUrl()`), which guarantees a safe value.

Path-traversal sequences (e.g. `../../etc/passwd`), uppercase characters, spaces, and other invalid formats are rejected with a descriptive error.

**Credential redaction:** `RepositoryManager.add()` redacts embedded credentials from URLs before interpolating them into error messages (e.g. `https://token@host/repo.git` → `https://***@host/repo.git`).

---

### Git CLI

`src/git/git-cli.ts` provides the low-level interface for spawning Git sub-processes. All commands are executed with `shell: false` — arguments must be supplied as a pre-split array — which eliminates shell injection entirely.

#### Types (`src/git/git.types.ts`)

| Type | Description |
|------|-------------|
| `GitResult` | Resolved value from `runGit()`. Contains `exitCode: number`, `stdout: string`, and `stderr: string`. |
| `GitStatusInfo` | Snapshot of a repository's working-tree status: `currentBranch`, `localCommits`, `unfetchedCommits`, `modifiedFiles`, `lastActivity`, `hasConflicts`. |
| `BranchInfo` | Metadata for a single branch: `name`, `isCurrent`, `isRemote`, `upstream?`. |
| `CloneOptions` | Options passed to `cloneRepository()`. Fields: `depth?` (shallow-clone commit limit), `branch?` (branch to check out), `bare?` (bare clone — no working tree). |

#### `runGit(args, cwd?)`

```typescript
runGit(args: string[], cwd?: string): Promise<GitResult>
```

Spawns `git` with the given arguments and returns a `GitResult`.

- **Resolves** for **all normal outcomes**, including non-zero exit codes. The caller must inspect `exitCode` to decide whether to treat the result as an error.
- **Rejects** only on spawn-level failures — specifically when the `git` binary is not found on `PATH` (rejection value is a `NodeJS.ErrnoException` with `code === 'ENOENT'`).
- When the process exits abnormally without a recorded exit code, `exitCode` falls back to `1` (null-coalesced).
- `stdout` and `stderr` are decoded as UTF-8 using `Buffer.concat` — multi-byte characters that span chunk boundaries are handled correctly.

#### `runGitOrThrow(args, cwd?)`

```typescript
runGitOrThrow(args: string[], cwd?: string): Promise<string>
```

Thin wrapper around `runGit()` that asserts success.

- **Resolves** with `stdout.trim()` when `exitCode === 0`.
- **Throws** an `Error` when `exitCode !== 0`. The error message has the form:
  ```
  git <subcommand> failed (exit <code>):
  <trimmed stderr>
  ```
  where `<subcommand>` is `args[0]` (e.g. `clone`, `fetch`). The full args array is **not** included to avoid exposing credential-bearing URLs in logs or error reporters.

#### `cloneRepository(url, destination, options?)`

```typescript
cloneRepository(url: string, destination: string, options?: CloneOptions): Promise<GitResult>
```

Clones a Git repository to a local path using `git clone`.

- **Resolves** for all normal outcomes including non-zero exit codes. Inspect `GitResult.exitCode` to detect failure.
- **Rejects** only on spawn-level failures (e.g. `ENOENT` when `git` is not on `PATH`).
- `options` defaults to `{}` — all fields are optional.

| Option | Type | Description |
|--------|------|-------------|
| `depth` | `number` | Truncate history to this many commits (`--depth <n>`). Must be a positive integer. Omit for a full clone. |
| `branch` | `string` | Check out this branch instead of the remote default (`--branch <name>`). |
| `bare` | `boolean` | Perform a bare clone (`--bare`). The destination contains only the Git object store with no working tree. Omit or set `false` for a normal clone. |

> **Note:** `CloneOptions.bare` is implemented but not covered by the current test suite. Bare clone behaviour (no working tree, `HEAD` reference, remote tracking) should be verified before relying on it in production workflows.

#### Security

- `shell: false` is always enforced — no shell expansion, globbing, or metacharacter processing occurs.
- Arguments are passed as a typed `string[]` directly to `spawn()`, preventing injection even when values come from user-supplied input.
- Error messages use only `args[0]` (the subcommand name), not the full args array, to avoid leaking credential-bearing URLs.

---

### Branch operations (`src/git/git-branch.ts`)

Seven stateless functions built over `runGit()` / `runGitOrThrow()`. All accept `repoPath: string` as their first argument pointing to a local repository.

#### `listBranches(repoPath)`

```typescript
listBranches(repoPath: string): Promise<BranchInfo[]>
```

Returns all branches (local and remote-tracking) as `BranchInfo[]`. Remote-tracking branches (e.g. `origin/main`) have `isRemote: true`. The currently checked-out branch has `isCurrent: true`. Symbolic remote HEAD pointers (e.g. `origin/HEAD`) are excluded.

#### `getCurrentBranch(repoPath)`

```typescript
getCurrentBranch(repoPath: string): Promise<string | null>
```

Returns the name of the currently checked-out branch, or `null` when the repository is in detached HEAD state.

#### `getDefaultBranch(repoPath)`

```typescript
getDefaultBranch(repoPath: string): Promise<string>
```

Returns the repository's default branch name. Resolution order:
1. Remote HEAD symbolic ref (`refs/remotes/origin/HEAD`)
2. Existence of a local or remote `main` branch
3. Existence of a local or remote `master` branch
4. Falls back to `"main"`

Always resolves (never rejects or throws).

#### `createBranch(repoPath, branchName)`

```typescript
createBranch(repoPath: string, branchName: string): Promise<GitResult>
```

Creates a new branch and immediately checks it out (`git checkout -b`). Resolves for all normal outcomes; inspect `exitCode` and `stderr` for conflict or validation errors.

- **Input guard:** returns `{ exitCode: 128, stderr: "fatal: '...' is not a valid branch name" }` immediately (without invoking git) if `branchName` starts with `'-'`. This prevents git from interpreting the name as a flag.

#### `switchBranch(repoPath, branchName)`

```typescript
switchBranch(repoPath: string, branchName: string): Promise<GitResult>
```

Switches to an existing branch (`git checkout`). Resolves for all normal outcomes including non-zero exit codes — the caller inspects `exitCode` and `stderr` (e.g. for conflict detection).

- **Input guard:** same `-` prefix guard as `createBranch()` — returns `exitCode: 128` immediately if `branchName` starts with `'-'`, preventing silent data-loss scenarios such as `git checkout --force` discarding uncommitted changes.

#### `branchExists(repoPath, branchName, remote?)`

```typescript
branchExists(repoPath: string, branchName: string, remote?: string): Promise<boolean>
```

Checks whether a branch exists by verifying the ref directly via `git rev-parse --verify`.

- When `remote` is omitted, checks the local ref (`refs/heads/<branchName>`).
- When `remote` is provided, checks the remote-tracking ref (`refs/remotes/<remote>/<branchName>`).

> **Warning:** `branchName` and `remote` are not validated against a safe refname pattern. A path-traversal value (e.g. `branchName = '../config'`) yields `refs/remotes/origin/../config`, which git resolves as `refs/remotes/config` and may return a false-positive `true` for a non-existent branch. Validate both parameters before passing untrusted input. A future cleanup WP will add the same `'-'` prefix guard already present on `createBranch()` and `switchBranch()`.

#### `fetchRemote(repoPath, remote?)`

```typescript
fetchRemote(repoPath: string, remote?: string): Promise<GitResult>
```

Fetches updates from a remote. When `remote` is omitted, git fetches all configured remotes. Resolves for all normal outcomes including non-zero exit codes.

> **Note:** Unlike `createBranch()` and `switchBranch()`, `fetchRemote()` does not validate the `remote` parameter against a `'-'` prefix guard. Passing `'--all'` executes `git fetch --all` (fetches all remotes) rather than failing. A future cleanup WP will address this asymmetry.

#### Input validation asymmetry

`createBranch()` and `switchBranch()` reject branch names starting with `'-'` (returning `exitCode: 128` immediately) because `git checkout` cannot use `--` to delimit the branch name from flags. `branchExists()` and `fetchRemote()` do not yet have this guard — they are lower-risk (no data-loss path) and the guard is planned for a future cleanup WP.

---

### Status operations (`src/git/git-status.ts`)

Two functions that query the working-tree status of a local repository. All underlying Git sub-commands are run in parallel via `Promise.all()` — the result is a single `GitStatusInfo` snapshot.

#### `getGitStatus(repoPath)`

```typescript
getGitStatus(repoPath: string): Promise<GitStatusInfo>
```

Returns a `GitStatusInfo` snapshot of the repository's current state.

| Field | Type | Description |
|-------|------|-------------|
| `currentBranch` | `string \| null` | Checked-out branch name; `null` when HEAD is detached. |
| `localCommits` | `number` | Commits the local branch is ahead of its upstream tracking branch. `0` when no upstream is configured. |
| `unfetchedCommits` | `number` | Commits the upstream tracking branch is ahead of the local branch. Reflects the last-fetched remote state — call `fetchAndGetStatus()` for a live count. `0` when no upstream is configured. |
| `modifiedFiles` | `number` | Number of entries reported by `git status --porcelain` (staged, unstaged, and untracked). |
| `lastActivity` | `string \| null` | ISO 8601 timestamp of the most recent commit; `null` for an empty repository. |
| `hasConflicts` | `boolean` | `true` when the working tree contains unresolved merge conflicts. Detected by inspecting the two-character XY codes in the porcelain output (e.g. `UU`, `AA`, `DD`, `AU`, `UA`, `DU`, `UD`). |

#### `fetchAndGetStatus(repoPath)`

```typescript
fetchAndGetStatus(repoPath: string): Promise<GitStatusInfo>
```

Fetches updates from the `origin` remote, then returns the working-tree status via `getGitStatus()`.

The fetch is best-effort: failures (network error, missing remote, authentication rejection) are silently ignored so the status query always succeeds. When a fetch fails, `unfetchedCommits` reflects the last known remote state rather than the current live count.

---

### Branch orchestrator (`src/orchestration/branch-orchestrator.ts`)

`BranchOrchestrator` composes the stateless git layer (`git-branch.ts`) with the data-model managers to provide high-level branch operations across all repositories in a workspace.

#### Constructor

```typescript
new BranchOrchestrator(
    config: AppConfig,
    projectManager: ProjectManager,
    workspaceManager: WorkspaceManager,
    errorLogManager?: ErrorLogManager,
)
```

All three required dependencies are injected via constructor. The optional `errorLogManager` parameter enables error log integration — when provided, `switchBranches()` appends an entry for each per-repository failure. When omitted, all logging is silently skipped and the orchestrator behaves identically to prior behaviour.

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `getAvailableBranches` | `getAvailableBranches(projectId, workspaceId): Promise<Map<string, BranchInfo[]>>` | Fetches from remote and returns all branches for every repository in the workspace. |
| `compileBranchSuggestions` | `compileBranchSuggestions(branchMap): string[]` | Produces a deduplicated, sorted branch-name list from a `getAvailableBranches()` result. |
| `switchBranches` | `switchBranches(projectId, workspaceId, branchAssignments): Promise<BranchSwitchResult>` | Switches (or creates) the specified branch in each repository concurrently. |

#### `getAvailableBranches(projectId, workspaceId)`

```typescript
getAvailableBranches(projectId: string, workspaceId: string): Promise<Map<string, BranchInfo[]>>
```

Fetches from `origin` in every repository belonging to the project, then calls `listBranches()` to build the result map.

- Fetch failures (no network, no remote configured) are silently ignored so the list always reflects at least the locally known state.
- Returns a `Map` keyed by repository ID — the same IDs used in `ProjectManager`.

**Throws** `Error` when the project does not exist (`"Cannot get branches: project "…" does not exist."`). Validates existence eagerly before any git operations begin.

#### `compileBranchSuggestions(branchMap)`

```typescript
compileBranchSuggestions(branchMap: Map<string, BranchInfo[]>): string[]
```

Reduces a full branch map to a flat, UI-ready list:

- Remote-tracking refs (e.g. `origin/main`) are normalised to their short form (`main`) so a branch known both locally and as a remote-tracking ref appears only once.
- Deduplication is **case-insensitive**; the first-seen casing is preserved.
- The returned list is sorted with `localeCompare`.

#### `switchBranches(projectId, workspaceId, branchAssignments)`

```typescript
switchBranches(
    projectId: string,
    workspaceId: string,
    branchAssignments: Record<string, string>,
): Promise<BranchSwitchResult>
```

Switches each repository listed in `branchAssignments` to the specified branch name. All repositories run concurrently via `Promise.all()`.

For each `repoId → branchName` entry:
- If the branch does not exist locally **or** as a remote-tracking ref, it is created with `git checkout -b`.
- If the branch already exists (locally or remotely), the repository is switched to it with `git checkout`.

The workspace's `DateModified` timestamp is updated only when at least one per-repository branch switch succeeded. When every operation fails, the timestamp is left unchanged to avoid recording a modification that never actually happened.

**Return value** (`BranchSwitchResult`):

```typescript
{
    results: {
        [repoId: string]: {
            success: boolean;
            conflict: boolean;
            error?: string;   // set when success is false
        };
    };
}
```

**Throws** `Error` when the project or workspace does not exist. Unlike `getAvailableBranches()`, existence is **not** validated up front — any error surfaces only when `workspaceManager.update()` is called at the end, after all per-repository operations have already completed.

> **Conflict detection:** When a switch fails, the `stderr` output is scanned for `/conflict/i` and `/overwritten by (checkout|switch)/i` patterns. If either matches, `conflict` is set to `true`; otherwise `conflict` is `false` and the raw git error is available in `error`. Because git error messages vary across versions and platforms, callers should treat `conflict === true` as a strong signal but also check `error` for platform-specific failure modes.

> **Error log propagation:** When `errorLogManager` is injected and `errorLogManager.append()` itself throws (for example, when the disk is full at log-write time), that exception propagates out of the `Promise.all` callback and converts a partial per-repository failure into a full rejection of `switchBranches()`. Logging exceptions are not swallowed. The same applies to `WorkspaceOrchestrator.createWorkspace()` and `RepositoryOrchestrator.addRepositoryToProject()`.

---

## Development Notes

### TypeScript module resolution (Node16)

This project uses `"module": "Node16"` and `"moduleResolution": "Node16"` in `tsconfig.json`. This is the most accurate emulation of how Node.js ESM natively resolves modules.

**Consequence:** all relative imports in TypeScript source files **must include the `.js` extension**, even though you are writing `.ts` files:

```typescript
// Correct
import { foo } from './utils.js';

// Wrong — will produce a TypeScript error
import { foo } from './utils';
```

TypeScript resolves `./utils.js` to `./utils.ts` at compile time, then emits `./utils.js` in the output, which is what Node.js requires at runtime. Omitting the extension will cause both a compile error and a runtime module-not-found error.

### Build output

Compilation targets ES2022 and outputs to `dist/`. Source maps are generated alongside each file (`*.js.map`). The `dist/` directory is excluded from version control via `.gitignore`.

### Ignored files

| Path | Reason |
|------|--------|
| `dist/` | Compiled output — regenerate with `npm run build` |
| `node_modules/` | Dependencies — regenerate with `npm install` |
| `config.json` | Local runtime configuration — not committed |

---

## GUI Frontend

The browser-based GUI is a single-page application (SPA) served directly from `gui/public/`. It uses plain HTML, CSS, and vanilla JavaScript (ES modules) with no build step or bundler. The backend HTTP server (Phase 5) serves these files as static assets.

### Deployment model

> **This tool is designed for `localhost` and trusted intranet use only.**

The GUI has no authentication or authorisation layer. Any user who can reach the server port can:

- Read all repository, project, and workspace data.
- View the full error log, including raw error messages, stack details, project names, workspace IDs, and repository names surfaced verbatim in the detail panel.
- Execute destructive actions (delete repositories, projects, workspaces; clear the error log; switch branches).

**Do not expose the server port to the internet or to shared multi-user environments.** If you must expose the tool beyond localhost, place it behind a reverse proxy with HTTP Basic Authentication or equivalent access control, and ensure TLS termination is in place.

### Architecture overview

```
gui/public/
├── index.html                      # SPA shell: layout, nav, #app mount point, #toast-container
├── css/
│   └── styles.css                  # All application styles
└── js/
    ├── app.js                      # Bootstrap: initialises router, registers all routes
    ├── router.js                   # Hash-based client-side router
    ├── api.js                      # Fetch wrapper — all HTTP calls go through here
    ├── components/
    │   ├── confirm-dialog.js       # Promise-based modal confirmation dialog
    │   ├── status-badge.js         # Git status badge DOM component
    │   ├── toast.js                # Transient notification toasts
    │   └── form-helpers.js         # Form field factory and required-field validation
    └── views/
        ├── branch-switch.js        # #/projects/:id/workspaces/:wid/branch-switch — 3-step branch switch wizard
        ├── dashboard.js            # #/ — project list + create-project form
        ├── error-log.js            # #/error-log — filterable error log viewer
        ├── project-detail.js       # #/projects/:id — project detail & workspace list
        ├── repositories.js         # #/repositories — repository list & management
        └── workspace-detail.js     # #/projects/:id/workspaces/:wid — workspace status & actions
```

Routing is hash-based (`#/repositories`, `#/projects/my-project`, etc.). The router intercepts `hashchange` events and renders the matching view into the `#app` container. Each view is a JS module that builds DOM elements and binds event handlers.

### Route registry

All routes are registered in `app.js`. The full route table is:

| Hash pattern | View module | Description |
|---|---|---|
| `#/` | `views/dashboard.js` | Project list (default landing page) |
| `#/repositories` | `views/repositories.js` | Repository list and management |
| `#/error-log` | `views/error-log.js` | Filterable error log viewer |
| `#/projects/:id` | `views/project-detail.js` | Project detail and workspace list |
| `#/projects/:id/workspaces/:wid` | `views/workspace-detail.js` | Workspace detail, live status, and actions |
| `#/projects/:id/workspaces/:wid/branch-switch` | `views/branch-switch.js` | 3-step branch switch wizard |

The router starts automatically on page load via `router.start()`. Navigating to an unregistered hash renders a 404 message. An empty hash (`""`) is normalised to `#/` so the dashboard always loads as the default view.

---

### Project Detail view (`views/project-detail.js`)

The project detail view is rendered at `#/projects/:id`. It fetches all required data in **parallel** (project record, workspace list, and global repository list via `Promise.all`) before rendering the page.

#### Sections rendered

| Section | Description |
|---------|-------------|
| **Metadata** | Project ID and name as a page heading; inline description editor. Clicking **Edit Description** reveals a textarea; **Save** calls `PUT /api/projects/:id`; **Cancel** restores the read-mode display. |
| **Repositories** | Lists repositories currently in the project. Each row shows name and ID, plus a **Remove** button (requires confirmation dialog). An **Add Repository** select picker lists only repos not already in the project and calls `POST /api/projects/:id/repositories`. When all global repositories are already added, the picker is replaced by an informational message. |
| **Workspaces** | Table of all workspaces (ID, description, creation date, actions). Each workspace ID is a link to `#/projects/:id/workspaces/:wid`. The **STABLE** workspace's Delete button is visually disabled and non-functional — the `disabled` attribute and `btn-disabled` CSS class are applied, and the button carries a `title` tooltip explaining the restriction. Non-STABLE workspaces can be deleted after confirmation. |
| **Add Workspace** | Collapsible form toggled by **+ Add Workspace**. Validates workspace ID against `/^[A-Z]{2,10}$/` (2–10 uppercase letters, no digits or special characters) before calling `POST /api/projects/:id/workspaces`. |
| **Danger Zone** | Two actions: **Rename Project** (calls `PUT /api/projects/:id/rename`, then navigates to `#/projects/:newId`) and **Delete Project** (calls `DELETE /api/projects/:id`, then navigates to `#/`). Both require confirmation dialogs. Rename is client-side-guarded against identical IDs. |

#### Refresh strategy

After any successful mutation (add/remove repository, add/delete workspace), the view re-renders itself by calling `renderProjectDetail` recursively (`refresh()`). This **full-refresh-on-mutation** approach re-issues all three parallel API calls (`GET /api/projects/:id`, `GET /api/projects/:id/workspaces`, `GET /api/repositories`) and rebuilds the entire DOM from scratch. This is intentional: it guarantees UI consistency without stateful diffing and is correct for current usage scale. A targeted section re-render (e.g. refreshing only the workspace list) is a deferred optimisation.

#### Router injection

`project-detail.js` exports a `setRouter(router)` function (in addition to `renderProjectDetail`) so that it can call `router.navigate()` on rename and delete without creating a circular dependency with `app.js`. `app.js` calls `setProjectDetailRouter(router)` (aliased from `setRouter`) **before** calling `router.start()`.

The injected `_router` reference is null-guarded in three places — the back-link handler, the workspace link handler, and post-rename/post-delete navigation — so the view remains usable in test contexts where no router is injected.

#### Key casing

The Go backend returns project and workspace fields with capitalised keys (`Id`, `Name`, `Repositories`, etc.). `project-detail.js` normalises both forms via three shared helpers imported from `utils/normalise.js`: `normaliseProject()`, `normaliseRepo()`, and `normaliseWorkspace()`. See the [Normalisation helpers note](#normalisation-helpers-note) below.

---

### Repositories view (`views/repositories.js`)

The repositories view is rendered at `#/repositories`. It provides full CRUD management for all registered repositories.

#### Sections rendered

| Section | Description |
|---------|-------------|
| **Repository table** | Lists all repositories with **ID**, **Name**, and **URL** (hyperlinked) columns, fetched from `GET /api/repositories`. Shows an empty-state message when no repositories exist. |
| **Inline Name edit** | Each row has an **Edit** button that replaces the Name cell with a text `<input>` and **Save** / **Cancel** action buttons. Saving calls `PUT /api/repositories/:id`; Escape key or Cancel restores read mode without an API call. |
| **Delete** | Each row has a **Delete** button that shows a confirmation dialog warning that the repository will be removed from all projects. Confirming calls `DELETE /api/repositories/:id` and removes the row from the table. |
| **Add Repository form** | An inline **Add Repository** section below the table. **URL** is required; **Name** and **ID** are optional (omitted as `undefined` when blank, not sent as empty strings). Submitting calls `POST /api/repositories`, shows a success toast, and refreshes the table. |

All API errors (list load failures, create/update/delete failures) are displayed as error toasts via `showToast()`.

#### Key casing

`repositories.js` normalises backend response keys via `normaliseRepo()` imported from `utils/normalise.js` — see the [Normalisation helpers note](#normalisation-helpers-note) below.

---

### Workspace Detail view (`views/workspace-detail.js`)

The workspace detail view is rendered at `#/projects/:id/workspaces/:wid`. It shows the live Git status of all repositories in the workspace and provides workspace management actions.

#### Data loading

On mount, three API calls are issued in **parallel** via `Promise.all`:

| Call | API endpoint | Used for |
|------|-------------|---------|
| `api.workspaces.get(projectId, wid)` | `GET /api/projects/:id/workspaces/:wid` | Workspace metadata (ID, description) |
| `api.projects.get(projectId)` | `GET /api/projects/:id` | Project's repository list |
| `api.status.get(projectId, wid)` | `GET /api/projects/:id/workspaces/:wid/status` | Initial Git status for all repos |

If any of the three calls fails, an error state is rendered with a **← Back to Project** link and no polling is started.

#### Sections rendered

| Section | Description |
|---------|-------------|
| **Header** | Breadcrumb (`projectId → workspaceId`), workspace title (`Workspace: <ID>`), and description when non-empty. The breadcrumb project link calls `router.navigate()`. |
| **Repository Status table** | One row per repository showing: repository name (+ ID hint when different), current branch name, and a color-coded `createStatusBadge()` element. Rows use `data-repo-id` for in-place polling updates. |
| **Actions** | Three actions: **Switch Branches** (navigates to `#/projects/:id/workspaces/:wid/branch-switch`), **Rename Workspace** (inline form, disabled for STABLE), and **Delete Workspace** (confirmation dialog, disabled for STABLE). |

#### Live status polling

After the initial render, a `setInterval` (10 s, constant `POLL_INTERVAL_MS`) calls `api.status.get()` and passes the result to `updateStatusTable()`. The update function locates rows by `[data-repo-id]` selector using `CSS.escape()` and replaces only the badge wrapper and branch-cell text — the table structure is never fully re-rendered. Polling errors are silently swallowed; stale badges remain until the next successful poll. Polling is skipped when the project has no repositories.

#### Cleanup contract

`renderWorkspaceDetail` returns a **cleanup function** that calls `clearInterval` on the polling interval and sets it to `null` (idempotent). The router's `_render()` method stores and calls this function before rendering the next view. No changes to `router.js` were required.

#### STABLE workspace guards

Both **Rename Workspace** and **Delete Workspace** are disabled (HTML `disabled` attribute + `btn-disabled` CSS class + `title` tooltip) when `wid === 'STABLE'`. The guard is applied symmetrically to both buttons.

#### Rename workflow

Clicking **Rename Workspace** reveals an inline form. The new workspace ID is validated against `WORKSPACE_ID_PATTERN` (`/^[A-Z]{2,10}$/`, imported from `form-helpers.js`) before showing a confirmation dialog. On success, `api.workspaces.rename()` is called and the router navigates to the new workspace URL (`#/projects/:id/workspaces/:newId`).

#### Router injection

`workspace-detail.js` exports `setRouter(router)` (called from `app.js` as `setWorkspaceDetailRouter`). The `_router` reference is null-guarded at every navigation site so the view remains functional in test environments.

#### Key casing

`workspace-detail.js` normalises backend responses via `normaliseProject()` and `normaliseWorkspace()` (imported from `utils/normalise.js`), plus `extractRepoId()` and `extractRepoName()` (local helpers). See the [Normalisation helpers note](#normalisation-helpers-note) below.

---

### Branch Switch Wizard (`views/branch-switch.js`)

The branch switch wizard is rendered at `#/projects/:id/workspaces/:wid/branch-switch`. It guides the user through selecting a target branch, optionally customising per-repository assignments, and executing the switch — all within a 3-step wizard flow.

#### Step overview

| Step | Name | Description |
|------|------|-------------|
| 1 | **Choose Branch** | Text input with `<datalist>` autocomplete and clickable suggestion pills populated from `api.branches.list()`. Validates that the input is non-empty before advancing. |
| 2 | **Assign Per-Repo Branches** | Table with one row per repository. Each row has a text input pre-filled with the Step 1 branch and a `<select>` dropdown. The Step 1 branch appears in a separate **"Selected"** `<optgroup>` at the top; all other known branches appear in an **"Available Branches"** `<optgroup>` below. Selecting a dropdown option copies the value into the corresponding text input. |
| 3 | **Results** | Calls `api.branches.switch()` with the collected `{ repoId → branchName }` assignments, shows a loading spinner during the API call, then renders a per-repo results table. |

#### Navigation behaviour

- **Next** (Step 1 → 2): validates that the branch name input is non-empty. An `aria-invalid` attribute and an inline error `<span>` are shown when validation fails.
- **Back** (Step 2 → 1): restores the previously entered branch name. The Step 1 API response is **cached in closure variables** (`savedBranchName` / `savedBranchData`) — navigating Back reuses the cached data instead of re-fetching from `api.branches.list()`.
- **Confirm** (Step 2 → 3): collects `data-repo-id` + `.branch-assignment-input` values. When a text input has been cleared by the user, the assignment silently falls back to the Step 1 branch (`inp.value.trim() || chosenBranch`). This prevents submitting empty branch names; users who intentionally clear a field will receive the global branch rather than a validation error.
- **Done** (Step 3 → workspace): navigates back to `#/projects/:id/workspaces/:wid` via `_router.navigate()`, falling back to `location.hash` when no router is injected.

#### Results table

Each row shows the repository ID, an outcome label, and a detail cell:

| Outcome | Label | Detail |
|---------|-------|--------|
| `success === true`, `conflict === false` | **Success** (green) | `—` |
| `conflict === true` | **Conflict** (red) | `"Merge conflicts detected. Please resolve conflicts manually in your editor."` |
| `success === false`, `conflict === false` | **Error** (red) | Raw git error string from the `error` field |

A summary banner is shown above the table:

- **All success** → `"All branches switched successfully."` (green)
- **Any conflict** → `"Some repositories have merge conflicts. Please resolve them manually."` (red)
- **Any error (no conflicts)** → `"Some repositories encountered errors during the branch switch."` (red)

> **Backend contract:** `POST /api/projects/:id/workspaces/:wid/branches/switch` must always return a non-empty `results` object. The view guards against an empty `{}` response (rendering `"No results returned."`) as a defensive measure, but this is not a normal code path — the backend should always return at least one result entry per submitted assignment.

#### Error handling

| Error site | Behaviour |
|-----------|-----------|
| `api.branches.list()` fetch failure (Step 1) | Renders an error `<div>` with the error message and a **Retry** button that re-invokes `renderStep1()`. |
| `api.branches.switch()` call failure (Step 3) | Renders an error `<div>`, shows an error toast via `showToast()`, and provides a **← Back to Workspace** button that navigates to `#/projects/:id/workspaces/:wid`. |

#### Router injection

`branch-switch.js` exports `setRouter(router)` (called from `app.js` as `setBranchSwitchRouter`). The `_router` reference is null-guarded at every navigation site — the breadcrumb links, the Done button, and the Back to Workspace error button — so the view remains functional in test contexts where no router is injected.

#### Breadcrumb

The page renders a 3-segment breadcrumb: `projectId / workspaceId / Switch Branches`. The first two segments are clickable links wired to `_router.navigate()` when a router is available.

---

### Dashboard view (`views/dashboard.js`)

The dashboard is the landing page rendered at `#/`. It displays all projects fetched from `GET /api/projects` and provides a "Create Project" inline form.

#### Project grid

Each project is rendered as a card showing:
- **Name** — links to `#/projects/:id`; clicking calls `router.navigate()` (no full page reload).
- **ID** — displayed as secondary metadata below the name.
- **Description** — shown when non-empty.
- **Repository count** — derived from the `Repositories` / `repositories` array on the project object.
- **Workspace count** — fetched in parallel via `api.workspaces.list(id)`. Failures degrade gracefully: the count shows as `0 workspaces` rather than breaking the grid.

> **Note on key casing:** The Go backend returns project fields with capitalised keys (`Id`, `Name`, `Description`, `Repositories`). The dashboard normalises both forms; see `ProjectResponse` in `api.js` for details.

#### Create Project form

The **+ Create Project** button toggles an inline form with:
- **Name** (required) — used as the project display name; the backend derives the kebab-case ID automatically.
- **Description** (optional) — omitted from the API call when left blank (sent as `undefined`, not `""`).

On success: a success toast is shown, the form is reset and hidden, and the project list refreshes. On failure: an error toast shows the message from the API error response.

---

### Error Log view (`views/error-log.js`)

The error log view is rendered at `#/error-log`. It provides a paginated, filterable table of all error log entries recorded by the backend and exposes a destructive **Clear All** action.

> **Deployment note:** The error log view surfaces raw backend operational data — error messages, stack details, project names, workspace IDs, and repository names — verbatim in the detail panel. This is by design for a developer tool. **The GUI should only be served on `localhost` or within a trusted intranet.** Do not expose the server port to the internet or to shared / multi-user environments. See [Configuration → Server port](#configjson-schema) and [Security](#security) for hardening guidance.

#### Features

| Feature | Description |
|---------|-------------|
| **Entry table** | Fetches entries from `GET /api/error-log` on mount and displays them in a table with **Severity**, **Source**, **Message**, and **Time** columns. |
| **Severity filter** | Dropdown (`All Severities`, `Error`, `Warning`) — re-fetches from the API on each change. |
| **Source filter** | Dropdown (`All Sources`, `Clone`, `Branch Switch`, `Fetch`, `Polling`, `Storage`, `Route Handler`) — re-fetches from the API on each change. |
| **Expandable detail rows** | Clicking (or pressing Enter/Space on) a table row toggles an inline `<pre>` detail block below it showing the full entry JSON. The toggle is keyboard-accessible (`aria-expanded` attribute updated). |
| **Relative timestamps** | Each entry's timestamp is displayed as a human-readable relative string (e.g. `"3 min ago"`). The full ISO 8601 timestamp is available in the `title` tooltip. |
| **Severity badges** | Severity is rendered as a coloured pill using CSS classes `.severity-error` (red) and `.severity-warning` (amber), both defined in `styles.css`. |
| **Clear All** | Prompts a confirmation dialog, then calls `DELETE /api/error-log`. On success, filters reset to `All` and the table reloads. |
| **XSS safety** | All dynamic text is set via `textContent` — no `innerHTML` usage anywhere in the view. |

#### Key functions

| Function | Description |
|----------|-------------|
| `renderErrorLog(container, _params)` | Entry point exported to the router. Builds the filter bar and table scaffold, then calls `loadEntries()`. |
| `loadEntries()` | Calls `api.errorLog.list()` with current filter state and populates the `<tbody>` via `buildEntryRows()`. |
| `buildEntryRows(entries)` | Creates a main `<tr>` and a hidden detail `<tr>` per entry. Wires click and keyboard handlers for expand/collapse. |
| `buildSeverityBadge(severity)` | Returns a `<span>` with class `severity-badge severity-{error|warning}`. Falls back to a plain badge with `—` text for empty/unknown severities. |
| `relativeTime(isoString)` | Converts an ISO 8601 timestamp to a human-readable relative string. Falls back to the raw string on parse failure. |
| `onClearAll()` | Shows a confirmation dialog, calls `api.errorLog.clear()`, shows a success toast, and resets the filter state. |

#### Normalisation

Backend entries use PascalCase keys (`Id`, `Severity`, `Source`, `Message`, `Details`, `Context`, `Timestamp`). The view normalises them via `normaliseErrorEntry()` imported from `utils/normalise.js`.

---

### API client (`gui/public/js/api.js`)

All communication with the backend REST API goes through the `api` object exported from `api.js`. It is organised into six namespaces, one per resource type. All methods return Promises and throw an `Error` (message taken from the `error` field in the JSON response body) for any non-2xx response.

```js
import { api } from './api.js';
```

#### Error handling

Non-2xx responses throw an `Error` whose message is taken from the `error` field in the JSON response body. When the body is not JSON (e.g. a plain-text proxy error), the HTTP `statusText` is used as the fallback. HTTP 204 No Content responses resolve with `undefined`.

#### `api.repositories`

| Method | HTTP | URL | Body | Returns |
|--------|------|-----|------|---------|
| `list()` | GET | `/api/repositories` | — | `Object[]` |
| `get(id)` | GET | `/api/repositories/:id` | — | `Object` |
| `create(data)` | POST | `/api/repositories` | `{ url, name?, id? }` | `Object` (201) |
| `update(id, data)` | PUT | `/api/repositories/:id` | `{ name }` | `Object` |
| `delete(id)` | DELETE | `/api/repositories/:id` | — | `undefined` (204) |

#### `api.projects`

| Method | HTTP | URL | Body | Returns |
|--------|------|-----|------|---------|
| `list()` | GET | `/api/projects` | — | `ProjectResponse[]` |
| `get(id)` | GET | `/api/projects/:id` | — | `ProjectResponse` |
| `create(data)` | POST | `/api/projects` | `{ name, repositoryIds?, description?, id? }` | `ProjectResponse` (201) |
| `update(id, data)` | PUT | `/api/projects/:id` | `{ name?, description? }` | `ProjectResponse` |
| `rename(id, newId)` | PUT | `/api/projects/:id/rename` | `{ newId }` | `ProjectResponse` |
| `delete(id)` | DELETE | `/api/projects/:id` | — | `undefined` (204) |
| `addRepository(projectId, repoId)` | POST | `/api/projects/:id/repositories` | `{ repositoryId }` | `ProjectResponse` |
| `removeRepository(projectId, repoId)` | DELETE | `/api/projects/:id/repositories/:repoId` | — | `undefined` (204) |

**`ProjectResponse` shape:** The backend Go model serialises project fields using capitalised keys (`Id`, `Name`, `Description`, `Repositories`). View code must normalise both casings — see the `@typedef ProjectResponse` JSDoc in `api.js` for the canonical definition and a normalisation example.

#### `api.workspaces`

| Method | HTTP | URL | Body | Returns |
|--------|------|-----|------|---------|
| `list(projectId)` | GET | `/api/projects/:id/workspaces` | — | `Object[]` |
| `get(projectId, wid)` | GET | `/api/projects/:id/workspaces/:wid` | — | `Object` |
| `create(projectId, data)` | POST | `/api/projects/:id/workspaces` | `{ workspaceId, description? }` | `Object` (201) |
| `update(projectId, wid, data)` | PUT | `/api/projects/:id/workspaces/:wid` | `{ description }` | `Object` |
| `rename(projectId, wid, newId)` | PUT | `/api/projects/:id/workspaces/:wid/rename` | `{ newId }` | `Object` |
| `delete(projectId, wid)` | DELETE | `/api/projects/:id/workspaces/:wid` | — | `undefined` (204) |

#### `api.branches`

| Method | HTTP | URL | Body | Returns |
|--------|------|-----|------|---------|
| `list(projectId, wid)` | GET | `/api/projects/:id/workspaces/:wid/branches` | — | `{ branches: Record<repoId, BranchInfo[]>, suggestions: string[] }` |
| `switch(projectId, wid, assignments)` | POST | `/api/projects/:id/workspaces/:wid/branches/switch` | `{ assignments: Record<repoId, branchName> }` | `{ results: Record<repoId, { success, conflict, error? }> }` |

`suggestions` is a pre-computed, case-insensitive-deduplicated flat list of branch names across all repositories — ready for use in a branch-name autocomplete or dropdown.

#### `api.errorLog`

| Method | HTTP | URL | Body | Returns |
|--------|------|-----|------|---------|
| `list(params?)` | GET | `/api/error-log` | — | `{ entries: Object[], total: number }` |
| `get(id)` | GET | `/api/error-log/:id` | — | `Object` |
| `clear()` | DELETE | `/api/error-log` | — | `undefined` (204) |
| `count()` | GET | `/api/error-log?limit=0` | — | `{ total: number }` |

**`list()` query parameters** (all optional):

| Parameter | Type | Description |
|-----------|------|-------------|
| `severity` | `string` | Filter by severity (`'error'`, `'warning'`). Omit or pass `'all'` for no filter. |
| `source` | `string` | Filter by source (`'clone'`, `'branch-switch'`, `'fetch'`, `'polling'`, `'storage'`, `'route-handler'`). Omit or pass `'all'` for no filter. |
| `limit` | `number` | Maximum entries to return. |
| `offset` | `number` | Entry offset for pagination. |

Parameters are passed as a `URLSearchParams`-encoded query string — all values are percent-encoded automatically. `severity: 'all'` and `source: 'all'` are omitted from the request rather than sent as literal `'all'` strings; the view handles this by only passing non-`'all'` values to `list()`.

`count()` is a convenience method for badge/counter display — it returns only the `total` field with no entry payload (equivalent to `GET /api/error-log?limit=0`).

#### `api.status`

| Method | HTTP | URL | Body | Returns |
|--------|------|-----|------|---------|
| `get(projectId, wid)` | GET | `/api/projects/:id/workspaces/:wid/status` | — | `Record<repoId, GitStatusInfo \| null>` |
| `refresh(projectId, wid)` | POST | `/api/projects/:id/workspaces/:wid/status/refresh` | — | `Record<repoId, GitStatusInfo \| null>` |

`refresh()` forces a live git poll before returning; `get()` returns the last cached result. Each `GitStatusInfo` value has: `currentBranch`, `localCommits`, `unfetchedCommits`, `modifiedFiles`, `lastActivity`, `hasConflicts`.

> **URL encoding:** All path segments (IDs, workspace IDs) are wrapped in `encodeURIComponent()` before being interpolated into URLs. This is handled transparently by the internal `request()` helper; callers pass raw ID strings.

#### `api.config`

Runtime configuration endpoints. Changes take effect immediately — the in-memory `appConfig` is mutated and the new value is persisted to `config.json`.

**Polling interval**

| Method | HTTP | URL | Body | Returns |
|--------|------|-----|------|---------|
| `getPolling()` | GET | `/api/config/polling` | — | `{ gitPollingIntervalSeconds: number }` |
| `setPolling(seconds)` | PUT | `/api/config/polling` | `{ seconds: number }` | `{ gitPollingIntervalSeconds: number }` |

`setPolling(seconds)` validates that `seconds` is a finite integer ≥ 10. Any other value (fractional, non-numeric, below minimum, infinite, NaN) returns HTTP 400 with a descriptive error message. On success the background polling loop is restarted at the new interval immediately — no process restart required.

**Git credentials**

| Method | HTTP | URL | Body | Returns |
|--------|------|-----|------|---------|
| `getCredentials()` | GET | `/api/config/credentials` | — | `Record<host, maskedToken>` |
| `setCredential(host, token)` | PUT | `/api/config/credentials` | `{ host: string, token: string }` | `Record<host, maskedToken>` |
| `deleteCredential(host)` | DELETE | `/api/config/credentials/:host` | — | `Record<host, maskedToken>` |

Tokens are **never returned in full** — all responses apply `maskToken()`, which exposes only the last 4 characters (e.g. `****ab12`). Tokens shorter than 4 characters are fully masked as `****`.

---

### Components

All components are ES modules under `gui/public/js/components/`. They have no external dependencies and manipulate the DOM directly using `textContent` (never `innerHTML`) to prevent XSS.

---

#### Confirmation dialog (`confirm-dialog.js`)

```js
import { showConfirm } from './components/confirm-dialog.js';

try {
    await showConfirm('Delete project', 'This action cannot be undone.');
    // User clicked Confirm → proceed with deletion
} catch {
    // User clicked Cancel or pressed Escape → abort
}
```

`showConfirm(title, message)` — renders a modal overlay and returns a `Promise<void>`.

- **Resolves** when the user clicks **Confirm**.
- **Rejects** (with `new Error('User cancelled')`) when the user clicks **Cancel**, presses **Escape**, or clicks the backdrop.
- The overlay is appended to `document.body` and removed from the DOM on close (all three dismiss paths converge through a shared `cleanup()` function).
- Uses `.modal-overlay` / `.modal` / `.modal-title` / `.modal-body` / `.modal-actions` CSS classes from `styles.css`.
- Accessibility: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, `aria-describedby`. Focus is moved to the Confirm button on open.

> **Known limitation:** No focus trap is implemented — pressing Tab can move focus outside the modal. This is acceptable for an internal developer tool; a WCAG 2.1 SC 2.1.2-compliant trap can be added if keyboard accessibility becomes a requirement.

---

#### Status badge (`status-badge.js`)

```js
import { createStatusBadge } from './components/status-badge.js';

const badge = createStatusBadge(gitStatusInfo); // or null
container.appendChild(badge);
```

`createStatusBadge(gitStatusInfo)` — accepts a `GitStatusInfo` object (or `null`) and returns an `HTMLElement`.

The returned element contains:
- A coloured pill showing the branch name (`currentBranch`, or `"detached HEAD"` when `null`).
- Secondary detail chips (only rendered when the value is non-zero / present):
  - Modified file count (`modifiedFiles`)
  - Commits ahead of remote (`localCommits`)
  - Commits behind remote (`unfetchedCommits`)
  - Last activity timestamp, formatted as a human-readable relative string (`"5m ago"`, `"3h ago"`, `"2d ago"`, or a locale date for older commits)
  - Conflict warning chip when `hasConflicts` is `true`

When `gitStatusInfo` is `null`, a compact `"No data"` element with class `status-badge-error` is returned instead.

**CSS classes** applied to the primary pill (priority order — highest wins):

| Class | Condition |
|-------|-----------|
| `status-badge-conflict` | `hasConflicts === true` |
| `status-badge-modified` | `modifiedFiles > 0` |
| `status-badge-ahead` | `localCommits > 0` |
| `status-badge-behind` | `unfetchedCommits > 0` |
| `status-badge-clean` | All other cases |

> **Note:** The spec prose for this component listed different class names (`status-clean`, `status-modified`, etc.). The implementation correctly follows the authoritative `styles.css` class names (`status-badge-clean`, `status-badge-modified`, etc.) listed in the table above.

---

#### Toast notifications (`toast.js`)

```js
import { showToast } from './components/toast.js';

showToast('Repository saved.', 'success');
showToast('Something went wrong.', 'error');
showToast('Branch list refreshed.', 'info');
```

`showToast(message, type, duration?)` — appends a transient notification to `#toast-container`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `message` | `string` | Text to display. |
| `type` | `'success' \| 'error' \| 'info' \| 'warning'` | Visual variant. |
| `duration` | `number` (optional) | Auto-dismiss delay in ms. Defaults to `4000`. |

Returns the created `HTMLElement`, or `null` if `#toast-container` is absent from the DOM (a warning is logged to the console).

- Each toast has CSS classes `toast toast-{type}` and includes a manual close button.
- Toasts stack vertically inside `#toast-container`.
- Auto-dismiss uses a CSS slide-out transition (`TOAST_ANIMATION_MS = 200 ms` must match `styles.css`).
- A double-dismiss guard (`dataset.dismissing`) prevents the auto-timer and the close button from racing.

The `#toast-container` element is declared in `index.html`. The toast component does not create it.

---

#### Form helpers (`form-helpers.js`)

```js
import { createFormField, validateRequired } from './components/form-helpers.js';

// Build a field
const nameField = createFormField('Project Name', 'text', 'name', {
    required: true,
    placeholder: 'my-project',
});
form.appendChild(nameField);

// Validate on submit
form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validateRequired(form, ['name', 'url'])) return;
    // all required fields are non-empty → proceed
});
```

##### `createFormField(label, type, name, opts?)`

Returns a `<div class="form-group">` containing a `<label>` and a form control.

| Parameter | Type | Description |
|-----------|------|-------------|
| `label` | `string` | Human-readable label text. Appends `" *"` when `required` is true. |
| `type` | `string` | Any `<input>` type (`'text'`, `'url'`, `'email'`, …), `'select'`, or `'textarea'`. |
| `name` | `string` | The `name` attribute on the control. |
| `opts` | `FormFieldOptions` | Optional — see table below. |

**`FormFieldOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `required` | `boolean` | `false` | Appends `" *"` to the label. |
| `placeholder` | `string` | `''` | Placeholder text (inputs only). |
| `value` | `string` | `''` | Pre-populated value. |
| `hint` | `string` | `''` | Optional hint text rendered below the control. |
| `choices` | `string[] \| {value, label}[]` | `[]` | Options for `<select>` fields. |
| `rows` | `number` | `3` | Row count for `<textarea>`. |
| `id` | `string` | auto | Override the auto-generated element ID. |

##### `validateRequired(form, fields)`

Checks that each named field in `form` is non-empty.

- Clears all existing `.field-error` inline error elements before re-validating (prevents stale errors on repeated submissions).
- For each empty field: adds `class="error"` to the control and inserts an inline `.field-error` `<span>` below it.
- Input controls also get an `'input'` listener that clears the error as soon as the user starts typing.
- Returns `true` if all listed fields are non-empty, `false` otherwise.

| Parameter | Type | Description |
|-----------|------|-------------|
| `form` | `HTMLFormElement` | The form to validate. |
| `fields` | `string[]` | Array of `name` attribute values to check. |

---

### Normalisation helpers note

The Go backend serialises object fields with **capitalised keys** (`Id`, `Name`, `Url`, `Repositories`, `Description`, `CreatedAt`, etc.). All view modules normalise these before use:

| Helper | Module | Fields normalised |
|--------|--------|-------------------|
| `normaliseProject(project)` | `utils/normalise.js` | `id`, `name`, `description`, `repositories` |
| `normaliseRepo(repo)` | `utils/normalise.js` | `id`, `name`, `url` |
| `normaliseWorkspace(ws)` | `utils/normalise.js` | `id`, `description`, `createdAt` |
| `normaliseErrorEntry(entry)` | `utils/normalise.js` | `id`, `severity`, `source`, `message`, `details`, `context`, `timestamp` |
| `extractRepoId(repo)` | `workspace-detail.js` | Extracts repo ID from string or object (`Id`, `id`, `RepositoryId`, `repositoryId`) |
| `extractRepoName(repo)` | `workspace-detail.js` | Extracts repo display name, falls back to `extractRepoId()` |

> **Consolidated:** `normaliseRepo()`, `normaliseProject()`, `normaliseWorkspace()`, and `normaliseErrorEntry()` are all exported from the shared module at `gui/public/js/utils/normalise.js`. All views import from this single source. `extractRepoId()` and `extractRepoName()` remain local to `workspace-detail.js` as they are only used there.

```
###  Path: `/docs/agents/implementation-history/README.md`

```md
# Implementation Archive

This folder contains an archive of implementation plans for the project.

**DEPRECATION WARNING:** These are historical documents, and very likely
do not reflect the current state of the application.

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
###  Path: `/gui/README.md`

```md
# GUI Frontend

Vanilla JavaScript single-page application for managing repositories, projects, and workspaces. No build step, no framework — served directly by the built-in HTTP server.

## Key Concepts

- **Hash-based routing**: Navigation uses URL hash fragments (`#/path`). The router extracts parameters and dispatches to view functions.
- **ES modules**: All JavaScript files use native ES module imports.
- **Dependency injection**: The router is injected into views via `setRouter()` to avoid circular imports.
- **API client**: The `api.js` module provides a namespaced client (`repositories`, `projects`, `workspaces`, `branches`, `status`) matching the REST API.

## Folder Structure

| Directory/File | Responsibility |
|---|---|
| `public/index.html` | HTML shell with `#app` container |
| `public/css/styles.css` | Full stylesheet with CSS custom properties |
| `public/js/app.js` | Application bootstrap and route registration |
| `public/js/router.js` | Hash-based SPA router with parameter extraction |
| `public/js/api.js` | REST API client with namespaced methods |
| `public/js/views/` | Page-level view functions (dashboard, project detail, etc.) |
| `public/js/components/` | Reusable UI components (dialogs, toasts, badges) |
| `public/js/utils/` | Utility functions (JSON key normalisation) |

## Integration Points

- **Dependencies**: Server REST API (all data access via HTTP).
- **Served by**: `src/server/staticServer.ts`.

```
###  Path: `/src/config/README.md`

```md
# Configuration Module

Loads and validates the application configuration from a `config.json` file on disk.

## Key Concepts

- **AppConfig**: The central configuration interface that all other modules depend on. Contains paths for project storage, clone depth, server port, polling interval, and optional git credentials.
- **Config file**: A `config.json` file at the tool root, created from `config.dist.json`. Not committed to version control. Restrict permissions with `chmod 600 config.json` — see the README security advisory.
- **Defaults**: Missing optional fields are filled with sensible defaults (clone depth: 50, server port: 4200, polling interval: 30s).
- **gitCredentials**: Optional `Record<string, string>` mapping hostname → Personal Access Token or password. Absent or empty means public-repo-only mode. Validated on load: non-object types, non-string values, and empty-string tokens all throw a descriptive error.
- **saveConfigField caller guard**: `saveConfigField(field, value)` does not validate the `field` parameter. Any HTTP route handler or external caller that passes user-supplied input for `field` **must** guard it against an explicit allowlist before calling the function.

## Integration Points

- **Consumed by**: Models (RepositoryManager, ProjectManager), Orchestrators, Server — all receive `AppConfig` via constructor injection.
- **Load point**: Called once at startup from the CLI entry point (`src/index.ts`) or server bootstrap.

```
###  Path: `/src/error-log/README.md`

```md
# Error Log Module

Persistent, bounded error log for recording runtime faults and warnings to a JSON file on disk.

## Key Concepts

- **Stateless manager**: `ErrorLogManager` re-reads `error-log.json` from disk on every public method call — no in-memory cache. Concurrent writes from other processes are always reflected.
- **FIFO eviction**: The store is capped at `AppConfig.maxErrorLogEntries` (default: `DEFAULT_MAX_ERROR_LOG_ENTRIES` = 500). When the limit is exceeded, the oldest entries (at the front of the array) are removed so the file stays within bounds.
- **Auto-increment IDs**: `append()` assigns `Id = maxExistingId + 1` (or `1` for the first entry). IDs are unique but not guaranteed to be contiguous after eviction.
- **ISO 8601 timestamps**: `append()` stamps each entry with `new Date().toISOString()` (UTC).
- **Graceful cold start**: If `error-log.json` does not exist yet, `read()` catches `FileNotFoundError` and returns a fresh empty store — consistent with the `FileNotFoundError` handling pattern in `json-storage.ts`.

## Public API

| Method | Description |
|---|---|
| `append(entry)` | Append a new entry; returns the fully constructed `ErrorLogEntry` (with `Id` and `Timestamp` filled in). Trims oldest entries when over the cap (`AppConfig.maxErrorLogEntries`, default 500). |
| `list(options?)` | Return entries newest-first with optional `severity` / `source` filtering and `limit` / `offset` pagination. Returns `{ entries, total }` where `total` is the post-filter, pre-pagination count. See boundary behaviour note below. |
| `getById(id)` | Return the entry with the given numeric ID, or `undefined` if not found. |
| `sources()` | Return a sorted array of distinct `Source` values currently in the store. Useful for populating filter dropdowns dynamically. |
| `clear()` | Empty the `Entries` array while preserving `SchemaVersion` on the store. |

### `list()` boundary behaviour

| Scenario | `entries` result | `total` result |
|---|---|---|
| `limit: 0` | Empty array | Full filtered count |
| Negative `limit` | Empty array (treated as `0` by `slice`) | Full filtered count |
| `offset` ≥ filtered count | Empty array | Full filtered count |
| Negative `offset` | Same as `offset: 0` (treated as `0` by `slice`) | Full filtered count |

`total` always reflects the number of entries that match the filter criteria, regardless of pagination parameters.

## Persistence

The log is stored at `{storageFolder}/error-log.json` as defined by `AppConfig.storageFolder`. The file is created on first `append()` or `clear()` call if it does not already exist.

## No Barrel Index

There is no `index.ts` barrel for this module. Downstream consumers must import directly from the source files:

```typescript
import type { ErrorLogEntry, ErrorSeverity } from './error-log/error-log.types.js';
import { ErrorLogManager } from './error-log/error-log.manager.js';
```

If future work packages add more exports to this module, a barrel index should be introduced at that point.

## Integration Points

- **Dependencies**: `config` (`AppConfig` for storage paths), `storage` (`readJsonFile`, `writeJsonFile`, `FileNotFoundError`).
- **Consumed by**: Server route handlers (`src/server/routes/error-log.ts`) and orchestration layer.

## REST API

`ErrorLogManager` is surfaced over HTTP via `registerErrorLogRoutes()` in `src/server/routes/error-log.ts`. The four endpoints are:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/error-log` | List entries (newest first) with optional `severity`, `source`, `limit`, `offset` query params. |
| `GET` | `/api/error-log/sources` | Return sorted distinct `Source` values in the store (`{ sources: string[] }`). |
| `GET` | `/api/error-log/:id` | Get a single entry by numeric ID. Returns 400 for non-positive-integer IDs. |
| `DELETE` | `/api/error-log` | Clear all entries. No auth guard — localhost-only scope assumed. |

See `docs/agents/project-manifest/rest-api.md` for full parameter documentation, response shapes, and security notes.

```
###  Path: `/src/git/README.md`

```md
# Git Layer

Stateless functions wrapping Git CLI subprocess calls. All operations spawn `git` with `shell: false` for security.

## Key Concepts

- **Stateless**: Every function takes a repository path as argument. No cached state.
- **GitResult**: Unified return type with exit code, stdout, and stderr.
- **Timeout support**: Clone and fetch operations accept timeout values to prevent hanging on unreachable remotes.
- **Branch operations**: Listing, creating, switching, checking existence — all work with both local and remote branches.
- **Non-interactive auth suppression**: `runGit()` always sets `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=echo` in the subprocess environment. This is intentional — `GIT_TERMINAL_PROMPT=0` suppresses TTY prompts, and `GIT_ASKPASS=echo` bypasses all credential helpers (including macOS osxkeychain and Linux libsecret) by substituting a no-op askpass binary that returns empty credentials immediately, causing git to fail fast on unauthenticated requests. Do **not** remove `GIT_ASKPASS=echo` — `GIT_TERMINAL_PROMPT=0` alone does not prevent osxkeychain from blocking indefinitely on macOS.

## Files

| File | Responsibility |
|---|---|
| `git.types.ts` | Type definitions: GitResult, GitStatusInfo, BranchInfo, CloneOptions |
| `git-cli.ts` | Low-level `runGit()` and `runGitOrThrow()` subprocess execution |
| `git-credentials.ts` | URL credential utilities: `extractHost()`, `injectCredentials()`, `hasEmbeddedCredentials()`, `stripEmbeddedCredentials()` |
| `git-clone.ts` | `cloneRepository()` with depth and timeout options |
| `git-branch.ts` | Branch listing, creation, switching, existence checks |
| `git-status.ts` | Repository status: current branch, uncommitted changes, conflicts |

## Integration Points

- **Consumed by**: Orchestration layer (WorkspaceOrchestrator, BranchOrchestrator).
- **Dependencies**: None (uses Node.js `child_process` only).

```
###  Path: `/src/models/README.md`

```md
# Models Layer

Stateless CRUD managers backed by JSON files on disk. Each manager re-reads its backing store on every public method call, ensuring concurrent writes from other processes are always visible.

## Key Concepts

- **Stateless managers**: No in-memory caching. Every call reads fresh data from disk.
- **Repository**: A named Git remote URL. Global across all projects.
- **Project**: A named collection of repositories with one or more workspaces.
- **Workspace**: A named parallel working copy within a project. Each workspace has its own cloned copies of the project's repositories.
- **STABLE workspace**: Every project has a default `STABLE` workspace that cannot be renamed or deleted.

## Folder Structure

| Directory | Contents |
|---|---|
| `project/` | ProjectManager, ProjectData and ProjectWorkspace types, project index |
| `repository/` | RepositoryManager, Repository type, repository store |
| `workspace/` | WorkspaceManager, WorkspaceInfo type, STABLE_WORKSPACE_ID constant |

## Integration Points

- **Dependencies**: `config` (AppConfig for storage paths), `storage` (JSON read/write primitives).
- **Consumed by**: Orchestration layer, Server route handlers.

```
###  Path: `/src/orchestration/README.md`

```md
# Orchestration Layer

High-level composite operations that coordinate models and Git commands to implement multi-step workflows. Each orchestrator handles a specific domain: projects, repositories, workspaces, or branches.

## Key Concepts

- **Orchestrator pattern**: Each orchestrator receives its dependencies via constructor injection and composes lower-layer calls into transactional-style operations.
- **OrchestrationResult**: Standardized result type reporting per-repository success/failure.
- **VS Code workspace files**: The `vscode-workspace.ts` module generates `.code-workspace` files so users can open parallel workspaces directly in VS Code.

## Files

| File | Responsibility |
|---|---|
| `orchestration.types.ts` | Shared result types and timeout constants |
| `project-orchestrator.ts` | Create, delete, rename projects (clones repos into STABLE workspace) |
| `repository-orchestrator.ts` | Add/remove repos from projects, delete repos globally |
| `workspace-orchestrator.ts` | Create, delete, rename workspaces (clones repos into new workspace) |
| `branch-orchestrator.ts` | Multi-repo branch switching with conflict detection |
| `vscode-workspace.ts` | Generate `.code-workspace` files for VS Code |

## Integration Points

- **Dependencies**: `config`, `models` (ProjectManager, RepositoryManager, WorkspaceManager), `git` (clone, branch, status).
- **Consumed by**: Server route handlers, CLI.

```
###  Path: `/src/server/README.md`

```md
# HTTP Server

Built-in HTTP server providing a REST API and static file serving for the GUI. Uses only Node.js built-in `http` module — no Express or other framework.

## Key Concepts

- **Custom Router**: Method-based route registration with path parameter extraction (`:param` syntax).
- **Static file server**: Serves the `gui/public/` directory for the frontend SPA.
- **Polling Manager**: Periodically fetches git status for active workspaces, caching results for the GUI.
- **REST API**: Full CRUD for repositories, projects, workspaces, plus branch operations, status polling, and error log access.
- **Error Log**: `startServer()` creates a single `ErrorLogManager` instance and shares it across all subsystems (WorkspaceOrchestrator, BranchOrchestrator, PollingManager, and Router). No external reference is returned; the instance is internal to the server lifecycle.

## Folder Structure

| Directory/File | Responsibility |
|---|---|
| `index.ts` | Server start/stop lifecycle |
| `app-launcher.ts` | Fire-and-forget external application launcher (internal — not re-exported from `index.ts`) |
| `router.ts` | HTTP request router with parameter extraction |
| `staticServer.ts` | Static file serving for GUI assets |
| `pollingManager.ts` | Periodic git status polling and caching |
| `requestUtils.ts` | JSON body parsing, response helpers |
| `routes/` | REST API endpoint handlers (one file per resource domain) |
| `routes/error-log.ts` | `GET /api/error-log`, `GET /api/error-log/:id`, `DELETE /api/error-log` |
| `__tests__/` | Server-specific unit tests |

## Internal Modules

### `app-launcher.ts` — Application Launcher

Exports `launchApplication(command, args)` as a **module-internal utility** — it is **not** re-exported from `src/server/index.ts` and is not part of the public server barrel. Files that need it import it directly:

```typescript
import { launchApplication } from './app-launcher.js';
```

This is intentional. `launchApplication` is a low-level process-spawning primitive specific to the menu's "open browser" use case; exposing it on the server barrel would imply it is part of the server's REST API surface, which it is not. Future contributors should import it directly rather than adding it to the barrel export.

## Integration Points

- **Dependencies**: `config`, `models` (all managers), `orchestration` (all orchestrators), `error-log` (`ErrorLogManager`).
- **Consumed by**: CLI entry point (server start), GUI (REST API).
- **Serves**: `gui/public/` as static files.

```
###  Path: `/src/storage/README.md`

```md
# Storage Layer

Low-level JSON file persistence primitives. Provides typed read/write operations and storage directory initialization.

## Key Concepts

- **BaseStore**: Every JSON store has a `SchemaVersion` field for future migration support.
- **Atomic writes**: `writeJsonFile()` serializes objects to JSON with consistent formatting.
- **Initialization**: `initializeStorage()` creates the storage directory structure and seed files on first run.

## Integration Points

- **Dependencies**: None (uses Node.js `fs` only).
- **Consumed by**: Models layer (RepositoryManager, ProjectManager).

```
###  Path: `/src/utils/README.md`

```md
# Utilities

Shared helper functions used across all layers.

## Files

| File | Responsibility |
|---|---|
| `paths.ts` | Path resolution: tool root, config path, project/workspace folder computation |
| `slug.ts` | Slug generation and validation: `toKebabCase()`, `isValidKebabCase()`, `inferSlugFromUrl()`, `isValidWorkspaceId()` |

## Integration Points

- **Consumed by**: Models, Orchestration, Git, Server layers.

```
---
**File Statistics**
- **Size**: 89.45 KB
- **Lines**: 1726
File: `project-overview.md`
