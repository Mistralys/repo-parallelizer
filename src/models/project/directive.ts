/**
 * Agent Directives — owner-defined, single-paragraph rules rendered into the
 * generated workspace `AGENTS.md`. They exist at two scopes: project-wide
 * (`ProjectData.Directives`, applies to every workspace) and per workspace
 * (`ProjectWorkspace.Directives`).
 *
 * This module is pure (no filesystem access): it holds the types, limits and
 * the validation/normalisation rules used by `ProjectManager`.
 */

import { normaliseSingleParagraph } from '../../utils/single-paragraph-text.js';

/** Maximum length of a single directive, in characters. */
export const DIRECTIVE_MAX_LENGTH = 1000;

/** Maximum number of directives per scope. */
export const DIRECTIVES_MAX_COUNT = 50;

/** A single agent directive. */
export interface AgentDirective {
    /** Stable unique identifier (UUID). */
    Id: string;

    /** The directive text: one paragraph, no line breaks. */
    Text: string;

    /** ISO 8601 timestamp of the last change. */
    DateModified: string;
}

/** Mutable user-supplied fields of a directive. */
export interface AgentDirectiveInput {
    Text: string;
}

/**
 * Where a directive lives. There is deliberately no default: every manager
 * method requires an explicit scope.
 */
export type DirectiveScope =
    | { kind: 'project' }
    | { kind: 'workspace'; workspaceId: string };

/**
 * Validates and normalises directive input.
 *
 * @param input  Raw input.
 * @param others The other directives of the same scope (exclude the one being
 *   edited); used for the duplicate check and the count limit.
 * @returns The normalised input.
 * @throws {Error} With a user-presentable message on the first violation.
 */
export function validateDirectiveInput(
    input: AgentDirectiveInput,
    others: readonly AgentDirective[],
): AgentDirectiveInput {
    const text = normaliseSingleParagraph(input.Text, DIRECTIVE_MAX_LENGTH, 'Directive');
    const lower = text.toLowerCase();

    if (others.some((o) => o.Text.toLowerCase() === lower)) {
        throw new Error('This directive already exists in this scope.');
    }
    if (others.length >= DIRECTIVES_MAX_COUNT) {
        throw new Error(`At most ${DIRECTIVES_MAX_COUNT} directives are allowed per scope.`);
    }
    return { Text: text };
}
