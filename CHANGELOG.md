# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-04-03

### Added

- `src/git/git.types.ts` — Core Git type definitions: `GitResult`, `GitStatusInfo`, `BranchInfo`, and `CloneOptions`.
- `src/git/git-cli.ts` — Low-level Git CLI wrapper (`runGit`, `runGitOrThrow`) using `child_process.spawn` with `shell: false` to prevent shell injection. Resolves with full exit code, stdout, and stderr; rejects on spawn failure (ENOENT).
- `src/git/git-clone.ts` — `cloneRepository(url, targetPath, options)` builds a safe argument array from `CloneOptions` (depth, optional branch) and delegates to `runGit`. Returns `GitResult` without throwing on non-zero exit.
- `src/git/git-branch.ts` — Seven stateless branch helpers: `listBranches` (local + remote with `isRemote`/`isCurrent` flags), `getCurrentBranch` (null on detached HEAD), `getDefaultBranch` (symbolic-ref with `main`/`master` fallback), `createBranch`, `switchBranch`, `branchExists`, and `fetchRemote`.
- `src/git/git-status.ts` — `getGitStatus()` aggregates five parallel read-only git commands via `Promise.all` into a `GitStatusInfo` object (local commits ahead, unfetched commits behind, modified-file count, last activity ISO 8601 or null, current branch, conflict detection via `CONFLICT_CODES` Set). `fetchAndGetStatus()` performs a best-effort fetch before returning status.
- Test coverage expanded to 231 passing tests across all git modules (`git-cli.test.ts`, `git-clone.test.ts`, `git-branch.test.ts`, `git-status.test.ts`).

## [0.2.0] - 2026-04-03

### Added

- `initializeStorage(config)` in `src/storage/json-storage.ts` — idempotently creates the storage folder structure and seeds `repositories.json` and `projects-index.json` with empty defaults on first run.
- `RepositoryManager` class (`src/models/repository/repository.manager.ts`) — full CRUD for repositories: `list`, `getById`, `exists`, `add`, `update`, `remove`. `add()` infers a slug ID from the repository URL via `inferSlugFromUrl()` when no explicit ID is provided, and enforces uniqueness on both ID and URL.
- `repository.types.ts` (`src/models/repository/repository.types.ts`) — `Repository` and `RepositoryStore` type definitions.
- `ProjectManager` class (`src/models/project/project.manager.ts`) — full CRUD for projects: `list`, `getById`, `create`, `update`, `rename`, `remove`, `addRepository`, `removeRepository`. `create()` auto-generates a `STABLE` workspace, validates all supplied repository IDs, and keeps the project index file in sync. `rename()` renames the backing project JSON file atomically.
- `project.types.ts` (`src/models/project/project.types.ts`) — `ProjectWorkspace`, `ProjectData`, `ProjectIndexEntry`, and `ProjectIndex` type definitions.
- `WorkspaceManager` class (`src/models/workspace/workspace.manager.ts`) — full CRUD for workspaces within a project: `list`, `getById`, `create`, `update`, `rename`, `remove`, `isStable`. Guards the `STABLE` workspace from deletion and rename. All mutations update `DateModified`.
- `workspace.types.ts` (`src/models/workspace/workspace.types.ts`) — `WorkspaceInfo` flat-view type (includes `ProjectID` and `WorkspaceID`).
- Test coverage expanded to 176 passing tests across all models and storage layers.

### Changed

- `src/models/project/project.manager.ts` extended with internal workspace storage helpers (`addWorkspace`, `updateWorkspace`, `removeWorkspace`, `renameWorkspace`) used by `WorkspaceManager`.

## [0.1.0] - 2026-04-03

### Added

- Initial project scaffold: TypeScript configuration, build pipeline, and entry point.
- `src/config/config.ts` — Config loader resolving `StorageFolder` and `ProjectsFolder` paths.
- `src/storage/json-storage.ts` — Generic typed JSON read/write utilities (`readJsonFile`, `writeJsonFile`).
- `src/utils/slug.ts` — Slug generation, validation (`isValidSlug`), and URL-to-slug inference (`inferSlugFromUrl`).
- `src/utils/paths.ts` — Path resolution helpers.
