# Repository Parallelizer

Manage multiple related git repositories as a single project — with parallel workspaces, branch orchestration, and a web-based GUI.

## What Is This?

When a project spans several git repositories, keeping them in sync is tedious: cloning each one, switching branches across all of them, remembering which repos belong together. **Repository Parallelizer** treats a group of repos as one "project" and lets you create isolated **workspaces** — each with its own branch configuration, cloned copies, and a ready-to-open VS Code `.code-workspace` file.

Set up a project once, then spin up as many parallel workspaces as you need — one for the main branch, one for a feature, one for a hotfix — without stepping on your own toes.

## Features

- **Project-based repo grouping** — register repositories once, then combine them into projects.
- **Parallel workspaces** — create multiple independent workspaces per project, each with its own branch assignments and cloned copies.
- **One-click branch switching** — switch branches across all repos in a workspace in a single operation, with conflict detection.
- **VS Code integration** — auto-generated `.code-workspace` files let you open an entire workspace in VS Code instantly.
- **Web GUI** — a built-in browser UI for managing repositories, projects, workspaces, and branches — no terminal required after setup. The project dashboard supports real-time filtering by name/ID/description, repository filtering, and sort by alphabetical or last-activity order.
- **Live git status** — automatic polling shows current branches, uncommitted changes, and unfetched commits at a glance.
- **Workspace health checks** — detect and fix configuration drift (missing repos, stale workspace files).
- **Interactive CLI** — a keyboard-driven terminal menu for quick access to setup, server launch, and documentation generation.
- **Private repo support** — per-host credential management for cloning private repositories.

## How Does This Compare to Git Worktrees?

Git worktrees let you check out multiple branches of a **single** repository side by side — great when your entire project lives in one repo. Repository Parallelizer solves a different problem: when your project spans **multiple** repositories that need to move together.

| | Git Worktrees | Repository Parallelizer |
|---|---|---|
| **Scope** | One repository, multiple branches | Multiple repositories, multiple branches |
| **Branch switching** | Per-repo only | Coordinated across all repos at once |
| **VS Code workspace** | Manual setup | Auto-generated `.code-workspace` files |
| **Status overview** | Per-repo (`git status`) | Aggregated across all repos in a workspace |

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

### Alternative: run without installing globally

```bash
# Unix / macOS
./menu.sh

# Windows
menu.cmd
```

### CLI commands

| Command | Description |
|---------|-------------|
| `paralizer` | Open the interactive CLI menu |
| `paralizer serve` | Start the GUI server directly |
| `paralizer setup` | Run the setup wizard |
| `paralizer docs` | Generate project documentation |

## Start with Windows

1. Press `Win + R`, type the following command to open your user Startup folder, and press **Enter**:
   ```
   shell:startup
   ```
   *(This opens the folder: `C:\Users\<YourUsername>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`)*

2. In that folder, right-click an empty area and select **New** > **Text Document**.
3. Name it `start-repo-parallelizer.vbs` (ensure you delete the `.txt` extension!).
4. Right-click the new file, select **Edit** (or open it with Notepad/VS Code), and paste the following code into it:

   ```vbscript
   Set WshShell = CreateObject("WScript.Shell")
   ' 0 means the window will be hidden, so you don't have a lingering terminal
   WshShell.Run "cmd /c paralizer serve", 0
   Set WshShell = Nothing
   ```

   > **Requires `npm link`** — run `npm link` once in the project folder so `paralizer` is available globally.

5. Save and close the file.

### How it works:
Every time you log into Windows, this script will seamlessly launch the server in the background without leaving an unused command prompt window taking up space on your taskbar. The background Node.js process will execute exactly as it normally does. 

*(If you ever want to stop it from starting automatically, just delete the `start-repo-parallelizer.vbs` file from that Startup folder.)*

## Learn More

| Resource | Description |
|----------|-------------|
| [Project Manifest](docs/agents/project-manifest/README.md) | Architecture overview and document index |
| [REST API](docs/agents/project-manifest/rest-api.md) | All HTTP endpoints with methods, paths, and response shapes |
| [GUI Frontend](docs/agents/project-manifest/gui-frontend.md) | SPA architecture, routes, and components |
| [Tech Stack](docs/agents/project-manifest/tech-stack.md) | Runtime, dependencies, and architectural patterns |
| [API Surface](docs/agents/project-manifest/api-surface.md) | Exported types, classes, and function signatures |
| [Configuration](docs/agents/project-manifest/constraints.md) | Conventions, validation rules, and config schema |
| [Contributing](CONTRIBUTING.md) | Development setup, build commands, and test instructions |
| [Changelog](CHANGELOG.md) | Release history |

## License

[ISC](LICENSE)
