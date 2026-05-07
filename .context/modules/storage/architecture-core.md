# Storage - Architecture
_SOURCE: Storage types and JSON file operations_
# Storage types and JSON file operations
```
// Structure of documents
└── src/
    └── storage/
        └── json-storage.ts
        └── storage.types.ts

```
###  Path: `/src/storage/json-storage.ts`

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import type { RepositoryStore } from '../models/repository/repository.types.js';
import type { ProjectIndex } from '../models/project/project.types.js';
import type { ErrorLogStore } from '../error-log/error-log.types.js';

/**
 * Thrown by `readJsonFile` when the specified file does not exist.
 * Catch by `instanceof FileNotFoundError` rather than string-matching the error message.
 */
export class FileNotFoundError extends Error {
    readonly filePath: string;
    constructor(filePath: string) {
        super(`File not found: "${filePath}"`);
        this.name = 'FileNotFoundError';
        this.filePath = filePath;
        // Ensure instanceof checks work correctly across module boundaries.
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Reads and parses a JSON file, returning the content as the specified type.
 * Throws a descriptive error if the file is missing or contains malformed JSON.
 *
 * **Type safety:** The return value is an unchecked cast — the JSON is parsed
 * and the result is assumed to conform to `T` without runtime validation.
 * If the file may have been hand-edited or comes from an untrusted source,
 * callers are responsible for validating the returned value (e.g., via a
 * type guard or schema validator) before relying on its structure.
 */
export function readJsonFile<T>(filePath: string): T {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new FileNotFoundError(filePath);
        }
        throw new Error(`Failed to read file "${filePath}": ${(err as Error).message}`);
    }

    try {
        return JSON.parse(raw) as T;
    } catch (err) {
        throw new Error(`Failed to parse JSON in "${filePath}": ${(err as Error).message}`);
    }
}

/**
 * Serialises data as JSON with 4-space indentation and a trailing newline,
 * then writes it to the specified file path. Parent directories are created
 * automatically if they do not exist.
 */
export function writeJsonFile<T>(filePath: string, data: T): void {
    ensureDirectory(path.dirname(filePath));
    const content = JSON.stringify(data, null, 4) + '\n';
    fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Creates the specified directory tree recursively.
 * Silent (no-op) if the directory already exists.
 * Throws a descriptive error if a path component already exists as a file.
 */
export function ensureDirectory(dirPath: string): void {
    try {
        fs.mkdirSync(dirPath, { recursive: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') {
            throw new Error(
                `Cannot create directory "${dirPath}": a path component already exists as a file.`
            );
        }
        throw err;
    }
}

/**
 * Creates the required directory structure and seed files for the application.
 * Safe to call multiple times — existing directories and files are not modified.
 *
 * Creates:
 * - `{storageFolder}/`
 * - `{storageFolder}/projects/`
 * - `{projectsFolder}/`
 * - `{storageFolder}/repositories.json` (empty store with SchemaVersion: 1)
 * - `{storageFolder}/projects-index.json` (empty index with SchemaVersion: 1)
 * - `{storageFolder}/error-log.json` (empty error log with SchemaVersion: 1)
 */
export function initializeStorage(config: AppConfig): void {
    ensureDirectory(config.storageFolder);
    ensureDirectory(path.join(config.storageFolder, 'projects'));
    ensureDirectory(config.projectsFolder);

    seedJsonFile<RepositoryStore>(
        path.join(config.storageFolder, 'repositories.json'),
        { Repositories: [], SchemaVersion: 1 },
    );

    seedJsonFile<ProjectIndex>(
        path.join(config.storageFolder, 'projects-index.json'),
        { Projects: [], SchemaVersion: 1 },
    );

    seedJsonFile<ErrorLogStore>(
        path.join(config.storageFolder, 'error-log.json'),
        { Entries: [], SchemaVersion: 1 },
    );
}

/**
 * Writes a JSON file with the given default data only if it does not already exist.
 */
function seedJsonFile<T>(filePath: string, defaultData: T): void {
    if (!fs.existsSync(filePath)) {
        writeJsonFile<T>(filePath, defaultData);
    }
}

```
###  Path: `/src/storage/storage.types.ts`

```ts
/**
 * Numeric schema version tag attached to every persisted JSON store file,
 * enabling forward-compatible migration logic in future releases.
 *
 * @see BaseStore.SchemaVersion for the versioning policy that governs when
 * this value must be incremented.
 */
export type SchemaVersion = number;

/**
 * Base interface for all JSON store files. Every persisted store includes a
 * `SchemaVersion` field for forward-compatible migration logic.
 */
export interface BaseStore {
    /**
     * Monotonically incrementing integer that tracks structural changes to the
     * persisted JSON shape.
     *
     * **Versioning policy:**
     * - Adding an **optional** field is backward-compatible — existing JSON
     *   files that lack the field are still valid. Do **not** bump
     *   `SCHEMA_VERSION` for these changes.
     * - **Do** bump `SCHEMA_VERSION` (and add a migration step) when making a
     *   breaking change: removing a required field, renaming a field, or
     *   changing the type of an existing field in a way that would cause older
     *   JSON files to fail validation or produce incorrect behaviour.
     */
    SchemaVersion: SchemaVersion;
}

```
---
**File Statistics**
- **Size**: 5.9 KB
- **Lines**: 176
File: `modules/storage/architecture-core.md`
