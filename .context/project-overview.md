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
# Repository Parallelizer

Manage multiple related git repositories as a single project — with parallel workspaces, branch orchestration, and a web-based GUI.

## What Is This?

When a project spans several git repositories, keeping them in sync is tedious: cloning each one, switching branches across all of them, remembering which repos belong together. **Repository Parallelizer** treats a group of repos as one "project" and lets you create isolated **workspaces** — each with its own branch configuration, cloned copies, and a ready-to-open VS Code `.code-workspace` file.

Set up a project once, then spin up as many parallel workspaces as you need — one for the main branch, one for a feature, one for a hotfix — without stepping on your own toes.

## Features

- **Project-based repo grouping** — register repositories once, then combine them into projects.
- **Parallel workspaces** — create multiple independent workspaces per project, each with its own branch assignments and cloned copies.
- **One-click branch switching** — switch branches across all repos in a workspace in a single operation, with conflict detection.
- **VS Code integration** — auto-generated `.code-workspace` files let you open an entire workspace in VS Code instantly.
- **Web GUI** — a built-in browser UI for managing repositories, projects, workspaces, and branches — no terminal required after setup. The project dashboard supports real-time filtering by name/ID/description, repository filtering, and sort by alphabetical or last-activity order.
- **Live git status** — automatic polling shows current branches, uncommitted changes, and unfetched commits at a glance.
- **Workspace health checks** — detect and fix configuration drift (missing repos, stale workspace files).
- **Interactive CLI** — a keyboard-driven terminal menu for quick access to setup, server launch, and documentation generation.
- **Private repo support** — per-host credential management for cloning private repositories.

## How Does This Compare to Git Worktrees?

Git worktrees let you check out multiple branches of a **single** repository side by side — great when your entire project lives in one repo. Repository Parallelizer solves a different problem: when your project spans **multiple** repositories that need to move together.

| | Git Worktrees | Repository Parallelizer |
|---|---|---|
| **Scope** | One repository, multiple branches | Multiple repositories, multiple branches |
| **Branch switching** | Per-repo only | Coordinated across all repos at once |
| **VS Code workspace** | Manual setup | Auto-generated `.code-workspace` files |
| **Status overview** | Per-repo (`git status`) | Aggregated across all repos in a workspace |

If your project is a single repo, worktrees are the simpler choice. If you're juggling a frontend, backend, shared library, and infrastructure repo that all need to be on the same feature branch — that's where this tool comes in.

## Requirements

- **Node.js** >= 18
- **npm** >= 9
- **git** >= 2.28

## Quick Start

```bash
# Clone and build
git clone https://github.com/Mistralys/repo-parallelizer.git
cd repo-parallelizer
npm install
npm run build

# Run the setup wizard to create your config
npm link
paralizer setup

# Launch the GUI
paralizer serve
```

The setup wizard walks you through creating a `config.json` with your projects folder and storage location. Once complete, open `http://localhost:4200` in your browser to start managing your repositories.

### Alternative: run without installing globally

```bash
# Unix / macOS
./menu.sh

# Windows
menu.cmd
```

### CLI commands

| Command | Description |
|---------|-------------|
| `paralizer` | Open the interactive CLI menu |
| `paralizer serve` | Start the GUI server directly |
| `paralizer setup` | Run the setup wizard |
| `paralizer docs` | Generate project documentation |

## Start with Windows

1. Press `Win + R`, type the following command to open your user Startup folder, and press **Enter**:
   ```
   shell:startup
   ```
   *(This opens the folder: `C:\Users\<YourUsername>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`)*

2. In that folder, right-click an empty area and select **New** > **Text Document**.
3. Name it `start-repo-parallelizer.vbs` (ensure you delete the `.txt` extension!).
4. Right-click the new file, select **Edit** (or open it with Notepad/VS Code), and paste the following code into it:

   ```vbscript
   Set WshShell = CreateObject("WScript.Shell")
   ' 0 means the window will be hidden, so you don't have a lingering terminal
   WshShell.Run "cmd /c paralizer serve", 0
   Set WshShell = Nothing
   ```

   > **Requires `npm link`** — run `npm link` once in the project folder so `paralizer` is available globally.

5. Save and close the file.

### How it works:
Every time you log into Windows, this script will seamlessly launch the server in the background without leaving an unused command prompt window taking up space on your taskbar. The background Node.js process will execute exactly as it normally does. 

*(If you ever want to stop it from starting automatically, just delete the `start-repo-parallelizer.vbs` file from that Startup folder.)*

## Learn More

| Resource | Description |
|----------|-------------|
| [Project Manifest](docs/agents/project-manifest/README.md) | Architecture overview and document index |
| [REST API](docs/agents/project-manifest/rest-api.md) | All HTTP endpoints with methods, paths, and response shapes |
| [GUI Frontend](docs/agents/project-manifest/gui-frontend.md) | SPA architecture, routes, and components |
| [Tech Stack](docs/agents/project-manifest/tech-stack.md) | Runtime, dependencies, and architectural patterns |
| [API Surface](docs/agents/project-manifest/api-surface.md) | Exported types, classes, and function signatures |
| [Configuration](docs/agents/project-manifest/constraints.md) | Conventions, validation rules, and config schema |
| [Contributing](CONTRIBUTING.md) | Development setup, build commands, and test instructions |
| [Changelog](CHANGELOG.md) | Release history |

## License

[ISC](LICENSE)

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
- **Size**: 21.95 KB
- **Lines**: 469
File: `project-overview.md`
