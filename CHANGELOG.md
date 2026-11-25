# Changelog

## v1.7.0 - **WIP; UNRELEASED**

**Text typed into table cells can no longer forge the generated-section markers in workspace files.**
GUI regeneration also now includes the Repository Files section, so it matches the CLI. The generated
workspace AGENTS.md gives agents clearer directions on checking git state and on which instruction
files to read for each repository, and now lists the project's other workspaces so agents can find them.
That list now stays current when workspaces are created, renamed, or deleted. It also lists the
owner-defined directive rules and shows an optional role for each repository. Directives can be
managed from the command line or the GUI, and repository roles from the command line or the GUI.

- Security: Table cell text can no longer forge generated markers; line breaks are collapsed.
- Workspaces: AGENTS.md Agent Directives now list project and workspace rules, project rules first.
- Workspaces: Directive rule text is shown as a single line and cannot forge generated markers.
- Workspaces: README and AGENTS Repositories table gained an optional Role / relations column.
- REST: Added project and workspace directive endpoints and a repository role endpoint, each refreshing generated files.
- CLI: AGENTS.md CLI section now hints at the directives and repo-roles list commands when in use.
- CLI: Added `paralizer directives` to list, add, update, and delete project and workspace directives.
- GUI: Added a Directives tab on the project page to add, edit, and delete project directives.
- GUI: Workspace page gained a Workspace directives section to add, edit, and delete directives.
- CLI: Added `paralizer repo-roles` to list, set, and clear per-project repository roles.
- GUI: Project repository table gained a click-to-edit Role / relations column; saves on blur or Enter, empty clears.
- CLI: Repository role changes refresh generated workspace files; a failed refresh exits with code 2.
- CLI: `paralizer help` now lists the repo-roles command.
- CLI: Added `paralizer regenerate [<project-id>] [--workspace <ID>]`, refreshing generated workspace files without changing stored data.
- Workspaces: Fixed GUI regeneration omitting the Repository Files section; it now matches the CLI.
- Workspaces: AGENTS.md now has a Workspaces table of sibling workspaces with folder, path, and GUI link.
- Workspaces: The Workspaces table lists STABLE first, marks the current one, and is skipped for a single workspace.
- Workspaces: Sibling workspaces' Workspaces table now refreshes after create, rename, or delete.
- Workspaces: A failed sibling refresh is logged as a warning and never affects the operation.
- Workspaces: AGENTS.md now guides agents to check git state with read-only git commands.
- Workspaces: AGENTS.md now lists each repository's instruction files to read, in table order.
- Workspaces: AGENTS.md directives are now scoped to the generated overview and apply to every repository.
- Workspaces: AGENTS.md now always mentions the `.workspace/` folder and names README, AGENTS, and CLAUDE.
- Workspaces: Custom Files and Repository Files sections in AGENTS.md gained a clarifying intro.
- CLI: AGENTS.md CLI section now shows the custom-files and repo-files list commands.
- Tests: Added coverage for the `repo-roles` command and its help listing.
- Tests: Added coverage for the repository role cell and the `setRepositoryRole` API client.
- Tests: Added coverage for the directives API client, list editor, and project and workspace Directives UI.
- Tests: Added workspace-index fixture contexts and a golden-baseline capture script (`capture-golden`).
- Tests: Added coverage for the Workspaces section, including ordering, renames, and unchanged README.
- Tests: Added coverage for Repository Files rendering and for GUI/CLI regeneration parity.
- Tests: Added coverage for marker neutralisation and for single-line text handling.
- Tests: Added coverage for keeping hand-written text outside markers on regeneration.
- Tests: Added coverage for the `regenerate` command and for `paralizer help` output.
- Tests: Replaced the AGENTS golden baseline with a README golden test and coverage for the new text.
- Tests: Added coverage for directive rules, the role column, CLI hints, and a post-change golden test.
- Tests: Added coverage for the directive and repository role REST endpoints.
- Tests: Added coverage for the `directives` command and for ID-prefix resolution without a path.
- Tests: Added coverage for sibling workspace refresh on create, rename, and delete.

## v1.6.0 - Workspace Info & Custom Files

**Projects can now define custom files that are written into every workspace.**
Each file has a target folder, name, label, description, and text content, and stays in sync
with the project definition. Repositories can also opt in to sync their name, description, and
custom files through git. Agents and scripts can manage custom files from the command line.

- Custom Files: Projects can define files that are written into all of their workspaces.
- Custom Files: Copies are kept in sync on save and removed from all workspaces on delete or move.
- Repositories: Added an opt-in "Sync workspace info" setting backed by a managed clone.
- Repositories: Repository-level custom files, such as wrapper scripts, can now be synced via git.
- GUI: Added a Custom Files tab to the project view for adding, editing, and deleting files.
- GUI: Repository detail page gained a Workspace Info Sync section with status, import, and push.
- CLI: Added `paralizer custom-files` with list, show, add, update, and delete subcommands.
- CLI: Added `paralizer help`, printing the full command documentation.
- CLI: Added a "Check install" menu action that updates dependencies and rebuilds when stale.
- Workspaces: Custom files can be listed in a "Custom Files" table in the generated AGENTS.md.
- Workspaces: AGENTS.md now has a "Paralizer CLI" section with install path and help command.
- GUI: Repositories list gained a Sync column showing whether sync is on or off.
- GUI: Commit & push now names the pushed commit and branch in its confirmation toast.
- GUI: Sync actions show an info notice when the remote lacks partial-clone filtering support.
- GUI: Fix actions on health alerts no longer get stuck if the fix fails or is cancelled.
- GUI: Project view now remembers the active tab after saving or deleting.
- Repositories: Sync now logs files it skipped or removed.
- Security: Custom file paths cannot escape the workspace or overwrite generated index files.
- Security: Imported repository files are now validated like files added by hand.
- Security: Synced files never store credentials; git error output strips credential-bearing URLs.

## v1.5.0 - Workspace Index Files

**Workspaces now get auto-generated README, AGENTS.md, and CLAUDE.md index files.**
These files summarize the project, workspace, and repository list, and stay in sync
as data changes while preserving any hand-added content. Repositories and workspaces
can now also carry a short description, shown throughout the GUI.

- Workspaces: AGENTS.md, README, and CLAUDE.md index files are now auto-generated per workspace.
- GUI: Added description fields to repositories and workspaces.
- Workspaces: Health checks now flag missing or hand-edited index files.
- Security: Added path-traversal protections when generating workspace files.

## v1.4.0 - Terminal Launch Button

- GUI: Added an "Open in Terminal" button to launch a terminal window at a workspace's folder.
- Server: Added cross-platform terminal launching, matching the existing VS Code/GitHub Desktop launchers.

## v1.3.0 - Multi-Credential Support & Repository Modal

**Repositories can now be configured with multiple named Git credentials, selectable per repository.**
A new modal form replaces inline editing for creating and editing repositories. Credential host
matching is also more reliable, and a new in-app guide walks through setting up Git tokens.

- Credentials: Added support for multiple named Git credentials, selectable per repository.
- GUI: Added credential selection controls and status badges to repository and workspace views.
- GUI: Added a modal form for creating and editing repositories.
- Credentials: Fixed credential matching for hosts with different letter casing.
- GUI: Added a Git token setup guide linked from the settings page.
- Credentials: Updating a credential's label no longer requires re-entering its host and token.
- GUI: Clarified credential selection hints and removed confusing auto-preselection.
- GUI: Fixed a missing page title on the Notes view.

## v1.2.0 - Notes Display Settings
- GUI: Added Notes Display section to the settings page with card height and column count controls.
- GUI: Notes Collected view now applies saved card height and column layout.
- Config: Added `notesColumns` and `notesCardHeight` config fields with range validation.
- Docs: Updated contributing guide.

## v1.1.0 - Workspace Notes
- Workspace: Added `notes` field to workspace and project models.
- Server: Added notes API endpoint for reading and persisting workspace notes.
- GUI: Added notes textarea to the workspace detail view.
- GUI: Added "Notes Collected" view aggregating notes across all workspaces.

## v1.0.1 - Page Titles
- GUI: The browser page title now displays helpful titles.

## v1.0.0 - Project Filtering & Repositories Overview
> First stable release

- GUI: Added filtering and sorting controls to the projects list.
- GUI: Added dedicated repository detail view.
- GUI: Added footer displaying app and GUI version numbers.
- CLI: Added staleness check with auto-rebuild.
- CLI: Added menu refresh after a successful build.
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
