# repo-parallelizer

Parallelization of VS Code workspaces with multiple local git repositories.

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **git** >= 2.28

## Installation

```bash
npm install
npm run build
```

This compiles TypeScript to `dist/` and makes the `paralizer` CLI available.

## Usage

### Global install (recommended)

```bash
npm link
paralizer
```

### Run directly

```bash
node dist/index.js
```

> **Note:** `dist/index.js` does not have the executable bit set after compilation. Use `node dist/index.js` or `npm link` for local execution — not `./dist/index.js` directly.

### npm scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript (`tsc`) |
| `npm run dev` | Watch mode — recompile on save (`tsc --watch`) |
| `npm start` | Run compiled output via `node dist/index.js` |

## Configuration

At runtime the tool reads a `config.json` file located at the tool root (next to `package.json`). This file is **not committed** — create it locally before running the tool.

### Setup

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
| `storageFolder` | `string` | ✅ | — | Directory used for internal storage. On first run, `repositories.json` and `projects-index.json` are created here automatically. |
| `cloneDepth` | `number` | | `50` | Depth passed to `git clone --depth`. Use `0` for a full clone. |
| `serverPort` | `number` | | `4200` | TCP port the built-in HTTP server listens on. |
| `gitPollingIntervalSeconds` | `number` | | `30` | How often (in seconds) the tool polls git remotes for new commits. |

### Storage structure

On first run, the tool calls `initializeStorage()` automatically. This creates the following structure under `storageFolder` (directories and seed files are created only if they do not already exist):

```
{storageFolder}/
  repositories.json       # { "Repositories": [], "SchemaVersion": 1 }
  projects-index.json     # { "Projects": [], "SchemaVersion": 1 }
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
| `workspaceId` | `string` | ✅ | ID for the new workspace. Must be 2–6 uppercase ASCII letters (A–Z), no digits or special characters (e.g. `"DEV"`, `"PROD"`). Validated via `isValidWorkspaceId()`. |
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
| `newId` | `string` | ✅ | New workspace ID. Must be 2–6 uppercase ASCII letters; must not already exist in the project. |

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
)
```

All three dependencies are injected; there is no internal state beyond the injected references.

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

The workspace's `DateModified` timestamp is always updated after all per-repository operations complete, regardless of individual outcomes — including partial failures.

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
| **Add Workspace** | Collapsible form toggled by **+ Add Workspace**. Validates workspace ID against `/^[A-Z]{2,6}$/` (2–6 uppercase letters, no digits or special characters) before calling `POST /api/projects/:id/workspaces`. |
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

Clicking **Rename Workspace** reveals an inline form. The new workspace ID is validated against `WORKSPACE_ID_PATTERN` (`/^[A-Z]{2,6}$/`, imported from `form-helpers.js`) before showing a confirmation dialog. On success, `api.workspaces.rename()` is called and the router navigates to the new workspace URL (`#/projects/:id/workspaces/:newId`).

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

### API client (`gui/public/js/api.js`)

All communication with the backend REST API goes through the `api` object exported from `api.js`. It is organised into five namespaces, one per resource type. All methods return Promises and throw an `Error` (message taken from the `error` field in the JSON response body) for any non-2xx response.

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

#### `api.status`

| Method | HTTP | URL | Body | Returns |
|--------|------|-----|------|---------|
| `get(projectId, wid)` | GET | `/api/projects/:id/workspaces/:wid/status` | — | `Record<repoId, GitStatusInfo \| null>` |
| `refresh(projectId, wid)` | POST | `/api/projects/:id/workspaces/:wid/status/refresh` | — | `Record<repoId, GitStatusInfo \| null>` |

`refresh()` forces a live git poll before returning; `get()` returns the last cached result. Each `GitStatusInfo` value has: `currentBranch`, `localCommits`, `unfetchedCommits`, `modifiedFiles`, `lastActivity`, `hasConflicts`.

> **URL encoding:** All path segments (IDs, workspace IDs) are wrapped in `encodeURIComponent()` before being interpolated into URLs. This is handled transparently by the internal `request()` helper; callers pass raw ID strings.

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
| `extractRepoId(repo)` | `workspace-detail.js` | Extracts repo ID from string or object (`Id`, `id`, `RepositoryId`, `repositoryId`) |
| `extractRepoName(repo)` | `workspace-detail.js` | Extracts repo display name, falls back to `extractRepoId()` |

> **Consolidated:** `normaliseRepo()`, `normaliseProject()`, and `normaliseWorkspace()` are exported from the shared module at `gui/public/js/utils/normalise.js`. All views import from this single source. `extractRepoId()` and `extractRepoName()` remain local to `workspace-detail.js` as they are only used there.
