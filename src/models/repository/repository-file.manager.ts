import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/config.types.js';
import { readJsonFile, writeJsonFile, FileNotFoundError } from '../../storage/json-storage.js';
import { NotFoundError } from '../../errors.js';
import type { BaseStore } from '../../storage/storage.types.js';
import type { RepositoryManager } from './repository.manager.js';
import { isValidKebabCase } from '../../utils/slug.js';
import { isLexicallyContained } from '../../utils/path-guard.js';
import {
    validateRepositoryFileInput,
    type RepositoryFile,
    type RepositoryFileInput,
} from './repository-file.js';

const REPOSITORY_FILES_SUBDIR = 'repository-files';
const SCHEMA_VERSION = 1;

/** Top-level shape of a per-repository `repository-files/{repoId}.json` store file. */
export interface RepositoryFileStore extends BaseStore {
    Files: RepositoryFile[];
}

const DEFAULT_STORE: RepositoryFileStore = { Files: [], SchemaVersion: SCHEMA_VERSION };

/**
 * Provides CRUD operations over the per-repository file store
 * (`{storageFolder}/repository-files/{repoId}.json`).
 *
 * Every public method is stateless — it re-reads the relevant store from disk
 * on each call so that concurrent writes from other processes are always
 * reflected. `repositories.json` is never read or written by this manager;
 * `repositoryManager` is used solely to validate that a given repository ID
 * exists before touching its file store.
 */
export class RepositoryFileManager {
    private readonly storeDir: string;

    constructor(
        private readonly config: AppConfig,
        private readonly repositoryManager: RepositoryManager,
    ) {
        this.storeDir = path.join(config.storageFolder, REPOSITORY_FILES_SUBDIR);
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private storeFilePath(repoId: string): string {
        return path.join(this.storeDir, `${repoId}.json`);
    }

    private load(repoId: string): RepositoryFileStore {
        try {
            return readJsonFile<RepositoryFileStore>(this.storeFilePath(repoId));
        } catch (err) {
            if (err instanceof FileNotFoundError) {
                // Spread DEFAULT_STORE and override Files with a fresh array so
                // that callers pushing to store.Files cannot accidentally mutate
                // the module-level constant across calls.
                return { ...DEFAULT_STORE, Files: [] };
            }
            throw err;
        }
    }

    private save(repoId: string, store: RepositoryFileStore): void {
        // `writeJsonFile` creates the `repository-files/` directory lazily.
        writeJsonFile(this.storeFilePath(repoId), store);
    }

    private now(): string {
        return new Date().toISOString();
    }

    private assertRepositoryExists(repoId: string, operationLabel: string): void {
        if (!this.repositoryManager.exists(repoId)) {
            throw new NotFoundError(`Cannot ${operationLabel}: repository with ID "${repoId}" does not exist.`);
        }
    }

    /**
     * Shared `load → findIndex → NotFoundError → mutate → save` sequence used
     * by `update()` and `remove()`.
     *
     * `fn` receives the existing file record and the full store (the latter so
     * a mutator can run the case-insensitive path-uniqueness check against
     * `store.Files` before returning the replacement record, inside the same
     * load/save cycle) and returns either the replacement record to persist in
     * its place, or `null` to delete it.
     *
     * @param repoId         The repository ID whose file store to mutate.
     * @param fileId         The file ID to mutate.
     * @param operationLabel Short, lowercase phrase describing the operation,
     *                       interpolated into the `NotFoundError` message as
     *                       `Cannot ${operationLabel}: ...`.
     * @param fn             Produces the replacement record, or `null` to remove it.
     *
     * @throws {NotFoundError} If the repository does not exist, or no file with
     *   the given ID exists in its store.
     */
    private mutate(
        repoId: string,
        fileId: string,
        operationLabel: string,
        fn: (existing: RepositoryFile, store: RepositoryFileStore) => RepositoryFile | null,
    ): RepositoryFile | null {
        this.assertRepositoryExists(repoId, operationLabel);

        const store = this.load(repoId);
        const index = store.Files.findIndex((f) => f.Id === fileId);

        if (index === -1) {
            throw new NotFoundError(`Cannot ${operationLabel}: file "${fileId}" does not exist in repository "${repoId}".`);
        }

        const result = fn(store.Files[index], store);
        if (result === null) {
            store.Files.splice(index, 1);
        } else {
            store.Files[index] = result;
        }
        this.save(repoId, store);
        return result;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Returns the repository's files (empty array when none).
     *
     * @throws {NotFoundError} If the repository does not exist.
     */
    list(repoId: string): RepositoryFile[] {
        this.assertRepositoryExists(repoId, 'list files');
        return this.load(repoId).Files;
    }

    /**
     * Returns a single file by ID.
     *
     * @throws {NotFoundError} If the repository does not exist, or no file with
     *   the given ID exists in its store.
     */
    get(repoId: string, fileId: string): RepositoryFile {
        this.assertRepositoryExists(repoId, 'get file');
        const file = this.load(repoId).Files.find((f) => f.Id === fileId);
        if (!file) {
            throw new NotFoundError(`Cannot get file: file "${fileId}" does not exist in repository "${repoId}".`);
        }
        return file;
    }

    /**
     * Adds a file. Input is validated and normalised via
     * `validateRepositoryFileInput()`.
     *
     * @throws {NotFoundError} If the repository does not exist.
     * @throws {Error} If validation fails (message is user-presentable),
     *   including the 64-file count limit and the case-insensitive path
     *   uniqueness check.
     */
    add(repoId: string, input: RepositoryFileInput): RepositoryFile {
        this.assertRepositoryExists(repoId, 'add file');

        const store = this.load(repoId);
        const valid = validateRepositoryFileInput(input, store.Files);
        const now = this.now();
        const file: RepositoryFile = { Id: randomUUID(), ...valid, DateModified: now };

        store.Files = [...store.Files, file];
        this.save(repoId, store);
        return file;
    }

    /**
     * Replaces the editable fields of a file.
     *
     * @returns The previous and updated definitions, so the caller can clean
     *   up the old on-disk path when the location changed.
     * @throws {NotFoundError} If the repository does not exist, or no file with
     *   the given ID exists in its store.
     * @throws {Error} If validation fails. The case-insensitive path-uniqueness
     *   check runs against the store's other files inside the same load/save
     *   cycle as the rest of the mutation (via the shared `mutate()` helper).
     */
    update(repoId: string, fileId: string, input: RepositoryFileInput): { previous: RepositoryFile; updated: RepositoryFile } {
        let previous!: RepositoryFile;

        const updated = this.mutate(repoId, fileId, 'update file', (existing, store) => {
            previous = existing;
            const others = store.Files.filter((f) => f.Id !== fileId);
            const valid = validateRepositoryFileInput(input, others);
            return { Id: fileId, ...valid, DateModified: this.now() };
        });

        // `mutate()` only returns `null` when `fn` itself returns `null`, which
        // this callback never does — `updated` is always a `RepositoryFile` here.
        return { previous, updated: updated as RepositoryFile };
    }

    /**
     * Removes a file definition and returns it, so the caller can delete its
     * copy from the managed clone.
     *
     * @throws {NotFoundError} If the repository does not exist, or no file with
     *   the given ID exists in its store.
     */
    remove(repoId: string, fileId: string): RepositoryFile {
        let removed!: RepositoryFile;
        this.mutate(repoId, fileId, 'remove file', (existing) => {
            removed = existing;
            return null;
        });
        return removed;
    }

    /**
     * Replaces the entire file list for a repository in one write, used by
     * the import flow after a diff has been resolved. No per-field validation
     * is performed — callers are responsible for ensuring `files` is already
     * consistent (unique paths, size limits, etc.) before calling this method.
     *
     * @throws {NotFoundError} If the repository does not exist.
     */
    replaceAll(repoId: string, files: RepositoryFile[]): void {
        this.assertRepositoryExists(repoId, 'replace files');
        const store = this.load(repoId);
        store.Files = files;
        this.save(repoId, store);
    }

    /**
     * Deletes the repository's file store (`repository-files/{repoId}.json`),
     * used by the repository deletion cascade. A no-op when the store file
     * does not exist. Does not check whether the repository itself still
     * exists in `repositories.json` — the deletion cascade calls this during
     * or after removing the repository record.
     *
     * Unlike every other method, this one intentionally skips
     * `assertRepositoryExists()` (see the class docs), which is exactly what
     * every other method relies on to guarantee `repoId` is a
     * `isValidKebabCase()` value already persisted in `repositories.json` —
     * without that guarantee, an attacker-influenced `repoId` such as
     * `"../../../../some/other/store"` would resolve outside
     * `repository-files/` and delete an arbitrary `.json` file. `removeStore()`
     * therefore validates the format itself and, as a second, independent
     * layer, confirms the resolved path stays lexically contained under
     * `repository-files/` before ever touching the filesystem. Either check
     * failing is treated as a no-op (matching the "no-op when absent"
     * contract) rather than thrown, since a cascade caller has no further
     * action to take on a malformed ID.
     */
    removeStore(repoId: string): void {
        if (!isValidKebabCase(repoId)) {
            return;
        }

        const filePath = this.storeFilePath(repoId);
        if (!isLexicallyContained(path.resolve(filePath), path.resolve(this.storeDir))) {
            return;
        }

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
}
