/**
 * Shared helpers for embedding user-supplied text into generated Markdown
 * files without letting it interfere with the generated-region markers or the
 * surrounding line structure.
 *
 * The marker rule is a safety property: a value containing a literal
 * generated begin/end marker would corrupt the region merge in
 * `workspace-index.ts` (`mergeGeneratedContent` truncates at the first end
 * marker). It lives here, in `src/utils/`, so models, orchestration and the
 * renderer all share one implementation.
 *
 * Every helper here is the identity function for input that contains no
 * generated-marker text (collapseToSingleLine additionally rewrites line
 * breaks); output changes only for marker-containing input.
 */

/**
 * Substring common to both generated-region markers
 * (`<!-- paralizer:generated:begin -->` and `<!-- paralizer:generated:end -->`).
 * Any text containing it is treated as marker text.
 */
export const GENERATED_MARKER_TOKEN = 'paralizer:generated:';

/** Replacement for {@link GENERATED_MARKER_TOKEN}; no longer matches a marker. */
const NEUTRALISED_MARKER_TOKEN = 'paralizer-generated:';

/**
 * Whether the text contains generated-marker text (a begin/end marker or the
 * bare {@link GENERATED_MARKER_TOKEN}).
 */
export function containsGeneratedMarker(value: string): boolean {
    return value.includes(GENERATED_MARKER_TOKEN);
}

/**
 * Rewrites every occurrence of {@link GENERATED_MARKER_TOKEN} so the text can
 * no longer be recognised as a generated marker. Identity for marker-free text.
 */
export function neutraliseGeneratedMarkers(value: string): string {
    return value.split(GENERATED_MARKER_TOKEN).join(NEUTRALISED_MARKER_TOKEN);
}

/**
 * Collapses CR, LF and CRLF sequences to a single space each and trims
 * leading/trailing whitespace, yielding a single line.
 */
export function collapseToSingleLine(value: string): string {
    return value.replace(/\r\n|\r|\n/g, ' ').trim();
}

/**
 * Validates and normalises user-supplied text that must render as a single
 * paragraph (one Markdown list item): line breaks collapse to single spaces,
 * the result is trimmed, and it must be non-empty, at most `maxLength`
 * characters, and free of generated-marker text.
 *
 * @param raw       Raw user input.
 * @param maxLength Maximum length of the normalised text, in characters.
 * @param what      Field name used in error messages (e.g. `Directive`).
 * @returns The normalised text.
 * @throws {Error} With a user-presentable message naming `what`.
 */
export function normaliseSingleParagraph(raw: string, maxLength: number, what: string): string {
    const text = collapseToSingleLine(raw);
    if (text === '') throw new Error(`${what} is required.`);
    if (text.length > maxLength) {
        throw new Error(`${what} must be at most ${maxLength} characters.`);
    }
    if (containsGeneratedMarker(text)) {
        throw new Error(`${what} must not contain generated-region marker text ("${GENERATED_MARKER_TOKEN}").`);
    }
    return text;
}
