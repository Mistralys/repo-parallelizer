# Project Custom Files

## Summary
Add a per-project "Custom Files" feature: a CRUD tab (after "Repositories") on the project screen where files can be configured with a workspace-relative target path, file name, label, description and text content. The files are written into every workspace of the project and kept in sync with the project definition, so projects can ship shell scripts or project-specific documentation to each workspace. An optional per-file toggle (default off) lists the file in a dedicated section of the generated workspace AGENTS.md.

## Scope
- New "Custom Files" tab after "Repositories" on the project detail view: list, create, edit, delete; fields: relative directory, file name (with extension), label, description, text content (plain textarea editor, no syntax highlighting), "list in AGENTS.md" toggle (default off).
- Storage + REST CRUD endpoints for custom files per project.
- Sync into all workspaces of the project: when a file is added, when its configuration is saved, and together with the existing AGENTS.md update trigger. Local edits are silently overwritten.
- Removing a file (or changing its path/name) deletes the previously written copies from the workspaces; the UI states this. Only files the tool wrote (tracked) are deleted.
- Executable bit set automatically for executable types (shell scripts, cross-OS: `.sh`, `.bash`, `.zsh`, `.command`, or `#!` shebang on POSIX; `.bat`/`.cmd`/`.ps1` need none on Windows).
- Path safety: target must stay inside the workspace root (no absolute paths, no `..`, no separators in the file name, no collisions with other custom files, repository folders or generated files).
- UTF-8 text only; size cap; binary excluded.
- Generated AGENTS.md gets a "Custom Files" section listing path, label and description of files with the toggle on.
- Docs: manifest (rest-api, gui-frontend, data-flows, api-surface, constraints), changelog.

## Out of Scope
- CLI commands, syntax highlighting, binary files, placeholder variables, reordering.

> Ad-hoc plan created from a direct user request; no formal planning pass was run.
