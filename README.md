# Repository Parallelizer

Manage multiple related git repositories as a single project — with parallel workspaces, branch orchestration, and a web-based GUI.

## What Is This?

When a project spans several git repositories, keeping them in sync is tedious: cloning each one, switching branches across all of them, remembering which repos belong together. **Repository Parallelizer** treats a group of repos as one "project" and lets you create isolated **workspaces** — each with its own branch configuration, cloned copies, and a ready-to-open VS Code `.code-workspace` file.

Set up a project once, then spin up as many parallel workspaces as you need — one for the main branch, one for a feature, one for a hotfix — without stepping on your own toes.

## Features

- **Project-based repo grouping** — register repositories once, then combine them into projects.
- **Parallel workspaces** — create multiple independent workspaces per project, each with its own branch assignments and cloned copies.
- **Coordinated branch switching** — switch branches across the repos in a workspace in a single operation, with conflict detection.
- **VS Code integration** — generated `.code-workspace` files let you open a workspace in VS Code.
- **Workspace index files** — each workspace gets a generated `README.md`, `AGENTS.md`, and `CLAUDE.md` listing its repositories, links, and agent directives; hand-added content outside the generated block is preserved on regeneration.
- **Project custom files** — define files (scripts, notes, config) once on a project and have them written into its workspaces and kept in sync when you edit or delete them.
- **Descriptions** — give repositories and workspaces a short description, shown throughout the GUI.
- **Web GUI** — a built-in browser UI for managing repositories, projects, workspaces, and branches. The project dashboard can be filtered by name, ID, description, or repository, and sorted alphabetically or by last activity.
- **Git status overview** — periodic polling shows current branches, uncommitted changes, and unfetched commits.
- **Workspace health checks** — detect and fix configuration drift such as missing repos, stale workspace files, missing or hand-edited index files, and credential errors.
- **Repository info sync** — opt in per repository to share its name, description, and custom files through version control via a managed clone, with import and Commit & Push support in the GUI.
- **Command-line access** — an interactive terminal menu, plus commands for managing custom files without the GUI.
- **Private repo support** — per-host credential management for cloning private repositories.

## How Does This Compare to Git Worktrees?

Git worktrees let you check out multiple branches of a **single** repository side by side — great when your entire project lives in one repo. Repository Parallelizer solves a different problem: when your project spans **multiple** repositories that need to move together.

| | Git Worktrees | Repository Parallelizer |
|---|---|---|
| **Scope** | One repository, multiple branches | Multiple repositories, multiple branches |
| **Branch switching** | Per-repo only | Coordinated across the repos in a workspace |
| **VS Code workspace** | Manual setup | Generated `.code-workspace` files |
| **Status overview** | Per-repo (`git status`) | Aggregated across the repos in a workspace |

If your project is a single repo, worktrees are the simpler choice. If you're juggling a frontend, backend, shared library, and infrastructure repo that all need to be on the same feature branch — that's where this tool comes in.

## Requirements

- **Node.js** >= 18
- **npm** >= 9
- **git** >= 2.28

## Quick Start

```bash
# Clone and build
git clone https://github.com/Mistralys/repo-parallelizer.git
cd repo-parallelizer
npm install
npm run build

# Run the setup wizard to create your config
npm link
paralizer setup

# Launch the GUI
paralizer serve
```

The setup wizard walks you through creating a `config.json` with your projects folder and storage location. Once complete, open `http://localhost:4200` in your browser to start managing your repositories.

To run without installing globally, use `./menu.sh` (Unix / macOS) or `menu.cmd` (Windows).

### CLI commands

| Command | Description |
|---------|-------------|
| `paralizer` | Open the interactive CLI menu |
| `paralizer serve` | Start the GUI server directly |
| `paralizer setup` | Run the setup wizard |
| `paralizer docs` | Generate project documentation |
| `paralizer custom-files <subcommand>` | Manage a project's custom files (list, show, add, update, delete) |
| `paralizer repo-files <subcommand>` | Manage a repository's own files, synced via git — publish with Commit & Push in the GUI |
| `paralizer help` | Show all commands and their options |

Each workspace's generated `AGENTS.md` points to the Paralizer install and to `paralizer help`, so scripts and agents can manage custom files from the command line:

```bash
paralizer custom-files update my-project scripts/deploy.sh --content-file ./deploy.sh
```

## Learn More

| Resource | Description |
|----------|-------------|
| [Start with Windows](docs/start-with-windows.md) | Launch the GUI server at Windows login |
| [Project Manifest](docs/agents/project-manifest/README.md) | Architecture overview and document index |
| [REST API](docs/agents/project-manifest/rest-api.md) | HTTP endpoints with methods, paths, and response shapes |
| [GUI Frontend](docs/agents/project-manifest/gui-frontend.md) | SPA architecture, routes, and components |
| [Tech Stack](docs/agents/project-manifest/tech-stack.md) | Runtime, dependencies, and architectural patterns |
| [API Surface](docs/agents/project-manifest/api-surface.md) | Exported types, classes, and function signatures |
| [Constraints](docs/agents/project-manifest/constraints.md) | Conventions, validation rules, and config schema |
| [Contributing](CONTRIBUTING.md) | Development setup, build commands, and test instructions |
| [Changelog](CHANGELOG.md) | Release history |

## License

[ISC](LICENSE)
