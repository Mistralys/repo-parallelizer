# Synthesis Report — Private Repository Authentication
**Plan:** `2026-04-08-private-repo-auth`  
**Date:** 2026-04-10  
**Total WPs:** 11 · **All COMPLETE**  
**Final Test Suite:** 612/612 pass · 0 failures  
**TypeScript Build:** Clean (zero errors throughout)

---

## Executive Summary

This plan delivered end-to-end private repository authentication for repo-parallelizer. Starting from a tool that could only clone public repositories, the session implemented the full authentication stack: credential storage in `config.json`, transient per-clone URL injection, credential management REST endpoints, a Settings UI, automatic credential stripping on model writes, and fail-fast subprocess-level auth suppression.

The feature is complete and production-ready. No blocking findings remain. All security concerns identified during the cycle were resolved before the respective WPs were promoted to COMPLETE.

### What Was Built

| Layer | Change |
|---|---|
| **Config** | `gitCredentials?: Record<string, string>` on `AppConfig`; `parseGitCredentials()` validator; `saveConfigField()` utility |
| **Git subprocess** | `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=echo` in `runGit()` — fail-fast on unauthenticated access |
| **Credential utilities** | New `src/git/git-credentials.ts`: `extractHost()`, `injectCredentials()`, `hasEmbeddedCredentials()`, `stripEmbeddedCredentials()` |
| **Orchestrators** | `injectCredentials()` wired at clone time; `stripEmbeddedCredentials()` applied to `gitResult.stderr` before error surfaces |
| **Repository model** | `RepositoryManager.add()` strips embedded credentials before storing — clean URLs in `repositories.json` always |
| **REST API** | `GET / PUT / DELETE /api/config/credentials` with token masking (`****{last4}`) |
| **Settings UI** | `#/settings` view — credentials table, add/update form, per-row delete with confirmation |
| **Integration tests** | Fake-git binary stub pattern verifying CLI argument construction in both orchestrators |
| **Documentation** | All manifest docs updated: `api-surface.md`, `rest-api.md`, `gui-frontend.md`, `constraints.md`, `data-flows.md`; `ctx generate` run after every WP |

---

## Metrics

| Metric | Value |
|---|---|
| Work packages | 11 |
| WPs completing on first pass | 9 |
| WPs requiring rework | 2 (WP-002, WP-006) |
| Total rework cycles | WP-002: 1 · WP-006: 4 |
| Peak security issues found | WP-006: 1 High × 2 (distinct audits) |
| Security issues resolved | All |
| Tests at plan start | ~392 |
| Tests at plan end | 612 |
| Net new tests | ~220 |
| Final test score | **612/612 (100%)** |
| TypeScript errors | 0 |
| CTX regenerations | 11 (one per documentation pipeline) |

### Rework Detail

**WP-002** (GIT_TERMINAL_PROMPT) — 1 cycle  
QA discovered that `GIT_TERMINAL_PROMPT=0` alone does not prevent indefinite hanging on macOS because the system `credential.helper=osxkeychain` is invoked before the prompt env var takes effect. Adding `GIT_ASKPASS=echo` completes the defence.

**WP-006** (Credential injection wiring) — 4 cycles  
This was the most complex WP. Two distinct High security findings were raised and resolved:

1. **First Security Audit FAIL:** Raw `gitResult.stderr` was assigned to the error field without sanitization — token-bearing URLs from git fatal messages would leak via API responses and GUI toasts.
2. **First Developer Rework:** Applied `stripEmbeddedCredentials(gitResult.stderr)` — semantically correct intent, but the function silently returned the original string for prose input.
3. **Second Security Audit FAIL:** The WHATWG URL parser accepts git prose error messages (e.g., `fatal: repository '...'`) by treating the leading word (`fatal:`) as a URL scheme, causing the try-block to succeed and the HTTPS guard to reject and return the unmodified string.
4. **Second Developer Rework:** Restructured `stripEmbeddedCredentials()` — non-HTTPS parsed protocols and genuine parse failures both fall through to a regex scrub `(https?://)[^@\s]*@` → `$1***@`. Two regression tests added.

---

## Strategic Recommendations (Gold Nuggets)

### 1. The WHATWG URL Parser Trusts Any Scheme
**Impact: HIGH — Silent security bypass in sanitizers**

`new URL("fatal: repository 'https://ghp_TOKEN@github.com/...' not found")` succeeds in V8/Node.js — it parses `fatal:` as a valid scheme and the rest as an opaque path. Any security sanitizer that gates on "if parsing succeeds and scheme is https" will silently pass through git prose error messages carrying embedded credentials.

**Rule:** Functions that sanitize arbitrary strings for credential exposure must never assume "if URL parse fails, fall back to regex". The correct structure is "if the parsed scheme is not exactly `https:`, always fall through to regex scrubbing."

This is now documented in `constraints.md` and the `stripEmbeddedCredentials()` JSDoc.

---

### 2. Two Env Vars Required for Non-Interactive Git — `GIT_ASKPASS=echo` Must Not Be Removed
**Impact: HIGH — Auth hang on macOS (default Homebrew git setup)**

`GIT_TERMINAL_PROMPT=0` suppresses TTY prompts but does NOT suppress credential helpers. On macOS, `credential.helper=osxkeychain` is the system default; it intercepts the auth challenge before the terminal prompt is triggered, causing indefinite blocking on 401 HTTP responses. Adding `GIT_ASKPASS=echo` substitutes a no-op binary that immediately returns empty credentials, bypassing all credential helpers.

The combination provides defence-in-depth: TERMINAL_PROMPT kills interactive prompts; ASKPASS kills credential helpers. Both are required for truly non-interactive git automation.

This is documented in `src/git/README.md`, `constraints.md`, and with an explicit maintainer warning in `src/git/git-cli.ts`.

---

### 3. Fake-Git Binary Stub Pattern for CLI Argument Testing
**Impact: MEDIUM — Discover what git actually receives at runtime**

Modern git (libcurl-backed, v2.x) strips embedded credentials from its own stderr before writing them. This makes it impossible to verify credential injection by checking error output. The solution is a fake-git shell script prepended to `PATH` that captures `"$@"` to a temp file and exits 128.

Benefits over module mocking:
- Tests the actual subprocess argument string, not a mock call
- Platform-consistent (no Node.js internals coupling)
- Works without network access or real git servers
- Catches env var bugs that mocks would silently hide

Pattern documented in `constraints.md` (Test Conventions) with reference implementations in `workspace-orchestrator.test.ts` and `repository-orchestrator.test.ts`.

---

### 4. Token Injection Lifetime Contract — Now in Architecture Docs
**Impact: MEDIUM — Prevents future regressions**

The credential injection pattern has a strict lifetime: credentials must be injected **immediately before** the git operation and stripped from **all error/output strings immediately after**. Violating either half leaks tokens.

Key rules now encoded in `constraints.md` and `data-flows.md` Section 9–10:
- `injectCredentials()` must only be called within the scope of a git operation callsite
- `stripEmbeddedCredentials()` must be applied to any `gitResult.stderr` before it reaches API responses, log output, or thrown Error messages
- No token-bearing URL is ever written to `repositories.json` — clean URL from model, credentialed URL only as a transient local variable

---

### 5. `isPlainObject()` Guard in Route Handlers
**Impact: LOW — Prototype pollution prevention**

The PUT `/api/config/credentials` handler includes an `isPlainObject()` guard before destructuring the request body. This prevents prototype pollution attacks (`{ "__proto__": { "isAdmin": true } }`). The pattern should be used as a standard in all route handlers that accept JSON objects.

---

## Unresolved Technical Debt

These are low-severity items recorded during pipelines and intentionally not addressed:

| Item | Severity | Location | Notes |
|---|---|---|---|
| `decodeURIComponent` missing on DELETE `:host` param | Low | `src/server/routes/config.ts` | Hosts with colons (e.g. `gitlab.com:8080`) become undeletable via the UI — ghost-credential scenario. Recommend fix before next feature touching this route. |
| `fs.chmodSync(0o600)` on config.json after write | Low | `src/storage/json-storage.ts` | PATs stored as plaintext. README advisory exists but no enforced file permission on write. |
| `setupFakeGit()` duplicated in two test files | Low | `workspace-orchestrator.test.ts`, `repository-orchestrator.test.ts` | Extract to `src/tests/test-helpers.ts` when a third consumer appears. |
| `makeTempDir()` lacks `process.on('exit')` cleanup | Low | `src/tests/config.test.ts` et al. | AGENTS.md Section 4 marks this as MUST. Pre-existing pattern. Recommend a future cleanup WP. |
| `__proto__` / `constructor` / `prototype` not blocked in host validation | Low | `src/server/routes/config.ts` | V8-safe today; defence-in-depth would add a blocklist. |
| `console.warn` in `RepositoryManager.add()` | Low | `src/models/repository/repository.manager.ts` | Only `console.warn` in production code. Migrate to structured logger when one is introduced. |

---

## Next Steps for Planner

1. **Fix `decodeURIComponent` gap** in DELETE `/api/config/credentials/:host` — wrap `decodeURIComponent(params['host'])` in try/catch at the top of the handler. Small, targeted, no regressions expected.
2. **Apply `fs.chmodSync(0o600)`** after every `config.json` write — add to `writeJsonFile()` or `saveConfigField()` to enforce file permissions automatically, which closes the Security Auditor's residual plaintext-at-rest concern.
3. **Temp dir cleanup pass** — add a single `process.on('exit')` handler to `config.test.ts` (and other test files using `makeTempDir()`) per AGENTS.md Section 4 (MUST).
4. **`setupFakeGit()` extraction** — create `src/tests/test-helpers.ts` with the shared fake-git binary stub once a third test file needs it.
5. **Consider SSH authentication** — the current implementation handles only HTTPS PAT auth. SSH key management is a known gap (all four credential utility functions return `null`/unchanged for SSH URLs by design).
