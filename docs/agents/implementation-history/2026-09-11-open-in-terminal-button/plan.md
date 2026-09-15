# Plan

## Plan Audit Cycles
- Audits: 1 — Plan Auditor v1.9.2
- Architectural Reviews: 1 — Plan Architect Reviewer v2.3.2

## Prior Project Context

The repository context (`ledger_get_repository_context`) returned no configured strategic vision (short/mid/long-term all `null`), so no strategy-alignment check applies. The most directly relevant prior project is documented in `docs/agents/implementation-history/2026-04-15-launch-external-apps/` (CHANGELOG `0.4.0 - Launch External Apps`): it added the cross-platform `launchApplication()` utility, the `POST .../launch/vscode` and `POST .../launch/github-desktop/:rid` routes, and the "Open in VS Code" / per-repo "Open" buttons. Its **Out of Scope** section explicitly names *"Terminal launchers (e.g. "Open in Terminal") — same pattern but different commands"* as deliberately deferred — this plan implements that deferred item. Two rework cycles on that same feature (`2026-04-15-launch-external-apps-rework-1`, `-rework-2`) fixed a compound-check ordering inconsistency in the `github-desktop` handler (project-existence check before workspace-existence check); this plan's new `launch/terminal` handler is modeled on the already-corrected `launch/vscode` handler (which only needs a single `resolveWorkspace()` guard, no separate repository check), so that prior fix does not need to be re-applied here. No knowledge-base insights specific to app-launcher, terminal launching, or this route family were found via `ledger_search_insights`.

## Summary

Add a workspace-level **"Open in Terminal"** button to the GUI's workspace detail page, positioned next to the existing "Open in VS Code" button. Clicking it opens a native terminal window at the workspace's root folder (the directory containing all of the workspace's cloned repositories). This follows the exact same server-spawns-a-local-process architecture already used for "Open in VS Code" and the per-repository "Open" (GitHub Desktop) button, adding a third `POST .../launch/*` endpoint and a third `api.workspaces.launch.*` client method.

## Architectural Context

The relevant subsystem is `src/server/routes/workspaces.ts`'s `registerWorkspaceRoutes()`, which already registers two external-process-launching routes (`launch/vscode`, `launch/github-desktop/:rid`) sharing one guard→existence-check→spawn→respond shape, and delegates all OS-level process spawning to `src/server/app-launcher.ts`'s `launchApplication(command, args)` — a fire-and-forget, cross-platform (`shell: true` on Windows only) detached-spawn utility, deliberately kept out of the server's public barrel (`index.ts`) since it is an internal primitive. On the GUI side, `gui/public/js/api.js` groups all such launcher calls under the `api.workspaces.launch` sub-namespace (its own JSDoc explicitly anticipates an "Open in Terminal" addition here), and `gui/public/js/views/workspace-detail.js`'s `buildHeaderSection()` renders a management-button row (`.workspace-mgmt-row`) where `buildOpenVscodeButton()` is inserted at two anchor points: appended directly when the workspace is already initialized at render time, or `insertBefore(btn, renameBtn)` when a workspace transitions to initialized via the "Setup Workspace" button's success handler.

## Approach / Architecture

Extend the same three layers used by the two existing launchers, in the same shape:

1. **`app-launcher.ts`** gains a new exported `launchTerminal(directoryPath)` function and a new exported pure helper `buildTerminalCommand(directoryPath, platform)` that resolves the platform-specific `{ command, args, cwd }` triple (macOS → `open -a Terminal`, Windows → `cmd /c start cmd` with `cwd`, other → `x-terminal-emulator` with `cwd`). Both functions delegate their actual spawning to a shared internal `spawnDetached()` helper extracted from the existing `launchApplication()` body, so the guard/spawn/event-wiring logic is written once, not duplicated.
2. **`workspaces.ts`** gains a third route, `POST /api/projects/:id/workspaces/:wid/launch/terminal`, following the identical guard→400-if-missing→spawn→200/500 shape as `launch/vscode`, targeting the workspace's root folder (via the already-existing private `workspaceFolder()` helper) rather than the `.code-workspace` file.
3. **`api.js`** gains `api.workspaces.launch.terminal(projectId, wid)`, and **`workspace-detail.js`** gains a `buildOpenTerminalButton()` inserted at the same two anchor points as the VS Code button, immediately after it.

## Rationale

Reusing the identical three-layer shape (app-launcher primitive → route handler → API client method → GUI button) that was proven twice already (VS Code, GitHub Desktop) minimizes design risk and keeps the codebase's "one way to add a launcher" convention intact. Extracting a shared `spawnDetached()` helper avoids duplicating the guard/spawn/event-wiring block a third time as the launcher surface grows, while keeping `launchApplication()`'s existing public signature and behavior completely unchanged (its existing tests continue to pass without modification). Resolving the platform-specific terminal command in a separate, pure, exported function (`buildTerminalCommand`) — rather than inlining a `process.platform` switch directly inside `launchTerminal()` — makes the one genuinely new piece of logic (which command/args/cwd to use per OS) unit-testable without spawning a real terminal window in CI, addressing the exact gap the project's own synthesis history flagged for the Windows branch of the original launcher (untestable without platform injection).

## Considered Alternatives

| Decision | Chosen Shape | Alternatives Considered | Trade-Off Summary |
|----------|--------------|-------------------------|--------------------|
| Where platform-specific command resolution lives | New pure `buildTerminalCommand(directoryPath, platform)` + `launchTerminal(directoryPath)` in `app-launcher.ts`, reusing an extracted `spawnDetached()` helper | (A) Inline the `process.platform` switch directly in the `workspaces.ts` route handler, mirroring `menu.ts`'s `openBrowser()`; (B) extend `launchApplication(command, args, options?)` with an optional `cwd`/options parameter and let the route compute the command itself | (A) would scatter process-spawning concerns across two modules and duplicate the guard/spawn/event wiring inline in a route file, breaking the established "app-launcher owns all process spawning" boundary. (B) would change a tested public function's signature for a single, unrelated caller. The chosen shape keeps the boundary intact, keeps `launchApplication()` byte-for-byte behavior-compatible, and isolates the one new decision (platform → command) in an independently testable pure function. |
| Terminal target directory scope | Workspace root folder (`workspaceFolder(projectId, workspaceId)`), matching the scope of the existing "Open in VS Code" button | Per-repository terminal button in the repo-status-cells "Actions" column, matching the per-repo "Git GUI"/"Browse" buttons | The user request explicitly pairs this feature with the existing workspace-level "Open in VS Code" button, not the per-repository action row. A workspace-level terminal (opened at the folder containing every cloned repo) is the more useful default for a multi-repo workspace; a per-repo variant can be added later without conflicting with this shape. |
| Linux terminal command | Single hardcoded `x-terminal-emulator` (Debian `update-alternatives` convention) | Hardcoding a specific emulator (`xterm`, `gnome-terminal`, `konsole`); trying a fallback chain of several candidates | The project's existing launcher never implements fallback chains (`code`, `github` are each single hardcoded commands) — a fallback chain would be new architectural complexity for a single OS branch. `x-terminal-emulator` is the closest Linux equivalent to a single canonical command, with the accepted risk that non-Debian-based distros without it will see a descriptive 500 error (identical failure-mode shape as an uninstalled `code`/`github`). |
| Windows terminal launch mechanism | `cmd /c start cmd` with the new directory passed via the spawned process's `cwd` option | Launching Windows Terminal directly (`wt.exe`) | `cmd.exe` ships with every Windows installation with no extra dependency, consistent with the project's existing assumption that `code`/`github` "must already be installed... on PATH" only for the tools the feature is actually about — a terminal window itself should not introduce a new required install. |
| GUI button composition — duplicated per-button builder vs. shared factory | `buildOpenTerminalButton(projectId, workspaceId)` as a third private function structurally mirroring `buildOpenVscodeButton` (own click handler, own disabled/loading-text logic, own toast messages) | A shared `buildLauncherButton({ label, title, loadingLabel, successMessage, launch })` factory used by all launcher buttons | Reviewed by the Plan Architect Reviewer (Decision 6: **Reconsider**, not blocking). Introducing a factory only for this third button while leaving the first two in their current per-button shape would create an inconsistent mix, and migrating the existing two builders is out of this plan's scope. Duplication matches the codebase's current convention and keeps the plan's risk minimal; a factory becomes the stronger choice once a fourth launcher button is proposed. |

## Pattern Alignment

- Follows the `api.workspaces.launch` sub-namespace convention in `gui/public/js/api.js` — the namespace's own JSDoc already names "Open in Terminal" as the anticipated next addition.
- Follows the test-only function-injection convention on `registerWorkspaceRoutes()` (`launchFn` as the last optional parameter, defaulting to the real implementation) by adding `launchTerminalFn` in the same position/shape.
- Follows the existing guard→existence-check→spawn→respond route-handler shape used by both `launch/vscode` and `launch/github-desktop/:rid`.
- Follows the existing button-builder convention (`buildOpenVscodeButton(projectId, workspaceId)` as a private, non-exported, side-effect-free-until-clicked function local to `workspace-detail.js`). The Plan Architect Reviewer flagged this convention as a `Reconsider` (Decision 6): three near-identical ~24-line builder functions with no shared factory is approaching the "Rule of Three," but factoring one out now would only cover the new button while leaving the existing two unmigrated, an inconsistent result out of this plan's scope — see `## Structural Improvements` for the disposition.
- Follows the existing per-launcher-button dedicated test file convention (`workspace-detail.vscode-button.test.mjs`, `workspace-detail.open-button.test.mjs`) by adding `workspace-detail.terminal-button.test.mjs` rather than folding new assertions into an existing file.
- **Departure:** introduces the module's first exported *pure* helper function (`buildTerminalCommand`) inside `app-launcher.ts`, which previously exposed only the single side-effecting `launchApplication()`. Justified in Rationale — required to make the platform-selection logic unit-testable without invoking real OS terminal spawns in CI, an explicit gap the project's own synthesis history flagged as unresolved for the analogous Windows `shell:true` branch of the original launcher.

## Structural Improvements

| Structure | Observation | Decision | Reason |
|-----------|-------------|----------|--------|
| `src/server/app-launcher.ts` — `launchApplication()`'s inline spawn/Promise/event-wiring block | Adding a second exported launcher function (`launchTerminal`) with the same guard→spawn→unref→event-listener wiring would duplicate this block verbatim if left inline | Promoted to Detailed Step 1 (extract a shared internal `spawnDetached(command, args, options?)` helper; `launchApplication` delegates to it unchanged) | Avoids duplicating the spawn/event-wiring logic a second time in the same file; keeps a single choke-point for all detached-process spawning in this module, consistent with the module's own stated purpose. |
| `gui/public/js/views/workspace-detail.js` — three near-identical private button-builder functions (`buildOpenVscodeButton`, the per-repo "Open" builder, and the new `buildOpenTerminalButton`) with no shared factory | Flagged by the Plan Architect Reviewer (Decision 6, `Reconsider`): the three builders differ only in label, API call, and message strings — a `buildLauncherButton({ label, title, loadingLabel, launch, successMessage })` factory would remove the duplication | Rejected for this plan | Applying a factory only to the new button while leaving the existing two in their current shape produces an inconsistent mix of styles in the same file; migrating the existing two builders onto a factory is out of this plan's scope. Noted for the Planner: this becomes a `Challenge`-strength recommendation if a fourth launcher button is ever proposed. |

## Detailed Steps

1. In `src/server/app-launcher.ts`, extract the existing guard→`spawn()`→`unref()`→`spawn`/`error`-event wiring out of `launchApplication()` into a new internal (non-exported) helper `spawnDetached(command: string, args: string[], options?: { cwd?: string }): Promise<void>`, accepting an optional `cwd` passed through to the underlying `spawn()` call's options. Rewrite `launchApplication(command, args)` to be a one-line delegation to `spawnDetached(command, args)`. Behavior must be unchanged — the existing tests in `src/server/__tests__/app-launcher.test.ts` must continue to pass without modification.
2. In the same file, add an exported pure function:
   ```ts
   export function buildTerminalCommand(
       directoryPath: string,
       platform: NodeJS.Platform,
   ): { command: string; args: string[]; cwd?: string }
   ```
   - `platform === 'darwin'` → `{ command: 'open', args: ['-a', 'Terminal', directoryPath] }` (no `cwd` — the path is passed as the `open` argument).
   - `platform === 'win32'` → `{ command: 'cmd', args: ['/c', 'start', 'cmd'], cwd: directoryPath }`.
   - anything else (Linux and other POSIX platforms) → `{ command: 'x-terminal-emulator', args: [], cwd: directoryPath }`.
3. In the same file, add:
   ```ts
   export function launchTerminal(directoryPath: string): Promise<void> {
       const { command, args, cwd } = buildTerminalCommand(directoryPath, process.platform);
       return spawnDetached(command, args, { cwd });
   }
   ```
4. Add tests to `src/server/__tests__/app-launcher.test.ts` for `buildTerminalCommand()`: one test per platform branch (`'darwin'`, `'win32'`, `'linux'` as the "other" representative), asserting the exact returned `{ command, args, cwd }` object — no real process spawning involved, so these tests are deterministic and CI-safe on any host OS.
5. In `src/server/routes/workspaces.ts`:
   - Add `launchTerminal` to the existing `import { launchApplication } from '../app-launcher.js';` import line.
   - Add an 8th parameter to `registerWorkspaceRoutes`: `launchTerminalFn: (directoryPath: string) => Promise<void> = launchTerminal`, documented with the same "For testing only. Production callers must not pass this argument." JSDoc pattern used for `launchFn`.
   - Add a new route handler:
     ```ts
     // POST /api/projects/:id/workspaces/:wid/launch/terminal
     router.post('/api/projects/:id/workspaces/:wid/launch/terminal', async (_req, res, params) => {
         const projectId   = params['id'];
         const workspaceId = params['wid'];
         if (resolveWorkspace(res, projectId, workspaceId) === undefined) return;

         const wsDir = workspaceFolder(projectId, workspaceId);
         if (!fs.existsSync(wsDir)) {
             sendError(res, 400, 'Workspace directory does not exist. Run setup first.');
             return;
         }

         try {
             await launchTerminalFn(wsDir);
             sendJson(res, 200, { success: true });
         } catch (err) {
             const message = err instanceof Error ? err.message : 'Failed to launch terminal.';
             errorLogManager.append({
                 Severity: 'error',
                 Source: 'app-launcher',
                 Operation: 'launch-terminal',
                 Context: { ProjectId: projectId, WorkspaceId: workspaceId },
                 Message: message,
             });
             sendError(res, 500, message);
         }
     });
     ```
   - Update the route-table JSDoc comment above `registerWorkspaceRoutes` to add a row: `| POST | /api/projects/:id/workspaces/:wid/launch/terminal | 200 | 400/404/500 |`.
6. In `src/server/__tests__/routes/workspaces-launch.test.ts`:
   - Extend `buildSut(projectsFolder, launchFn?)` to accept and forward an optional `launchTerminalFn` parameter to `registerWorkspaceRoutes` (as its 8th positional argument).
   - Add a new labelled test section `// === POST .../launch/terminal ===` with tests for: 404 when workspace does not exist, 404 when project does not exist, 400 with `'Workspace directory does not exist. Run setup first.'` when the workspace directory is absent, 200 `{ success: true }` when the directory exists (asserting the stub was called with `wsDir` as its single argument), and 500 + a correctly-shaped `ErrorLogManager` entry (`Source: 'app-launcher'`, `Operation: 'launch-terminal'`) when the stub rejects.
7. In `gui/public/js/api.js`, add to the `api.workspaces.launch` object:
   ```js
   terminal(projectId, wid) {
       return request(
           'POST',
           `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}/launch/terminal`,
       );
   },
   ```
   with a JSDoc block mirroring `vscode()`'s.
8. In `gui/public/js/api.workspaces.launch.test.mjs`, add a test block for `api.workspaces.launch.terminal()` mirroring the existing `vscode()` block: type-of-function check, correct-URL-with-encoding check, no-request-body check, parsed-response-passthrough check, and error-propagation-on-non-2xx check.
9. In `gui/public/js/views/workspace-detail.js`:
   - Add `buildOpenTerminalButton(projectId, workspaceId)`, a private function mirroring `buildOpenVscodeButton` exactly in structure: `<button class="btn btn-secondary btn-sm">Open in Terminal</button>`, `title="Open this workspace folder in a terminal window."`, click handler disables the button, sets text to `'Opening…'`, calls `await api.workspaces.launch.terminal(projectId, workspaceId)`, shows `'Terminal launched for this workspace.'` success toast or the error's message on failure, restores button state in `finally`.
   - In `buildHeaderSection()`'s initial-render branch (`if (workspace.initialized) { ... }`), append `buildOpenTerminalButton(projectId, workspace.id)` immediately after `buildOpenVscodeButton(projectId, workspace.id)`.
   - In the "Setup Workspace" button's success handler, after `mgmtRow.insertBefore(vscodeBtn, renameBtn)`, add `const terminalBtn = buildOpenTerminalButton(projectId, workspace.id); mgmtRow.insertBefore(terminalBtn, renameBtn);` so the resulting DOM order is `[Open in VS Code] → [Open in Terminal] → Rename → Delete`.
10. Add a new test file `gui/public/js/views/workspace-detail.terminal-button.test.mjs`, copying the jsdom/mock scaffolding of `workspace-detail.vscode-button.test.mjs` (patching `api.workspaces.launch.terminal` instead of `.vscode`), with acceptance criteria AC1–AC5 mirrored: presence when `initialized === true`; absence when `false`; DOM order after the "Open in VS Code" button and before Rename; click → success/error toast; dynamic post-setup insertion alongside the VS Code button.
11. Update `docs/agents/project-manifest/api-surface.md`: add `launchTerminal(directoryPath: string): Promise<void>` and `buildTerminalCommand(directoryPath: string, platform: NodeJS.Platform): { command: string; args: string[]; cwd?: string }` next to the existing `launchApplication` entry; add the new `launchTerminalFn` parameter to the documented `registerWorkspaceRoutes` signature; add `api.workspaces.launch.terminal(pid, wid)` to the REST-mapping list next to `launch.vscode`/`launch.githubDesktop`.
12. Update `docs/agents/project-manifest/rest-api.md`: add a row for `POST /api/projects/:id/workspaces/:wid/launch/terminal` under the Workspaces table (or the existing launch-endpoints location), documenting 200/400/404/500 behavior in the same prose style as the two existing launch rows.
13. Update `docs/agents/project-manifest/gui-frontend.md`: add `launch.terminal(pid, wid)` to the "External-App Launch Methods" table; update the `#/projects/:id/workspaces/:wid` route description to mention the "Open in Terminal" button alongside "Open in VS Code".

## Dependencies

- Node.js built-in `child_process.spawn` (already used by `app-launcher.ts` — no new package dependency).
- The existing `workspaceFolder()` private helper in `src/server/routes/workspaces.ts` (no change needed to it).

## Required Components

- `src/server/app-launcher.ts` — modified (new `spawnDetached`, `buildTerminalCommand`, `launchTerminal`).
- `src/server/routes/workspaces.ts` — modified (new route + `launchTerminalFn` parameter + JSDoc table row).
- `src/server/__tests__/app-launcher.test.ts` — modified (new `buildTerminalCommand` tests).
- `src/server/__tests__/routes/workspaces-launch.test.ts` — modified (new route test section + `buildSut` extension).
- `gui/public/js/api.js` — modified (`api.workspaces.launch.terminal`).
- `gui/public/js/api.workspaces.launch.test.mjs` — modified (new test block).
- `gui/public/js/views/workspace-detail.js` — modified (`buildOpenTerminalButton` + two insertion points).
- `gui/public/js/views/workspace-detail.terminal-button.test.mjs` — **new file**.
- `docs/agents/project-manifest/api-surface.md` — modified.
- `docs/agents/project-manifest/rest-api.md` — modified.
- `docs/agents/project-manifest/gui-frontend.md` — modified.

## Assumptions

- macOS: `open -a Terminal <directoryPath>` opens Terminal.app with a new window/tab at that directory — Terminal.app is a default macOS system application, always present.
- Windows: `cmd.exe` is always present; spawning `cmd /c start cmd` with the Node `spawn()` `cwd` option set to the target directory produces a new console window whose starting directory is that target.
- Linux: `x-terminal-emulator` is present on `PATH` (true for Debian/Ubuntu and derivatives via the `update-alternatives` system). Distributions without this alias (e.g. some Fedora/Arch installs) will surface a descriptive 500 error and an error-toast, an accepted limitation consistent with the project's existing acceptance of an untested/unverified Windows `shell:true` code path in the original launcher.
- This is a single-user, localhost-only tool; the new endpoint requires no additional authentication or authorization, consistent with the two existing launch endpoints.

## Constraints

- Relative imports must retain `.js` extensions (Node16 ESM), per `AGENTS.md`.
- Command names passed to `spawnDetached`/`launchTerminal` are always hardcoded literals (`'open'`, `'cmd'`, `'x-terminal-emulator'`) — never derived from user input, consistent with `api-surface.md`'s "Security note (Windows)" callout's existing rule for `launchApplication`.
- `shell` behavior remains governed solely by `process.platform === 'win32'` inside `spawnDetached` (unchanged from the current `launchApplication` implementation) — no new shell-mode branching is introduced by `buildTerminalCommand`, which only selects the command/args/cwd triple.
- The directory path passed to `launchTerminal` is always server-computed from validated config (`appConfig.projectsFolder`) and validated project/workspace IDs — never a raw, unvalidated client-supplied string.

## Out of Scope

- A configurable/custom terminal command setting (e.g., letting the user choose iTerm2, Windows Terminal, or a specific Linux terminal emulator). Can be added later as a Settings option if requested.
- A per-repository "Open in Terminal" button in the repo-status-cells "Actions" column (mirrors "Git GUI"/"Browse" scope) — this plan only adds the workspace-level button, matching the existing "Open in VS Code" button's scope.
- Windows Terminal (`wt.exe`) support as an alternative or preferred launch mechanism.
- A fallback chain trying multiple Linux terminal emulator candidates when `x-terminal-emulator` is unavailable.

## Acceptance Criteria

- AC-01: `POST /api/projects/:id/workspaces/:wid/launch/terminal` returns `404` when the workspace or its parent project does not exist.
- AC-02: The endpoint returns `400` with the message `"Workspace directory does not exist. Run setup first."` when the workspace's on-disk root folder does not exist.
- AC-03: The endpoint returns `200 { success: true }` and invokes the terminal-launch function with the workspace's root folder path when the directory exists and the launch succeeds.
- AC-04: On a launch failure, the endpoint returns `500` with a descriptive error message and appends an `ErrorLogManager` entry with `Source: 'app-launcher'` and `Operation: 'launch-terminal'`.
- AC-05: `buildTerminalCommand()` returns the correct `{ command, args, cwd }` triple for `'darwin'`, `'win32'`, and all other (`'linux'`-representative) platform values.
- AC-06: `api.workspaces.launch.terminal(projectId, wid)` sends a `POST` to the correct, correctly-encoded URL with no request body, and returns the parsed JSON response.
- AC-07: An "Open in Terminal" button is rendered in the workspace detail management row immediately after "Open in VS Code" whenever `workspace.initialized === true`, both on initial render and dynamically after a successful "Setup Workspace" action, and is absent when the workspace is not initialized.
- AC-08: Clicking "Open in Terminal" calls `api.workspaces.launch.terminal(projectId, workspaceId)` and shows a success toast on success or an error toast (with the error's message) on failure.

## Testing Strategy

Mirror the existing three-tier test strategy used for the VS Code/GitHub Desktop launchers: (1) deterministic unit tests for the new pure `buildTerminalCommand()` resolver (no real process spawning, so fully CI-safe across host platforms); (2) server route tests using function-injection (`launchTerminalFn`) so no real terminal is ever spawned during route testing; (3) GUI unit tests using the existing jsdom + mocked-`api` harness pattern for both the API client method and the button's rendering/click/DOM-ordering behavior. No test spawns an actual terminal window on any platform — the underlying `spawnDetached()`/`launchApplication()` spawn-and-event-wiring behavior is already covered by the existing, unmodified `app-launcher.test.ts` tests for `launchApplication`, and `launchTerminal` reuses that exact same code path.

## Test Plan

- `src/server/__tests__/app-launcher.test.ts` — new tests asserting `buildTerminalCommand(dir, 'darwin')`, `(dir, 'win32')`, and `(dir, 'linux')` each return the documented `{ command, args, cwd }` shape — AC-05.
- `src/server/__tests__/app-launcher.test.ts` — existing `launchApplication` tests re-run unmodified after the `spawnDetached` extraction, verifying no behavior regression — supports AC-03/AC-04 indirectly (shared code path).
- `src/server/__tests__/routes/workspaces-launch.test.ts` — `'POST /launch/terminal: returns 404 when workspace does not exist'` — AC-01.
- `src/server/__tests__/routes/workspaces-launch.test.ts` — `'POST /launch/terminal: returns 404 when project does not exist'` — AC-01.
- `src/server/__tests__/routes/workspaces-launch.test.ts` — `'POST /launch/terminal: returns 400 with correct message when workspace directory is missing'` — AC-02.
- `src/server/__tests__/routes/workspaces-launch.test.ts` — `'POST /launch/terminal: returns 200 { success: true } when directory exists and launch succeeds'` (asserts the stub received the workspace root path) — AC-03.
- `src/server/__tests__/routes/workspaces-launch.test.ts` — `'POST /launch/terminal: returns 500 and logs error when launch throws'` (asserts `Source: 'app-launcher'`, `Operation: 'launch-terminal'`) — AC-04.
- `gui/public/js/api.workspaces.launch.test.mjs` — `'launch.terminal() sends POST to the correct URL'`, `'... encodes special characters'`, `'... sends no request body'`, `'... returns the parsed JSON response'`, `'... throws on non-2xx response'` — AC-06.
- `gui/public/js/views/workspace-detail.terminal-button.test.mjs` — `'AC1: "Open in Terminal" button is present in mgmt row when workspace.initialized is true'` — AC-07.
- `gui/public/js/views/workspace-detail.terminal-button.test.mjs` — `'AC2: "Open in Terminal" button is not rendered when workspace.initialized is false'` — AC-07.
- `gui/public/js/views/workspace-detail.terminal-button.test.mjs` — `'AC3: "Open in Terminal" button appears after "Open in VS Code" and before Rename'` — AC-07.
- `gui/public/js/views/workspace-detail.terminal-button.test.mjs` — `'AC4: clicking the button calls api.workspaces.launch.terminal and shows a success/error toast'` — AC-08.
- `gui/public/js/views/workspace-detail.terminal-button.test.mjs` — `'AC5: after a successful workspace setup, "Open in Terminal" is dynamically inserted alongside "Open in VS Code"'` — AC-07.

## Documentation Updates

- `docs/agents/project-manifest/api-surface.md` — add `launchTerminal()`, `buildTerminalCommand()` signatures; update the documented `registerWorkspaceRoutes` parameter list; add `api.workspaces.launch.terminal(pid, wid)` to the REST-mapping list. (Required by `AGENTS.md`: "Exported type, interface, class, or function added/modified" → update `api-surface.md`.)
- `docs/agents/project-manifest/rest-api.md` — add the new `POST .../launch/terminal` endpoint row. (Required by `AGENTS.md`: "New REST endpoint added/modified" → update `rest-api.md`.)
- `docs/agents/project-manifest/gui-frontend.md` — add `launch.terminal(pid, wid)` to the External-App Launch Methods table; update the workspace-detail route description to mention the new button. (Required by `AGENTS.md`: "New GUI route, view, or component added" → update `gui-frontend.md`.)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **`x-terminal-emulator` is not installed on some Linux distributions** | The endpoint returns a descriptive 500 error and the GUI shows an error toast, identical failure-mode shape as an uninstalled `code`/`github` command; documented as an accepted limitation. |
| **Windows `cmd /c start cmd` may not reliably set the new window's starting directory via `cwd` on all Windows configurations** | Documented as a manual-testing recommendation (mirrors the original launcher plan's own acknowledged gap that Windows behavior could not be verified in the macOS/Linux CI environment). |
| **Extracting `spawnDetached()` accidentally changes `launchApplication()`'s observable behavior** | The existing `app-launcher.test.ts` tests for `launchApplication` are run unmodified after the refactor and must continue to pass, providing a regression safety net. |
| **Race condition: workspace deleted between the 400 existence-check and the spawn call** | Extremely unlikely on a single-user localhost tool; the spawned terminal would simply open at a now-missing path, a benign OS-level outcome — consistent with the equivalent, already-accepted risk noted for the two existing launch endpoints. |

## Recommended Workflow
- **Workflow:** standalone
- **Rationale:** This is a small, single-cohesive-feature addition that mechanically replicates an already-proven pattern (implemented twice before, for VS Code and GitHub Desktop) across a well-understood set of files, with no new architecture, no new security-sensitive surface, and a test suite structure that mirrors existing files line-for-line — a single developer session with self-review against the mirrored test files is adequate.
