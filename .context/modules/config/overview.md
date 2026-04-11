# Configuration - Overview
```
// Structure of documents
└── src/
    └── config/
        └── README.md

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
---
**File Statistics**
- **Size**: 1.71 KB
- **Lines**: 35
File: `modules/config/overview.md`
