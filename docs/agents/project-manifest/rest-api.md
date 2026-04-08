# REST API

All endpoints are served by the built-in HTTP server on `serverPort` (default `4200`). Request and response bodies are JSON. The GUI SPA is served as static files from the same server.

---

## Repositories

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/repositories` | 200 | — | List all repositories. |
| `GET` | `/api/repositories/:id` | 200 | 404 | Get a single repository by ID. |
| `POST` | `/api/repositories` | 201 | 400 | Register a new repository. Body: `{ url, name?, id? }`. |
| `PUT` | `/api/repositories/:id` | 200 | 404, 500 | Update repository metadata. Body: `{ name }`. |
| `DELETE` | `/api/repositories/:id` | 204 | 404 | Delete a repository. |

---

## Projects

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/projects` | 200 | — | List all projects (index entries). |
| `GET` | `/api/projects/:id` | 200 | 404 | Get full project data by ID. |
| `POST` | `/api/projects` | 201 | 400 | Create a new project. Body: `{ name, repositoryIds, description?, id? }`. |
| `PUT` | `/api/projects/:id` | 200 | 404 | Update project metadata. Body: `{ Name?, Description? }`. |
| `PUT` | `/api/projects/:id/rename` | 200 | 400, 404 | Rename project (change ID). Body: `{ newId }`. |
| `DELETE` | `/api/projects/:id` | 204 | 404 | Delete project and all workspace files. |
| `POST` | `/api/projects/:id/repositories` | 200 | 400, 404 | Add repository to project. Body: `{ repositoryId }`. |
| `DELETE` | `/api/projects/:id/repositories/:repoId` | 204 | 404 | Remove repository from project. |

---

## Workspaces

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/projects/:id/workspaces` | 200 | 404 | List workspaces in a project. |
| `GET` | `/api/projects/:id/workspaces/:wid` | 200 | 404 | Get a single workspace. |
| `POST` | `/api/projects/:id/workspaces` | 201 | 400, 404 | Create workspace. Body: `{ id, description? }`. |
| `PUT` | `/api/projects/:id/workspaces/:wid` | 200 | 400, 404 | Update workspace. Body: `{ Description? }`. |
| `PUT` | `/api/projects/:id/workspaces/:wid/rename` | 200 | 400, 404 | Rename workspace. Body: `{ newId }`. |
| `DELETE` | `/api/projects/:id/workspaces/:wid` | 204 | 404 | Delete workspace (STABLE cannot be deleted). |

---

## Branches

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/projects/:id/workspaces/:wid/branches` | 200 | 404, 500 | Get all branches per repository + suggestion list. |
| `POST` | `/api/projects/:id/workspaces/:wid/branches/switch` | 200 | 400, 404, 500 | Switch branches. Body: `{ assignments: { [repoId]: branchName } }`. |

### `GET .../branches` Response Shape

```json
{
    "branches": {
        "repo-id": [
            { "name": "main", "isCurrent": true, "isRemote": false, "upstream": "origin/main" }
        ]
    },
    "suggestions": ["main", "develop", "feature/xyz"]
}
```

### `POST .../branches/switch` Response Shape

```json
{
    "results": {
        "repo-id": { "success": true, "conflict": false },
        "other-repo": { "success": false, "conflict": true, "error": "merge conflict..." }
    }
}
```

---

## Status

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/projects/:id/workspaces/:wid/status` | 200 | 404 | Get cached git status for all repos in workspace. |
| `POST` | `/api/projects/:id/workspaces/:wid/status/refresh` | 200 | 404, 500 | Force-refresh git status (fetch + poll). |

### `GET .../status` Response Shape

```json
{
    "repo-id": {
        "currentBranch": "main",
        "localCommits": 0,
        "unfetchedCommits": 2,
        "modifiedFiles": 3,
        "lastActivity": "2026-04-08T12:00:00Z",
        "hasConflicts": false
    }
}
```
