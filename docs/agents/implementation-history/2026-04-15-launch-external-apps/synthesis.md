# Project Synthesis Report
**Plan:** `2026-04-15-launch-external-apps`
**Generated:** 2026-04-15
**Status:** ✅ COMPLETE — All 6 work packages passed all pipeline stages.

---

## Executive Summary

This session delivered end-to-end support for launching external GUI applications (VS Code and GitHub Desktop) directly from the workspace detail view. Because the browser cannot spawn local processes, the feature follows a clean server-delegation architecture: the GUI sends POST requests to two new server endpoints, which validate the workspace/repository state, spawn the application via a new cross-platform utility, and return a structured success/error response.

The work decomposed into six well-scoped packages:

| WP | Description | Stages |
|---|---|---|
| WP-001 | `src/server/app-launcher.ts` — cross-platform spawn utility | impl → qa → security-audit → code-review → docs |
| WP-002 | Two new POST endpoints on `workspaces.ts` + `ErrorLogManager` wiring | impl → qa → security-audit → code-review → docs |
| WP-003 | `api.workspaces.openVscode()` + `api.workspaces.openGithubDesktop()` API client methods | impl → qa → code-review → docs |
| WP-004 | "Open in VS Code" button in the workspace header management row | impl → qa → code-review → docs |
| WP-005 | Per-repository "Open" button in a new 4th "Actions" column of the status table | impl → qa → code-review → docs |
| WP-006 | Cross-cutting documentation review of `rest-api.md`, `api-surface.md`, `gui-frontend.md` | docs only |

All 22 acceptance criteria across all six packages are marked `met: true`. No work package required a rework cycle. The pipeline health check confirms 6/6 WPs passed all active stages with zero missing stages.

---

## Metrics

### Test Suite

| Package | New Tests | Total at Completion | Failures |
|---|---|---|---|
| WP-001 (`app-launcher.ts`) | 2 | 721 | 0 |
| WP-002 (launch endpoints) | 14 | 733 | 0 |
| WP-003 (API client) | 12 | 27 (GUI suite) | 0 |
| WP-004 (VS Code button) | 11 | 43 | 0 |
| WP-005 (Open button / Actions column) | 5 | 38 | 0 |

**Net new tests shipped: 44.** The server test suite grew from 719 → 733 (no regressions). The GUI test suite (separate runner) grew from 15 → 43 tests across four dedicated test files.

### Security Audit

WP-001 and WP-002 both received full security audits (OWASP Top 10 pass).

- **Critical/High findings: 0**
- **Medium findings: 4** (two per WP — all design-level, none blocking in the current localhost-only deployment context)
- **Low/Info findings: 8** (informational, no action required)

### Build & Type Safety

TypeScript compilation was verified clean after each implementation pass. No type errors introduced.

### Documentation Artifacts

- `src/server/app-launcher.ts` — JSDoc with `@param`, `@returns`, `@throws` annotations; added to `api-surface.md`, `src/server/README.md`, `src/server/module-context.yaml`.
- `src/server/routes/workspaces.ts` — updated `registerWorkspaceRoutes()` JSDoc (all 6+1 params); path-traversal inline comment; `api-surface.md` signature corrected.
- `docs/agents/project-manifest/rest-api.md` — new dedicated `## Launch` section for both endpoints.
- `docs/agents/project-manifest/gui-frontend.md` — openVscode/openGithubDesktop API entries, Actions column behaviour, workspace header button lifecycle.
- `CONTRIBUTING.md` — `api.workspaces` namespace growth note and `workspaces.launch` sub-namespace architectural recommendation.
- `.context/` CTX bundle fully regenerated after each documentation pass (28 files, exit code 0).

---

## Security Findings (Aggregated)

The four medium-priority security observations are all informational in the current context (localhost-only, 127.0.0.1 binding). They should be re-evaluated if the server is ever exposed to a network.

| ID | Severity | Location | Finding |
|---|---|---|---|
| S-01 | **Medium** | `app-launcher.ts` | Windows `shell:true` injection risk — if `command`/`args` were ever sourced from user input, shell metacharacters could be injected. In practice the command is hardcoded (`'code'`, `'github'`). **Mitigation:** Call-site allowlist documented in `api-surface.md`. |
| S-02 | **Medium** | `app-launcher.ts` | No input validation (`command` empty-string, no allowlist). **Mitigation:** Empty-command guard added by code review Fix-Forward. Allowlist is a call-site responsibility (documented). |
| S-03 | **Medium** | `workspaces.ts` | Path traversal defence-in-depth gap — `projectId`/`workspaceId` are validated indirectly via manager lookups rather than an explicit `path.resolve()` + `startsWith()` check. In practice, traversal is blocked because a traversal path cannot be registered in the data store. **Recommended hardening:** add explicit path boundary assertion. |
| S-04 | **Medium** | `workspaces.ts` | 500 responses include raw `err.message` from `launchApplication` (reveals executable name/PATH status). **Mitigation:** Acceptable for localhost; callers should sanitize if the API is ever exposed externally. |

---

## Strategic Recommendations (Gold Nuggets)

### 1. 🛡️ Add Path Boundary Assertions (Hardening, Low Effort)

Security Audit flagged (S-03) that `wsFilePath` and `repoDir` in `workspaces.ts` are not guarded with an explicit `path.resolve()` + `startsWith(appConfig.projectsFolder)` assertion. The current indirect defence is adequate for the current threat model. A one-liner guard would future-proof the code and eliminate all doubt:

```ts
if (!resolvedPath.startsWith(path.resolve(appConfig.projectsFolder))) {
  return sendError(res, 400, 'Invalid path.');
}
```

**Recommended for the next security-hardening pass.**

### 2. 🧩 Refactor Repeated Workspace-Existence Check

The Developer (WP-002) and QA (WP-002) both noted that 5+ handlers in `workspaces.ts` share a copy-pasted workspace-existence check block. A small private helper `verifyWorkspaceExists(res, projectId, workspaceId): Promise<boolean>` would reduce duplication and make the intent explicit. **Recommended for the next `workspaces.ts` refactor pass.**

### 3. 🗂️ Plan `api.workspaces.launch` Sub-Namespace

The `api.workspaces` namespace is now at 11 methods. The Reviewer (WP-003) and the Documentation agent both flagged that the existing `config.credentials` / `config.polling` pattern provides a precedent for nested sub-namespaces. If more launch-type endpoints are added in future, grouping them under `api.workspaces.launch` would improve discoverability. **Not urgent now; document the decision before the namespace reaches 15+ methods.** (This is now noted in `CONTRIBUTING.md`.)

### 4. 🧪 Add Windows CI Coverage for `shell:true` Branch

The `shell: true` Windows branch in `app-launcher.ts` cannot be tested in the current macOS/Linux CI environment. Both QA and the Security Auditor flagged this. **Recommended:** mock `process.platform` in a dedicated Jest test (or add a Windows CI job) to verify the conditional is exercised in automated tests.

### 5. 🍞 Consider Toast Coverage Strategy

Both WP-004 and WP-005 note that jsdom's lack of a `#toast-container` node means `showToast()` is a silent no-op in tests. Toast side-effects are validated by inference (button re-enables correctly via `finally`). Two options for strengthening coverage: (a) inject `#toast-container` in test setup and assert on rendered toast DOM, or (b) add a module-level `showToast` spy. **Recommended before any toast-related regression work.**

---

## What Was Built — File Inventory

**New files:**
- `src/server/app-launcher.ts` — cross-platform `launchApplication()` utility
- `src/server/__tests__/app-launcher.test.ts` — 2 unit tests
- `src/server/__tests__/routes/workspaces-launch.test.ts` — 14 route integration tests
- `gui/public/js/api.workspaces.launch.test.mjs` — 12 API client tests
- `gui/public/js/views/workspace-detail.vscode-button.test.mjs` — 11 GUI unit tests
- `gui/public/js/views/workspace-detail.open-button.test.mjs` — 5 GUI unit tests

**Modified files (implementation):**
- `src/server/routes/workspaces.ts` — two new POST endpoints, `ErrorLogManager` param, updated JSDoc
- `src/server/index.ts` — passes `errorLogManager` as 6th arg to `registerWorkspaceRoutes()`
- `gui/public/js/api.js` — `openVscode()`, `openGithubDesktop()` added to `api.workspaces`
- `gui/public/js/views/workspace-detail.js` — `buildOpenVscodeButton()`, header row button, Actions column with per-repo "Open" button

**Modified files (documentation):**
- `src/server/README.md`, `src/server/module-context.yaml`
- `docs/agents/project-manifest/rest-api.md`
- `docs/agents/project-manifest/api-surface.md`
- `docs/agents/project-manifest/gui-frontend.md`
- `CONTRIBUTING.md`
- `.context/` bundle (28 files, regenerated)

---

## Next Steps

1. **Security hardening (WP-001/WP-002 follow-up):** Add the `path.resolve()` + `startsWith()` path boundary assertions in `workspaces.ts` (S-03). Low effort, eliminates the only structural security gap.
2. **`workspaces.ts` refactor:** Extract the repeated workspace-existence check into a private helper — reduces future maintenance surface.
3. **Windows CI:** Add a mocked `process.platform` test or a Windows CI job for the `shell:true` branch in `app-launcher.ts`.
4. **Toast test coverage:** Adopt a `showToast` spy or DOM setup strategy in GUI tests so toast assertions are direct, not inferred.
5. **Future launch actions (e.g. "Open in terminal"):** Use the established 4th "Actions" column pattern in the status table — no table restructuring required.
