import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Filesystem path-containment and symlink-escape guards.
 *
 * Extracted from `src/orchestration/workspace-index.ts`'s write-guard chain
 * (allowlist → realpath symlink-escape → shape) so the same, carefully
 * hardened logic can be reused by a second consumer without duplicating a
 * security-sensitive fix.
 *
 * Consumers:
 * - `src/orchestration/workspace-index.ts` — `writeWorkspaceIndexFiles()`'s
 *   guard chain, protecting generated index-file writes.
 * - `src/orchestration/repository-orchestrator.ts` — `removeRepositoryFromProject()`'s
 *   clone-folder deletion guard.
 */

// ---------------------------------------------------------------------------
// Guards (lexical containment -> realpath symlink-escape -> shape)
// ---------------------------------------------------------------------------

/**
 * Lexical containment check: does `resolvedTarget` sit strictly under
 * `resolvedRoot`? Purely string-based — does not touch the filesystem, and
 * therefore cannot see through a symlink (see {@link escapesRootViaRealpath}
 * for that layer).
 */
export function isLexicallyContained(resolvedTarget: string, resolvedRoot: string): boolean {
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

/**
 * Walks upward from `targetPath` to the deepest ancestor that actually
 * exists on disk. `targetPath` itself is expected not to exist yet in the
 * common case (a file this writer is about to create).
 */
function findDeepestExistingAncestor(targetPath: string): string {
    let current = targetPath;
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) {
            // Reached the filesystem root without finding anything that
            // exists — return it so the caller's realpath call still
            // resolves to something rather than looping forever.
            return current;
        }
        current = parent;
    }
    return current;
}

/** Upper bound on symlink chain length {@link bestEffortRealpath} will follow before giving up. */
export const MAX_SYMLINK_RESOLUTION_DEPTH = 40;

/**
 * Resolves the link target of the symlink at `linkPath`, as an absolute path.
 * A relative link target is resolved against the symlink's own directory,
 * matching POSIX symlink semantics.
 */
function resolveSymlinkTarget(linkPath: string): string {
    const linkTarget = fs.readlinkSync(linkPath);
    return path.isAbsolute(linkTarget) ? linkTarget : path.resolve(path.dirname(linkPath), linkTarget);
}

/**
 * Best-effort realpath resolution that, unlike `fs.realpathSync`, does not
 * require the final path component to exist — so it also resolves a
 * *broken* symlink (one whose target does not exist).
 *
 * `fs.existsSync()` (used by {@link findDeepestExistingAncestor}) follows
 * symlinks and returns `false` for a broken symlink, exactly as it does for
 * a path that plainly does not exist. That made a broken symlink planted at
 * a write target invisible to the ancestor walk: the walk skipped straight
 * over the symlink itself and landed on its parent directory, which sits
 * inside the root, so the escape was never detected even though the symlink
 * pointed outside it. This function closes that gap by `lstat`-ing the exact
 * target path first — before ever asking whether it "exists" — so a symlink
 * is always followed explicitly, whether or not it is broken.
 *
 * Follows an arbitrary chain of symlinks (including one where an
 * intermediate hop is itself broken) up to {@link MAX_SYMLINK_RESOLUTION_DEPTH}
 * levels, then throws — the caller treats that as an escape, matching the
 * existing conservative-on-error behaviour of this guard chain.
 */
export function bestEffortRealpath(targetPath: string, depth = 0): string {
    if (depth > MAX_SYMLINK_RESOLUTION_DEPTH) {
        throw new Error(`Too many levels of symbolic links while resolving "${targetPath}"`);
    }

    let lst: fs.Stats | null;
    try {
        lst = fs.lstatSync(targetPath);
    } catch {
        lst = null;
    }

    if (lst !== null && lst.isSymbolicLink()) {
        return bestEffortRealpath(resolveSymlinkTarget(targetPath), depth + 1);
    }

    const ancestor = findDeepestExistingAncestor(targetPath);
    const resolvedAncestor = fs.realpathSync(ancestor);
    const suffix = path.relative(ancestor, targetPath);
    return suffix === '' ? resolvedAncestor : path.resolve(resolvedAncestor, suffix);
}

/**
 * Resolves `projectsFolder`'s own real path, for use as the root compared
 * against a realpath'd target ancestor in {@link escapesRootViaRealpath}.
 * Falls back to a lexical `path.resolve` if the root itself cannot be
 * realpath'd (e.g. it does not exist yet) — a case that should not arise in
 * practice, since a workspace folder existing under it implies the root
 * exists too, but the fallback keeps this helper crash-free regardless.
 */
export function resolveRootRealPath(projectsFolder: string): string {
    try {
        return fs.realpathSync(projectsFolder);
    } catch {
        return path.resolve(projectsFolder);
    }
}

/**
 * Real-path symlink-escape check: resolves `targetPath` — following any
 * symlink along the way, including a symlink at the target's own leaf
 * position, even when that symlink is broken — and reports whether the
 * resolved path escapes `resolvedRoot`. Catches a symlink planted under an
 * otherwise lexically-valid path that points outside the intended root — the
 * one class of escape a lexical check alone cannot see.
 */
export function escapesRootViaRealpath(targetPath: string, resolvedRoot: string): boolean {
    try {
        const resolved = bestEffortRealpath(targetPath);
        return !isLexicallyContained(resolved, resolvedRoot);
    } catch {
        // Unresolvable target (e.g. a symlink cycle or permission error) is
        // treated conservatively as an escape.
        return true;
    }
}

/**
 * Shape check: rejects a target path that already exists on disk as a
 * directory, so a degenerate collision (e.g. something named `README.md`
 * that is actually a folder) is reported as rejected rather than crashing
 * on the subsequent write call.
 */
export function isDirectoryShaped(targetPath: string): boolean {
    try {
        return fs.statSync(targetPath).isDirectory();
    } catch {
        return false;
    }
}
