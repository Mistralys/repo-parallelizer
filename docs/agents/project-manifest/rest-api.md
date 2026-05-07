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
| `GET` | `/api/projects/:id` | 200 | 404 | Get full project data by ID. Response includes an optional `LastActivity?: string` field (ISO 8601) when the project has recorded git activity via the polling layer; absent on projects that have never been polled. |
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
| `GET` | `/api/projects/:id/workspaces` | 200 | 404 | List workspaces in a project. Response includes `Initialized` boolean and `FolderPath` string. |
| `GET` | `/api/projects/:id/workspaces/:wid` | 200 | 404 | Get a single workspace. Response includes `Initialized` boolean and `FolderPath` string. |
| `POST` | `/api/projects/:id/workspaces` | 201 | 400, 404 | Create workspace. Body: `{ id, description? }`. |
| `PUT` | `/api/projects/:id/workspaces/:wid` | 200 | 400, 404 | Update workspace description and/or notes. Body: `{ description?, notes? }` — at least one field required. 400 if neither field is present or body is not a valid JSON object. Response includes a `Notes` field on the returned `WorkspaceInfo`. |
| `PUT` | `/api/projects/:id/workspaces/:wid/rename` | 200 | 400, 404 | Rename workspace. Body: `{ newId }`. |
| `DELETE` | `/api/projects/:id/workspaces/:wid` | 204 | 404 | Delete workspace (STABLE cannot be deleted). |
| `POST` | `/api/projects/:id/workspaces/:wid/setup` | 200 | 400, 404, 500 | Initialize workspace on disk (clone repos, generate .code-workspace file). |
| `POST` | `/api/projects/:id/workspaces/:wid/regenerate-workspace-file` | 200 | 400, 404, 500 | Regenerate the `.code-workspace` file from the current repository list without cloning. Workspace folder must already exist on disk (400 if absent). Body: none. Response: `{ success: true }`. |
| `GET` | `/api/projects/:id/workspaces/:wid/health` | 200 | 404 | Fetch the health report for a workspace. Returns `{ healthy: boolean, issues: Array<{ type: string, severity: string, message: string, fixAction: string, repositoryId?: string }> }`. Uninitialized workspaces return `{ healthy: true, issues: [] }`. 404 if project or workspace ID is unknown. |

### `PUT /api/projects/:id/workspaces/:wid` — Request Body

At least one field is required. Both fields may be sent together.

| Field | Type | Required | Description |
|---|---|---|---|
| `description` | `string` | No | Human-readable description for the workspace. |
| `notes` | `string` | No | Free-text notes for the workspace. |

**400 cases:**
- Body is not a valid JSON object.
- Body contains neither a `description` nor a `notes` field (or both values are non-string types).

**200 Response:** the full updated `WorkspaceInfo` object, including the `Notes` field (always present as a string; empty string `""` when no notes have been set).

---

## Launch

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `POST` | `/api/projects/:id/workspaces/:wid/launch/vscode` | 200 | 400, 404, 500 | Open the workspace's `.code-workspace` file in VS Code. 404 if the workspace is unknown. 400 with `"Workspace file does not exist. Run setup first."` if the file is missing from disk. 500 + error log entry (Source: `'app-launcher'`, Operation: `'launch-vscode'`) if the OS-level spawn fails. Response: `{ success: true }`. |
| `POST` | `/api/projects/:id/workspaces/:wid/launch/github-desktop/:rid` | 200 | 400, 404, 500 | Open a repository directory in GitHub Desktop. 404 if the workspace, project, or repository is unknown. 400 with `"Repository directory does not exist. Run setup first."` if the repo directory is missing from disk. 500 + error log entry (Source: `'app-launcher'`, Operation: `'launch-github-desktop'`) if the OS-level spawn fails. Response: `{ success: true }`. |

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

---

## Error Log

Four endpoints for reading and managing the runtime error log. The log is backed by `{storageFolder}/error-log.json` and capped at `AppConfig.maxErrorLogEntries` entries (default: 500, FIFO eviction).

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/error-log` | 200 | — | List error log entries, newest first. Supports filtering and pagination via query params. |
| `GET` | `/api/error-log/sources` | 200 | — | Return sorted distinct `Source` values in the store. |
| `GET` | `/api/error-log/:id` | 200 | 400, 404 | Get a single entry by numeric ID. |
| `DELETE` | `/api/error-log` | 204 | — | Clear all entries. |

> **Route ordering note:** `/api/error-log/sources` is registered **before** `/api/error-log/:id` so the literal segment `"sources"` is not captured as an `:id` parameter.

### `GET /api/error-log` — Query Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `severity` | `"error" \| "warning"` | — | Filter by severity. Any other value is silently treated as no filter. |
| `source` | `string` | — | Exact-match filter on the `Source` field. No length cap or allowlist — treat as internal-use only. |
| `limit` | `integer ≥ 0` | `100` | Maximum entries to return. `limit=0` returns an empty `entries` array but `total` is still populated. Negative values are clamped to 0. |
| `offset` | `integer ≥ 0` | `0` | Zero-based offset into the filtered result set. Negative values are treated as 0. |

> **Note on `limit=0`:** Passing `limit=0` returns `{ entries: [], total: N }`. This is intentional — it is useful for polling the current count without fetching entries. It does **not** mean "return all entries"; omit the parameter entirely to get the default 100.

### `GET /api/error-log` Response Shape

```json
{
    "entries": [
        {
            "Id": 42,
            "Timestamp": "2026-04-11T09:00:00.000Z",
            "Severity": "error",
            "Source": "clone",
            "Operation": "cloneRepository",
            "Context": { "RepositoryId": "my-repo" },
            "Message": "git clone failed",
            "Details": "fatal: repository not found"
        }
    ],
    "total": 1
}
```

`total` is the post-filter, pre-pagination count (i.e. how many entries match the filters before `limit`/`offset` are applied).

### `GET /api/error-log/:id` — ID Validation

The `:id` segment must be a **positive integer** (digits only). The following return `400`:

| Input | Reason |
|---|---|
| `abc` | Non-numeric |
| `12abc` | Mixed alphanumeric |
| `1.5` | Float |
| `0` | ID 0 is invalid; IDs start at 1 |

### `DELETE /api/error-log` — Security Note

> ⚠️ **No authentication or authorisation guard.** Any caller that can reach the HTTP server can permanently clear all diagnostic data.
>
> This is acceptable because the server is scoped to `localhost` only. **Do not expose this server beyond localhost without adding an authentication layer** (e.g. a reverse-proxy ACL or an API-key header guard) in front of the DELETE endpoint.

---

## Credentials (`/api/config/credentials`)

Manage per-host git credentials stored in `gitCredentials` within `config.json`. Changes take effect immediately (no server restart required) and are persisted to disk.

**Token masking:** tokens are never returned in full. The response always shows `****` followed by the last 4 characters (e.g. `****abc1`). Tokens shorter than 4 characters are fully masked as `****`.

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/config/credentials` | 200 | — | List all configured credentials with masked tokens. |
| `PUT` | `/api/config/credentials` | 200 | 400 | Add or update a single host entry. Body: `{ host, token }`. |
| `DELETE` | `/api/config/credentials/:host` | 200 | 404 | Remove a single host entry. |

### Validation (PUT)

- `host`: non-empty string; must not contain path separators (`/`, `\`) or whitespace.
- `token`: non-empty string.

Both fields are required; missing or invalid fields return `400` with a descriptive error message.

### `GET /api/config/credentials` Response

```json
{
    "github.com": "****abc1",
    "gitlab.com": "****xyz9"
}
```

An empty object `{}` is returned when no credentials are configured.

### `PUT /api/config/credentials` Request / Response

**Request body:**
```json
{ "host": "github.com", "token": "ghp_fulltoken" }
```

**Response** (full masked map after update):
```json
{ "github.com": "****oken" }
```

### `DELETE /api/config/credentials/:host` Response

**Response** (full masked map after deletion — empty object when last entry removed):
```json
{}
```

---

## Polling (`/api/config/polling`)

Read and update the git polling interval at runtime, without a server restart. Changes take effect immediately (the polling manager is restarted with the new interval) and are persisted to `config.json`.

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/config/polling` | 200 | — | Return the current polling interval. |
| `PUT` | `/api/config/polling` | 200 | 400 | Update the polling interval. Body: `{ seconds }`. |

### Validation (PUT)

- `seconds`: must be a finite integer **≥ 10**. Fractional values, strings, `null`, `Infinity`, and `NaN` all return `400`.

### `GET /api/config/polling` Response

```json
{ "gitPollingIntervalSeconds": 30 }
```

### `PUT /api/config/polling` Request / Response

**Request body:**
```json
{ "seconds": 60 }
```

**Response** (updated value):
```json
{ "gitPollingIntervalSeconds": 60 }
```

> **Note:** No upper bound is currently enforced. Values up to `Number.MAX_SAFE_INTEGER` pass validation and would effectively disable polling for the process lifetime. A practical maximum of 86 400 seconds (24 hours) is planned as a follow-up improvement.

---

## Webserver URL (`/api/config/webserver-url`)

Read and update the base URL of the local webserver that serves workspace repositories. When set, the workspace-detail view shows a "Browse" button for each repository row, opening `{webserverUrl}/{projectId}/{workspaceId}/{repoId}/` in a new browser tab. Changes are persisted to `config.json` and take effect immediately.

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/config/webserver-url` | 200 | — | Return the current webserver URL (or `null` when not configured). |
| `PUT` | `/api/config/webserver-url` | 200 | 400 | Update the webserver URL. Body: `{ url }`. Empty string clears the setting. |

### Validation (PUT)

- `url`: must be a string. Non-string values return `400`.
- Dangerous schemes (`javascript:`, `data:`, `vbscript:`) are rejected with `400` (defence-in-depth — `window.open('javascript:...')` can execute code in some browsers).
- An empty string (or whitespace-only string) clears the setting (`webserverUrl` is removed from `config.json`; the Browse button is hidden).
- Trailing slashes are stripped before persisting to prevent double-slash in constructed URLs.

### `GET /api/config/webserver-url` Response

```json
{ "webserverUrl": "http://localhost:8080" }
```

Returns `null` when not configured:
```json
{ "webserverUrl": null }
```

### `PUT /api/config/webserver-url` Request / Response

**Request body (set):**
```json
{ "url": "http://localhost:8080" }
```

**Response:**
```json
{ "webserverUrl": "http://localhost:8080" }
```

**Request body (clear):**
```json
{ "url": "" }
```

**Response:**
```json
{ "webserverUrl": null }
```

---

## Notes Display (`/api/config/notes-display`)

Read and update the notes view display settings at runtime, without a server restart. Changes take effect immediately (in-memory `appConfig` is mutated) and are persisted to `config.json` via `saveConfigField()`.

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/config/notes-display` | 200 | — | Return the current notes display settings. |
| `PUT` | `/api/config/notes-display` | 200 | 400 | Update notes display settings. Body: `{ notesCardHeight?, notesColumns? }` — all fields optional (partial update). |

### Validation (PUT)

All fields are optional. Omitting a field leaves the current value unchanged.

| Field | Type | Range | Description |
|---|---|---|---|
| `notesCardHeight` | integer | `[120, 800]` | Height of each note card in pixels. |
| `notesColumns` | integer | `[1, 6]` | Number of columns in the notes view grid. |

**400 cases (per field, when provided):**
- Value is not a number → `'Field "notesCardHeight" must be a number.'`
- Value is not a finite integer (e.g. float, `NaN`, `Infinity`) → `'Field "notesCardHeight" must be a finite integer.'`
- Value below minimum → `'Field "notesCardHeight" must be at least 120. Received: N.'`
- Value above maximum → `'Field "notesCardHeight" must be at most 800. Received: N.'`
- Body is not a valid JSON object → `'Request body must be a JSON object.'`

Same error patterns apply to `notesColumns` (range `[1, 6]`).

### `GET /api/config/notes-display` Response

```json
{ "notesCardHeight": 220, "notesColumns": 2 }
```

### `PUT /api/config/notes-display` Request / Response

**Full update:**
```json
{ "notesCardHeight": 300, "notesColumns": 3 }
```

**Partial update (height only):**
```json
{ "notesCardHeight": 400 }
```

**Response** (always returns the full current settings after applying changes):
```json
{ "notesCardHeight": 400, "notesColumns": 2 }
```

> **Partial update semantics:** Fields absent from the request body are left unchanged. An empty body `{}` is valid — it returns the current settings with no modifications.

---

## Notes

Aggregate endpoint that returns the `Notes` field for every workspace across all projects in a single request. Intended for use by the GUI to display workspace notes without fetching individual workspace records.

| Method | Path | Success | Error Codes | Description |
|---|---|---|---|---|
| `GET` | `/api/notes` | 200 | 500 | Return all workspace notes grouped by project. |

**Behaviour:**
- All projects and all their workspaces are always included unconditionally — there is no filtering by project or workspace.
- Workspaces with no notes stored have `Notes: ""` in the response.
- Returns `{ Projects: [] }` when no projects exist.
- Returns `500` if reading from storage fails (file I/O error, JSON parse failure, etc.).

### `GET /api/notes` Response Shape

```json
{
    "Projects": [
        {
            "ProjectId": "my-project",
            "ProjectName": "My Project",
            "Workspaces": [
                { "WorkspaceId": "STABLE", "Notes": "" },
                { "WorkspaceId": "DEV",    "Notes": "some notes" }
            ]
        }
    ]
}
```
