/**
 * Converts a string to kebab-case.
 *
 * - Trims leading/trailing whitespace.
 * - Lowercases all characters.
 * - Replaces runs of non-alphanumeric characters with a single hyphen.
 * - Strips any leading or trailing hyphens that result from the replacement.
 *
 * **Non-ASCII characters** (accented letters, CJK, emoji, etc.) are stripped
 * rather than transliterated — e.g. `"héllo"` → `"h-llo"`. Users with
 * non-Latin project names should be aware the output may be shorter than
 * expected.
 *
 * **All-special input** (e.g. `"!@#$%"`) returns an empty string. Callers
 * that accept arbitrary user input should guard against empty output and fall
 * back to a default slug if needed.
 *
 * Examples:
 *   "My Cool Project"     → "my-cool-project"
 *   "  hello   world  "  → "hello-world"
 *   "foo___bar--baz"      → "foo-bar-baz"
 *   "123 My Project"      → "123-my-project"
 *   "héllo"               → "h-llo"
 *   "!@#$%"               → ""
 */
export function toKebabCase(input: string): string {
    return input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Returns true if the input is a valid kebab-case string:
 * one or more lowercase alphanumeric segments separated by single hyphens,
 * with no leading/trailing hyphens.
 *
 * Examples:
 *   "my-project"  → true
 *   "My_Project"  → false
 *   "foo--bar"    → false
 *   "-leading"    → false
 */
export function isValidKebabCase(input: string): boolean {
    return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(input);
}

/**
 * Infers a kebab-case slug from a Git remote URL.
 * Supports both HTTPS (https://github.com/user/repo.git) and SSH
 * (git@github.com:user/repo.git) formats. Strips the trailing ".git" suffix.
 *
 * **Malformed or empty input** does not throw — instead it returns an empty
 * string. Callers must guard against empty-string output before using the
 * result as a workspace or project identifier.
 *
 * Examples:
 *   "https://github.com/user/my-repo.git"  → "my-repo"
 *   "git@github.com:user/my-repo.git"      → "my-repo"
 *   ""                                      → ""
 *   "not-a-url"                             → "not-a-url"
 */
export function inferSlugFromUrl(url: string): string {
    const withoutGit = url.replace(/\.git$/i, '');
    // Split on both '/' and ':' to handle SSH and HTTPS URL formats
    const segments = withoutGit.split(/[/:]/);
    const repoName = segments[segments.length - 1];
    return toKebabCase(repoName);
}

/**
 * Returns true if the string is a valid workspace identifier:
 * 2–6 uppercase ASCII letters.
 *
 * **Digits are not accepted** — workspace IDs must consist of letters only
 * (A–Z). For example, `"AB1"` returns false. If your workflow requires
 * alphanumeric IDs the regex `^[A-Z]{2,6}$` will need to be updated.
 *
 * Examples:
 *   "AB"      → true
 *   "a"       → false   (too short, wrong case)
 *   "TOOLONG" → false   (exceeds 6 characters)
 *   "AB1"     → false   (digit not permitted)
 */
export function isValidWorkspaceId(id: string): boolean {
    return /^[A-Z]{2,6}$/.test(id);
}
