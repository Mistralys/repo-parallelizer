# Utilities

Shared helper functions used across all layers.

## Files

| File | Responsibility |
|---|---|
| `paths.ts` | Path resolution: tool root, config path, project/workspace folder computation |
| `slug.ts` | Slug generation and validation: `toKebabCase()`, `isValidKebabCase()`, `inferSlugFromUrl()`, `isValidWorkspaceId()` |

## Integration Points

- **Consumed by**: Models, Orchestration, Git, Server layers.
