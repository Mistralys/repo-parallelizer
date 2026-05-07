# Project - Folder Structure
###  
```
└── AGENTS.md
└── CHANGELOG.md
└── CLAUDE.md
└── CONTRIBUTING.md
└── LICENSE/
└── README.md
└── config.dist.json
└── config.json
└── context.yaml
└── docs/
    ├── agents/
    │   ├── project-manifest/
    │   │   ├── README.md
    │   │   ├── api-surface.md
    │   │   ├── constraints.md
    │   │   ├── data-flows.md
    │   │   ├── gui-frontend.md
    │   │   ├── rest-api.md
    │   │   ├── tech-stack.md
    │   ├── research/
    │   │   └── 2026-04-23-project-list-filtering-sorting.md
    ├── projects/
    │   └── tool-description.md
└── gui/
    ├── README.md
    ├── module-context.yaml
    ├── package.json
    ├── public/
    │   └── css/
    │       ├── styles.css
    │       ├── vendor/
    │       │   └── pico.classless.min.css
    │   └── index.html
    │   └── js/
    │       └── __tests__/
    │           ├── dashboard.test.mjs
    │           ├── normalise.test.mjs
    │           ├── test-setup.mjs
    │       └── api.config.test.mjs
    │       └── api.errorLog.test.mjs
    │       └── api.js
    │       └── api.workspaces.launch.test.mjs
    │       └── app.js
    │       └── components/
    │           ├── branch-quick-switch.js
    │           ├── confirm-dialog.js
    │           ├── form-helpers.js
    │           ├── nav-badge.js
    │           ├── repo-status-cells.js
    │           ├── repo-status-cells.test.mjs
    │           ├── status-badge.js
    │           ├── theme-toggle.js
    │           ├── toast.js
    │       └── router.js
    │       └── utils/
    │           ├── constants.js
    │           ├── dom.js
    │           ├── nav-highlight.js
    │           ├── normalise.js
    │           ├── time.js
    │       └── views/
    │           └── branch-switch.js
    │           └── dashboard.js
    │           └── dashboard.test.mjs
    │           └── error-log.js
    │           └── notes-collected.js
    │           └── notes-collected.test.mjs
    │           └── project-detail.js
    │           └── repositories.js
    │           └── repositories.test.mjs
    │           └── repository-detail.js
    │           └── repository-detail.test.mjs
    │           └── settings.js
    │           └── workspace-detail.js
    │           └── workspace-detail.notes.test.mjs
    │           └── workspace-detail.open-button.test.mjs
    │           └── workspace-detail.vscode-button.test.mjs
└── menu.cmd
└── menu.sh
└── package-lock.json
└── package.json
└── src/
    ├── cli/
    │   ├── docs.ts
    │   ├── menu.ts
    │   ├── setup.ts
    │   ├── terminal-ui.ts
    ├── config/
    │   ├── README.md
    │   ├── config.constants.ts
    │   ├── config.ts
    │   ├── config.types.ts
    │   ├── module-context.yaml
    ├── error-log/
    │   ├── README.md
    │   ├── error-log.manager.ts
    │   ├── error-log.types.ts
    │   ├── module-context.yaml
    ├── errors.ts
    ├── git/
    │   ├── README.md
    │   ├── git-branch.ts
    │   ├── git-cli.ts
    │   ├── git-clone.ts
    │   ├── git-credentials.ts
    │   ├── git-status.ts
    │   ├── git.types.ts
    │   ├── module-context.yaml
    ├── index.ts
    ├── models/
    │   ├── README.md
    │   ├── module-context.yaml
    │   ├── project/
    │   │   ├── project.manager.ts
    │   │   ├── project.types.ts
    │   ├── repository/
    │   │   ├── repository.manager.ts
    │   │   ├── repository.types.ts
    │   ├── workspace/
    │   │   └── workspace.manager.ts
    │   │   └── workspace.types.ts
    ├── orchestration/
    │   ├── README.md
    │   ├── branch-orchestrator.ts
    │   ├── module-context.yaml
    │   ├── orchestration.types.ts
    │   ├── project-orchestrator.ts
    │   ├── repository-orchestrator.ts
    │   ├── vscode-workspace.ts
    │   ├── workspace-health.ts
    │   ├── workspace-orchestrator.ts
    ├── server/
    │   ├── README.md
    │   ├── __tests__/
    │   │   ├── app-launcher.test.ts
    │   │   ├── index.test.ts
    │   │   ├── pollingManager.errorLog.test.ts
    │   │   ├── pollingManager.test.ts
    │   │   ├── requestUtils.test.ts
    │   │   ├── router.test.ts
    │   │   ├── routes/
    │   │   │   ├── branches.test.ts
    │   │   │   ├── config.test.ts
    │   │   │   ├── error-log.test.ts
    │   │   │   ├── notes.test.ts
    │   │   │   ├── projects.test.ts
    │   │   │   ├── repositories.test.ts
    │   │   │   ├── status.test.ts
    │   │   │   ├── workspaces-health.test.ts
    │   │   │   ├── workspaces-launch.test.ts
    │   │   │   ├── workspaces.test.ts
    │   │   ├── staticServer.test.ts
    │   ├── app-launcher.ts
    │   ├── index.ts
    │   ├── module-context.yaml
    │   ├── pollingManager.ts
    │   ├── requestUtils.ts
    │   ├── router.ts
    │   ├── routes/
    │   │   ├── branches.ts
    │   │   ├── config.ts
    │   │   ├── error-log.ts
    │   │   ├── notes.ts
    │   │   ├── projects.ts
    │   │   ├── repositories.ts
    │   │   ├── status.ts
    │   │   ├── version.ts
    │   │   ├── workspaces.ts
    │   ├── staticServer.ts
    ├── storage/
    │   ├── README.md
    │   ├── json-storage.ts
    │   ├── module-context.yaml
    │   ├── storage.types.ts
    ├── tests/
    │   ├── branch-orchestrator.test.ts
    │   ├── config.test.ts
    │   ├── error-log.manager.test.ts
    │   ├── git-branch.test.ts
    │   ├── git-cli.test.ts
    │   ├── git-clone.test.ts
    │   ├── git-credentials.test.ts
    │   ├── git-status.test.ts
    │   ├── json-storage.test.ts
    │   ├── paths.test.ts
    │   ├── project-orchestrator.test.ts
    │   ├── project.manager.test.ts
    │   ├── repository-orchestrator.test.ts
    │   ├── repository.manager.test.ts
    │   ├── setup.test.ts
    │   ├── slug.test.ts
    │   ├── storage-init.test.ts
    │   ├── test-helpers.ts
    │   ├── vscode-workspace.test.ts
    │   ├── workspace-health.test.ts
    │   ├── workspace-orchestrator.test.ts
    │   ├── workspace.manager.test.ts
    ├── utils/
    │   └── README.md
    │   └── module-context.yaml
    │   └── paths.ts
    │   └── slug.ts
└── tsconfig.json

```
---
**File Statistics**
- **Size**: 7.58 KB
- **Lines**: 214
File: `project-folder-structure.md`
