# Project Synthesis Report — Phase 6: GUI Frontend

**Plan:** `2026-04-03-phase6-gui-frontend`  
**Report Date:** 2026-04-07  
**Project Status:** COMPLETE  
**Total Work Packages:** 17 (8 COMPLETE · 9 CANCELLED)

---

## Executive Summary

Phase 6 delivered a fully functional, vanilla-JavaScript browser-based GUI for the repo-parallelizer tool. The frontend is a single-page application (SPA) served directly by the existing Node.js HTTP server — no build tools, no framework, no dependencies.

**What was built:**

| Component | File(s) | Description |
|---|---|---|
| SPA shell | `gui/public/index.html` | HTML5 entry point, nav, `#app` mount point, toast container |
| Design system | `gui/public/css/styles.css` | ~842-line CSS with custom properties, all status badges, animations |
| Hash router | `gui/public/js/router.js` | `Router` class — `register()`, `navigate()`, `start()`, `stop()`, view cleanup callbacks |
| API client | `gui/public/js/api.js` | 23 methods across 5 namespaces (repositories, projects, workspaces, branches, status) |
| Confirm dialog | `gui/public/js/components/confirm-dialog.js` | Promise-based modal with ARIA roles and 3 cancellation paths |
| Status badge | `gui/public/js/components/status-badge.js` | Priority-ordered git status pill (conflict > modified > ahead > behind > clean) |
| Toast notifications | `gui/public/js/components/toast.js` | Auto-dismissing stacking toasts with double-dismiss guard |
| Form helpers | `gui/public/js/components/form-helpers.js` | `createFormField()`, `validateRequired()`, `WORKSPACE_ID_PATTERN` |
| Dashboard view | `gui/public/js/views/dashboard.js` | Project grid with repo/workspace counts and Create Project form |
| Repositories view | `gui/public/js/views/repositories.js` | Full CRUD table — inline edit, delete with confirmation, add form |
| Project Detail view | `gui/public/js/views/project-detail.js` | Repos, workspaces, inline desc edit, rename/delete with navigation |
| Workspace Detail view | `gui/public/js/views/workspace-detail.js` | Status table with live 10-second polling, in-place badge updates |
| Branch Switch wizard | `gui/public/js/views/branch-switch.js` | 3-step wizard: choose branch → per-repo assignment → results |
| CLI wiring | `src/index.ts` | Entry point now calls `startServer()` — the GUI is live on startup |

The original plan included 9 additional work packages (WP-002 through WP-010) that were cancelled as redundant or superseded by the revised WP numbering scheme (WP-011 through WP-017 covered the same scope with an adjusted dependency graph).

---

## Metrics

### Test Coverage

| Work Package | QA Tests | Backend Regressions | Result |
|---|---|---|---|
| WP-001 — SPA Shell & Router | — (logic-verified) | 517 | ✅ PASS |
| WP-011 — API Client & Components | 73 | 517 | ✅ PASS |
| WP-012 — CLI Server Wiring | — (E2E smoke tests) | 517 | ✅ PASS |
| WP-013 — Dashboard View | 54 | 517 | ✅ PASS |
| WP-014 — Project Detail View | 53 | 517 | ✅ PASS |
| WP-015 — Repositories View | 45 | 517 | ✅ PASS |
| WP-016 — Workspace Detail View | 61 | 517 | ✅ PASS |
| WP-017 — Branch Switch Wizard | — (static analysis + runtime) | 517 | ✅ PASS |

**Total targeted GUI tests:** 286 (73 + 54 + 53 + 45 + 61)  
**Backend regression tests:** 517 — zero failures across all WPs  
**Security issues (Critical/High):** 0  
**Pipeline stages completed with PASS:** All active stages across all 8 completed WPs

### Security Audit Summary (WP-011 & WP-012)

- **0 Critical, 0 High** findings across both audited WPs
- **2 Medium** findings noted (server binds to `0.0.0.0` instead of `127.0.0.1`; no security response headers) — neither was blocking; both are tracked architectural notes
- **Positive finding:** All frontend files use `.textContent` exclusively for DOM text insertion — zero XSS surfaces identified
- All URL path segments encoded with `encodeURIComponent()` throughout

---

## Strategic Recommendations (Gold Nuggets)

### 1. 🔴 Bind the HTTP server to `127.0.0.1` (Medium Priority)

> *Raised by: Security Auditor, WP-012*

The server currently binds to all interfaces (`0.0.0.0`). Any machine on the same network can reach the API, which exposes filesystem paths, repository names, workspace IDs, and branch-switch operations without any authentication. For a local developer tool this is low-exploitation risk today, but the fix is a one-liner:

```ts
server.listen(port, '127.0.0.1', () => { ... })
```

If LAN access is a deliberate product requirement, document it clearly.

### 2. 🟡 Add Security Response Headers (Medium Priority)

> *Raised by: Security Auditor, WP-012*

No `X-Content-Type-Options`, `X-Frame-Options`, or `Content-Security-Policy` headers are set. Minimum recommended additions:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- A restrictive `default-src 'self'` CSP on HTML responses

These are a single middleware addition in `src/server/staticServer.ts`.

### 3. 🟡 Extract `normalise.js` Utility Module (Medium Priority)

> *Raised by: Reviewer (project-level comment), Reviewers on WP-014 and WP-015*

`normaliseRepo()` is duplicated verbatim in both `repositories.js` and `project-detail.js`. As the view layer grows, each new view will be tempted to create a third copy. The suggested location is already documented in the README:

```
gui/public/js/utils/normalise.js
```

This should host `normaliseRepo()`, `normaliseProject()`, `normaliseWorkspace()`, and any future per-entity normalisers. **Recommendation: extract before adding a fourth or fifth view.**

### 4. 🟡 Add `type` Allowlist Guard to `showToast()` (Low/Medium Priority)

> *Raised by: Security Auditor and Reviewer, WP-011*

`showToast()` interpolates the caller-supplied `type` parameter directly into a CSS class string with no validation. The fix is a one-liner:

```js
const VALID_TYPES = new Set(['success', 'error', 'info', 'warning']);
const safeType = VALID_TYPES.has(type) ? type : 'info';
```

Currently safe in all call sites, but a defence-in-depth improvement before the call surface widens.

### 5. 🟢 CSS.escape() Portability in `form-helpers.js` (Low Priority)

> *Raised by: Developer, QA, Security Auditor, WP-011*

`validateRequired()` uses `CSS.escape()` to safely interpolate field names into `querySelector` selectors — correct and XSS-safe in browsers. However, it fails in `jsdom` (test environments) and is absent in IE11. A runtime-portable inline fallback resolves both concerns without adding a dependency:

```js
const esc = typeof CSS !== 'undefined' && CSS.escape
  ? CSS.escape
  : (s) => s.replace(/([^\w-])/g, '\\$1');
```

### 6. 🟢 Move `toast-close` Inline Styles to CSS (Low Priority)

> *Raised by: Developer, QA, Security Auditor, Reviewer, WP-011*

The close button in `toast.js` applies `marginLeft`, `fontSize`, and `lineHeight` as inline `style` properties. The button already has a `.toast-close` class — moving these three rules to `styles.css` would make them themeable and eliminate the inline style surface.

### 7. 🟢 Async View Cleanup in `router.js` (Low Priority)

> *Raised by: Reviewer, WP-001*

`router.js`'s `_render()` method stores cleanup callbacks returned synchronously by view functions. If a future view is `async` and returns a `Promise<cleanup>`, the cleanup will not be registered. This is not a concern for any current views (all sync), but should be documented or addressed before async views are written.

---

## Known Technical Debt

| Item | Location | Priority | Notes |
|---|---|---|---|
| `normaliseRepo()` duplication | `repositories.js` + `project-detail.js` | Medium | Extract to `utils/normalise.js` before a 3rd view copies it |
| Server binds `0.0.0.0` | `src/server/index.ts` | Medium | Restrict to `127.0.0.1` for local-only use |
| Missing security headers | `src/server/staticServer.ts` | Medium | Add at minimum `X-Content-Type-Options` + `X-Frame-Options` |
| No focus trap in confirm-dialog | `confirm-dialog.js` | Low | Tab can escape modal — acceptable for internal tool |
| Hard-coded ARIA IDs in confirm-dialog | `confirm-dialog.js` | Low | Concurrent dialogs would have duplicate IDs |
| `showToast()` type not allowlist-validated | `toast.js` | Low | One-liner fix; no current exploit path |
| `CSS.escape()` browser-only | `form-helpers.js` | Low | Inline polyfill resolves test-env + IE11 portability |
| `toast-close` inline styles | `toast.js` | Low | Move to `styles.css` `.toast-close` rule |
| Workspace ID regex duplicated | `workspace-detail.js` + `project-detail.js` | Low | `WORKSPACE_ID_PATTERN` already exported from `form-helpers.js`; verify all callers import from there |
| `updateStatusTable()` misses repos added post-load | `workspace-detail.js` | Low | Polling only refreshes repos present at initial render time |
| Step 2 silent empty-input fallback | `branch-switch.js` | Low | Silent revert to `chosenBranch` may surprise users |
| No active nav-link highlighting | `index.html` / `app.js` | Low | `.nav-link.active` CSS class exists but never set |
| API always sends `Content-Type: application/json` on GET/DELETE | `api.js` | Low | Harmless but non-conventional |
| Raw request body echoed in JSON parse errors | `src/server/requestUtils.ts` | Low | First 120 chars of invalid body are reflected back |
| No audit log for mutating API calls | `src/server/index.ts` | Low | Relevant if tool is ever network-exposed |

---

## Next Steps for Planner / Manager

1. **Immediate (before next feature WP):** Restrict server bind address to `127.0.0.1` — single-line change with security value.
2. **Short-term refactor WP:** Extract `normalise.js` before the view count grows further. This is the highest-leverage code-quality improvement.
3. **Security headers WP:** Add `X-Content-Type-Options`, `X-Frame-Options`, and a basic CSP to the static file server middleware. Low effort, meaningful security posture improvement.
4. **GUI component polish pass:** Address the toast allowlist guard, CSS.escape polyfill, and toast-close CSS class in a single small WP — all are one-liners.
5. **Active nav-link highlighting:** Set `.nav-link.active` on the current route's anchor during navigation — purely cosmetic but improves UX.
6. **Manual E2E test pass:** The Branch Switch wizard (WP-017) was validated via static analysis and backend regression tests. A live browser walkthrough against a real backend should be performed before the first production release.
7. **Consider a `gui/public/package.json` with `"type": "module"`** to silence `MODULE_TYPELESS_PACKAGE_JSON` Node.js warnings in the test environment.

---

## Documentation Produced This Session

All documentation was produced inline with each work package — no separate documentation WP was required.

| Document | Additions |
|---|---|
| `README.md` | Full GUI Frontend section: architecture tree, route registry, API client reference (all 5 namespaces), component docs (confirm-dialog, status-badge, toast, form-helpers), Dashboard view, Repositories view, Project Detail view, Workspace Detail view, Branch Switch Wizard section, normalisation helpers note |
| `CONTRIBUTING.md` | `setRouter()` DI pattern with worked example, cleanup contract pattern with code example |
| `gui/public/js/router.js` | JSDoc trailing-slash behaviour note |
| `gui/public/js/app.js` | WP-ownership labels on route stubs (historical) |
| `gui/public/js/api.js` | `@typedef ProjectResponse` documenting dual-casing contract |
| `gui/public/js/views/project-detail.js` | Module-level JSDoc: refresh strategy, data-fetching, router injection |
| `gui/public/js/views/branch-switch.js` | JSDoc on `outcomeClass()`/`outcomeLabel()`, inline comment on Step 2 silent fallback |
| `src/index.ts` | Full AppConfig required-fields enumeration in JSDoc, `__dirname` CJS explanation comment |
| `src/server/index.ts` | Singleton design constraint documentation for test authors |

---

*Report generated by Head of Operations (Synthesis Agent) — Phase 6 GUI Frontend*
