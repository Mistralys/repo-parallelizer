/**
 * Repository roles — an optional, owner-defined "Role / relations" text per
 * repository, stored on the project (`ProjectData.RepositoryRoles`, keyed by
 * repository ID) so one project's description of a repository never leaks
 * into another project.
 *
 * This module is pure (no filesystem access).
 */

import { normaliseSingleParagraph } from '../../utils/single-paragraph-text.js';

/** Maximum length of a repository role text, in characters. */
export const REPOSITORY_ROLE_MAX_LENGTH = 500;

/**
 * Validates and normalises a repository role.
 *
 * @param raw Raw user input.
 * @returns The normalised single-paragraph text, or `''` when the input is
 *   empty after trimming (meaning "clear the role").
 * @throws {Error} With a user-presentable message when the text is too long
 *   or contains generated-marker text.
 */
export function validateRepositoryRole(raw: string): string {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return '';
    }
    return normaliseSingleParagraph(raw, REPOSITORY_ROLE_MAX_LENGTH, 'Repository role');
}
