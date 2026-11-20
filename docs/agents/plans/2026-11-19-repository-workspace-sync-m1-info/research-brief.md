# Research Brief — Repository Workspace Info Sync

## Scope Sketch

- Repository model and storage — `src/models/repository/`, `src/storage/` — modification (new optional `InfoSync` settings on `Repository`, new manager methods, new managed-clone folder under storage)
- Git layer — `src/git/` — modification + new code (partial/sparse clone options, remote URL, fetch/push by URL with refspec, path-scoped status, path-scoped commit)
- Credential pipeline — `src/git/git-credentials.ts`, `src/orchestration/workspace-orchestrator.ts`, `src/orchestration/repository-orchestrator.ts` — integration + refactor (duplicated resolve/inject block)
- Repository info file + sync orchestration — `src/orchestration/` — new code (info file render/parse/hash, main folder resolution/validation, sync orchestrator)
- Artefact choke-point — `src/orchestration/workspace-artifacts.ts` — integration (sync runs alongside index regeneration)
- Repository deletion cascade — `src/orchestration/repository-orchestrator.ts` — integration (managed clone cleanup)
- Health reporting — `src/orchestration/workspace-health.ts` — modification (shared issue/report types)
- REST layer — `src/server/routes/repositories.ts`, `src/server/index.ts` — integration + new route module
- CLI composition — `src/cli/custom-files.ts` — integration (constructs `WorkspaceArtifactsOrchestrator` itself)
- GUI — `gui/public/js/api.js`, `views/repository-detail.js`, `views/repositories.js`, `views/workspace-detail.js`, `components/`, `css/styles.css` — modification + new code
- Documentation — `docs/agents/project-manifest/*.md`, module READMEs, `CHANGELOG.md`, `.context/` — modification

## Area: Repository Model and Storage

### Verified References
- `src/models/repository/repository.types.ts` (L1–L57): `Repository { Id; Name; Url; credentialsStripped?; LastRefreshedAt?; CredentialId?; Description? }`, `RepositoryStore extends BaseStore { Repositories }`. All persisted fields PascalCase; runtime-only flag camelCase.
- `src/models/repository/repository.manager.ts`: `RepositoryManager` — stateless, re-reads `repositories.json` per call. Methods: `list()`, `getById()`, `exists()`, `add({url,name?,id?,description?})`, `update(id, {name, url?, description?})`, `remove(id)`, `updateCredential(id, credentialId|null)`, `touchRefreshTimestamp(id)`. `update()` spreads the existing record (`{ ...store.Repositories[index], Name }`), so unknown/new optional fields survive an update. `normalizeDescription()` trims and caps at `MAX_REPOSITORY_DESCRIPTION_LENGTH`. URL is trimmed and passed through `stripEmbeddedCredentials()` when `hasEmbeddedCredentials()`; duplicate-URL check excludes self.
- `src/config/config.constants.ts` L120: `MAX_REPOSITORY_DESCRIPTION_LENGTH = 500`.
- `src/storage/storage.types.ts`: `BaseStore { SchemaVersion }`; policy — optional field additions do not bump `SCHEMA_VERSION`.
- `src/storage/json-storage.ts` (L50–L75): `writeJsonFile()` writes `JSON.stringify(data, null, 4) + '\n'`, creating parent dirs; `ensureDirectory()`; `initializeStorage()` creates `{storage}/`, `{storage}/projects/`, `projectsFolder`, and seeds `repositories.json`, `projects-index.json`, `error-log.json`.
- `src/utils/paths.ts`: `getStorageFolder()`, `getProjectsFolder()`, `getToolRoot()`, `getConfigPath()`.

### Established Patterns
- Optional persisted field, no schema bump — `Repository.CredentialId`, `Repository.Description` (`constraints.md` "Schema Version Policy").
- Field removal by destructuring rather than writing `undefined` — `RepositoryManager.updateCredential()` (`src/models/repository/repository.manager.ts`).
- Storage layout documented in `docs/agents/project-manifest/data-flows.md` §11.

### Structural Observations
- `src/models/repository/repository.manager.ts`: each mutator repeats the same `load → findIndex → NotFoundError → mutate → save` sequence (`update`, `updateCredential`, `touchRefreshTimestamp`). Adding two or three more mutators repeats it again.
- `src/models/repository/repository.types.ts`: `Repository` is a flat bag of fields; a new group of related machine-local settings (enabled flag, main folder mode/path, last-written hash, timestamp) has no existing grouping.

### Constraints
- Repository IDs are kebab-case (`isValidKebabCase()`), so `{storage}/repositories/{repoId}` cannot traverse.
- `GET /api/repositories` returns the raw stored records — any new field is exposed to the GUI (fine for non-secret data; credentials/tokens must never be stored there).

## Area: Git Layer

### Verified References
- `src/git/git.types.ts`: `GitResult`, `GitStatusInfo { currentBranch; localCommits; unfetchedCommits; modifiedFiles; lastActivity; hasConflicts }`, `BranchInfo`, `CloneOptions { depth?; branch?; bare?; timeoutMs? }`, `RunGitOptions { timeoutMs?; maxBufferBytes? }`.
- `src/git/git-cli.ts`: `runGit(args, cwd?, options?)` — `shell: false`, env `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`; resolves on non-zero exit. `runGitOrThrow(args, cwd)` — error message uses only `args[0]` plus stderr (stderr is NOT credential-stripped there).
- `src/git/git-clone.ts`: `cloneRepository(url, destination, options)` — URL allowlist (`https://`, `http://`, `git://`, `ssh://`, `git@`, `file://`, `/`), cleartext warning, builds `['clone', --depth, --branch, --bare, url, dest]`.
- `src/git/git-branch.ts`: `listBranches()`, `getCurrentBranch()`, `getDefaultBranch(repoPath)` (L69: `symbolic-ref refs/remotes/origin/HEAD --short`, then main/master fallbacks), `createBranch()`, `switchBranch()` (rejects `-` prefix), `branchExists()`, `fetchRemote(repoPath, remote?, timeoutMs?)` (L189; `['fetch', remote]`).
- `src/git/git-status.ts`: `getGitStatus(repoPath)` (ahead/behind via `@{upstream}`, porcelain over the whole tree), `fetchAndGetStatus()`.
- `src/git/git-credentials.ts`: `extractHost()`, `hostsEqual()`, `resolveCredential(url, credentials, credentialId?)`, `injectCredentialToken(url, token)` (WHATWG URL username), `hasEmbeddedCredentials()`, `stripEmbeddedCredentials()` (URL path + regex scrub for prose).
- `src/orchestration/orchestration.types.ts`: `CLONE_TIMEOUT_MS = 120_000` (L6), `FETCH_TIMEOUT_MS = 30_000` (L12).
- Local git: `git version 2.56.0`; manifest minimum `>= 2.28` (`tech-stack.md`). `git sparse-checkout` (cone) exists since 2.25, `--filter` clone since 2.19.

- [added by: Plan Auditor, unverified] `src/error-log/error-log.types.ts` L6: `ErrorSeverity = 'error' | 'warning' | 'audit' | 'info'`; `ErrorLogEntry { Source; Operation; Context { RepositoryId? ... }; Message; Details? }`.
- [added by: Plan Auditor, unverified] `src/git/git-cli.ts` L150: `runGitOrThrow()` builds message `git <args[0]> failed (exit N):\n<stderr>` without stripping.
- [added by: Plan Auditor, unverified] `src/config/config.types.ts` L42: `AppConfig.storageFolder`. `src/storage/json-storage.ts` L88-L98: `repositories.json` lives directly in `{storageFolder}/` (no `repositories/` directory exists today).

### Established Patterns
- Stateless git wrappers returning `GitResult`; callers inspect `exitCode` — `src/git/git-branch.ts`.
- `-` prefix guard on user-influenced refnames — `createBranch()`/`switchBranch()` in `src/git/git-branch.ts`.
- Real local-repo fixtures in tests (`git init`, commits) — `src/tests/git-clone.test.ts`; fake-git binary for argument capture — `setupFakeGit()` in `src/tests/test-helpers.ts`.

### Structural Observations
- No git function exists for: reading/setting a remote URL, fetching from an explicit URL with a refspec, pushing, staging/committing, path-scoped porcelain status, sparse-checkout. All need new wrappers.
- Existing workspace clones are cloned from the credential-injected URL and never `set-url` back: the token is at rest in each clone's `.git/config` `remote.origin.url` (grep for `set-url` in `src/` returns nothing). Polling `fetch origin` relies on this.
- Git behaviour fact: when a server does not support `--filter`, `git clone --filter=...` does not fail — it prints `warning: filtering not recognized by server, ignoring` and performs a full clone. The agreed "fall back to full clone with a warning" therefore needs detection of that warning, not a retry.
- Git behaviour fact: in a partial clone, missing blobs are fetched lazily from the promisor remote (`origin`) on checkout. If `origin` holds a credential-less URL for a private HTTPS repository, the lazy fetch fails. Fetching by explicit URL also does not inherit the partial-clone filter unless `--filter` is passed again.
- Git behaviour fact: local-path clones (`/path`) ignore `--filter`; tests must use `file://` URLs and set `uploadpack.allowFilter=true` on the fixture origin.

### Constraints
- Every stderr surfaced after credential injection must pass through `stripEmbeddedCredentials()` (`constraints.md` "Git Subprocess Security").
- `injectCredentialToken()` only immediately before a git call; never returned across API boundaries.

## Area: Credential Pipeline Duplication

### Verified References
- `src/orchestration/workspace-orchestrator.ts` L141–L170: `resolveCredential()` → `extractHost()` → "requires a credential for host" error when HTTPS and no credential → `injectCredentialToken()`.
- `src/orchestration/repository-orchestrator.ts` L125–L153: the same block, duplicated, with the same error message text.
- `src/server/routes/repositories.ts` (PUT `/api/repositories/:id`, ~L340–L370): host-incoherence auto-clear — after a URL edit, clears a pinned `CredentialId` whose host no longer matches, and writes a `credential-audit` / `clear-credential` audit entry.

### Established Patterns
- Credential success/failure log entries `Source: 'credentials'` — `data-flows.md` §14.

### Structural Observations
- `src/orchestration/workspace-orchestrator.ts` / `src/orchestration/repository-orchestrator.ts`: credential resolve/inject/explain block is copy-pasted; a third consumer (managed clone, fetch, push) would make it three copies.
- `src/server/routes/repositories.ts`: the host-incoherence auto-clear lives inline in the PUT handler; an import that changes `Url` would need the identical rule. (After the design review the plan no longer imports `Url`, so the PUT handler remains the only consumer.)

### Constraints
- Explicit `CredentialId` lookups do not cross-validate host (`resolveCredential()` remarks).

## Area: Artefact Choke-Point and Index Files

### Verified References
- `src/orchestration/workspace-artifacts.ts`: `WorkspaceArtifactsOrchestrator(config, projectManager, repositoryManager)` — `regenerateWorkspace(projectId, workspaceId, overrides?)` (sync; writes `.code-workspace`, `writeWorkspaceIndexFiles()`, `writeCustomFiles()`), `removeCustomFileCopies()`, `regenerateProject()`, `regenerateForRepository(repositoryId)` (only regenerates projects that list the repository — a repository in no project triggers nothing), `removeWorkspace()`.
- Callers of the regenerate methods: `src/server/routes/projects.ts` (L255, L308, L446, L474, L495, L540), `src/server/routes/workspaces.ts` (L287, L340, L444), `src/server/routes/repositories.ts` (L375, `regenerateForRepository` after PUT), `src/cli/custom-files.ts` (L282, L366), `src/orchestration/project-orchestrator.ts` (L182), `src/orchestration/repository-orchestrator.ts` (L194, L304), `src/orchestration/workspace-orchestrator.ts` (L208, L339).
- `src/orchestration/workspace-index.ts`: pure render/merge/write module; `writeWorkspaceIndexFiles()` writes unconditionally (content includes `generatedAt`), guarded by `isLexicallyContained` → `escapesRootViaRealpath` → `isDirectoryShaped`.
- `src/utils/path-guard.ts`: `isLexicallyContained()`, `bestEffortRealpath()`, `resolveRootRealPath()`, `escapesRootViaRealpath()`, `MAX_SYMLINK_RESOLUTION_DEPTH` (shared by index writer and repository delete guard).
- `src/tests/workspace-artifacts-chokepoint.test.ts`: source-level guard that no module outside `workspace-artifacts.ts` imports `workspace-index.js`/`vscode-workspace.js` writers.
- Instantiation sites: `src/server/index.ts` L99–L103 and `src/cli/custom-files.ts` L144–L146 (CLI builds its own managers + orchestrator).

- [added by: Plan Auditor, unverified] `package.json` L51-L52: `npm test` = `tsc && node --test dist/tests/*.test.js dist/server/__tests__/*.test.js dist/server/__tests__/**/*.test.js`; `npm run test:gui` = `node --test 'gui/public/js/**/*.test.mjs'`.
- [added by: Plan Auditor, unverified] `src/tests/workspace-artifacts-chokepoint.test.ts`: guards only `workspace-index.js` / `vscode-workspace.js` imports; a new `repository-info.ts` writer is not covered by it.

### Established Patterns
- Pure module + orchestrator split — `workspace-index.ts` (pure) consumed by `workspace-artifacts.ts` (orchestrator).
- Best-effort artefact regeneration after a successful mutation, failures logged as `Severity: 'warning'`, `Source: 'workspace-index'` — `logArtifactWarning()` in `src/server/routes/repositories.ts`.
- Constructor injection of optional `errorLogManager` — all orchestrators.

### Structural Observations
- `src/orchestration/workspace-artifacts.ts`: `regenerateForRepository()` does nothing for a repository that no project references; repository-level artefacts (the info file) need a trigger independent of projects.
- `src/server/index.ts` and `src/cli/custom-files.ts` each construct `WorkspaceArtifactsOrchestrator` by hand; a new constructor dependency must be added in both places or the CLI silently diverges.

### Constraints
- All regenerate methods are synchronous; callers do not await them. Anything added to them must be synchronous (filesystem only, no git subprocess).

## Area: Health Reporting

### Verified References
- `src/orchestration/workspace-health.ts`: `WorkspaceHealthIssue { type; severity: 'error'|'warning'; message; fixAction; repositoryId? }`, `WorkspaceHealthReport { healthy; issues }`, `checkWorkspaceHealth(...)` (sync, filesystem + error log only).
- `docs/agents/project-manifest/rest-api.md` "Health Issue Types" table.
- `gui/public/js/views/workspace-detail.js` L839–L950: internal `buildHealthAlertSection(healthReport, callbacks)` with a hard-coded `if (fixAction === 'regenerate-workspace-file') … else if ('setup-workspace') … else if ('configure-credential')` chain; CSS `.health-alert`, `.health-alert-title`, `.health-alert-issue`, `__message`, `__action` in `gui/public/css/styles.css` (L1522–L1565).
- `gui/public/js/views/workspace-detail.index-health.test.mjs`: existing tests for the health alert.

### Established Patterns
- `fixAction` identifier → GUI button — `workspace-detail.js`.

### Structural Observations
- `src/orchestration/workspace-health.ts`: the issue/report types are workspace-named but generic in shape; a second report (repository info sync) would either duplicate them or misuse the workspace name.
- `gui/public/js/views/workspace-detail.js`: `buildHealthAlertSection()` is private to one view and dispatches via an if-chain; a second view cannot reuse it, and each new `fixAction` grows the chain.

### Constraints
- Messages rendered via `textContent` (XSS rule in `data-flows.md` §10).

## Area: Repository Deletion Cascade

### Verified References
- `src/orchestration/repository-orchestrator.ts`: constructor `(config, projectManager, repositoryManager, workspaceArtifacts, errorLogManager?)`; `removeRepositoryFromProject()` two-layer guard (strict-descendant lexical + `escapesRootViaRealpath()`); `deleteRepositoryGlobally(repositoryId)` (L337, sync) → per-project unlink → `repositoryManager.remove()` → `delete-repository-global` audit.
- `data-flows.md` §15 documents the cascade.

### Established Patterns
- Guarded `fs.rmSync` with strict-descendant + realpath checks — `removeRepositoryFromProject()`.

### Structural Observations
- None beyond adding one cleanup step; the cascade is well-factored.

### Constraints
- Audit entries emitted only after the mutation succeeds.

## Area: REST Layer

### Verified References
- `src/server/routes/repositories.ts` (576 lines): `registerRepositoryRoutes(router, repoManager, appConfig, workspaceArtifactsOrchestrator, repositoryOrchestrator, errorLogManager?)`; helpers `validateDescription()`, `resolveRepository()`, `buildCredentialOptionsResponse()`, `logArtifactWarning()`.
- `src/server/index.ts` L95–L158: composition root; `registerRepositoryRoutes(...)` at L150.
- `src/server/requestUtils.ts`: `parseJsonBody()` (1 MB limit), `sendJson()`, `sendError()`, `isPlainObject()`.
- `docs/agents/project-manifest/rest-api.md` "Repositories" table.

### Established Patterns
- One `register*Routes()` function per resource file — `src/server/routes/*.ts`.
- Route tests per file — `src/server/__tests__/routes/repositories.test.ts`; mock HTTP helpers in `src/server/__tests__/helpers/mock-http.ts`.

### Structural Observations
- `src/server/routes/repositories.ts` is already 576 lines; adding seven more handlers inline would roughly double it.

### Constraints
- Route registration order matters when patterns share segment count (comment at `/api/repositories/credential-options`).

## Area: CLI

### Verified References
- `src/index.ts`: command switch (`menu`, `serve`, `setup`, `docs`, `custom-files`, `help`).
- `src/cli/custom-files.ts`: builds `RepositoryManager`, `ProjectManager`, `WorkspaceArtifactsOrchestrator` (L144–L146) and calls `regenerateProject()`.
- `constraints.md` "Custom Files": CLI/REST parity rule is scoped to custom files.

### Established Patterns
- In-process CLI using the same managers/choke-point as REST — `src/cli/custom-files.ts`.

### Structural Observations
- See Artefact Choke-Point: duplicated orchestrator construction.

### Constraints
- None that mandate a CLI for this feature (parity rule is custom-files-specific).

## Area: GUI

### Verified References
- `gui/public/js/views/repository-detail.js` (843 lines): `setRouter()`, `buildCredentialSection(repoId, storedCredentialId)` (L84), `buildHeader(repo)` (L354), `renderRepositoryDetail(container, params)` (L615); Refresh with `refreshInProgress` mutex.
- `gui/public/js/views/repositories.js` (329 lines): `buildTableHead()`, `truncateDescription()`, `buildRepoRow(repo, onChanged)`, `buildAddRepoButton()`; credential badge via `buildCredentialBadge()` from `utils/dom.js`.
- `gui/public/js/views/project-custom-files.js` (459 lines): section module consumed by `project-detail.js` (`buildCustomFilesSection()`).
- `gui/public/js/components/modal-shell.js`: `createModalShell({ titleText, ariaLabelledbyId, ariaDescribedbyId?, className?, onCancel })` → `{ overlay, modal, mount, close, setBusy }`.
- `gui/public/js/components/repository-modal.js`: `showRepositoryModal({ mode, repo })` built on modal-shell.
- `gui/public/js/components/confirm-dialog.js`: `showConfirm(title, message)`.
- `gui/public/js/components/toast.js` (L93–L96): each toast element is created with `role="status"` and `aria-live="polite"` — toasts are already announced politely (verified during design-review integration, 2026-11-20).
- `gui/public/js/api.js` (972 lines): `api.repositories` namespace object (L118–).
- `gui/public/js/utils/normalise.js`: PascalCase → camelCase mapping.
- `gui/public/js/views/repository-detail.test.mjs`: jsdom tests; GUI tests auto-discovered by `npm run test:gui`.

### Established Patterns
- Section module per tab/section — `views/project-custom-files.js`.
- Modals on `modal-shell.js` — `components/repository-modal.js`.
- Sub-namespace for grouped API methods — `api.workspaces.launch` (`gui-frontend.md`).
- No `innerHTML` assignments; `clearElement()` from `utils/dom.js`.

### Structural Observations
- `gui/public/js/views/workspace-detail.js`: see Health Reporting — the health alert builder is not shareable.
- `gui/public/js/views/repository-detail.js`: 843 lines; adding a full sync section inline would make it the second-largest view.

### Constraints
- No build step; native ES modules; router injection via `setRouter()`; cleanup contract for intervals/listeners.

## Area: Documentation

### Verified References
- `AGENTS.md` §2 maintenance matrix: exported types → `api-surface.md`; REST → `rest-api.md`; GUI → `gui-frontend.md`; conventions → `constraints.md`; storage layout/data flow → `data-flows.md`; new files → `ctx generate`.
- Module READMEs: `src/git/README.md`, `src/orchestration/README.md`, `src/models/README.md`, `src/server/README.md`, `gui/README.md`.
- `CHANGELOG.md`: top section `## Unreleased - Custom Files CLI`; house style = bold one-line summary, then `- Area: change.` bullets.
- Prior plans for conventions: `docs/agents/implementation-history/2026-09-25-workspace-index-files/`, `2026-11-18-project-custom-files/`, `2026-11-19-cli-custom-files/`.

### Constraints
- Type-audit acceptance criterion required for WPs that add exported types (`constraints.md`).

## Addendum (verified during audit integration, cycle 1)
- `src/git/git-branch.ts` (L69–L111): `getDefaultBranch()` tries `symbolic-ref refs/remotes/origin/HEAD`, then `main`/`master` local and remote refs, and finally returns the literal `'main'` without verifying the ref exists. On an empty remote the subsequent checkout fails.
- `src/config/config.constants.ts` (L120): `MAX_REPOSITORY_DESCRIPTION_LENGTH = 500` is the only length constant of its kind; no `INFO_COMMIT_*` constants exist today.
- `package.json` (L51–L52): `test` = `tsc && node --test dist/tests/*.test.js dist/server/__tests__/*.test.js dist/server/__tests__/**/*.test.js`; `test:gui` = `node --test 'gui/public/js/**/*.test.mjs'` (jsdom). No browser, zoom, contrast or a11y tooling is configured.
- `gui/public/css/styles.css`: dark theme via `:root[data-theme="dark"]` (L91); a single `@media (prefers-reduced-motion: reduce)` block covering `.modal-overlay`, `.modal` (L921); `@media (max-width: 768px)` blocks at L1141 and L1353. No existing GUI test reads `styles.css`.

## Addendum (verified during plan production)
- `gui/public/js/utils/normalise.js` (L24–L33): `normaliseRepo()` is a whitelist mapper (`id`, `name`, `url`, `description`, `credentialId`, `LastRefreshedAt`); unknown keys such as a new `InfoSync` object are dropped unless added explicitly. Tests: `gui/public/js/__tests__/normalise.test.mjs`.

## Addendum (cycle 2 audit)
- [added by: Plan Auditor, unverified] `src/config/config.constants.ts` L120: `MAX_REPOSITORY_DESCRIPTION_LENGTH = 500` (insertion anchor for the new info-commit constants).
- [added by: Plan Auditor, unverified] `src/orchestration/orchestration.types.ts` L6/L12: `CLONE_TIMEOUT_MS = 120_000`, `FETCH_TIMEOUT_MS = 30_000`; no `PUSH_TIMEOUT_MS` yet.
- [added by: Plan Auditor, unverified] `src/cli/custom-files.ts` L144-L146: `createDefaultCustomFilesDeps()` builds `WorkspaceArtifactsOrchestrator(config, projectManager, repoManager)`.
- [added by: Plan Auditor, unverified] Existing test files: `src/tests/{cli-custom-files,repository-orchestrator,repository.manager,workspace-artifacts,workspace-artifacts-chokepoint,workspace-health}.test.ts`; route tests live in `src/server/__tests__/routes/`; `setupFakeGit` is in `src/tests/test-helpers.ts`.
