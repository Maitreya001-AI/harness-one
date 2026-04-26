/**
 * Path containment + sensitive-file checks shared across fs/shell tools.
 *
 * Two concerns layered together:
 *
 * 1. **Workspace containment** — handled by `harness-one/io/path-safety`.
 *    Realpath dance, symlink-escape detection, NUL rejection. Was
 *    re-implemented per-tool until HARNESS_LOG entries HC-002 and HC-019
 *    promoted it to a vertical primitive in harness-one core.
 *
 * 2. **Sensitive-name policy** (DESIGN §3.6) — coding-agent's own
 *    fail-closed list of filenames that must never be touched even when
 *    inside the workspace (`.env`, `id_rsa`, `*.key`, etc.). This stays
 *    here because it is a coding-agent security policy, not a generic
 *    path primitive.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import {
  resolveWithinRoot,
  splitPath,
  canonicalizeRoot,
  canonicalizeRootSync,
} from 'harness-one/io';

/** Canonical sensitive-filename patterns (DESIGN §3.6). */
const SENSITIVE_BASENAME_PATTERNS: readonly RegExp[] = Object.freeze([
  /^\.env(\..+)?$/i,
  /^id_rsa$/i,
  /^id_dsa$/i,
  /^id_ed25519$/i,
  /^id_ecdsa$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /^\.netrc$/i,
  /^\.aws$/i,
  /^credentials$/i,
]);

/** Returns `true` when `relPath` (or any of its segments) is sensitive. */
export function isSensitivePath(relPath: string): boolean {
  for (const segment of splitPath(relPath)) {
    for (const pattern of SENSITIVE_BASENAME_PATTERNS) {
      if (pattern.test(segment)) return true;
    }
  }
  return false;
}

/** Compute a canonical absolute workspace root, throwing on invalid input. */
export function canonicalizeWorkspace(workspace: string): string {
  return canonicalizeRootSync(workspace);
}

/**
 * Async variant of {@link canonicalizeWorkspace}. Realpath collapses
 * symlinked roots (e.g. macOS `/var → /private/var`) so containment
 * checks work without false escape errors.
 */
export async function canonicalizeWorkspaceAsync(workspace: string): Promise<string> {
  return canonicalizeRoot(workspace);
}

/**
 * Resolve `userPath` against `workspace`, additionally enforcing the
 * coding-agent sensitive-name policy.
 *
 * `allowSensitive: false` (default) raises `GUARD_BLOCKED` when the
 * resolved relative path matches any sensitive pattern. Pass `true` for
 * read-with-prompt paths where the soft guardrail handles the user
 * prompt.
 *
 * Lower-level workspace containment / NUL / symlink-escape checks come
 * from `harness-one/io/resolveWithinRoot` so this app benefits
 * automatically from any future hardening landed there.
 */
export async function resolveSafePath(
  workspace: string,
  userPath: string,
  options?: { allowSensitive?: boolean },
): Promise<string> {
  const real = await resolveWithinRoot(workspace, userPath);
  if (options?.allowSensitive !== true) {
    const realRoot = await canonicalizeRoot(workspace);
    const relSegments = splitPath(real.slice(realRoot.length));
    const rel = relSegments.join('/');
    if (isSensitivePath(rel)) {
      throw new HarnessError(
        `Refusing to touch sensitive path: ${rel}`,
        HarnessErrorCode.GUARD_BLOCKED,
        'Sensitive files are blocked by the coding-agent path guardrail. ' +
          'Adjust your prompt to avoid these files, or override via approval flow.',
      );
    }
  }
  return real;
}
