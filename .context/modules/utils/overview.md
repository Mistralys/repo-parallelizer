# Utilities - Overview
```
// Structure of documents
└── src/
    └── utils/
        └── README.md

```
###  Path: `/src/utils/README.md`

```md
# Utilities

Shared helper functions used across all layers.

## Files

| File | Responsibility |
|---|---|
| `paths.ts` | Path resolution: tool root, config path, project/workspace folder computation |
| `slug.ts` | Slug generation and validation: `toKebabCase()`, `isValidKebabCase()`, `inferSlugFromUrl()`, `isValidWorkspaceId()` |

## Integration Points

- **Consumed by**: Models, Orchestration, Git, Server layers.

```
---
**File Statistics**
- **Size**: 681 B
- **Lines**: 33
File: `modules/utils/overview.md`
