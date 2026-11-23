# Repository Parallelizer

Manage multiple related git repositories as a single project, with parallel workspaces and a web-based GUI.

## What Is This?

When a project spans several git repositories, keeping them in sync is tedious: cloning each one, switching branches across all of them, remembering which repos belong together. **Repository Parallelizer** treats a group of repos as one project and lets you create isolated **workspaces**, each with its own branch configuration, cloned copies, and a ready-to-open VS Code `.code-workspace` file.

Set up a project once, then spin up parallel workspaces for the main branch, a feature, or a hotfix without stepping on your own toes.

## Features

- **Group repositories into projects** — register repositories once, then combine them into projects.
- **Parallel workspaces** — create multiple independent workspaces per project, each with its own branch assignments and cloned copies.
- **Coordinated branch switching** — switch branches across the repos in a workspace in one operation, with conflict detection.
- **Open in VS Code** — generated `.code-workspace` files let you open a workspace right away.
- **Workspace index files** — each workspace gets a generated `README.md`, `AGENTS.md`, and `CLAUDE.md` listing its repositories; content you add by hand outside the generated block is preserved.
- **Project custom files** — define scripts, notes, or config once on a project and have them written into its workspaces.
- **Git status overview** — see current branches, uncommitted changes, and unfetched commits in the GUI.
- **Workspace health checks** — detect and fix drift such as missing repos, stale workspace files, and credential errors.
- **Share repository info through git** — opt in per repository to sync its name, description, and custom files.
- **Private repository support** — per-host credential management for cloning private repositories.
- **Web GUI and command line** — manage everything in the browser, or use the interactive terminal menu.

## Requirements

- **Node.js** >= 18
- **npm** >= 9
- **git** >= 2.28

## Quick Start

```bash
git clone https://github.com/Mistralys/repo-parallelizer.git
cd repo-parallelizer
npm install
npm run build
npm link
paralizer setup
paralizer serve
```

The setup wizard creates a `config.json` with your projects folder and storage location. Once the server is running, open `http://localhost:4200` in your browser (the default port).

## Learn More

| Resource | Description |
|----------|-------------|
| [CLI Reference](docs/cli-reference.md) | All `paralizer` commands and options |
| [Worktrees Comparison](docs/worktrees-comparison.md) | When to use this tool instead of Git worktrees |
| [Start with Windows](docs/start-with-windows.md) | Launch the GUI server at Windows login |
| [Contributing](CONTRIBUTING.md) | Development setup, build commands, and test instructions |
| [Changelog](CHANGELOG.md) | Release history |
| [Project Manifest](docs/agents/project-manifest/README.md) | Architecture, REST API, and technical reference |

## License

[ISC](LICENSE)
