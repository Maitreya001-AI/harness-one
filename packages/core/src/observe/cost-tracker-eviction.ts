/**
 * ARCH-008: Pluggable eviction semantics shared between the core
 * `createCostTracker` and `@harness-one/langfuse`'s `createLangfuseCostTracker`.
 *
 * Both trackers maintain three pieces of state:
 *  1. A bounded ring of `TokenUsageRecord` rows.
 *  2. A `runningSum` that mirrors the cost of items currently in the ring.
 *  3. Per-model + per-trace cumulative `KahanSum` maps.
 *
 * The historical implementations diverge on what happens when the cost
 * tracker hits a capacity limit:
 *
 *  - **Core (`'overflow-bucket'`)** never evicts existing per-model / per-trace
 *    totals. New unknown keys are aggregated under {@link OVERFLOW_BUCKET_KEY}
 *    so a flood of junk keys cannot wipe a legitimate total (SEC-009). The
 *    record buffer still shifts when oversize, which decrements `runningSum`
 *    but leaves the per-key totals untouched (cumulative-since-start).
 *
 *  - **Langfuse (`'lru'`)** evicts the oldest record AND decrements the
 *    affected per-model / per-trace totals so `getCostByModel()` /
 *    `getCostByTrace()` track the *retained window* of records. This matches
 *    Langfuse's own retention semantics: trackers usually run alongside a
 *    backend that stores the long-tail, so the local view is intentionally
 *    a sliding window.
 *
 * This module exposes both strategies behind a small interface so the
 * shared test suite (`cost-tracker-conformance.test.ts`) can assert that
 * both trackers honour the public {@link import('./cost-tracker.js').CostTracker}
 * contract regardless of strategy.
 *
 * @module
 */

import type { TokenUsageRecord } from '../core/pricing.js';
import { KahanSum, OVERFLOW_BUCKET_KEY } from './cost-tracker.js';

/** Strategy selector exposed publicly. */
export type EvictionStrategyName = 'overflow-bucket' | 'lru';

/**
 * Eviction policy hook. Implementations decide:
 *  1. What to do with newly-unseen keys when the per-key map is at capacity.
 *  2. What to do when the record buffer evicts a row (does the per-key total
 *     decrement, or stay cumulative?).
 */
export interface EvictionStrategy {
  /** Stable identifier for diagnostics and tests. */
  readonly name: EvictionStrategyName;
  /**
   * Resolve the {@link KahanSum} bucket to credit `estimatedCost` to.
   * The returned sum is mutated by the caller (`.add(estimatedCost)`).
   * Returning `null` signals "drop the credit on the floor" — the
   * `lru` strategy uses this when capacity is reached and overflow
   * is not desired.
   */
  resolveKeyBucket(
    map: Map<string, KahanSum>,
    key: string,
    capacity: number,
    onOverflow?: (info: { key: string; capacity: number }) => void,
  ): KahanSum | null;
  /**
   * Called when a record is evicted from the bounded buffer. Strategies
   * that maintain a sliding window (`lru`) decrement the per-key totals;
   * cumulative-since-start strategies (`overflow-bucket`) leave them.
   */
  onRecordEvicted(
    record: TokenUsageRecord,
    modelTotals: Map<string, KahanSum>,
    traceTotals: Map<string, KahanSum>,
  ): void;
}

/**
 * Core's historical strategy: never evict existing per-key totals; route
 * unknown keys past the capacity into {@link OVERFLOW_BUCKET_KEY}. Buffer
 * eviction does NOT decrement per-key totals (they remain cumulative).
 */
export const overflowBucketStrategy: EvictionStrategy = {
  name: 'overflow-bucket',
  resolveKeyBucket(map, key, capacity, onOverflow) {
    let sum = map.get(key);
    if (sum) return sum;
    if (map.size >= capacity) {
      onOverflow?.({ key, capacity });
      sum = map.get(OVERFLOW_BUCKET_KEY);
      if (!sum) {
        sum = new KahanSum();
        map.set(OVERFLOW_BUCKET_KEY, sum);
      }
      return sum;
    }
    sum = new KahanSum();
    map.set(key, sum);
    return sum;
  },
  onRecordEvicted(): void {
    // Cumulative semantics: do not subtract from per-key totals when a
    // record is shifted out of the bounded buffer.
  },
};

/**
 * Langfuse's historical strategy: per-key totals track the *retained window*
 * of records. Buffer eviction subtracts the evicted record's cost from the
 * matching per-model / per-trace totals so `getCostByModel()` mirrors the
 * still-addressable record set. Capacity overflow on the per-key map is
 * silent (the entry is created — the langfuse impl never sets a per-key
 * cap, so this branch is unreachable in practice).
 */
export const lruStrategy: EvictionStrategy = {
  name: 'lru',
  resolveKeyBucket(map, key) {
    let sum = map.get(key);
    if (!sum) {
      sum = new KahanSum();
      map.set(key, sum);
    }
    return sum;
  },
  onRecordEvicted(record, modelTotals, traceTotals) {
    const m = modelTotals.get(record.model);
    if (m) m.subtract(record.estimatedCost);
    const t = traceTotals.get(record.traceId);
    if (t) t.subtract(record.estimatedCost);
  },
};

/** Look up a strategy by name. */
export function getEvictionStrategy(name: EvictionStrategyName): EvictionStrategy {
  switch (name) {
    case 'overflow-bucket': return overflowBucketStrategy;
    case 'lru': return lruStrategy;
  }
}

/**
 * Wave-15: shared eviction loop used by both {@link createCostTracker} and
 * `@harness-one/langfuse`'s `createLangfuseCostTracker`. Centralizes the
 * "shift oldest, decrement running total, notify strategy" sequence so the
 * two trackers agree byte-for-byte on eviction semantics.
 *
 * The caller owns the backing buffer, running sum, and per-key maps; this
 * helper just orchestrates the eviction call order correctly.
 *
 * @example
 * ```ts
 * applyRecordCap({
 *   records, runningSum, maxRecords,
 *   modelTotals, traceTotals, strategy: lruStrategy,
 * });
 * ```
 */
export function applyRecordCap(args: {
  readonly records: TokenUsageRecord[];
  readonly runningSum: KahanSum;
  readonly maxRecords: number;
  readonly modelTotals: Map<string, KahanSum>;
  readonly traceTotals: Map<string, KahanSum>;
  readonly strategy: EvictionStrategy;
}): void {
  const { records, runningSum, maxRecords, modelTotals, traceTotals, strategy } = args;
  while (records.length > maxRecords) {
    const evicted = records.shift();
    if (!evicted) break;
    runningSum.subtract(evicted.estimatedCost);
    strategy.onRecordEvicted(evicted, modelTotals, traceTotals);
  }
}
