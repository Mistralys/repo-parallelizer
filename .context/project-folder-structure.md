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
└── context.yaml
└── docs/
    ├── agents/
    │   ├── project-manifest/
    │   │   └── README.md
    │   │   └── api-surface.md
    │   │   └── constraints.md
    │   │   └── data-flows.md
    │   │   └── file-tree.md
    │   │   └── gui-frontend.md
    │   │   └── rest-api.md
    │   │   └── tech-stack.md
    ├── projects/
    │   └── tool-description.md
└── gui/
    ├── README.md
    ├── module-context.yaml
    ├── public/
    │   └── css/
    │       ├── styles.css
    │       ├── vendor/
    │       │   └── pico.classless.min.css
    │   └── index.html
    │   └── js/
    │       └── api.js
    │       └── app.js
    │       └── components/
    │           ├── confirm-dialog.js
    │           ├── form-helpers.js
    │           ├── status-badge.js
    │           ├── theme-toggle.js
    │           ├── toast.js
    │       └── router.js
    │       └── utils/
    │           ├── nav-highlight.js
    │           ├── normalise.js
    │       └── views/
    │           └── branch-switch.js
    │           └── dashboard.js
    │           └── project-detail.js
    │           └── repositories.js
    │           └── workspace-detail.js
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
    │   ├── config.ts
    │   ├── config.types.ts
    │   ├── module-context.yaml
    ├── errors.ts
    ├── git/
    │   ├── README.md
    │   ├── git-branch.ts
    │   ├── git-cli.ts
    │   ├── git-clone.ts
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
    │   ├── workspace-orchestrator.ts
    ├── server/
    │   ├── README.md
    │   ├── __tests__/
    │   │   ├── index.test.ts
    │   │   ├── pollingManager.test.ts
    │   │   ├── requestUtils.test.ts
    │   │   ├── router.test.ts
    │   │   ├── routes/
    │   │   │   ├── branches.test.ts
    │   │   │   ├── projects.test.ts
    │   │   │   ├── repositories.test.ts
    │   │   │   ├── status.test.ts
    │   │   │   ├── workspaces.test.ts
    │   │   ├── staticServer.test.ts
    │   ├── index.ts
    │   ├── module-context.yaml
    │   ├── pollingManager.ts
    │   ├── requestUtils.ts
    │   ├── router.ts
    │   ├── routes/
    │   │   ├── branches.ts
    │   │   ├── projects.ts
    │   │   ├── repositories.ts
    │   │   ├── status.ts
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
    │   ├── git-branch.test.ts
    │   ├── git-cli.test.ts
    │   ├── git-clone.test.ts
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
    │   ├── vscode-workspace.test.ts
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
- **Size**: 5.11 KB
- **Lines**: 154
File: `project-folder-structure.md`
