# Utilities

Shared helper functions used across all layers.

## Files

| File | Responsibility |
|---|---|
| `paths.ts` | Path resolution: tool root, config path, project/workspace folder computation |
| `slug.ts` | Slug generation and validation: `toKebabCase()`, `isValidKebabCase()`, `inferSlugFromUrl()`, `isValidWorkspaceId()` |
| `path-guard.ts` | Shared filesystem path-containment and symlink-escape guards (lexical containment → realpath symlink-escape → directory-shape), extracted from `workspace-index.ts`'s original write-guard chain so every writer that targets a bounded root — generated index files, `custom-files.ts`'s workspace-folder writer, `repository-files.ts`'s managed-main-folder writer (Milestone 2), and `repository-orchestrator.ts`'s clone-folder delete guard — shares one hardened implementation instead of re-deriving it. Also exposes the composite `guardedFileTarget()`/`pruneEmptyParents()` helpers used by the two file writers above. |
| `version.ts` | `getToolVersion()` — reads the tool's own `version` field from its `package.json` via `getToolRoot()`; returns `'unknown'` rather than throwing when the file is missing/unreadable/malformed. |

## Integration Points

- **Consumed by**: Models, Orchestration, Git, Server layers.
