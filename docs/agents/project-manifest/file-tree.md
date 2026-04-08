# File Tree

```
repo-parallelizer/
├── package.json                    # Project metadata, scripts, bin declaration
├── tsconfig.json                   # TypeScript compiler config (ES2022, Node16)
├── config.dist.json                # Template config — copy to config.json
├── config.json                     # (gitignored) Runtime config with user paths
├── README.md                       # Project overview and full API docs
├── CONTRIBUTING.md                 # Developer guide and conventions
├── CHANGELOG.md                    # Release history
├── LICENSE                         # Project license
│
├── src/                            # TypeScript source (rootDir)
│   ├── index.ts                    # CLI entry point — interactive menu
│   ├── errors.ts                   # Shared error classes (NotFoundError)
│   │
│   ├── config/                     # Configuration loading & types
│   │   ├── config.ts               # loadConfig() — reads and validates config.json
│   │   └── config.types.ts         # AppConfig interface
│   │
│   ├── git/                        # Git CLI wrapper layer (stateless functions)
│   │   ├── git.types.ts            # GitResult, GitStatusInfo, BranchInfo, CloneOptions, RunGitOptions
│   │   ├── git-cli.ts              # runGit(), runGitOrThrow() — subprocess execution
│   │   ├── git-clone.ts            # cloneRepository()
│   │   ├── git-branch.ts           # listBranches(), createBranch(), switchBranch(), etc.
│   │   └── git-status.ts           # getGitStatus(), fetchAndGetStatus()
│   │
│   ├── models/                     # Stateless data managers (CRUD, disk-backed JSON)
│   │   ├── project/
│   │   │   ├── project.types.ts    # ProjectData, ProjectWorkspace, ProjectIndexEntry
│   │   │   └── project.manager.ts  # ProjectManager class
│   │   ├── repository/
│   │   │   ├── repository.types.ts # Repository, RepositoryStore
│   │   │   └── repository.manager.ts # RepositoryManager class
│   │   └── workspace/
│   │       ├── workspace.types.ts  # WorkspaceInfo, STABLE_WORKSPACE_ID constant
│   │       └── workspace.manager.ts # WorkspaceManager class
│   │
│   ├── orchestration/              # High-level composite operations
│   │   ├── orchestration.types.ts  # OrchestrationResult, BranchSwitchResult, etc.
│   │   ├── project-orchestrator.ts # ProjectOrchestrator — create/delete/rename projects
│   │   ├── repository-orchestrator.ts # RepositoryOrchestrator — add/remove repos from projects
│   │   ├── workspace-orchestrator.ts  # WorkspaceOrchestrator — create/delete/rename workspaces
│   │   ├── branch-orchestrator.ts  # BranchOrchestrator — multi-repo branch operations
│   │   └── vscode-workspace.ts     # VS Code .code-workspace file generation
│   │
│   ├── storage/                    # JSON persistence primitives
│   │   ├── storage.types.ts        # BaseStore, SchemaVersion
│   │   └── json-storage.ts         # readJsonFile(), writeJsonFile(), initializeStorage()
│   │
│   ├── utils/                      # Shared helpers
│   │   ├── paths.ts                # getToolRoot(), getConfigPath(), folder resolution
│   │   └── slug.ts                 # toKebabCase(), isValidKebabCase(), inferSlugFromUrl(), isValidWorkspaceId()
│   │
│   ├── server/                     # Built-in HTTP server
│   │   ├── index.ts                # startServer(), stopServer()
│   │   ├── router.ts               # Router class with method-based registration
│   │   ├── staticServer.ts         # serveStatic() — serves gui/public/
│   │   ├── pollingManager.ts       # PollingManager — periodic git status polling
│   │   ├── requestUtils.ts         # parseJsonBody(), sendJson(), sendError(), extractParams()
│   │   ├── routes/                 # REST API endpoint handlers
│   │   │   ├── repositories.ts     # /api/repositories CRUD
│   │   │   ├── projects.ts         # /api/projects CRUD + rename + repo management
│   │   │   ├── workspaces.ts       # /api/projects/:id/workspaces CRUD + rename
│   │   │   ├── branches.ts        # /api/projects/:id/workspaces/:wid/branches
│   │   │   └── status.ts           # /api/projects/:id/workspaces/:wid/status
│   │   └── __tests__/              # Server-specific test files
│   │       ├── index.test.ts
│   │       ├── pollingManager.test.ts
│   │       ├── requestUtils.test.ts
│   │       └── routes/             # Per-route handler tests
│   │
│   └── tests/                      # Core module test files
│       ├── config.test.ts
│       ├── git-cli.test.ts
│       ├── git-clone.test.ts
│       ├── git-branch.test.ts
│       ├── git-status.test.ts
│       ├── json-storage.test.ts
│       ├── storage-init.test.ts
│       ├── paths.test.ts
│       ├── slug.test.ts
│       ├── project.manager.test.ts
│       ├── repository.manager.test.ts
│       ├── workspace.manager.test.ts
│       ├── project-orchestrator.test.ts
│       ├── repository-orchestrator.test.ts
│       ├── workspace-orchestrator.test.ts
│       ├── branch-orchestrator.test.ts
│       └── vscode-workspace.test.ts
│
├── gui/                            # Frontend SPA (served by staticServer)
│   └── public/
│       ├── index.html              # HTML shell with #app container
│       ├── css/
│       │   └── styles.css          # Full stylesheet with CSS variables
│       └── js/
│           ├── app.js              # App bootstrap — route registration
│           ├── router.js           # Hash-based SPA router
│           ├── api.js              # REST API client (namespaced: repositories, projects, workspaces, branches, status)
│           ├── views/              # Page-level view functions
│           │   ├── dashboard.js    # Project listing and creation
│           │   ├── repositories.js # Repository CRUD table
│           │   ├── project-detail.js # Project editing, repo/workspace management
│           │   ├── workspace-detail.js # Live status with polling, rename/delete
│           │   └── branch-switch.js # 3-step branch switch wizard
│           ├── components/         # Reusable UI components
│           │   ├── confirm-dialog.js # Modal confirmation dialog
│           │   ├── form-helpers.js # Form field generation and validation
│           │   ├── status-badge.js # Git status badge rendering
│           │   └── toast.js        # Toast notification system
│           └── utils/
│               └── normalise.js    # JSON key normalisation (PascalCase ↔ camelCase)
│
├── dist/                           # (gitignored) Compiled JS output
├── node_modules/                   # (gitignored) Dependencies
│
└── docs/
    ├── projects/
    │   └── tool-description.md     # Original project spec and data schemas
    └── agents/
        ├── project-manifest/       # This manifest
        ├── implementation-history/ # Phase-by-phase implementation logs
        ├── plans/                  # Planned work packages
        └── research/               # Agent research documents
```
