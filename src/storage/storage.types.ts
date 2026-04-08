/**
 * SchemaVersion is used to tag stored JSON objects with a numeric schema version,
 * enabling forward-compatible migration logic in future releases.
 */
export type SchemaVersion = number;

/**
 * Base interface for all JSON store files. Every persisted store includes a
 * `SchemaVersion` field for forward-compatible migration logic.
 */
export interface BaseStore {
    SchemaVersion: SchemaVersion;
}
