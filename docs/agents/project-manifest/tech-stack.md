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
