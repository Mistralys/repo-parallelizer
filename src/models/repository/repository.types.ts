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
}

/**
 * Top-level shape of the repositories.json storage file.
 */
export interface RepositoryStore extends BaseStore {
    Repositories: Repository[];
}
