/**
 * Cross-platform path utilities — `splitPath`, `toPosix`, `toFileUri`.
 *
 * Every fs-touching tool that accepts paths from an LLM has to deal with
 * the same OS-specific drift:
 *
 *   - On Windows `path.sep` is `\\`, but tools / users / config files
 *     routinely pass forward-slash paths.
 *   - LSP `file://` URIs MUST be POSIX-shaped regardless of host (LSP
 *     servers reject backslash URIs).
 *   - Pattern matching against path segments needs to split on BOTH
 *     separators or sensitive-name predicates silently miss matches.
 *
 * `apps/coding-agent` re-discovered every one of these on Windows-only
 * CI — see HARNESS_LOG entries HC-019 and HC-002. This module is the
 * canonical home so downstream tools never have to.
 *
 * @module
 */

import path from 'node:path';

/**
 * Split a path into segments, treating both `/` and `\\` as separators.
 *
 * Use this for predicate checks (sensitive-name matching, depth limits,
 * etc.) where the question is "does any segment of this path equal X?"
 * and where the input may have arrived via either separator regardless
 * of the host OS.
 *
 * Empty segments produced by leading / trailing / repeated separators
 * are filtered out so `splitPath('/a//b/').join('/')` round-trips to
 * `'a/b'`.
 *
 * @example
 * ```ts
 * splitPath('a/b\\c');        // ['a', 'b', 'c']
 * splitPath('home/.aws/cred'); // ['home', '.aws', 'cred']
 * ```
 */
export function splitPath(p: string): string[] {
  if (typeof p !== 'string' || p.length === 0) return [];
  return p.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/**
 * Convert a path to POSIX shape (forward slashes), regardless of host OS.
 *
 * - Windows-style `\\` separators are normalised to `/`.
 * - Drive letters such as `C:\\foo` become `C:/foo` — the result is
 *   suitable for embedding in `file://` URIs (use {@link toFileUri} for
 *   that path-end conversion).
 * - Idempotent: already-POSIX paths pass through unchanged.
 *
 * @example
 * ```ts
 * toPosix('C:\\Users\\me\\repo');  // 'C:/Users/me/repo'
 * toPosix('/tmp/ws/a.ts');         // '/tmp/ws/a.ts' (unchanged)
 * ```
 */
export function toPosix(p: string): string {
  if (typeof p !== 'string') return '';
  return p.replace(/\\/g, '/');
}

/**
 * Build a `file://` URI from a workspace root + relative (or absolute) path.
 *
 * The result is always POSIX-shaped — LSP clients, browser fetchers, and
 * standards-compliant URI parsers all reject backslash URIs.
 *
 * - If `relativePath` is absolute it is used directly; otherwise it is
 *   joined under `workspace`.
 * - Windows absolute paths (`C:/foo`) get the conventional triple-slash
 *   prefix (`file:///C:/foo`) so the URI authority component stays empty.
 * - POSIX absolute paths are emitted as `file:///abs/path`.
 *
 * `path.join` is intentionally NOT used to assemble the final string —
 * that would re-introduce backslashes on Windows.
 *
 * @example
 * ```ts
 * toFileUri('/tmp/ws', 'a.ts');             // 'file:///tmp/ws/a.ts'
 * toFileUri('C:\\dev\\ws', 'src\\main.ts'); // 'file:///C:/dev/ws/src/main.ts'
 * toFileUri('/x', '/abs/elsewhere.ts');     // 'file:///abs/elsewhere.ts'
 * ```
 */
export function toFileUri(workspace: string, relativePath: string): string {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new TypeError('toFileUri: workspace must be a non-empty string');
  }
  if (typeof relativePath !== 'string') {
    throw new TypeError('toFileUri: relativePath must be a string');
  }

  // Decide absolute / relative under the OS-native rules so behaviour
  // matches Node's path module on the host.
  const abs = path.isAbsolute(relativePath)
    ? relativePath
    : pathJoinPosix(workspace, relativePath);

  const posix = toPosix(abs);
  // Already POSIX-rooted (`/foo` or `\foo`) — single slash already prefixed.
  if (posix.startsWith('/')) return `file://${posix}`;
  // Windows-style absolute (`C:/foo`) — needs an extra `/` so the URI's
  // authority is empty.
  return `file:///${posix}`;
}

/**
 * Internal helper: join two paths but emit forward slashes regardless of
 * the host OS. Internal `//` runs (from trailing slash + leading slash,
 * or repeated separators within either piece) are collapsed so the URI
 * never carries empty path segments — POSIX accepts them but most LSP
 * clients and HTTP libs treat them inconsistently.
 *
 * Equivalent to `path.posix.join` semantically, but does not strip
 * meaningful prefixes (e.g. preserves `C:` drive letters that `path.posix`
 * would treat as a relative segment).
 */
function pathJoinPosix(a: string, b: string): string {
  const left = toPosix(a);
  const right = toPosix(b);
  if (left.length === 0) return collapseSlashes(right);
  if (right.length === 0) return collapseSlashes(left);
  return collapseSlashes(`${left}/${right}`);
}

/**
 * Collapse internal `//` runs to single `/`, but preserve leading
 * double-slash if present at index 0 (RFC 3986 reserves leading `//`
 * for the authority component — which we don't use, but be conservative).
 */
function collapseSlashes(s: string): string {
  if (s.length === 0) return s;
  // Replace runs of 2+ slashes with a single slash, except leading.
  return s[0] + s.slice(1).replace(/\/{2,}/g, '/');
}
