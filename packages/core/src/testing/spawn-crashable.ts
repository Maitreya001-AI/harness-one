/**
 * `spawnCrashable` — supervised child-process spawn for chaos /
 * crash-recovery tests, with the SIGKILL-via-wrapper exit-code 137
 * detection that showcase 03 had to re-derive.
 *
 * **Why it exists** (from showcase 03 FRICTION_LOG):
 *
 * When a subprocess is launched through `pnpm exec tsx ...` the
 * resulting tree is `pnpm` → `tsx` → `node leaf.ts`. When the leaf
 * is SIGKILLed by an external signal-killer, those intermediaries
 * see the signal first and translate it into the conventional Unix
 * exit code 137 (128 + 9). The parent's
 * `child.on('exit', code, signal)` then reports `code: 137,
 * signal: null` instead of `signal: 'SIGKILL'`. Tests that asserted
 * `signal === 'SIGKILL'` failed even though the data layer behaved
 * exactly as designed.
 *
 * `spawnCrashable` wraps this concern: it returns a structured
 * outcome (`'clean' | 'killed' | 'errored'`) regardless of which
 * intermediary intercepted the kill, so chaos-test authors can
 * assert against semantics, not signal-name plumbing.
 *
 * @module
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** Configuration for {@link spawnCrashable}. */
export interface SpawnCrashableConfig {
  /** Executable name (e.g. `'node'`, `'pnpm'`). */
  readonly entry: string;
  /** Arguments to pass after the entry. */
  readonly args?: readonly string[];
  /**
   * Optional schedule: send SIGKILL after this many ms. Omit to let
   * the child run to natural completion.
   */
  readonly killAt?: number;
  /** Spawn options forwarded to `child_process.spawn`. */
  readonly spawnOptions?: SpawnOptions;
  /**
   * Override `spawn` for tests. Must conform to the `child_process.spawn`
   * shape — used by the unit tests of this module to avoid forking real
   * processes.
   */
  readonly spawner?: (
    cmd: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
}

/** Outcome reported by {@link spawnCrashable} when the child terminates. */
export type SpawnCrashableOutcome =
  | { readonly outcome: 'clean'; readonly code: 0 }
  | { readonly outcome: 'killed'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly outcome: 'errored'; readonly code: number; readonly signal: null };

/**
 * Spawn a child process and resolve to a structured outcome when it
 * terminates. Recognises BOTH `signal === 'SIGKILL'` and
 * `code === 137` (signal-laundered SIGKILL via shell wrappers) as
 * the `'killed'` outcome.
 *
 * @example
 * ```ts
 * const outcome = await spawnCrashable({
 *   entry: 'node',
 *   args: ['./crashable-leaf.js'],
 *   killAt: 50,
 * });
 * expect(outcome.outcome).toBe('killed');
 * ```
 */
export function spawnCrashable(config: SpawnCrashableConfig): Promise<SpawnCrashableOutcome> {
  return new Promise((resolve, reject) => {
    const spawner = config.spawner ?? spawn;
    const child = spawner(config.entry, [...(config.args ?? [])], config.spawnOptions ?? {});

    let killTimer: NodeJS.Timeout | undefined;
    if (config.killAt !== undefined && config.killAt >= 0) {
      killTimer = setTimeout(() => {
        // SIGKILL is uncatchable — the leaf cannot block this.
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }, config.killAt);
    }

    child.once('error', (err) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      reject(err);
    });

    child.once('exit', (code, signal) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      // Recognise SIGKILL even when laundered through a shell wrapper.
      if (signal === 'SIGKILL' || code === 137) {
        resolve({
          outcome: 'killed',
          code,
          signal,
        });
        return;
      }
      // Generic non-zero exit (other signal codes, app errors, etc.)
      if (code !== null && code !== 0) {
        resolve({ outcome: 'errored', code, signal: null });
        return;
      }
      // Other signals (SIGTERM, etc.) collapse to the killed bucket
      // when no clean-zero exit was reported.
      if (signal !== null) {
        resolve({ outcome: 'killed', code, signal });
        return;
      }
      resolve({ outcome: 'clean', code: 0 });
    });
  });
}
