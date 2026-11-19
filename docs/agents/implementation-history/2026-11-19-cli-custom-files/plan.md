# CLI Commands for Custom Files

## Summary

Agents working in a workspace currently cannot change a project's custom files without a human copying content into the Paralizer GUI. This work adds a `paralizer custom-files` CLI command group (list, show, add, update, delete) that goes through the same validation and workspace sync as the GUI, plus a "Paralizer CLI" section in the generated workspace AGENTS.md that says where Paralizer is installed and how to reach the built-in help.

## Scope

- `paralizer help` and `paralizer custom-files help` print the command documentation (exit 0).
- `paralizer custom-files list|show|add|update|delete` operate on a project's custom files, reading content from a file or stdin, using the same validation and sync (including removal of old copies on move/rename/delete) as the REST API.
- The generated workspace AGENTS.md gets a "Paralizer CLI" section with the installation path and the help command, without duplicating the full documentation.
- Tests for the CLI; manifest, README and changelog updates.

## Out of Scope

- Managing other entities (projects, workspaces, repositories) from the CLI.
- GUI changes.

> Ad-hoc plan created from a direct user request; no formal planning pass was run.
