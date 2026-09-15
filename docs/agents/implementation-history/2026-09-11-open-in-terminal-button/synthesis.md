
## Synthesis

### Completion Status
- Date: 2026-09-11
- Status: COMPLETE
- Completed by: Standalone Developer Agent
- Research brief: used
- Archived in Ledger: 2026-09-11

### Outcome Summary

Added a workspace-level "Open in Terminal" button, replicating the proven three-layer launcher shape (server process-spawning primitive → route handler → API client method → GUI button) already used for "Open in VS Code" and "Open in GitHub Desktop". The implementation extracted a shared `spawnDetached()` helper inside `app-launcher.ts` so the new `launchTerminal()` function reuses the exact guard/spawn/event-wiring logic as the existing `launchApplication()`, keeping the latter's public behavior byte-for-byte unchanged.

### Implementation Summary
- `src/server/app-launcher.ts`: extracted an internal `spawnDetached()` helper from `launchApplication()`'s body; added the pure, exported `buildTerminalCommand(directoryPath, platform)` resolver and the exported `launchTerminal(directoryPath)` function that delegates to it.
- `src/server/routes/workspaces.ts`: added a new `POST /api/projects/:id/workspaces/:wid/launch/terminal` route following the identical guard → on-disk-existence-check → spawn → respond shape as the existing launch routes, plus a test-only `launchTerminalFn` injection parameter mirroring the existing `launchFn` pattern.
- `gui/public/js/api.js`: added `api.workspaces.launch.terminal(projectId, wid)` to the existing launcher sub-namespace.
- `gui/public/js/views/workspace-detail.js`: added `buildOpenTerminalButton()`, inserted immediately after "Open in VS Code" at both the initial-render anchor point (when the workspace is already initialized) and the dynamic post-setup insertion point.
- Documentation updated to describe the new endpoint, API method, and button across all three affected manifest files.

### Documentation Updates
- `docs/agents/project-manifest/api-surface.md` — documented `launchTerminal()`, `buildTerminalCommand()`, the new `launchTerminalFn` parameter on `registerWorkspaceRoutes`, and `api.workspaces.launch.terminal(pid, wid)`.
- `docs/agents/project-manifest/rest-api.md` — added the `POST .../launch/terminal` endpoint row under "Launch".
- `docs/agents/project-manifest/gui-frontend.md` — added `launch.terminal(pid, wid)` to the External-App Launch Methods table, updated the `#/projects/:id/workspaces/:wid` route description and the setup-button in-place-update note to mention the new "Open in Terminal" button.

### Verification Summary
- Tests run: `npm run test` (TypeScript compile + full server test suite via `node --test`), `npm run test:gui` (GUI unit tests via `node --test` + jsdom), plus targeted re-runs of the new/modified test files (`app-launcher.test.ts`, `workspaces-launch.test.ts`, `api.workspaces.launch.test.mjs`, `workspace-detail.terminal-button.test.mjs`).
- Static analysis run: `npx tsc --noEmit` (project has no separate lint tool configured — `tsc` in strict mode is the sole static analysis gate).
- Result: PASS. The full server suite passes cleanly. The GUI suite has one pre-existing failure (`api.config.test.mjs`, `credentialOptions`) that was verified to fail identically on a clean `main` checkout in isolation, unrelated to this plan's scope — recorded as a follow-up item below.

### Code Insights

#### Implementation Decisions
- [low] (decision) `src/server/app-launcher.ts`: Passed `cwd: options?.cwd` directly into the underlying `spawn()` options object rather than conditionally omitting the key when undefined. Node's `spawn()` treats `cwd: undefined` identically to omitting the property entirely, so `launchApplication()`'s observable behavior is unchanged after the `spawnDetached()` extraction — confirmed by re-running its existing, unmodified tests.

#### Follow-Up Items
- [medium] (debt) `gui/public/js/api.config.test.mjs:389` — the test `api.repositories.credentialOptions(id) sends GET /api/repositories/:id/credential-options` fails in isolation on a clean checkout of `main`, before any of this plan's changes, asserting an empty array instead of the expected mocked credential options. Pre-existing and unrelated to the Open-in-Terminal feature; worth a dedicated fix in a future plan.

### Additional Comments
- The plan's `Considered Alternatives` / `Structural Improvements` sections already weighed and rejected extracting a shared `buildLauncherButton()` factory for the three near-identical GUI button builders (`buildOpenVscodeButton`, the per-repo "Open" builder, `buildOpenTerminalButton`) as out of scope for this plan — that recommendation is preserved as-is in `plan.md` for a future planning cycle if a fourth launcher button is proposed.
- Windows-specific behavior (`cmd /c start cmd` with `cwd`) and the Linux `x-terminal-emulator` dependency remain unverified in this macOS/Linux CI environment, consistent with the plan's own acknowledged, accepted risk.
