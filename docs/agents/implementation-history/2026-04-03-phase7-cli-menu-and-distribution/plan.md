# Plan — Phase 7: CLI Menu, Setup & Distribution

## Summary

Implement the interactive CLI menu for first-time setup, documentation generation, and GUI launch. Create cross-platform launcher scripts (`menu.sh` / `menu.cmd`), polish the npm package for distribution, and set up CTX Generator configuration for agent context documentation.

## Architectural Context

Phases 1–6 deliver the complete tool: configuration, data models, Git operations, orchestration, HTTP server, and browser GUI. This phase adds the interactive terminal entry point and distribution packaging.

The tool description specifies:
- CLI menu for: setup script, documentation generation (CTX Generator), launch the GUI.
- Technology: Node.js with libraries for terminal colors and keyboard shortcuts.
- Menu convenience scripts: `menu.sh` + `menu.cmd`.
- NPM binary name: `paralizer`.
- CTX Generator available via `ctx generate`.

## Approach / Architecture

```
repo-parallelizer/
├── menu.sh                    # Unix launcher script
├── menu.cmd                   # Windows launcher script
├── config.dist.json           # (from Phase 1)
├── context.yaml               # CTX Generator configuration
├── src/
│   ├── index.ts               # Binary entry point (dispatch to menu or server)
│   └── cli/
│       ├── menu.ts            # Interactive CLI menu
│       ├── setup.ts           # Setup wizard (config generation)
│       ├── terminal-ui.ts     # Terminal colors, formatting, keyboard helpers
│       └── docs.ts            # CTX Generator documentation command
```

The binary entry point (`src/index.ts`) dispatches based on arguments:
- No args or `menu` → interactive CLI menu.
- `serve` → starts the GUI server directly (for programmatic use).
- `setup` → runs setup wizard directly.

## Rationale

- **CLI menu as default** makes the tool approachable for first-time use while the GUI is the primary interface for ongoing work.
- **Launcher scripts** (`menu.sh` / `menu.cmd`) provide a zero-friction entry point without requiring npm link during development.
- **Minimal terminal UI dependencies** — one color library (e.g., `chalk` or `picocolors`) and one keyboard input library (e.g., `readline` built-in or `inquirer`).
- **CTX Generator integration** produces structured documentation for AI-assisted development.

## Detailed Steps

### 0. Update Dependency Policy Documentation

0. **Update the "zero runtime dependencies" claim across all documentation:**
   - The project already uses `@picocss/pico` as a dev dependency, and this phase adds `picocolors` as the first true runtime (production) dependency.
   - The "zero runtime dependencies" invariant is no longer accurate and must be updated to reflect a "vetted dependencies only" policy.
   - **Files to update:**
     - `docs/agents/project-manifest/tech-stack.md` — Production dependencies section: Replace "None. Zero runtime dependencies" with a table listing `picocolors` and its purpose. Add a note that runtime dependencies are permitted when vetted for size, security, and zero transitive dependencies.
     - `AGENTS.md` — Project Stats table: Change `Runtime dependencies` value from "Zero — Node.js built-ins only" to reflect the actual dependency list.
   - The `.context/` output will be regenerated automatically by CTX Generator and does not need manual editing.

### 1. Terminal UI Utilities

1. **Implement `src/cli/terminal-ui.ts`**:
   - Add an npm dependency for terminal colors (`picocolors` — zero-dependency, fast).
   - `printHeader(text: string)`: Prints a styled header line.
   - `printOption(key: string, label: string)`: Prints a menu option with a highlighted key shortcut.
   - `printSuccess(text: string)`, `printError(text: string)`, `printInfo(text: string)`: Colored output helpers.
   - `waitForKey(validKeys: string[]): Promise<string>`: Listens for a single keypress from the valid set. Uses Node.js `readline` in raw mode.
   - `askQuestion(prompt: string): Promise<string>`: Prompts for a text input and returns the answer.
   - `askYesNo(prompt: string, defaultYes?: boolean): Promise<boolean>`: Yes/No prompt.
   - `clearScreen()`: Clears the terminal.

### 2. Setup Wizard

2. **Implement `src/cli/setup.ts`**:
   - `runSetup(): Promise<void>`:
     1. Check if `config.json` already exists. If so, ask if the user wants to overwrite.
     2. Prompt for `ProjectsFolder` — the directory where projects will be stored. Validate it exists or offer to create it.
     3. Prompt for `StorageFolder` — the directory for tool metadata. Validate or create.
     4. Prompt for `CloneDepth` (default: 50).
     5. Prompt for `ServerPort` (default: 4200).
     6. Prompt for `GitPollingIntervalSeconds` (default: 30).
     7. Write `config.json` with the provided values.
     8. Initialize storage directories (create folders, seed empty JSON files).
     9. Print success message with next steps.

### 3. Documentation Generation

3. **Implement `src/cli/docs.ts`**:
   - `generateDocs(): Promise<void>`:
     1. Check if `ctx` command is available on PATH.
     2. If available: run `ctx generate` from the tool root using `child_process.spawn`.
     3. Stream output to terminal.
     4. Print success/failure message.
     5. If `ctx` not found: print instructions on how to install the CTX Generator.

### 4. Interactive CLI Menu

4. **Implement `src/cli/menu.ts`**:
   - `showMenu(): Promise<void>`:
     - Clear screen, print app header with version (read from package.json).
     - Display menu options:
       - `[S]` Setup — Run the setup wizard
       - `[G]` Launch GUI — Start the server and open browser
       - `[D]` Generate Docs — Run CTX Generator
       - `[Q]` Quit
     - Wait for keypress and dispatch to the appropriate function.
     - After each action completes, return to the menu (except Quit).
   - **Launch GUI**:
     1. Call `startServer()` from Phase 5.
     2. Print the URL (`http://localhost:{port}`).
     3. Attempt to open the URL in the default browser:
        - macOS: `open http://...`
        - Windows: `start http://...`
        - Linux: `xdg-open http://...`
     4. Keep the process running (server stays up). Print "Press Ctrl+C to stop."

### 5. Binary Entry Point Update

5. **Update `src/index.ts`**:
   - Parse `process.argv` for commands:
     - `paralizer` or `paralizer menu` → `showMenu()`
     - `paralizer serve` → `startServer(loadConfig())`
     - `paralizer setup` → `runSetup()`
     - `paralizer docs` → `generateDocs()`
   - Handle missing config gracefully: if config doesn't exist and the command isn't `setup`, suggest running setup first.

### 6. Launcher Scripts

6. **Create `menu.sh`** (project root):
   ```bash
   #!/usr/bin/env bash
   cd "$(dirname "$0")"
   node dist/index.js menu "$@"
   ```

7. **Create `menu.cmd`** (project root):
   ```cmd
   @echo off
   cd /d "%~dp0"
   node dist\index.js menu %*
   ```

### 7. Package.json Finalization

8. **Update `package.json`**:
   - `bin.paralizer`, `engines.node`, and `description` are already set — verify they are correct.
   - Add `picocolors` to `dependencies` (not `devDependencies`).
   - Add `files` field to include only necessary files for distribution: `dist/`, `gui/public/`, `config.dist.json`, `menu.sh`, `menu.cmd`.
   - Add `keywords` and `repository` fields.
   - Verify `main` entry point.

### 8. CTX Generator Configuration

9. **Verify existing `context.yaml`** (project root):
   - `context.yaml` already exists with MCP config, module imports (`src/*/module-context.yaml`), and project-level documents (folder structure, overview, manifest).
   - Verify it is still accurate after the CLI module additions. If a `src/cli/module-context.yaml` is added, the existing glob `src/*/module-context.yaml` will pick it up automatically.
   - No creation needed — only verify and adjust if necessary.

### 9. README Update

10. **Update `README.md`**:
    - The README already contains installation, configuration, and path resolution documentation.
    - **Add/update** the Usage section to document the CLI menu commands (`paralizer`, `paralizer serve`, `paralizer setup`, `paralizer docs`).
    - **Add** documentation for `menu.sh` / `menu.cmd` launcher scripts.
    - **Add** a brief CLI menu section describing the interactive menu options.
    - Do **not** duplicate the existing configuration reference — it is already comprehensive.

## Dependencies

- Phase 1: Configuration system.
- Phase 5: `startServer()` function.
- All phases complete for full functionality.
- npm dependency: `picocolors` (terminal colors) — added to `dependencies` (production), not `devDependencies`.

## Required Components

- **NEW** `src/cli/terminal-ui.ts`
- **NEW** `src/cli/setup.ts`
- **NEW** `src/cli/docs.ts`
- **NEW** `src/cli/menu.ts`
- **NEW** `menu.sh`
- **NEW** `menu.cmd`
- **MODIFY** `src/index.ts` — Add CLI argument parsing and command dispatch
- **MODIFY** `package.json` — Add `picocolors` to production dependencies, finalize distribution fields
- **MODIFY** `README.md` — Add CLI usage documentation (extend existing content)
- **MODIFY** `docs/agents/project-manifest/tech-stack.md` — Update dependency policy from "zero" to "vetted"
- **MODIFY** `AGENTS.md` — Update runtime dependencies in Project Stats table
- **VERIFY** `context.yaml` — Already exists; verify it picks up new `src/cli/` module

## Assumptions

- `picocolors` is the first runtime npm dependency (terminal colors). The former "zero runtime dependencies" policy is replaced by a "vetted dependencies only" policy.
- Node.js `readline` module is sufficient for keyboard input (no `inquirer` needed).
- The `open` command (macOS), `start` (Windows), or `xdg-open` (Linux) is available for browser launching.
- CTX Generator is optionally installed — the tool works without it.

## Constraints

- Launcher scripts must work without npm global install (they run `node dist/index.js` directly).
- The CLI menu must work on all target platforms (macOS, Windows, Unix).
- The setup wizard must validate paths and handle both relative and absolute paths.

## Out of Scope

- Automated testing of the CLI menu (interactive terminal testing is complex; manual testing suffices).
- npm publishing workflow (user handles this).
- CI/CD configuration.

## Acceptance Criteria

- Running `menu.sh` (Unix) or `menu.cmd` (Windows) launches the interactive CLI menu.
- Setup wizard generates a valid `config.json` and initializes storage directories.
- "Launch GUI" starts the server and opens the browser.
- "Generate Docs" runs `ctx generate` if available, or shows installation instructions.
- `paralizer serve` starts the server directly without the interactive menu.
- `paralizer setup` runs the setup wizard directly.
- The npm package includes all necessary files for distribution.
- README provides clear setup and usage instructions.

## Testing Strategy

- **Manual testing**: Walk through the full setup wizard, verify config generation, launch GUI, generate docs.
- **Smoke tests**: `menu.sh` on macOS, `menu.cmd` on Windows (if available).
- **Setup wizard edge cases**: Existing config (overwrite prompt), non-existent directories (create prompt), invalid paths.
- **Browser launch**: Verify the correct OS-specific command is used.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Terminal raw mode issues on Windows** | Use Node.js readline which handles platform differences; test on Windows if possible |
| **Browser launch fails silently** | Catch spawn errors and print the URL for manual opening |
| **CTX Generator not installed** | Graceful fallback with installation instructions |
| **Launcher scripts not executable** | Document `chmod +x menu.sh`; Git preserves execute bits |
| **picocolors version conflicts** | Pin to a specific major version; it has zero dependencies |
