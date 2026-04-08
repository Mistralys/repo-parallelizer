# Plan — Phase 1: Project Foundation & Configuration

## Summary

Scaffold the npm package, set up the TypeScript build pipeline, create the binary entry point, implement the global configuration system, and establish the JSON storage utility layer that all subsequent phases depend on.

## Architectural Context

This is a greenfield project. The workspace currently contains only `LICENSE`, `README.md`, and a `docs/` folder. All source code, configuration, and build infrastructure must be created from scratch.

The tool is an npm package with:
- Binary name: `paralizer`
- Target platforms: macOS, Windows, Unix
- Storage: JSON files
- Configuration: `config.json` (from `config.dist.json` template)

## Approach / Architecture

```
repo-parallelizer/
├── package.json              # npm package definition, bin entry
├── tsconfig.json             # TypeScript configuration
├── config.dist.json          # Configuration template
├── src/
│   ├── index.ts              # Binary entry point
│   ├── config/
│   │   ├── config.ts         # Config loader & validator
│   │   └── config.types.ts   # Config type definitions
│   ├── storage/
│   │   ├── json-storage.ts   # Generic JSON read/write/update utilities
│   │   └── storage.types.ts  # Shared storage types (SchemaVersion, etc.)
│   └── utils/
│       ├── paths.ts          # Path resolution helpers (STORAGE_FOLDER, PROJECTS_FOLDER)
│       └── slug.ts           # Kebab-case slug generation & validation
├── dist/                     # Compiled output (gitignored)
├── docs/
└── README.md
```

The configuration system resolves paths relative to the tool's installation directory (where `config.json` lives). The JSON storage layer provides typed, atomic read/write operations with schema version tracking.

## Rationale

- **TypeScript** for type safety across the entire codebase; critical given the many data structures.
- **config.dist.json template** pattern is simple, well-understood, and specified in the requirements.
- **Generic JSON storage utilities** established early to avoid duplicated file I/O logic in later phases.
- **Slug utilities** needed across repositories, projects, and workspaces — centralizing early prevents drift.
- **No framework** for the package itself — it's a CLI tool with a built-in HTTP server, so lean dependencies are preferred.

## Detailed Steps

1. **Initialize npm package**
   - Create `package.json` with name `repo-parallelizer`, binary `paralizer` pointing to `dist/index.js`.
   - Add TypeScript as a dev dependency.
   - Add a `build` script (`tsc`), a `dev` script (`tsc --watch`), and a `start` script (`node dist/index.js`).

2. **Configure TypeScript**
   - Create `tsconfig.json` targeting ES2022 / Node16 module resolution.
   - Output to `dist/`, enable strict mode, source maps.
   - Include `src/**/*.ts`.

3. **Create `.gitignore` updates**
   - Ensure `dist/`, `node_modules/`, and `config.json` are gitignored.

4. **Create the configuration system**
   - Define `AppConfig` type in `src/config/config.types.ts`:
     - `ProjectsFolder: string` (mandatory)
     - `StorageFolder: string` (mandatory)
     - `CloneDepth: number` (default: 50)
     - `ServerPort: number` (default: 4200)
     - `GitPollingIntervalSeconds: number` (default: 30)
   - Create `config.dist.json` at the project root with placeholder values and comments as field names.
   - Implement `src/config/config.ts`:
     - `loadConfig()`: Reads `config.json` from the tool's root directory, validates required fields, applies defaults for optional fields, returns typed config.
     - Throws a clear error if `config.json` is missing (with instructions to copy from `config.dist.json`).

5. **Create JSON storage utilities**
   - Implement `src/storage/json-storage.ts`:
     - `readJsonFile<T>(filePath: string): T` — reads and parses a JSON file, throws on missing/malformed.
     - `writeJsonFile<T>(filePath: string, data: T): void` — writes JSON with 4-space indentation + trailing newline.
     - `ensureDirectory(dirPath: string): void` — recursively creates directory if it doesn't exist.
   - Define `src/storage/storage.types.ts` with the `SchemaVersion` field pattern.

6. **Create path utilities**
   - Implement `src/utils/paths.ts`:
     - `getToolRoot()`: Resolves the tool's installation directory.
     - `getConfigPath()`: Returns path to `config.json`.
     - `getStorageFolder(config)`: Returns resolved storage folder path.
     - `getProjectsFolder(config)`: Returns resolved projects folder path.

7. **Create slug utilities**
   - Implement `src/utils/slug.ts`:
     - `toKebabCase(input: string): string` — converts a string to a valid kebab-case slug.
     - `isValidKebabCase(input: string): boolean` — validates a slug.
     - `inferSlugFromUrl(gitUrl: string): string` — extracts repo slug from a Git remote URL.
     - `isValidWorkspaceId(input: string): boolean` — validates uppercase 2-6 char A-Z identifier.

8. **Create the binary entry point**
   - Implement `src/index.ts` with a shebang (`#!/usr/bin/env node`).
   - For now, load the config and print a confirmation message. This will be expanded in later phases to dispatch to CLI menu or GUI server.

9. **Verify the build**
   - Ensure `npm run build` compiles without errors.
   - Ensure `npm link` installs the `paralizer` binary locally.
   - Ensure running `paralizer` loads the config (or shows the missing-config error).

## Dependencies

- Node.js (>=18 LTS)
- TypeScript (dev dependency)
- No runtime dependencies in this phase

## Required Components

- **NEW** `package.json` — npm package manifest
- **NEW** `tsconfig.json` — TypeScript configuration
- **NEW** `config.dist.json` — Configuration template
- **NEW** `src/index.ts` — Binary entry point
- **NEW** `src/config/config.ts` — Config loader
- **NEW** `src/config/config.types.ts` — Config types
- **NEW** `src/storage/json-storage.ts` — JSON file utilities
- **NEW** `src/storage/storage.types.ts` — Storage types
- **NEW** `src/utils/paths.ts` — Path resolution
- **NEW** `src/utils/slug.ts` — Slug generation/validation
- **MODIFY** `.gitignore` — Add dist/, node_modules/, config.json

## Assumptions

- Node.js 18+ is available on the target machine.
- The tool is run from its own directory (config.json resolution is relative to the tool root).
- No authentication or encryption is needed for config or storage files.

## Constraints

- Cross-platform: All path handling must use `path.join()` / `path.resolve()`, no hardcoded separators.
- No runtime dependencies beyond Node.js built-ins in this phase.

## Out of Scope

- Repository, project, or workspace data models (Phase 2).
- Git operations (Phase 3).
- HTTP server or GUI (Phases 5–6).
- CLI menu (Phase 7).

## Acceptance Criteria

- `npm run build` compiles cleanly with zero errors.
- `npm link && paralizer` executes and either loads config successfully or prints a helpful missing-config message.
- `config.dist.json` can be copied to `config.json`, edited, and loaded without errors.
- JSON storage utilities can read/write JSON files with schema version tracking.
- Slug utilities correctly convert strings to kebab-case, validate workspace IDs, and infer slugs from Git URLs.

## Testing Strategy

- Unit tests for slug utilities (kebab-case conversion, URL inference, workspace ID validation).
- Unit tests for config loading (missing file, missing required fields, default application).
- Unit tests for JSON storage (read/write round-trip, missing file handling).
- Manual smoke test: build, link, and run the binary.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Path resolution differs across platforms** | Use `path.resolve()` consistently; test on macOS at minimum, document Windows considerations |
| **Config file location ambiguity** | Clearly define: config.json lives next to package.json in the tool root |
| **JSON write race conditions** | Single-developer tool, no concurrent writes expected; synchronous writes acceptable |
