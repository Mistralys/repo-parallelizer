# Project: Repository Parallelizer

**WIP**

## Overview

Create a tool to manage and automate the creation and handling of local development workspaces with VS Code and Github, and which are used to parallelize work on the same sets of Git repositories identified as projects.

## What it does

- Create and maintain VS Code workspace files
  - Workspace ID
  - List of repositories
  - Current project title "New Feature"
  - Freeform notes/comments
- Monitor git status of repositories
  - Local commits
  - Unfetched commits on origin
  - Modified file count
  - Last activity
- Create a branch for a workspace > Choose which repositories should use it
- GUI with an overview of all workspaces

## Data Types

### Repositories

All Git repositories that can be used for projects and workspaces are configured once globally to be able to easily use them where needeed. 

> NOTE: This is configuration-only. Checkouts are done only on the workspace level.

#### Repository Properties

- ID: Lowercase kebab-case repository slug (mandatory, must be unique, default: inferred from the URL)
    - Example: `https://github.com/Mistralys/repo-parallelizer.git` > `repo-parallelizer`
- Name: User-specified pretty name of the repository (optional, uses ID if empty)
- Remote URL: User-specified URL of the repository (mandatory, must be unique)

#### Data Storage

- A central list of repositories, `{STORAGE_FOLDER}/repositories.json`

```json
{
    "Repositories": [
        {
            "ID": "repo-paralellizer",
            "Name": "Repo Parallelizer",
            "URL": "https://github.com/Mistralys/repo-parallelizer.git"
        }
    ],
    "SchemaVersion": 1
}
```

### Projects

#### Overview

Projects are containers for:

- Git repositories - Connected globally to the project. Define which repositories each workspace must check out.
- Workspaces - Specific work "Branches" of a project. Contain the git repository clones.

They are used to group workspaces by topic. For example, a project can be created to work on a single library or an application with all related support libraries.

#### Project Properties

- ID: Lowercase kebab-case project slug (mandatory, must be unique, default: Inferred from the name)
- Name: User-specified pretty name of the project (mandatory, must be unique)
- Description: User-specified description of the project (optional)
- Date created: Date and time of the project's creation.
- Date modified: Date when the project has been last updated (= whenever changes are saved to the data file)
- Git Repositories: At least one repository must be added. Chosen by the user from the global list of repositories.
- Workspaces: At minimum `STABLE`.

#### Storage

- A project metadata file, `{STORAGE_FOLDER}/projects/{PROJECT_SLUG}.json`
- A global project index file for fast lookups, `{STORAGE_FOLDER}/projects-index.json`
- A project folder, `{PROJECTS_FOLDER}/{PROJECT_SLUG}`

**Projects schema**

```json
{
  "Projects": [
    { 
        "ID": "project-name", 
        "Name": "Project Name" 
    }
  ],
  "SchemaVersion": 1
}
```

**Project schema**

```json
{
    "ID": "project-name",
    "Name": "Project Name",
    "Description": "Detailed description of the project",
    "DateCreated": "DATE_WITH_TIMEZONE",
    "DateModified": "DATE_WITH_TIMEZONE", 
    "Repositories": [
        "repo-parallelizer"
    ],
    "Workspaces": {
        "STABLE": {
           "Description": "Detailed description of the workspace",
           "DateCreated": "DATE_WITH_TIMEZONE",
           "DateModified": "DATE_WITH_TIMEZONE"
        }
    },
    "SchemaVersion": 1
}
```

### Workspaces

#### Workspace Properties

- ID: User-specified, short uppercase identifier (2-6 chars, A-Z, unique within the project).
- Git repositories: Inherited from the project. Checked out on creation.
- Description: User-specified description of the workspace (optional).
- Date created: The date and time that this workspace has been created.
- Date modified: The date and time this workspace was last modified (includes git status changes).

#### The STABLE workspace

Each project has a `STABLE` workspace: This is used for the stable channel (the remote's default branch) for all repositories in the project. This is used for hotfixes independently of the other workspaces.

- The `STABLE` workspace is automatically created for new projects.
- The `STABLE` workspace cannot be deleted.
- The `STABLE` workspace's repositories always use the remote's default branch.
- The `STABLE` workspace does not allow switching the branch. Its sole purpose is to work on the main branch.

#### Storage

- Metadata (integrated in the project's JSON)
- A VS Code workspace file (JSON format), `{PROJECTS_FOLDER}/{PROJECT_SLUG}-{WORKSPACE_ID}.code-workspace`
- A workspace folder, `{PROJECTS_FOLDER}/{PROJECT_SLUG}/{WORKSPACE_ID}`
- Git repository clones, `{PROJECTS_FOLDER}/{PROJECT_SLUG}/{WORKSPACE_ID}/{REPOSITORY_SLUG}`

#### Example Workspace Setup

- Repository: Application
  - Git clone folder: `{PROJECTS_FOLDER}/{PROJECT_SLUG}/{WORKSPACE_ID}/{REPOSITORY_SLUG}`
  - Git branch: `new-feature`
- Repository: Support Library
  - Git clone folder: `{PROJECTS_FOLDER}/{PROJECT_SLUG}/{WORKSPACE_ID}/{REPOSITORY_SLUG}`
  - Git branch: `main`

#### Git Branch Handling

When working on a feature in multi-repository workspaces, not all repositories need to have a feature branch created. The user can choose, when creating a new branch through the GUI, which repositories should get the branch.

#### Git Error Handling

- Failed checkouts require user intervention.
- User can retry through the GUI, and if all else fails, can decide to delete the repository.
- Repositories that cannot be checked out are marked as erroneous in the GUI.
- Failed repositories are not included in the VS Code workspaces.
- Partial clone failures: Successful clones are always allowed to stay.

### VS Code Workspace Files

The workspace files have a straightforward structure:

```json
{
	"folders": [
        {
            "path": "{PROJECTS_FOLDER}/{PROJECT_SLUG}/{WORKSPACE_ID}/{REPOSITORY_SLUG}",
            "name": "{PROJECT_NAME} ({WORKSPACE_ID})"
        }
    ],
    "settings": {}
}
```

**IMPORTANT:** If the file already exist, the tool should only modify the `folders` property, and leave everything else untouched. The user may have other properties or settings that need to be persisted.

## Tech Stack

- Technology: public npm package
- NPM Binary name: `paralizer`
- Target platorms: MacOS, Windows, Unix
- Git Interface: CLI (Git is available on all systems)
- CLI Interface: node's `child_process.spawn` with `shell:false` (guranteed cross-platform)
- Storage: JSON files
- Documentation: CTX Generator for agent context documentation generation (https://github.com/context-hub/generator), available on the machine through `ctx generate`.


## The GUI 

A browser-based GUI is used to view and manage the available workspaces. This is the main interface to use the tool.

### Features

- Manage Git Repositories
- Manage Projects
  - Manage project repositories
  - Manage workspaces
    - Monitor repo git status

> NOTE: "Manage" means the possibility to create, modify and delete.

### Git Status Handling

The git status is polled regularly (see `GitPollingIntervalSeconds` config setting).

### Actions

#### Renaming a Project's ID

- The user must confirm this operation, with information on the consequences.
- The change is cascaded everywhere applicable
    - Folder names
    - Configurations
    - VS Code workspace file
    - etc.

#### Renaming a Workspace's ID

- The user must confirm this operation, with information on the consequences.
- The change is cascaded everywhere applicable
    - Folder names
    - Configurations
    - VS Code workspace file
    - etc.

#### Switching a Workspace's Branch

When working on a feature, the user can choose to create or switch to an existing branch.

1. Choose a branch
    - Choose an existing branch: A list is compiled using a case-insensitive comparison of all branches across all repositories.
    - Create a new branch: The user enters a branch name.
2. Choose repositories
    - A list of all repositories in the workspace is shown.
    - Each repository as a text input for the branch name.
    - Each repository also has a select input with a list of branch names in that repository (fetched from git). On selecting an entry, the branch name is copied into the branch text input. The branch chosen in step 1 is in a dedicated group at the top. of the select to distinguish it from the rest.
    - All repositories are initially set to the branch name chosen in step 1.
    - The user can change individual repository branch names.
3. Confirm changes
    - The selected branches are either created if they do not exist yet.
    - For existing branches, the repository is switched to that branch.
    - Any existing file changes are brought over to the new branch (not stashed).
    - If there are any conflicts, notify the user - they will handle this manually.

#### Adding a Project Repository

- Clones the repository into all workspaces of the project.
- Use the remote's default branch for all repositories, the user can change this afterwards.
- Updates all VS Code workspace documents of the project.

#### Adding a Project

- Automatically creates the `STABLE` workspace (which checks out its repos).

#### Adding a Workspace

- Checks out all local repository clones configured for the project.
- Uses the remote's default branch for all clones initially. (The user can adjust this afterwards)
- Repos use a depth of `50` by default.

#### Deleting Workspaces

The user must confirm the deletion.

- Deletes the whole workspace folder on disk, which includes all repository clones.
- Removes the workspace from the project's storage file.
- Deletes the workspace's VS Code workspace file.

> NOTE: The `STABLE` workspace cannot be deleted.

#### Deleting Projects

The user must confirm the deletion.

- Deletes the whole project folder on disk, which includes all workspaces and repositories.
- Deletes the project's storage file.
- Removes the project from the index.
- Deletes the project's VS Code workspace files.

#### Deleting Project Repositories

The user must confirm the deletion.

- Removes the repository from the project's storage file.
- Deletes the repository clones from the project's workspaces.

#### Deleting Repositories

The user must confirm the deletion.

- Removes the repository from the storage file.
- Removes the repository from all projects that use it.
- Deletes the local clones of the repository in all workspaces.

#### Changing a Repository URL

This happens so rarely that it is not allowed. Instead, the user should delete the repository and add a new one.

### Tech Stack

- No authentication required.
- Single developer use, run locally on development machines.
- Backend: Standalone Node.js HTTP server (gui/server.ts) using node:http directly.
- Frontend: Plain HTML, CSS, and vanilla JavaScript — hash-based client-side router, hand-written views, and a custom API client.

## CLI Menu

A CLI menu is used for first-time setup automation and general maintenance:

- Setup script
- Documentation generation (via CTX generator)
- Launch the GUI

The menu should be easy to run, e.g. `menu.sh` + `menu.cmd`.

Technology: node with libraries to handle terminal colors for a user-friendly interface including keyboard shortcuts.

## Global Configuration

- `ProjectsFolder`: Target folder for projects, e.g. `/path/to/projects/`
- `StorageFolder`: Target folder for the tool metadata storage, e.g. `/path/to/tool-metadata/`
- `CloneDepth`: The depth to use for cloning repos. Default: `50`.
- `ServerPort`: The port for the GUI's server. Default: `4200`.
- `GitPollingIntervalSeconds`: Seconds between git status polling actions. Default: `30`.

### Storage

The configuration lives in the tool's folder, from where it is started.

A template config is provided, `config.dist.json`, which can be copied to `config.json`. 

> NOTE: The setup script can guide the user through the config generation.

## Out of Scope

- No conflict/merge resolution.
- No CI/CD/PR management.
- No multi-user collaboration: Purely single-developer local developement.
- No VS Code integration beyond creating workspace files.
- No repo interdependencies: Handled by the user.
