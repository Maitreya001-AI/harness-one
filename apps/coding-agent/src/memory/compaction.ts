/**
 * Compaction policy applied to a finished task's checkpoint store.
 *
 * Keeps a small bounded set of recent checkpoints around so users can
 * `--resume` historical tasks, but prevents the directory from growing
 * unbounded over months of dogfood use.
 *
 * @module
 */

import type { CompactionResult, MemoryStore } from 'harness-one/memory';

export interface CompactCheckpointsOptions {
  /** Keep at most this many checkpoint entries. Defaults to 50. */
  readonly maxEntries?: number;
  /** Drop checkpoints older than this many milliseconds. Defaults to 30 days. */
  readonly maxAgeMs?: number;
}

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function compactTaskCheckpoints(
  store: MemoryStore,
  options?: CompactCheckpointsOptions,
): Promise<CompactionResult> {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxAge = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  return store.compact({
    maxEntries,
    maxAge,
    gradeWeights: { critical: 1.0, useful: 0.5, ephemeral: 0.1 },
  });
}
