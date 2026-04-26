/**
 * `withTempCheckpointDir` — async helper that creates an isolated
 * temp directory, hands it to the caller, and cleans it up on exit
 * (success OR failure).
 *
 * Closes the coding-agent HC-017 paper-cut: every test that builds a
 * `CodingAgent` (or any agent backed by `~/.harness-coding/checkpoints`)
 * has to remember to pass an explicit `checkpointDir` to avoid
 * polluting the user's home directory. This helper centralises the
 * mkdtemp + try/finally + rmdir ceremony.
 *
 * @module
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface WithTempCheckpointDirOptions {
  /** Optional prefix under `os.tmpdir()`. Default: `'harness-checkpoint-'`. */
  readonly prefix?: string;
  /**
   * Skip cleanup on exit. Default `false`. Useful for debugging when a
   * test fails and you want to inspect the on-disk state.
   */
  readonly keep?: boolean;
}

/**
 * Run `fn` with a freshly-created temp directory; clean up on exit.
 *
 * The directory is realpath-collapsed (handles macOS `/var → /private/var`)
 * so containment checks against it work consistently across platforms.
 *
 * @example
 * ```ts
 * await withTempCheckpointDir(async (dir) => {
 *   const agent = createCodingAgent({ workspace, checkpointDir: dir });
 *   // ... exercise agent; checkpoints land in `dir`, not ~/.harness-coding
 * });
 * ```
 */
export async function withTempCheckpointDir<T>(
  fnOrOptions: WithTempCheckpointDirOptions | ((dir: string) => Promise<T>),
  maybeFn?: (dir: string) => Promise<T>,
): Promise<T> {
  const options: WithTempCheckpointDirOptions =
    typeof fnOrOptions === 'function' ? {} : fnOrOptions;
  const fn = typeof fnOrOptions === 'function' ? fnOrOptions : maybeFn;
  if (typeof fn !== 'function') {
    throw new TypeError('withTempCheckpointDir: callback function is required');
  }
  const prefix = options.prefix ?? 'harness-checkpoint-';
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dir = await fs.realpath(raw);
  try {
    return await fn(dir);
  } finally {
    if (options.keep !== true) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {
        /* cleanup best-effort */
      });
    }
  }
}
