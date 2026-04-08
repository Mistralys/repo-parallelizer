# Synthesis Report — Phase 7: CLI Menu, Setup & Distribution

**Project:** `2026-04-03-phase7-cli-menu-and-distribution`  
**Plan:** Phase 7 — CLI Menu, Setup & Distribution  
**Generated:** 2026-04-08  
**Status:** ✅ COMPLETE — all 5 work packages delivered across all pipeline stages

---

## Executive Summary

Phase 7 completes the terminal-facing layer of `repo-parallelizer`, transforming a headless Node.js server tool into a fully interactive, distribution-ready CLI application. Five work packages were delivered in sequence:

1. **WP-001 — Terminal UI Utilities:** `src/cli/terminal-ui.ts` with 9 exported color/input helpers, powered by `picocolors` (the first production runtime dependency).
2. **WP-002 — Setup Wizard:** `src/cli/setup.ts` (`runSetup()`), a fully interactive first-run wizard with validated numeric inputs, directory creation, and `loadConfig()` compatibility.
3. **WP-003 — Documentation Generator + Interactive Menu:** `src/cli/docs.ts` (`generateDocs()`) and `src/cli/menu.ts` (`showMenu()`) — the while-loop key-dispatch menu that ties all actions together.
4. **WP-004 — Binary Entry Point Update:** `src/index.ts` rewritten as a clean command dispatcher (`paralizer`, `paralizer menu`, `paralizer serve`, `paralizer setup`, `paralizer docs`) with graceful error messages.
5. **WP-005 — Launcher Scripts & Package.json Finalization:** `menu.sh` and `menu.cmd` cross-platform launchers, plus `package.json` `main`, `files`, `keywords`, and `repository` fields for npm distribution.

All 34 acceptance criteria across all 5 WPs were confirmed met. The tool compiles cleanly (tsc 0 errors) and the full test suite grew from 517 → 539 tests, with 0 failures throughout.

---

## Metrics

| WP | Pipeline Stages | Tests at Completion | Build | AC Met |
|----|----------------|---------------------|-------|--------|
| WP-001 | impl → qa → review → docs | 517 / 517 | ✅ | 6 / 6 |
| WP-002 | impl → qa → review → docs | 539 / 539 | ✅ | 8 / 8 |
| WP-003 | impl → qa → review → docs | 539 / 539 | ✅ | 10 / 10 |
| WP-004 | impl → qa → review → docs | 539 / 539 | ✅ | 10 / 10 |
| WP-005 | impl → qa → review → docs | 539 / 539 | ✅ | 9 / 9 |

**New tests added:** 22 (WP-002 — `src/tests/setup.test.ts`)  
**Pipeline health:** 5 / 5 WPs with all stages PASS, 0 stages missing  
**Rework cycles:** 0 (all WPs delivered first-pass)

---

## Delivered Artifacts

### New Files
| File | Purpose |
|------|---------|
| `src/cli/terminal-ui.ts` | 9-function terminal UI helper (colors, prompts, raw-mode input) |
| `src/cli/setup.ts` | Interactive first-run configuration wizard |
| `src/cli/docs.ts` | CTX Generator integration with PATH check and fallback instructions |
| `src/cli/menu.ts` | While-loop interactive menu with 4 key-dispatch actions |
| `src/tests/setup.test.ts` | 22 unit tests for setup wizard helpers |
| `menu.sh` | Unix/macOS launcher (executable, shebang, `cd "$(dirname "$0")"`) |
| `menu.cmd` | Windows launcher (`@echo off`, `cd /d "%~dp0"`) |

### Modified Files
| File | Change |
|------|--------|
| `src/index.ts` | Rewritten as CLI command dispatcher (switch-on-argv) |
| `package.json` | Added `picocolors` dep; added `main`, `files`, `keywords`, `repository` |
| `README.md` | CLI usage, launcher scripts, server-direct, setup wizard sections |
| `CHANGELOG.md` | [Unreleased] section with all Phase 7 additions |
| `docs/agents/project-manifest/tech-stack.md` | "zero runtime dependencies" → "vetted dependencies" policy + picocolors table + CLI distribution pre-publish checklist |
| `docs/agents/project-manifest/api-surface.md` | Full CLI module API reference (all 4 files, all exported + private helpers) |
| `docs/agents/project-manifest/file-tree.md` | src/cli/ 4-file block + root menu.sh / menu.cmd entries |
| `AGENTS.md` | Runtime dependencies stat updated |
| `.context/project-manifest.md` | Stale "zero runtime dependencies" text replaced with picocolors table |

---

## Issues Encountered

None were blocking. All pipelines passed first-pass.

### Low-Priority Observations (carried into recommendations)

| # | Source | File | Issue |
|---|--------|------|-------|
| 1 | QA/Reviewer (WP-001) | `terminal-ui.ts` | `waitForKey()` has no `isTTY` guard — non-TTY environments (CI) will throw on `setRawMode`. Callers must guard with `process.stdin.isTTY`. |
| 2 | QA/Reviewer (WP-002) | `setup.ts:106` | `!Number.isInteger(parsed) \|\| Number.isNaN(parsed)` — the `isNaN` check is dead code (`isInteger(NaN)` is already false). Harmless. |
| 3 | Reviewer (WP-003) | `menu.ts` | `config.serverPort ?? 4200` is redundant — `loadConfig()` already applies the default. |
| 4 | QA/Reviewer (WP-004) | `src/index.ts` | Async IIFE has no top-level `.catch()`. Any uncaught rejection emits a warning instead of a clean exit-1. |
| 5 | Dev/QA/Reviewer (WP-005) | `package.json` | `repository.url` is a placeholder (`https://github.com/user/repo-parallelizer`) — **must be updated before `npm publish`**. |
| 6 | Dev/QA/Reviewer (WP-005) | `package.json` + `dist/` | `dist/tests/` and `dist/server/__tests__/` are included in the npm tarball (~700 kB of the 1.4 MB unpacked). A `.npmignore` would halve publish size. |
| 7 | Dev/QA/Reviewer (WP-005) | `menu.sh` | No `.gitattributes eol=lf` guard — on Windows checkouts Git may CRLF-convert the shebang line, breaking bash execution. |
| 8 | Multiple WPs | `src/utils/paths.ts` et al. | Pre-existing inconsistency: some older files use bare `'fs'`/`'path'` imports instead of `'node:fs'`/`'node:path'`. All new CLI files use `node:` prefix correctly. |

---

## Strategic Recommendations ("Gold Nuggets")

### 1. Pre-publish Checklist — Action Required Before First `npm publish`
Three items **must** be resolved before the package can go to the registry:
- [ ] Replace `package.json` `repository.url` placeholder with the real GitHub URL.
- [ ] Add `.npmignore` to exclude `dist/tests/` and `dist/server/__tests__/` (~700 kB savings, halves tarball).
- [ ] Add `menu.sh text eol=lf` to `.gitattributes` to prevent CRLF corruption on Windows checkouts.

A dedicated **Release Engineering WP** or a short housekeeping pass before the first `npm publish` should cover all three.

### 2. TTY Guard Standardisation
`waitForKey()` in `terminal-ui.ts` has no `process.stdin.isTTY` guard. This is safe in interactive use but will throw in CI or piped contexts. Recommend adding a guard inside the function itself (reject with a clear message when not a TTY) rather than relying on all callers to check individually. This would also enable basic smoke-testing of the menu dispatch logic without TTY mocking.

### 3. Async IIFE `.catch()` Hardening
`src/index.ts` IIFE has no top-level `.catch()`. While all current command handlers manage their own errors, an unguarded third-party or future regression would silently emit an `UnhandledPromiseRejection` warning rather than producing a clean error + exit(1). A one-line `.catch(err => { process.stderr.write(...); process.exit(1); })` is a cheap safety net.

### 4. IO Adapter for `runSetup()` Integration Tests
`runSetup()` cannot be end-to-end tested without real TTY stdin. The injectable `_ask`/`_confirm` callbacks on `_promptPath` and `_promptNumber` already solve the helper-level coverage gap. Extending this pattern to `runSetup()` itself (an optional `{ ask, confirm }` parameter) would allow full wizard-flow integration tests without stdin, closing the only remaining coverage gap in the CLI module.

### 5. Node: Import Prefix Cleanup Pass
`src/utils/paths.ts`, `src/utils/slug.ts`, and a number of older files use bare `'fs'`/`'path'` imports while all Phase 7 code uses `'node:fs'`/`'node:path'`. This is a purely cosmetic inconsistency but worth a single-WP cleanup pass for codebase uniformity.

### 6. `.context/` Auto-regeneration Discipline
The `.context/project-manifest.md` file drifted from the authoritative `tech-stack.md` source (carrying stale "zero runtime dependencies" text). This was caught and resolved in WP-001's documentation pass. Going forward: add a `npm run ctx` (or equivalent) step to the developer workflow — or regenerate `.context/` as a documentation post-step for every agent cycle — to prevent future drift.

---

## Next Steps for Planner / Program Manager

| Priority | Action |
|----------|--------|
| **High** | Pre-publish: fix placeholder `repository.url`, add `.npmignore`, add `.gitattributes eol=lf` — required before any `npm publish`. |
| **Medium** | Add top-level `.catch()` to `src/index.ts` async IIFE (one-line hardening). |
| **Medium** | Add `process.stdin.isTTY` guard inside `waitForKey()` to enable non-TTY robustness and future testability. |
| **Low** | IO adapter for `runSetup()` to enable full wizard integration tests. |
| **Low** | `node:` import prefix cleanup pass across pre-Phase-7 source files. |
| **Low** | `.context/` regeneration policy — automate or document as a recurring housekeeping step. |
| **Future** | SIGINT / graceful shutdown in `launchGui()` — the current `await new Promise<never>()` idiom works but a `process.on('SIGINT', () => stopServer())` handler would provide a cleaner Ctrl+C shutdown path. |

---

## Overall Assessment

Phase 7 was executed cleanly and efficiently. All 5 work packages were delivered first-pass with zero rework cycles. The 34 acceptance criteria were met across all pipeline stages (implementation, QA, code-review, documentation). The test suite grew from 517 → 539 tests, the build remained clean throughout, and the project is now distribution-ready pending the three pre-publish housekeeping items documented above.

The CLI module (`src/cli/`) is well-structured, clearly documented, and follows the project's established conventions. `repo-parallelizer` can now be invoked interactively as `paralizer`, run headlessly as `paralizer serve`, and distributed via npm or launcher scripts to macOS, Windows, and Linux users.
