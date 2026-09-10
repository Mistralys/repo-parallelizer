# Configuration - Overview
```
// Structure of documents
└── src/
    └── config/
        └── README.md

```
###  Path: `/src/config/README.md`

```md
# Configuration Module

Loads and validates the application configuration from a `config.json` file on disk.

## Key Concepts

- **AppConfig**: The central configuration interface that all other modules depend on. Contains paths for project storage, clone depth, server port, polling interval, and optional git credentials.
- **Config file**: A `config.json` file at the tool root, created from `config.dist.json`. Not committed to version control. On POSIX systems, `saveConfigField()` automatically applies `chmod 600` to `config.json` after every write to restrict read/write access to the file owner. On Windows no equivalent permission restriction is applied — ensure the file is stored in a location not accessible to other users.
- **Defaults**: Missing optional fields are filled with sensible defaults (clone depth: 50, server port: 4200, polling interval: 30s).
- **gitCredentials**: Optional `GitCredentialEntry[]` array. Each entry carries `id` (unique kebab-case identifier), `label` (display name), `host` (hostname), and `token` (PAT or password). Absent, `null`, or the legacy empty object `{}` → treated as no credentials (public-repo-only mode). An explicit empty array `[]` → credentials explicitly set to empty (same runtime effect, but the field is considered *present*). Validated on load — see [Parsing and migration](#parsing-and-migration).
- **saveConfigField caller guard**: `saveConfigField(field, value)` does not validate the `field` parameter. Any HTTP route handler or external caller that passes user-supplied input for `field` **must** guard it against an explicit allowlist before calling the function.
- **_defaultsCoverageGuard**: A compile-time completeness guard defined immediately after the `DEFAULTS` constant (lines 37–42). It constructs a full `AppConfig` value from `DEFAULTS` plus the two required fields. The `satisfies AppConfig` clause causes TypeScript to emit a type error at that exact line if a new required-or-defaulted `AppConfig` field is added without a corresponding entry in `DEFAULTS`. This catches silent runtime omissions at compile time — do not remove it.

## Parsing and migration

`parseGitCredentials()` is the internal parser for the `gitCredentials` config field. It handles three distinct cases:

| Input | Result |
|---|---|
| `undefined` / `null` / absent | `undefined` — no credentials configured |
| Legacy object `{}` (empty) | `undefined` — treated identically to absent |
| Legacy object `{ "github.com": "token" }` | Auto-migrated to `GitCredentialEntry[]` — hostname becomes `label` and `host`; `id` is derived from the hostname in kebab-case |
| Array `[]` (empty) | `[]` — credentials explicitly set to an empty list |
| Array `[{ id, label, host, token }]` | Validated and returned as-is |

**The `{}` vs `[]` distinction:** An absent field and the legacy empty object both produce `undefined`. An explicit empty array `[]` produces `[]`. Consumers that check `config.gitCredentials !== undefined` will see different results: the empty-array case passes the check while the absent/`{}`  case does not. This asymmetry is intentional — `{}` represents the old "no credentials" state from before the array format was introduced, while `[]` explicitly declares that credentials are managed but currently empty.

**Collision handling:** When two legacy hostnames produce the same kebab-case ID (e.g. `github.com` and `github-com` both → `github-com`), a numeric suffix is appended to disambiguate: `github-com`, `github-com-2`, `github-com-3`, …

**Migration is idempotent:** Re-parsing an already-migrated `GitCredentialEntry[]` returns the same array unchanged.

**Validation errors in legacy format entries** report a 1-based positional index rather than the hostname — for example: `Configuration error: gitCredentials entry #1 (legacy format) must have a string value, got number.` This avoids exposing infrastructure hostnames in error messages or logs.

## Integration Points

- **Consumed by**: Models (RepositoryManager, ProjectManager), Orchestrators, Server — all receive `AppConfig` via constructor injection.
- **Load point**: Called once at startup from the CLI entry point (`src/index.ts`) or server bootstrap.

```
---
**File Statistics**
- **Size**: 1.71 KB
- **Lines**: 35
File: `modules/config/overview.md`
