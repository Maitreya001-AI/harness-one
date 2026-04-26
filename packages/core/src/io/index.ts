/**
 * `harness-one/io` — filesystem safety primitives shared by every
 * coding-agent-shaped tool.
 *
 * Three modules:
 *
 *  - **path-safety** — workspace-containment with realpath collapsing,
 *    so symlink escapes (notably macOS `/var → /private/var`) are
 *    handled centrally rather than re-derived per app.
 *  - **safe-read** — `safeReadFile` that opens first, then stats the
 *    descriptor, so the classic `fs.stat()` → `fs.open()` TOCTOU race
 *    (CWE-367) is impossible by construction.
 *  - **path-utils** — `splitPath`, `toPosix`, `toFileUri` for the
 *    cross-platform string-shape work that LSP integrations and
 *    sensitive-name predicates need.
 *
 * Background: `apps/coding-agent` re-discovered each of these as
 * production bugs (HARNESS_LOG entries HC-002, HC-018, HC-019). This
 * module exists so downstream apps don't repeat the journey.
 *
 * @module
 */

// Path-safety: workspace containment + realpath dance
export {
  canonicalizeRoot,
  canonicalizeRootSync,
  realpathExistingPrefix,
  resolveWithinRoot,
  assertContainedIn,
  isContainedIn,
} from './path-safety.js';

// Safe-read: TOCTOU-free file reading
export type { SafeReadKind, SafeReadFileOptions, SafeReadFileResult } from './safe-read.js';
export { safeReadFile } from './safe-read.js';

// Path-utils: cross-platform string conversions
export { splitPath, toPosix, toFileUri } from './path-utils.js';
