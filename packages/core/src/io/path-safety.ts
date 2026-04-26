/**
 * Workspace-containment path safety primitives.
 *
 * Every fs-touching tool that accepts a path from an LLM has to enforce
 * the same set of invariants:
 *
 *   1. The path must contain no `\\0` (NUL) or empty input.
 *   2. The resolved path must live INSIDE the configured root.
 *   3. macOS `/var → /private/var` and similar realpath escapes must be
 *      collapsed before containment is checked, else legitimate temp-dir
 *      paths trigger false escape errors.
 *   4. The deepest existing ancestor must be realpathed so that an
 *      attacker who plants a symlink at any prefix cannot redirect a
 *      yet-uncreated leaf out of the root.
 *
 * This module is the canonical implementation. `apps/coding-agent` had
 * its own copy under `src/tools/paths.ts`; downstream apps building
 * coding-agent-shaped tools will all need this primitive — see
 * HARNESS_LOG entries HC-002 (macOS realpath) and HC-019
 * (cross-platform pitfalls).
 *
 * @module
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { HarnessError, HarnessErrorCode } from '../infra/errors-base.js';

/**
 * Compute the canonical, absolute form of a workspace root from a string.
 *
 * Synchronous — no I/O. Use {@link canonicalizeRoot} when you also want
 * symlinked roots collapsed via `realpath`.
 *
 * @throws `IO_PATH_INVALID` when `workspace` is not a non-empty string.
 */
export function canonicalizeRootSync(workspace: string): string {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new HarnessError(
      'Workspace path must be a non-empty string',
      HarnessErrorCode.IO_PATH_INVALID,
      'Pass an absolute path or one resolvable from cwd to the path-safety helpers',
    );
  }
  return path.resolve(workspace);
}

/**
 * Async variant of {@link canonicalizeRootSync} that also realpaths the
 * root so symlinked workspace directories (notably macOS `/var →
 * /private/var`) are normalised. When the root does not yet exist on
 * disk, falls back to the resolved (non-realpath) form.
 *
 * Agent factories should call this exactly once at startup and cache the
 * result. Tools then rely on the workspace being a canonical real path
 * when computing `path.relative()`.
 */
export async function canonicalizeRoot(workspace: string): Promise<string> {
  const resolved = canonicalizeRootSync(workspace);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Realpath the deepest existing ancestor of `target`, then re-append the
 * remainder. Equivalent to `realpath` when the file exists; safe even
 * when the leaf is yet to be created (e.g. write_file's intended
 * destination).
 *
 * Exported because some advanced consumers (auditors, dry-run reporters)
 * want the same realpath-with-tail computation without going through
 * {@link resolveWithinRoot}.
 */
export async function realpathExistingPrefix(target: string): Promise<string> {
  let current = target;
  const tail: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `userPath` (absolute or relative-to-root) against the canonical
 * workspace `root`, enforcing containment and rejecting symlink escapes.
 *
 * The returned string is always:
 *   - absolute,
 *   - realpath-collapsed up to the deepest existing ancestor,
 *   - guaranteed contained inside `root`.
 *
 * Pre-condition: `root` should already be a canonical real path —
 * obtained via {@link canonicalizeRoot} at agent startup. (The function
 * realpaths the root again as belt-and-braces, but doing it once at
 * startup avoids a `realpath` syscall per tool call.)
 *
 * @throws `IO_PATH_INVALID` when input is empty / NUL-bearing / non-string.
 * @throws `IO_PATH_ESCAPE` when the resolved real path lives outside `root`.
 */
export async function resolveWithinRoot(root: string, userPath: string): Promise<string> {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new HarnessError(
      'Path must be a non-empty string',
      HarnessErrorCode.IO_PATH_INVALID,
      'Provide a workspace-relative or absolute path',
    );
  }
  if (userPath.includes('\0')) {
    throw new HarnessError(
      'Path may not contain NUL characters',
      HarnessErrorCode.IO_PATH_INVALID,
      'Reject the input from the model and retry',
    );
  }
  const realRoot = await canonicalizeRoot(root);
  const resolved = path.resolve(realRoot, userPath);
  const real = await realpathExistingPrefix(resolved);
  assertContainedIn(realRoot, real);
  return real;
}

/**
 * Throw `IO_PATH_ESCAPE` when `target` is not contained in `root`.
 *
 * Both arguments are expected to be absolute, realpath-collapsed paths.
 * Containment is computed via `path.relative` and the `..` / drive-root
 * predicates so it is correct on every platform supported by Node.
 */
export function assertContainedIn(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  throw new HarnessError(
    `Path escapes root: ${target}`,
    HarnessErrorCode.IO_PATH_ESCAPE,
    'The resolved real path must live inside the configured workspace root. ' +
      'Common causes: `..` traversal in the user-supplied path, or a symlink that ' +
      'points outside the root (the realpath of any prefix is followed before this check).',
  );
}

/**
 * Predicate variant of {@link assertContainedIn}. Returns `true` when
 * `target` is inside `root`, `false` otherwise. Useful in batch / dry-run
 * paths where a throw would be inconvenient.
 */
export function isContainedIn(root: string, target: string): boolean {
  try {
    assertContainedIn(root, target);
    return true;
  } catch {
    return false;
  }
}
