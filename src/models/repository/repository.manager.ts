import * as path from 'path';
import type { AppConfig } from '../../config/config.types.js';
import { readJsonFile, writeJsonFile, FileNotFoundError } from '../../storage/json-storage.js';
import { inferSlugFromUrl, isValidKebabCase } from '../../utils/slug.js';
import { NotFoundError } from '../../errors.js';
import type { Repository, RepositoryStore } from './repository.types.js';

const REPOSITORIES_FILE = 'repositories.json';

const DEFAULT_STORE: RepositoryStore = { Repositories: [], SchemaVersion: 1 };

/**
 * Strips embedded credentials from a URL before interpolation into error
 * messages. Replaces `//user:pass@` or `//token@` with `//***@`.
 */
function redactUrl(url: string): string {
    return url.replace(/\/\/[^@]+@/, '//***@');
}

/**
 * Provides CRUD operations over the persisted repositories store.
 *
 * Every public method is stateless — it re-reads the store from disk on each
 * call so that concurrent writes from other processes are always reflected.
 */
export class RepositoryManager {
    private readonly filePath: string;

    constructor(config: AppConfig) {
        this.filePath = path.join(config.storageFolder, REPOSITORIES_FILE);
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private load(): RepositoryStore {
        try {
            return readJsonFile<RepositoryStore>(this.filePath);
        } catch (err) {
            if (err instanceof FileNotFoundError) {
                // Spread DEFAULT_STORE and override Repositories with a fresh array
                // so that callers pushing to store.Repositories cannot accidentally
                // mutate the module-level constant across calls.
                return { ...DEFAULT_STORE, Repositories: [] };
            }
            throw err;
        }
    }

    private save(store: RepositoryStore): void {
        writeJsonFile(this.filePath, store);
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Returns all repositories in the store.
     */
    list(): Repository[] {
        return this.load().Repositories;
    }

    /**
     * Returns the repository with the given ID, or `undefined` if not found.
     */
    getById(id: string): Repository | undefined {
        return this.load().Repositories.find((r) => r.Id === id);
    }

    /**
     * Returns `true` when a repository with the given ID exists in the store.
     */
    exists(id: string): boolean {
        return this.getById(id) !== undefined;
    }

    /**
     * Adds a new repository to the store.
     *
     * - When `id` is omitted, the ID is inferred from `url` via `inferSlugFromUrl()`.
     * - When `id` is provided explicitly it is validated via `isValidKebabCase()`
     *   after trimming. Path-traversal sequences and invalid formats are rejected.
     * - When `name` is omitted, it defaults to the resolved ID.
     *
     * @param params.url  Remote Git URL (HTTPS or SSH).
     * @param params.name Optional human-readable display name. Defaults to the resolved ID.
     * @param params.id   Optional explicit repository ID. Must be a valid kebab-case string.
     *
     * @throws {Error} If the explicit `id` is not valid kebab-case.
     * @throws {Error} If the URL produces an empty slug and no explicit `id` was given.
     * @throws {Error} If a repository with the same ID already exists.
     * @throws {Error} If a repository with the same URL already exists.
     */
    add(params: { url: string; name?: string; id?: string }): Repository {
        const store = this.load();

        let id = params.id;
        if (id) {
            id = id.trim();
            if (!isValidKebabCase(id)) {
                throw new Error(
                    `Invalid repository ID "${id}": must be a valid kebab-case string ` +
                    `(lowercase alphanumeric segments separated by single hyphens).`
                );
            }
        } else {
            id = inferSlugFromUrl(params.url);
            if (id === '') {
                throw new Error(
                    `Cannot infer a repository ID from URL "${redactUrl(params.url)}": the URL produced an empty slug. ` +
                    `Please provide an explicit ID.`
                );
            }
        }

        const name = params.name ?? id;

        const duplicate = store.Repositories.find((r) => r.Id === id);
        if (duplicate) {
            throw new Error(
                `A repository with ID "${id}" already exists.`
            );
        }

        const duplicateUrl = store.Repositories.find((r) => r.Url === params.url);
        if (duplicateUrl) {
            throw new Error(
                `A repository with URL "${redactUrl(params.url)}" already exists (ID: "${duplicateUrl.Id}").`
            );
        }

        const repo: Repository = { Id: id, Name: name, Url: params.url };
        store.Repositories.push(repo);
        this.save(store);
        return repo;
    }

    /**
     * Updates the `Name` of an existing repository.
     *
     * @throws {Error} If no repository with the given ID exists.
     */
    update(id: string, params: { name: string }): Repository {
        const store = this.load();
        const index = store.Repositories.findIndex((r) => r.Id === id);

        if (index === -1) {
            throw new NotFoundError(`Cannot update: repository with ID "${id}" does not exist.`);
        }

        store.Repositories[index] = { ...store.Repositories[index], Name: params.name };
        this.save(store);
        return store.Repositories[index];
    }

    /**
     * Removes the repository with the given ID from the store.
     *
     * @throws {Error} If no repository with the given ID exists.
     */
    remove(id: string): void {
        const store = this.load();
        const index = store.Repositories.findIndex((r) => r.Id === id);

        if (index === -1) {
            throw new NotFoundError(`Cannot remove: repository with ID "${id}" does not exist.`);
        }

        store.Repositories.splice(index, 1);
        this.save(store);
    }
}
