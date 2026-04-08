# Configuration Module

Loads and validates the application configuration from a `config.json` file on disk.

## Key Concepts

- **AppConfig**: The central configuration interface that all other modules depend on. Contains paths for project storage, clone depth, server port, and polling interval.
- **Config file**: A `config.json` file at the tool root, created from `config.dist.json`. Not committed to version control.
- **Defaults**: Missing optional fields are filled with sensible defaults (clone depth: 50, server port: 4200, polling interval: 30s).

## Integration Points

- **Consumed by**: Models (RepositoryManager, ProjectManager), Orchestrators, Server — all receive `AppConfig` via constructor injection.
- **Load point**: Called once at startup from the CLI entry point (`src/index.ts`) or server bootstrap.
