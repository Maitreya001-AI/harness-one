/**
 * Bounded ring buffer of {@link TokenUsageRecord} rows with a per-trace
 * lookup index.
 *
 * Owns the raw/effective index bookkeeping used by `cost-tracker.ts`:
 *
 *   - **RawIndex** — the position a record occupied when pushed, offset by
 *     all historical shifts. Monotone; never revisited.
 *   - **EffectiveIndex** — the current slot in the underlying array
 *     (0-indexed). The conversion is `effective = raw - evictionBias`.
 *
 * The two spaces are kept distinct via branded types so a callsite cannot
 * mix them. `evictionBias` is compacted back to `0` whenever the buffer
 * fully drains so a long-lived tracker doesn't approach `2^53` after many
 * years of streaming.
 *
 * Single-purpose: this module manages buffer + traceIdIndex + bias only. It
 * intentionally does NOT touch the `runningSum`, per-model/per-trace totals,
 * or eviction-strategy callbacks — those belong to the cost tracker so the
 * eviction policy stays pluggable.
 *
 * @module
 */

import type { TokenUsageRecord } from '../core/pricing.js';

type RawIndex = number & { readonly __brand: 'RawIndex' };
type EffectiveIndex = number & { readonly __brand: 'EffectiveIndex' };

/**
 * Handle returned by {@link CostRecordBuffer.getLatestForTrace} that lets the
 * caller mutate the latest row in place without re-translating the raw index
 * a second time.
 */
export interface LatestRecordHandle {
  readonly record: TokenUsageRecord;
  /** Overwrite the slot with an updated record (same trace + model). */
  replace(updated: TokenUsageRecord): void;
}

export interface CostRecordBuffer {
  /** Total live records currently held. */
  readonly size: number;
  /**
   * Append a record. Returns the evicted record when the buffer was already
   * at `maxRecords` and the oldest row had to be shifted out, or `undefined`
   * when no eviction was necessary.
   */
  push(record: TokenUsageRecord): TokenUsageRecord | undefined;
  /**
   * Resolve the most recent live record for `traceId`, or `undefined` when
   * no live record matches. Returns a handle that can replace the row in
   * place — the cost tracker uses this for `updateUsage()`.
   */
  getLatestForTrace(traceId: string): LatestRecordHandle | undefined;
  /** Drop every record and reset bias. */
  clear(): void;
}

export function createCostRecordBuffer(options: { readonly maxRecords: number }): CostRecordBuffer {
  const records: TokenUsageRecord[] = [];
  const traceIdIndex = new Map<string, RawIndex[]>();
  let evictionBias = 0;
  const maxRecords = options.maxRecords;

  const asRaw = (n: number): RawIndex => n as RawIndex;
  const toEffective = (raw: RawIndex): EffectiveIndex =>
    (raw - evictionBias) as EffectiveIndex;

  function appendIndex(record: TokenUsageRecord): void {
    if (!record.traceId) return;
    const rawIdx = asRaw(records.length - 1 + evictionBias);
    const list = traceIdIndex.get(record.traceId);
    if (list) list.push(rawIdx);
    else traceIdIndex.set(record.traceId, [rawIdx]);
  }

  function dropEvictedIndex(evicted: TokenUsageRecord): void {
    if (!evicted.traceId) return;
    // O(1) amortised eviction bookkeeping. The evicted record occupied
    // effective slot 0 → raw index == evictionBias. Only the affected
    // traceId's list needs surgery: its head entry (the minimum raw index)
    // is popped; every other traceId is unchanged in raw space.
    const list = traceIdIndex.get(evicted.traceId);
    if (list && list.length > 0 && list[0] === (evictionBias as number)) {
      list.shift();
      if (list.length === 0) traceIdIndex.delete(evicted.traceId);
    }
  }

  function compactBiasIfDrained(): void {
    // Buffer drained (every record evicted since the last clear): compact
    // `evictionBias` back to 0 so long-lived buffers don't approach 2^53
    // after many years of streaming. Safe because traceIdIndex is empty —
    // no live RAW index to translate.
    if (records.length === 0 && traceIdIndex.size === 0 && evictionBias !== 0) {
      evictionBias = 0;
    }
  }

  return {
    get size(): number {
      return records.length;
    },

    push(record: TokenUsageRecord): TokenUsageRecord | undefined {
      records.push(record);
      appendIndex(record);

      let evicted: TokenUsageRecord | undefined;
      if (records.length > maxRecords) {
        evicted = records.shift() as TokenUsageRecord;
        dropEvictedIndex(evicted);
        evictionBias++;
      }
      compactBiasIfDrained();
      return evicted;
    },

    getLatestForTrace(traceId: string): LatestRecordHandle | undefined {
      const list = traceIdIndex.get(traceId);
      if (!list || list.length === 0) return undefined;
      const rawIdx = list[list.length - 1];
      const effectiveIdx = toEffective(rawIdx);
      if (effectiveIdx < 0 || effectiveIdx >= records.length) return undefined;
      const record = records[effectiveIdx];
      if (!record) return undefined;
      return {
        record,
        replace(updated: TokenUsageRecord): void {
          records[effectiveIdx] = updated;
        },
      };
    },

    clear(): void {
      records.length = 0;
      traceIdIndex.clear();
      evictionBias = 0;
    },
  };
}
