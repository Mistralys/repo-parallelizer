# AGENTS.md — repo-parallelizer

> **Read this file first.** It tells you how to operate in this codebase.

---

## 1. Project Manifest — Start Here

**Location:** `docs/agents/project-manifest/`

| Document | Purpose |
|---|---|
| [README.md](docs/agents/project-manifest/README.md) | Manifest index — lists all documents. |
| [tech-stack.md](docs/agents/project-manifest/tech-stack.md) | Runtime, language, frameworks, build tools, architectural patterns. |
| [file-tree.md](docs/agents/project-manifest/file-tree.md) | Annotated directory structure. |
| [api-surface.md](docs/agents/project-manifest/api-surface.md) | All exported types, classes, and function signatures. |
| [data-flows.md](docs/agents/project-manifest/data-flows.md) | Key interaction paths through the system. |
| [constraints.md](docs/agents/project-manifest/constraints.md) | Conventions, validation rules, security, test patterns. |
| [rest-api.md](docs/agents/project-manifest/rest-api.md) | HTTP endpoints with methods, paths, and response shapes. |
| [gui-frontend.md](docs/agents/project-manifest/gui-frontend.md) | SPA architecture, routes, components, patterns. |

### Quick Start Workflow

1. **Read** `tech-stack.md` — understand the runtime, language, and architecture.
2. **Scan** `file-tree.md` — know where everything lives.
3. **Internalize** `constraints.md` — learn the rules before writing code.
4. **Reference** `api-surface.md` and `rest-api.md` — understand what already exists.
5. **Only then** read source files for implementation details.

---

## 2. Manifest Maintenance Rules

When you change the codebase, update the corresponding manifest documents.

| Change Made | Documents to Update |
|---|---|
| New source file or directory added | `file-tree.md` |
| Directory restructured or files moved | `file-tree.md` |
| Exported type, interface, class, or function added/modified | `api-surface.md` |
| Dependency added or removed | `tech-stack.md` |
| Build script or tooling changed | `tech-stack.md` |
| New REST endpoint added/modified | `rest-api.md` |
| New GUI route, view, or component added | `gui-frontend.md` |
| Convention or constraint established/changed | `constraints.md` |
| Startup sequence or data flow changed | `data-flows.md` |
| Storage schema or file layout changed | `data-flows.md` |

---

## 3. Efficiency Rules — Search Smart

- **Finding a file?** Check `file-tree.md` FIRST.
- **Understanding a method or type?** Check `api-surface.md` FIRST.
- **Implementation patterns or tech decisions?** Check `tech-stack.md` FIRST.
- **Looking for an endpoint?** Check `rest-api.md` FIRST.
- **GUI routing or component?** Check `gui-frontend.md` FIRST.
- **Only then** read source files.

Do not scan the `src/` tree looking for a function when the manifest already lists every export.

---

## 4. Failure Protocol & Decision Matrix

| Scenario | Action | Priority |
|---|---|---|
| Ambiguous requirement | Use most restrictive interpretation. | MUST |
| Manifest/code conflict | Trust manifest, flag code for fix. | MUST |
| Missing documentation | Flag gap, do not invent facts. | MUST |
| Untested code path | Proceed with caution, add test recommendation. | SHOULD |
| Relative import without `.js` extension | Fix immediately — this is a compile + runtime error. | MUST |
| Adding a GUI view | Follow router injection and cleanup contract patterns in `gui-frontend.md`. | MUST |
| Test creates temp files | Register `process.on('exit')` cleanup handler. | MUST |
| New exported type in a work package | Run type audit against plan before marking complete. | MUST |
| STABLE workspace targeted for rename/delete | Reject — the STABLE invariant is enforced at the storage layer. | MUST |
| Passing untrusted input to git branch functions | Validate against `'-'` prefix and safe refname patterns first. | SHOULD |

---

## 5. Project Stats

| Item | Value |
|---|---|
| **Language** | TypeScript 5.4+ (strict mode) |
| **Runtime** | Node.js >= 18 |
| **Architecture** | Layered: Storage → Models → Git → Orchestration → Server/CLI |
| **Module system** | Node16 ESM (`.js` extensions in all relative imports) |
| **Package manager** | npm >= 9 |
| **Test framework** | Node.js built-in test runner (`node --test`) |
| **Build tool** | `tsc` (TypeScript compiler) |
| **Runtime dependencies** | `picocolors` (terminal colors) — vetted for zero transitive deps |
| **Frontend** | Vanilla JS SPA, hash-based routing, no build step |
| **CLI binary** | `paralizer` (via `npm link`) |
