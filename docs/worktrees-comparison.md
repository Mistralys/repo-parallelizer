# How Does This Compare to Git Worktrees?

Git worktrees let you check out multiple branches of a **single** repository side by side, which suits projects that live entirely in one repo. Repository Parallelizer solves a different problem: projects that span **multiple** repositories which need to move together.

| | Git Worktrees | Repository Parallelizer |
|---|---|---|
| **Scope** | One repository | Several repositories |
| **Branch switching** | Per repository | Coordinated across the repositories in a workspace |
| **VS Code workspace** | Set up manually | Generated `.code-workspace` file |
| **Status overview** | Per-repository `git status` | Aggregated across a workspace's repositories |

## Which one should I use?

If your project is a single repository, worktrees are the simpler choice. If you are juggling, for example, a frontend, a backend, a shared library, and an infrastructure repository that all need to be on the same feature branch, that is where this tool fits.
