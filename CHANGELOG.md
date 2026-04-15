# Changelog

## 0.4.0 - Launch External Apps
- Server: Added cross-platform external app launcher with detached process spawning.
- GUI: Added "Open in VS Code" button on workspace detail page.
- GUI: Added "Open" button per repository row for GitHub Desktop.
- CLI: Added interactive menu with setup, GUI launch, and docs generation.
- CLI: Added first-time setup wizard with config prompts and validation.
- CLI: Added CTX Generator integration for documentation generation.
- Launcher: Added `menu.sh` (Unix) and `menu.cmd` (Windows) launcher scripts.

## v0.3.0 - Git Module
- Git: Added core type definitions for results, status, branches, and clone options.
- Git: Added CLI wrapper with shell-injection-safe spawning.
- Git: Added repository cloning with depth and branch options.
- Git: Added seven stateless branch helpers for listing, switching, and detection.
- Git: Added status aggregation with parallel queries and conflict detection.

## v0.2.0 - Models and Storage
- Storage: Added idempotent folder initialization with default seed files.
- Repository: Added full CRUD manager with slug inference from URLs.
- Project: Added full CRUD manager with auto-generated STABLE workspace.
- Workspace: Added full CRUD manager with STABLE guard protection.

## v0.1.0 - Foundation
- Project: Initial scaffold with TypeScript build pipeline.
- Config: Added config loader with path resolution.
- Storage: Added generic typed JSON read/write utilities.
- Utils: Added slug generation, validation, and URL inference.
- Utils: Added path resolution helpers.
