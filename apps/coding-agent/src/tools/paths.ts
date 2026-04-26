/**
 * Path containment + sensitive-file checks shared across fs/shell tools.
 *
 * Implements DESIGN §3.6 hard guardrails for path access:
 *   - workspace-rooted absolute paths only
 *   - reject `..` traversal escapes
 *   - reject symlink escapes (resolve via {@link realpath} when the target
 *     exists)
 *   - block sensitive filename patterns (`.env`, `*.key`, `id_rsa`, etc.)
 *
 * @module
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { HarnessError, HarnessErrorCode } from 'harness-one/core';

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
  // Split on BOTH separators so the predicate stays correct cross-platform —
  // on Windows `path.sep` is `\\` but callers (tests, configs, LLM-emitted
  // arguments) routinely pass forward-slash paths.
  for (const segment of relPath.split(/[\\/]/)) {
    for (const pattern of SENSITIVE_BASENAME_PATTERNS) {
      if (pattern.test(segment)) return true;
    }
  }
  return false;
}

/** Compute a canonical absolute workspace root, throwing on invalid input. */
export function canonicalizeWorkspace(workspace: string): string {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new HarnessError(
      'Workspace path must be a non-empty string',
      HarnessErrorCode.CORE_INVALID_INPUT,
      'Pass an absolute or cwd-relative path to the agent factory',
    );
  }
  return path.resolve(workspace);
}

/**
 * Async variant that additionally realpaths the workspace so symlinked
 * roots (e.g. macOS `/var` → `/private/var`) are normalised.
 *
 * Agent factories should call this exactly once at startup and pass the
 * result through `ToolContext.workspace`. Tools then rely on the workspace
 * being a canonical real path when computing `path.relative()`.
 */
export async function canonicalizeWorkspaceAsync(workspace: string): Promise<string> {
  const resolved = canonicalizeWorkspace(workspace);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Realpath the workspace root once, falling back to the resolved path if
 * the directory has not been created yet. Containment checks must compare
 * realpath-against-realpath because symlinks (e.g. macOS `/var` →
 * `/private/var`) otherwise produce false escape errors.
 */
async function realpathRoot(root: string): Promise<string> {
  try {
    return await fs.realpath(root);
  } catch {
    return root;
  }
}

/**
 * Realpath the deepest existing ancestor of `target`, then re-append the
 * remainder. Equivalent to realpath when the file exists; safe even when
 * the target is yet to be created.
 */
async function realpathExistingPrefix(target: string): Promise<string> {
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
 * Resolve `userPath` (which may be absolute or relative to `workspace`)
 * against the canonical `workspace` root.
 *
 * Throws `CORE_INVALID_INPUT` if:
 *  - the resolved path is not contained within `workspace`
 *  - the path contains `\0` or other forbidden characters
 *  - the resolved real path (when the target exists) escapes via symlink
 *
 * `allowSensitive: false` (default) additionally throws on sensitive
 * basenames like `.env`, `id_rsa`, `*.key`. Pass `true` for read-with-prompt
 * paths where the soft guardrail handles the user prompt.
 */
export async function resolveSafePath(
  workspace: string,
  userPath: string,
  options?: { allowSensitive?: boolean },
): Promise<string> {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new HarnessError(
      'Path must be a non-empty string',
      HarnessErrorCode.CORE_INVALID_INPUT,
      'Provide a workspace-relative or absolute path',
    );
  }
  if (userPath.includes('\0')) {
    throw new HarnessError(
      'Path may not contain NUL characters',
      HarnessErrorCode.CORE_INVALID_INPUT,
      'Reject the input from the model and retry',
    );
  }
  const root = canonicalizeWorkspace(workspace);
  const realRoot = await realpathRoot(root);
  const resolved = path.resolve(realRoot, userPath);

  // realpath the deepest existing ancestor so a symlinked prefix
  // (e.g. macOS `/var` → `/private/var`) doesn't trigger a false escape.
  const real = await realpathExistingPrefix(resolved);
  assertContained(realRoot, real);

  if (options?.allowSensitive !== true) {
    const rel = path.relative(realRoot, real);
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

/** Throw `CORE_INVALID_INPUT` when `target` is not contained in `root`. */
function assertContained(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  throw new HarnessError(
    `Path escapes workspace: ${target}`,
    HarnessErrorCode.CORE_INVALID_INPUT,
    'Coding-agent only operates inside the configured workspace directory.',
  );
}
