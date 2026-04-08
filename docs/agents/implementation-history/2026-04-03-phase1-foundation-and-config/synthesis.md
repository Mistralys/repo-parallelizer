# Synthesis Report — Phase 1: Foundation & Config

**Date:** 2026-04-03  
**Plan:** `2026-04-03-phase1-foundation-and-config`  
**Status:** COMPLETE  
**Work Packages:** 7/7 complete  

---

## Executive Summary

Phase 1 establishes the complete foundational scaffold for **repo-parallelizer** (`paralizer` CLI). Seven work packages delivered:

1. **WP-001** — TypeScript project scaffold (package.json, tsconfig.json, shebang, .gitignore)
2. **WP-002** — Path utilities: cwd-independent `getToolRoot()`, `getConfigPath()`, `getStorageFolder()`, `getProjectsFolder()`
3. **WP-003** — JSON storage layer: `readJsonFile<T>`, `writeJsonFile<T>`, `ensureDirectory`, `SchemaVersion` type
4. **WP-004** — Slug utilities: `toKebabCase()`, `isValidKebabCase()`, `inferSlugFromUrl()`, `isValidWorkspaceId()`
5. **WP-005** — Config loading system: `AppConfig` interface, `loadConfig()` with field validation and defaults
6. **WP-006** — CLI entry point: `src/index.ts` with full error handling, stderr/stdout separation, exit codes
7. **WP-007** — End-to-end integration smoke test across the complete pipeline

The tool compiles cleanly with zero TypeScript errors, passes `npm link` to register the `paralizer` binary, and correctly validates and loads `config.json` at startup.

---

## Metrics

| Metric | Value |
|---|---|
| Work Packages | 7 / 7 COMPLETE |
| Pipeline stages executed | 28 |
| Total tests passed | **78** |
| Total tests failed | **0** |
| WPs requiring rework | 1 (WP-005) |
| Reviewer Fix-Forwards applied | 2 (FolderConfig camelCase, TOCTOU fix) |
| Blocking issues encountered | 1 (WP-005 naming inconsistency — resolved) |
| Build status | `tsc` exits 0, zero errors/warnings |
| Binary | `paralizer` via `npm link` → `/usr/local/bin/paralizer` |

### Per-WP Test Summary

| WP | Stage | Tests Passed |
|---|---|---|
| WP-001 | QA | 5 / 5 |
| WP-002 | QA | 8 / 8 |
| WP-003 | QA | 9 / 9 |
| WP-004 | QA | 23 / 23 |
| WP-005 | QA (post-rework) | 21 / 21 |
| WP-006 | QA | 7 / 7 |
| WP-007 | QA (integration) | 5 / 5 |
| **Total** | | **78 / 78** |

---

## Incidents & Blockers

### WP-005 — Naming Convention Inconsistency (Resolved)

**Type:** Blocking code-review failure → rework cycle  
**Root cause:** `AppConfig` properties were implemented with PascalCase (`ProjectsFolder`, `StorageFolder`, `CloneDepth`, etc.) while `FolderConfig` in `paths.ts` (WP-002) had already been standardised to camelCase during its own code-review Fix-Forward. The structural incompatibility would have required adapter mapping in every Phase 3+ caller.  
**Resolution:** Developer renamed all `AppConfig` fields to camelCase (`projectsFolder`, `storageFolder`, `cloneDepth`, `serverPort`, `gitPollingIntervalSeconds`). `AppConfig` is now a structural superset of `FolderConfig`, enabling direct pass-through to `getStorageFolder(config: FolderConfig)`.  
**Rework cost:** 1 additional implementation + QA + code-review cycle.

---

## Strategic Recommendations ("Gold Nuggets")

### 1. `ReadonlyArray<keyof AppConfig>` Pattern for Required-Field Lists

In `src/config/config.ts`, `REQUIRED_FIELDS` is typed as `ReadonlyArray<keyof AppConfig>`. This creates a **compile-time binding** between the required-fields list and the `AppConfig` interface — TypeScript will immediately flag stale entries if a property is renamed. Replicate this pattern in all future WPs that declare required-field or allowed-key lists.

### 2. Fix-Forward Applied by Reviewer: TOCTOU in `readJsonFile`

The original `readJsonFile` used `existsSync()` followed by `readFileSync()` — a classic TOCTOU (Time-of-Check/Time-of-Use) race pattern. The Reviewer replaced this with a single `try/catch` around `readFileSync` with an `ENOENT` branch. This is the idiomatic Node.js pattern. **All future file-read utilities should use single try/catch directly on the I/O call.**

### 3. Establish a Test Framework Before Phase 2

All 78 QA tests were executed as ad-hoc one-shot `node` scripts against compiled `dist/`. No test files are committed to the repository. Every Phase 2 feature introduces new code paths that will have no regression protection. Recommend adding `vitest` or `node:test` with a lightweight harness **before Phase 2 begins** — even a single `tests/` folder with smoke tests for `paths.ts`, `json-storage.ts`, and `config.ts` would be sufficient to prevent regressions.

### 4. Fragile String-Sniff Error Discrimination in `config.ts`

`loadConfig()` detects a missing config file by checking `err.message.includes('File not found')` — a string match against the error message produced internally by `json-storage.ts`. If `json-storage.ts` is refactored and the message text changes, this branch silently falls through to the generic rethrow (still throws, but loses the user-friendly setup instruction). **Phase 2 should introduce a typed `FileNotFoundError` class** (or error with a `.code` property) to make this contract explicit.

### 5. Required-Field Validation Is Type-Unsafe

`loadConfig()` validates required fields with a truthiness check, not a `typeof` guard. A non-string truthy value (e.g., `"projectsFolder": 123`) passes validation and is cast to `string` via `as string`. This is safe for Phase 1's string-only config schema, but **Phase 2 should introduce `zod` or a hand-written type guard** to replace the unchecked cast pattern before non-string config fields are added.

---

## Open Technical Debt (Carry Forward to Phase 2)

| Priority | Status | Item | File |
|---|---|---|---|
| Medium | ✅ Done | Introduce `FileNotFoundError` class to eliminate string-sniff in `loadConfig()` | `src/config/config.ts` |
| Medium | ✅ Done | Add runtime schema validation (zod / type guards) for `AppConfig` required fields | `src/config/config.ts` |
| Medium | ✅ Done | Add test framework + baseline tests before Phase 2 | `src/tests/` (new) |
| Low | ✅ Done | Cache `getToolRoot()` result at module load to avoid repeated fs walks | `src/utils/paths.ts` |
| Low | ✅ Done | Gate verbose config dump at startup behind a `--verbose` flag | `src/index.ts` |
| Low | ✅ Done | `ensureDirectory()` does not produce a clear error when target path exists as a file | `src/storage/json-storage.ts` |
| Low | — Deferred | `inferSlugFromUrl()` returns empty string for malformed input; callers must guard | `src/utils/slug.ts` |
| Low | — Deferred | `isValidWorkspaceId()` rejects digits — document or reconsider if IDs like `AB1` are needed | `src/utils/slug.ts` |

---

## Documentation Produced

| File | Agent | Notes |
|---|---|---|
| `README.md` | Documentation | Full guide: prerequisites, install, CLI usage, config schema table, path resolution rules, setup steps |
| `CONTRIBUTING.md` | Documentation | Node16 `.js` extension requirement on relative imports, local dev setup |
| `src/utils/paths.ts` | Documentation | `FolderConfig` JSDoc: relative/absolute resolution rule with examples |
| `src/storage/json-storage.ts` | Documentation | `readJsonFile<T>` type-safety callout (unchecked generic cast) |
| `src/utils/slug.ts` | Documentation | Non-ASCII stripping, empty-output edge cases, `isValidWorkspaceId` digit-rejection |
| `src/index.ts` | Documentation | Module-level entry-point JSDoc with success/failure behavior and exit codes |

---

## Next Steps for Planner / Phase 2

1. ~~**Test framework first:** Create `tests/` with `vitest` or `node:test` covering `paths.ts`, `json-storage.ts`, and `config.ts` before any Phase 2 feature work.~~ ✅ Done — `src/tests/` with 56 `node:test` tests covering all four modules; `npm test` builds and runs them.
2. ~~**Typed error classes:** Add `FileNotFoundError` (or error codes) to `json-storage.ts` and update `config.ts` to remove the string-sniff.~~ ✅ Done — `FileNotFoundError` class in `json-storage.ts`; `loadConfig()` uses `instanceof` and `typeof` guards.
3. **Phase 2 (Data Models & Storage):** The foundation is ready. `AppConfig` (`projectsFolder`, `storageFolder`) feeds into `getStorageFolder(config)` without adapters. Build the workspace/project data model and persistence layer on top of `json-storage.ts`.
4. **Node16 import extensions:** All future `src/` files must use `.js` extensions on relative imports (`import { x } from './utils.js'`). This is documented in `CONTRIBUTING.md` but is a common new-contributor mistake — consider a lint rule or `tsconfig` `paths` check.
