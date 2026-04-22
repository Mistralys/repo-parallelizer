# Changelog

## v1.0.0 - Repository Overview Screen
> First stable release

- GUI: Added dedicated repository detail view with branch info, status, and last-refreshed display.
- GUI: Added `RepoStatusCells` component for reusable repository status cell rendering.
- GUI: Added footer displaying app and GUI version numbers.
- Server: Added `/api/version` endpoint returning app and GUI version information.
- Repository: Added `lastRefreshed` timestamp tracking to the manager and types.
- CLI: Fixed Windows cmd launcher script path.

## v0.5.0 - Branch Quick-Switch and Browse Button
- GUI: Added branch quick-switch popover to switch repo branches from the workspace detail view.
- GUI: Added "Browse" button per repository row linking to a configurable webserver URL.
- GUI: Added Webserver URL section to the settings page.
- Config: Added `webserverUrl` field with API endpoints for reading and persisting the value.
- Docs: Trimmed README to essential content.

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
