import type { BaseStore } from '../../storage/storage.types.js';

/**
 * Represents a single tracked Git repository.
 */
export interface Repository {
    /** Unique kebab-case identifier, inferred from URL when not provided explicitly. */
    Id: string;

    /** Human-readable display name. */
    Name: string;

    /** Remote Git URL (HTTPS or SSH). */
    Url: string;

    /**
     * Transient flag set by `RepositoryManager.add()` when embedded credentials
     * were stripped from the URL before storage. Not persisted to
     * `repositories.json`.
     *
     * Uses camelCase (not PascalCase like the persisted fields above) to signal
     * that this property is runtime-only and excluded from the data schema.
     */
    credentialsStripped?: boolean;
}

/**
 * Top-level shape of the repositories.json storage file.
 */
export interface RepositoryStore extends BaseStore {
    Repositories: Repository[];
}
