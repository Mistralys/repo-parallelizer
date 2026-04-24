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
