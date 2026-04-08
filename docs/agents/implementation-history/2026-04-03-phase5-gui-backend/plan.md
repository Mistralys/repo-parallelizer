# Plan — Phase 5: GUI Backend (HTTP API Server)

## Summary

Implement the standalone Node.js HTTP server that serves as the backend for the browser-based GUI. This includes the REST API endpoints for all CRUD and orchestration operations, the Git status polling mechanism, static file serving for the frontend assets, and request routing.

## Architectural Context

Phase 4 provides orchestrators that implement all high-level workflows (create/delete/rename projects, workspaces, repositories; branch switching; Git status).

The tool description specifies:
- Backend: Standalone Node.js HTTP server using `node:http` directly.
- No authentication required.
- Single developer use, run locally.
- Server port: configurable (default 4200).
- Git polling interval: configurable (default 30 seconds).

## Approach / Architecture

```
src/
├── server/
│   ├── server.ts              # HTTP server setup and lifecycle
│   ├── router.ts              # Request routing (method + path matching)
│   ├── request-utils.ts       # Body parsing, response helpers, error handling
│   ├── static.ts              # Static file serving for frontend assets
│   ├── polling.ts             # Git status polling manager
│   └── routes/
│       ├── repository.routes.ts    # /api/repositories/*
│       ├── project.routes.ts       # /api/projects/*
│       ├── workspace.routes.ts     # /api/projects/:id/workspaces/*
│       ├── branch.routes.ts        # /api/projects/:id/workspaces/:wid/branches/*
│       └── status.routes.ts        # /api/status/* (git polling results)
```

The server is a simple `http.createServer()` with a hand-rolled router that matches method + URL pattern. Route handlers delegate to orchestrators and return JSON responses. A polling manager periodically fetches Git status for all active workspace repositories.

## Rationale

- **`node:http` directly** as specified in the requirements — no Express, Fastify, or other frameworks.
- **Hand-rolled router** is sufficient for the number of endpoints (~20) and avoids framework dependencies.
- **Polling manager** runs server-side and caches results, so the frontend doesn't trigger Git operations on every page load.
- **Static file serving** embedded in the server keeps deployment simple (single process).

## Detailed Steps

### 1. Request Utilities

1. **Implement `src/server/request-utils.ts`**:
   - `parseJsonBody(req: IncomingMessage): Promise<unknown>` — Reads the request body and parses as JSON. Returns the parsed object. Throws on invalid JSON with a 400-appropriate error.
   - `sendJson(res: ServerResponse, statusCode: number, data: unknown): void` — Sets `Content-Type: application/json`, writes the serialized body, ends the response.
   - `sendError(res: ServerResponse, statusCode: number, message: string): void` — Sends a JSON error response `{ error: message }`.
   - `extractParams(pattern: string, url: string): Record<string, string> | null` — Simple pattern matching for URL parameters (e.g., `/api/projects/:id` matches `/api/projects/my-project` → `{ id: "my-project" }`).

### 2. Router

2. **Implement `src/server/router.ts`**:
   - `Router` class:
     - `get(pattern, handler)`, `post(pattern, handler)`, `put(pattern, handler)`, `delete(pattern, handler)` — Registers route handlers.
     - `handle(req, res): Promise<void>` — Matches incoming request to a registered route, extracts URL params, calls the handler. Returns 404 if no match, 405 if method doesn't match an existing path.
   - Route handlers receive `(req, res, params)` where `params` contains extracted URL parameters.

### 3. Static File Serving

3. **Implement `src/server/static.ts`**:
   - `serveStatic(req: IncomingMessage, res: ServerResponse, baseDir: string): boolean` — If the URL matches a file in `baseDir`, serves it with the correct MIME type. Returns false if no file matches. Serves `index.html` for the root path `/`.
   - Supports MIME types: `.html`, `.css`, `.js`, `.json`, `.svg`, `.png`, `.ico`.
   - Prevents directory traversal attacks (normalize path, ensure it stays within `baseDir`).

### 4. API Routes — Repositories

4. **Implement `src/server/routes/repository.routes.ts`**:
   - `GET /api/repositories` — List all repositories.
   - `GET /api/repositories/:id` — Get a single repository.
   - `POST /api/repositories` — Add a repository. Body: `{ url, name?, id? }`.
   - `PUT /api/repositories/:id` — Update a repository. Body: `{ name? }`.
   - `DELETE /api/repositories/:id` — Delete a repository globally (cascades via orchestrator).

### 5. API Routes — Projects

5. **Implement `src/server/routes/project.routes.ts`**:
   - `GET /api/projects` — List all projects (from index).
   - `GET /api/projects/:id` — Get full project data.
   - `POST /api/projects` — Create a project. Body: `{ name, repositoryIds, description?, id? }`.
   - `PUT /api/projects/:id` — Update a project. Body: `{ name?, description? }`.
   - `PUT /api/projects/:id/rename` — Rename project ID. Body: `{ newId }`.
   - `DELETE /api/projects/:id` — Delete a project (cascades via orchestrator).
   - `POST /api/projects/:id/repositories` — Add a repository to the project. Body: `{ repositoryId }`.
   - `DELETE /api/projects/:id/repositories/:repoId` — Remove a repository from the project.

### 6. API Routes — Workspaces

6. **Implement `src/server/routes/workspace.routes.ts`**:
   - `GET /api/projects/:id/workspaces` — List workspaces for a project.
   - `GET /api/projects/:id/workspaces/:wid` — Get a single workspace.
   - `POST /api/projects/:id/workspaces` — Create a workspace. Body: `{ id, description? }`.
   - `PUT /api/projects/:id/workspaces/:wid` — Update a workspace. Body: `{ description? }`.
   - `PUT /api/projects/:id/workspaces/:wid/rename` — Rename workspace ID. Body: `{ newId }`.
   - `DELETE /api/projects/:id/workspaces/:wid` — Delete a workspace.

### 7. API Routes — Branches

7. **Implement `src/server/routes/branch.routes.ts`**:
   - `GET /api/projects/:id/workspaces/:wid/branches` — Get available branches per repo + compiled suggestions.
   - `POST /api/projects/:id/workspaces/:wid/branches/switch` — Switch branches. Body: `{ assignments: Record<repoId, branchName> }`. Returns per-repo results.

### 8. API Routes — Status

8. **Implement `src/server/routes/status.routes.ts`**:
   - `GET /api/projects/:id/workspaces/:wid/status` — Get cached Git status for all repos in a workspace.
   - `POST /api/projects/:id/workspaces/:wid/status/refresh` — Force an immediate status refresh (bypasses polling interval).

### 9. Git Status Polling Manager

9. **Implement `src/server/polling.ts`**:
   - `PollingManager` class:
     - Holds an in-memory cache of `GitStatusInfo` per repository clone path.
     - `start(intervalSeconds: number)`: Starts an interval timer that polls all repositories across all workspaces. Uses `fetchAndGetStatus()` from Phase 3.
     - `stop()`: Clears the interval.
     - `getStatus(repoPath: string): GitStatusInfo | null` — Returns cached status.
     - `refreshWorkspace(projectId, workspaceId): Promise<void>` — Immediately polls all repos in the specified workspace and updates the cache.
   - Polling only runs while the server is active. Fetches are staggered (not all repos at once) to avoid network spikes.

### 10. Server Entry Point

10. **Implement `src/server/server.ts`**:
    - `startServer(config: AppConfig): Promise<void>`:
      1. Initialize managers and orchestrators.
      2. Create router, register all route modules.
      3. Create HTTP server with `http.createServer()`.
      4. Configure request handler: try static file serving first, then router, then 404.
      5. Start Git polling manager.
      6. Listen on configured port.
      7. Log startup message with URL.
    - `stopServer()`: Stops polling and closes the HTTP server.

## Dependencies

- Phase 1: Configuration (ServerPort, GitPollingIntervalSeconds).
- Phase 2: All data managers.
- Phase 3: Git status operations.
- Phase 4: All orchestrators.

## Required Components

- **NEW** `src/server/server.ts`
- **NEW** `src/server/router.ts`
- **NEW** `src/server/request-utils.ts`
- **NEW** `src/server/static.ts`
- **NEW** `src/server/polling.ts`
- **NEW** `src/server/routes/repository.routes.ts`
- **NEW** `src/server/routes/project.routes.ts`
- **NEW** `src/server/routes/workspace.routes.ts`
- **NEW** `src/server/routes/branch.routes.ts`
- **NEW** `src/server/routes/status.routes.ts`

## Assumptions

- The server runs on localhost only — no CORS, no HTTPS, no authentication.
- A single in-memory polling cache is sufficient (single user, single process).
- JSON request bodies are reasonable in size (no file uploads).
- The frontend static files will be placed in a `gui/public/` directory (built in Phase 6).

## Constraints

- No npm dependencies for the HTTP server — `node:http` only.
- All responses are JSON except static file serving.
- The static file server must prevent directory traversal (`../` in the URL).
- Destructive operations (delete) via the API do NOT require confirmation — the frontend handles confirmation dialogs before sending the request.

## Out of Scope

- Frontend assets (Phase 6).
- CLI menu (Phase 7).
- WebSocket for real-time status updates (poll-based is sufficient).

## Acceptance Criteria

- Server starts on configured port and serves a response at `GET /`.
- All API endpoints return correct JSON responses for valid and invalid requests.
- CRUD operations via API correctly create, read, update, and delete repositories, projects, and workspaces.
- Branch endpoints correctly return branch lists and execute branch switching.
- Git status polling runs at the configured interval and caches results.
- Status endpoints return cached Git info for workspace repositories.
- Static file serving delivers frontend assets with correct MIME types.
- Directory traversal attempts in static file requests are rejected.

## Testing Strategy

- **API integration tests**: Start the server, make HTTP requests, verify JSON responses and side effects.
- **Router unit tests**: Verify pattern matching, parameter extraction, 404/405 behavior.
- **Static file serving tests**: Valid files, missing files, directory traversal attempts.
- **Polling manager tests**: Verify cache population, interval behavior, refresh trigger.
- **Manual testing**: Use `curl` to exercise all endpoints against a real storage directory.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Port already in use** | Server catches EADDRINUSE and logs a clear message suggesting a different port |
| **Polling overloads system with many repos** | Stagger fetches; polling interval is configurable; fetch timeout prevents hangs |
| **Request body too large** | Set a reasonable body size limit (1MB) in the body parser |
| **Static file serving security** | Path normalization + root check prevents traversal; only whitelisted MIME types served |
