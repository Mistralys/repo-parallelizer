# CLI Reference

Paralizer ships a `paralizer` command (available after `npm link`). Without a global install, use `./menu.sh` (Unix / macOS) or `menu.cmd` (Windows) from the repository root; both build the project on first use and open the interactive menu.

## Commands

| Command | Description |
|---------|-------------|
| `paralizer` | Open the interactive CLI menu |
| `paralizer serve` | Start the GUI server directly (`--verbose` prints the detailed configuration first) |
| `paralizer setup` | Run the setup wizard |
| `paralizer custom-files <subcommand>` | Manage a project's custom files: `list`, `show`, `add`, `update`, `delete` |
| `paralizer repo-files <subcommand>` | Manage a repository's own files, synced via git: `list`, `show`, `add`, `update`, `delete`. The command never commits or pushes; publish changes with Commit & Push in the GUI |
| `paralizer directives <subcommand>` | Manage owner-defined agent directives for a project or, with `--workspace <ID>`, a single workspace: `list`, `add`, `update`, `delete`. Rules are rendered into the `AGENTS.md` of every affected workspace |
| `paralizer repo-roles <subcommand>` | Manage per-project repository roles (the `Role / relations` text in the generated workspace files): `list`, `set`, `clear`. `--json` for `list`; exit 0 success, 1 error, 2 saved but workspace sync failed |
| `paralizer regenerate [<project-id>] [--workspace <ID>]` | Re-render the generated workspace files for all workspaces, one project, or one workspace, without changing stored data. Use it after upgrading so existing workspaces get new generated text |
| `paralizer help` | Show all commands and their options |

Run `paralizer custom-files help`, `paralizer repo-files help`, `paralizer directives help` or `paralizer repo-roles help` for the full option list of each command group.

### Contributor command

`paralizer docs` runs `ctx generate` from the tool root to regenerate this project's own documentation context. It requires the [CTX Generator](https://github.com/context-hub/generator) (`ctx`) on your PATH and is intended for contributors to Repository Parallelizer, not for general use. Without `ctx`, it prints installation instructions instead.

## Managing files from scripts and agents

Each workspace's generated `AGENTS.md` points to the Paralizer install and to `paralizer help`, so scripts and agents can manage custom files from the command line:

```bash
paralizer custom-files update my-project scripts/deploy.sh --content-file ./deploy.sh
```

Custom-file changes are validated and then synced to all workspaces of the project. Workspace copies are overwritten on each sync, so edit the definition with this command, never the copy inside a workspace.
