# Storage - Overview
```
// Structure of documents
└── src/
    └── storage/
        └── README.md

```
###  Path: `/src/storage/README.md`

```md
# Storage Layer

Low-level JSON file persistence primitives. Provides typed read/write operations and storage directory initialization.

## Key Concepts

- **BaseStore**: Every JSON store has a `SchemaVersion` field for future migration support.
- **Atomic writes**: `writeJsonFile()` serializes objects to JSON with consistent formatting.
- **Initialization**: `initializeStorage()` creates the storage directory structure and seed files on first run.

## Integration Points

- **Dependencies**: None (uses Node.js `fs` only).
- **Consumed by**: Models layer (RepositoryManager, ProjectManager).

```
---
**File Statistics**
- **Size**: 861 B
- **Lines**: 33
File: `modules/storage/overview.md`
