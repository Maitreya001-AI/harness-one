/**
 * Token cost tracking with budget alerts.
 *
 * @module
 */

import type { TokenUsageRecord, CostAlert } from './types.js';
import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { createAsyncLock } from '../infra/async-lock.js';
import { safeWarn } from '../infra/safe-log.js';
import type { Logger } from './logger.js';
import type { MetricsPort } from './metrics-port.js';
import {
  type EvictionStrategy,
  type EvictionStrategyName,
  getEvictionStrategy,
} from './cost-tracker-eviction.js';
export type { EvictionStrategy, EvictionStrategyName } from './cost-tracker-eviction.js';
export { overflowBucketStrategy, lruStrategy, getEvictionStrategy } from './cost-tracker-eviction.js';

/** Pricing configuration for a model. */
export interface ModelPricing {
  readonly model: string;
  readonly inputPer1kTokens: number;
  readonly outputPer1kTokens: number;
  readonly cacheReadPer1kTokens?: number;
  readonly cacheWritePer1kTokens?: number;
}

/**
 * Synthetic key used to bucket cost entries that arrive after the per-model or
 * per-trace capacity has been reached. See {@link CostTracker} for the
 * rationale — we never evict existing entries (SEC-009) because evictions can
 * be abused by a caller to erase legitimate totals by flooding the tracker
 * with junk keys.
 */
export const OVERFLOW_BUCKET_KEY = '__overflow__';

/** Tracker for token usage costs with budget alerting.
 *
 * Semantics of getters (CQ-009):
 *
 * - `getTotalCost()` reflects the **recent window** of kept records
 *   (bounded by `maxRecords`). When the record buffer evicts, the running
 *   sum subtracts the evicted cost, so this value tracks costs that are
 *   still addressable via `records`.
 * - `getCostByModel()` / `getCostByTrace()` are **cumulative since start**
 *   (or since the last `reset()`). They do NOT decrease when the record
 *   buffer evicts — this lets long-running jobs report end-to-end per-model
 *   spend regardless of buffer churn.
 *
 * Bounded-map semantics (SEC-009):
 *
 * - Once `modelTotals` (or `traceTotals`) reaches its cap, **existing**
 *   entries are never evicted. New, previously-unseen keys are aggregated
 *   into a synthetic `__overflow__` bucket (accessible as
 *   `OVERFLOW_BUCKET_KEY` on the returned record). This prevents a caller
 *   from flooding the tracker with junk keys to erase legitimate totals.
 */
export interface CostTracker {
  /**
   * Set pricing for one or more models.
   *
   * @deprecated P1-15: Mutators leak mutable state post-construction and
   * create non-deterministic behaviour under concurrent `recordUsage()` calls.
   * Prefer passing the full pricing set at factory time via
   * `createCostTracker({ pricing })`. A `@deprecated` warning is logged once
   * per tracker on first call; the method remains functional for backward
   * compatibility.
   */
  setPricing(pricing: ModelPricing[]): void;
  /**
   * Wave-13 C-1: Concurrency-safe pricing update. Serialises against
   * `updateBudget()` and every concurrent `updatePricing()` via an internal
   * async lock so callers running multiple fiber-style updaters do not
   * interleave writes mid-record. Prefer this over the deprecated
   * `setPricing()` for post-construction mutation.
   */
  updatePricing(pricing: ModelPricing[]): Promise<void>;
  /** Record token usage and return the record with computed cost. */
  recordUsage(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): TokenUsageRecord;
  /**
   * Update the most recent usage record for a given traceId with partial new token counts.
   * Used for streaming scenarios where token counts arrive incrementally.
   * Recalculates cost difference and adjusts the running total accordingly.
   * Returns the updated record, or undefined if no record exists for the traceId.
   */
  updateUsage(traceId: string, usage: Partial<Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp' | 'traceId' | 'model'>>): TokenUsageRecord | undefined;
  /**
   * Recent-window total cost. Tracks the running sum of kept records in the
   * bounded `records` buffer. Not strictly cumulative — evicted records are
   * subtracted (see CQ-009).
   */
  getTotalCost(): number;
  /**
   * Cumulative-since-start cost breakdown by model (see CQ-009). New unknown
   * models landing after `maxModels` is reached are aggregated under
   * `OVERFLOW_BUCKET_KEY` rather than evicting existing totals (SEC-009).
   */
  getCostByModel(): Record<string, number>;
  /**
   * Cumulative-since-start cost for a specific trace (see CQ-009). Unknown
   * traces arriving after `maxTraces` is reached bucket into
   * `OVERFLOW_BUCKET_KEY` rather than evicting (SEC-009).
   */
  getCostByTrace(traceId: string): number;
  /**
   * Set the budget limit.
   *
   * @deprecated P1-15: Prefer setting `budget` at construction time via
   * `createCostTracker({ budget })`. Runtime mutation is retained for
   * backward compatibility and logs a `@deprecated` warning on first call.
   */
  setBudget(budget: number): void;
  /**
   * Wave-13 C-1: Concurrency-safe budget update. Serialises against
   * `updatePricing()` and concurrent `updateBudget()` via an internal async
   * lock. Prefer this over the deprecated `setBudget()` for post-construction
   * mutation.
   */
  updateBudget(budget: number): Promise<void>;
  /** Check if budget thresholds have been crossed. */
  checkBudget(): CostAlert | null;
  /** Register an alert handler. Returns a cleanup function to unsubscribe. */
  onAlert(handler: (alert: CostAlert) => void): () => void;
  /** Reset all usage records. */
  reset(): void;
  /** Get a prompt-injectable alert message based on budget usage, or null if under threshold. */
  getAlertMessage(): string | null;
  /** Returns true when total cost >= budget. Returns false if no budget is set. */
  isBudgetExceeded(): boolean;
  /** Returns fraction of budget used (0-1+). Returns 0 if no budget is set. */
  budgetUtilization(): number;
  /** Returns true when the budget has been exceeded and processing should stop. */
  shouldStop(): boolean;
}

/**
 * Compensated-summation accumulator (Kahan sum).
 *
 * Standard `+=` accumulation loses precision as the running total grows large
 * relative to each added term — after millions of fractional-dollar LLM cost
 * records, naive totals can drift by cents. `KahanSum` keeps a running
 * `_compensation` term that captures the low-order bits lost in each add,
 * re-injecting them on the next iteration.
 *
 * Trade-off: each `add()` does three extra FLOPs versus a naive `+=`. Use it
 * on hot paths where (a) many small values accumulate into a large total and
 * (b) the total is itself consumed (budget checks, billing). Do not use when
 * the total is only displayed or where IEEE-754 drift is already dominated
 * by input noise.
 *
 * @example
 * ```ts
 * const sum = new KahanSum();
 * for (const record of usageRecords) sum.add(record.costUSD);
 * if (sum.total > budget) stop();
 * ```
 */
export class KahanSum {
  private _total = 0;
  private _compensation = 0;

  /** Add a value to the running sum. */
  add(x: number): void {
    const y = x - this._compensation;
    const t = this._total + y;
    this._compensation = (t - this._total) - y;
    this._total = t;
  }

  /** Subtract a value from the running sum. */
  subtract(x: number): void {
    this.add(-x);
  }

  /** Get the current accumulated total. */
  get total(): number {
    return this._total;
  }

  /** Reset the sum to zero. */
  reset(): void {
    this._total = 0;
    this._compensation = 0;
  }
}

/**
 * Create a new CostTracker instance.
 *
 * ARCH-008: Eviction semantics are pluggable via `evictionStrategy`. The
 * default `'overflow-bucket'` matches the historical core behaviour:
 *
 *   - Per-model and per-trace cumulative totals are NEVER evicted; new keys
 *     past `maxModels` / `maxTraces` are aggregated under
 *     {@link OVERFLOW_BUCKET_KEY} (SEC-009).
 *   - The bounded record buffer still shifts when oversize, decrementing
 *     `getTotalCost()` (recent-window) but leaving per-model / per-trace
 *     cumulative totals untouched.
 *
 * Pass `evictionStrategy: 'lru'` to switch to the langfuse-flavoured policy
 * where per-key totals track the retained record window. See
 * `@harness-one/langfuse`'s `createLangfuseCostTracker` for the documented
 * divergence rationale.
 *
 * @example
 * ```ts
 * const tracker = createCostTracker({
 *   pricing: [{ model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 }],
 *   budget: 10.0,
 * });
 * tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 500 });
 * console.log(tracker.getTotalCost());
 * ```
 */
export function createCostTracker(config?: {
  pricing?: ModelPricing[];
  budget?: number;
  alertThresholds?: { warning: number; critical: number };
  maxRecords?: number;
  maxModels?: number;
  maxTraces?: number;
  /**
   * ARCH-008: select per-key total semantics. Defaults to `'overflow-bucket'`
   * (cumulative since start, never evicts). `'lru'` matches Langfuse's
   * sliding-window behaviour. Accepts a strategy object directly for tests.
   */
  evictionStrategy?: EvictionStrategyName | EvictionStrategy;
  /**
   * When `true`, `recordUsage()` throws if `model` is missing or empty or if
   * `inputTokens`/`outputTokens` are non-finite — so missing data surfaces
   * loudly instead of silently recording zero-cost rows. Default: false
   * (permissive, back-compat).
   */
  strictMode?: boolean;
  /**
   * When an unpriced model is recorded, emit a one-time `console.warn`
   * naming the model so operators can update the pricing config. Default: true.
   */
  warnUnpricedModels?: boolean;
  /**
   * SEC-009: Invoked at most once per minute (per tracker) when either
   * `modelTotals` or `traceTotals` is at capacity and a new key is being
   * folded into the `__overflow__` bucket. Use for operator alerting.
   * If not provided, a warning is emitted via the structured logger at the same cadence.
   */
  onOverflow?: (info: { kind: 'model' | 'trace'; capacity: number; rejectedKey: string }) => void;
  /** Optional logger for structured warning output. Falls back to the redaction-enabled default logger. */
  logger?: Logger;
  /**
   * P2-13: Suppress duplicate budget alerts emitted within this window
   * (per alert type: `warning` / `critical` / `exceeded`). Streaming
   * `recordUsage()` calls frequently fire many updates per second; without
   * dedupe a single budget crossing can flood alert handlers. Default: 500ms.
   * Set to `0` to disable dedupe (legacy alert-every-call behaviour).
   */
  alertDedupeWindowMs?: number;
  /**
   * Wave-13 C-3: Optional metrics port used to emit a running
   * `harness.cost.utilization` gauge on every `recordUsage()` call plus a
   * `harness.cost.alerts.total` counter when an alert fires. Defaults to
   * a no-op sink so existing callers see no behaviour change.
   */
  metrics?: MetricsPort;
}): CostTracker {
  const pricing = new Map<string, ModelPricing>();
  const records: TokenUsageRecord[] = [];
  // PERF-040: Set-backed alert handler storage — O(1) unsubscribe, consistent
  // with session/orchestrator event handler patterns (LM-012 / PERF-017).
  const alertHandlers = new Set<(alert: CostAlert) => void>();
  let budget: number | undefined = config?.budget;
  const warningThreshold = config?.alertThresholds?.warning ?? 0.8;
  const criticalThreshold = config?.alertThresholds?.critical ?? 0.95;
  const maxRecords = config?.maxRecords ?? 10_000;
  const maxModels = config?.maxModels ?? 1000;
  const maxTraces = config?.maxTraces ?? 10_000;
  const strictMode = config?.strictMode ?? false;
  const warnUnpricedModels = config?.warnUnpricedModels ?? true;
  const onOverflow = config?.onOverflow;
  const logger = config?.logger;
  // Wave-13 C-3: lazy-resolved metric instruments. We intentionally resolve
  // them once per tracker so implementations that cache by name keep a stable
  // identity; no-op sinks cost nothing.
  const metricsPort = config?.metrics;
  const costUtilizationGauge = metricsPort?.gauge('harness.cost.utilization', {
    description: 'Fraction of budget consumed (0..1+) reported after every recordUsage()',
    unit: '1',
  });
  const costAlertCounter = metricsPort?.counter('harness.cost.alerts.total', {
    description: 'Count of emitted budget alerts by type',
  });
  // P2-13: alert dedupe bookkeeping. Tracks the last emission timestamp per
  // alert type; an alert re-fires only once the dedupe window has passed.
  const alertDedupeWindowMs = config?.alertDedupeWindowMs ?? 500;
  const lastAlertTs: Record<CostAlert['type'], number> = {
    warning: 0,
    critical: 0,
    exceeded: 0,
  };
  // P1-15: one-shot deprecation warnings for setPricing / setBudget.
  let setPricingDeprecationWarned = false;
  let setBudgetDeprecationWarned = false;
  // ARCH-008: pluggable eviction strategy. Accept a string or an object so
  // tests can inject custom strategies.
  const evictionStrategy: EvictionStrategy =
    typeof config?.evictionStrategy === 'object'
      ? config.evictionStrategy
      : getEvictionStrategy(config?.evictionStrategy ?? 'overflow-bucket');
  /**
   * Tracks models we've already warned about so we emit one warning per
   * unpriced model, not one per record.
   */
  const warnedUnpriced = new Set<string>();

  // SEC-009: throttle overflow signals to once per minute (per kind).
  //
  // PERF-008 historical note: an earlier proposal deferred eviction with
  // batch-evict-10% semantics to remove LRU work from the hot path. SEC-009
  // superseded this — we no longer evict existing entries at all (caller
  // keys could otherwise wipe legitimate totals), so the hot-path cost is
  // now a single `Map.size` comparison and (at most) one lookup. The check
  // cost is O(1) and does not scale with `maxModels`.
  const OVERFLOW_THROTTLE_MS = 60_000;
  const lastOverflowSignal = { model: 0, trace: 0 };

  function signalOverflow(kind: 'model' | 'trace', capacity: number, rejectedKey: string): void {
    const now = Date.now();
    if (now - lastOverflowSignal[kind] < OVERFLOW_THROTTLE_MS) return;
    lastOverflowSignal[kind] = now;
    if (onOverflow) {
      try {
        onOverflow({ kind, capacity, rejectedKey });
      } catch (err) {
        // C3: Log instead of silently swallowing — the record path must not
        // break, but operators need visibility into buggy callbacks.
        safeWarn(
          logger,
          `[harness-one/cost-tracker] onOverflow callback threw for ${kind} (key: "${rejectedKey}"): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      safeWarn(
        logger,
        `[harness-one/cost-tracker] ${kind} total map at capacity (${capacity}); aggregating new keys into "${OVERFLOW_BUCKET_KEY}". First rejected key: "${rejectedKey}".`,
      );
    }
  }

  // Fix 5: Use KahanSum utility for running total
  const runningSum = new KahanSum();

  // Wave-13 C-1: Internal async lock serialising post-construction mutators
  // (`updatePricing`, `updateBudget`). The synchronous hot path
  // (`recordUsage`, `updateUsage`, `checkBudget`) is single-JS-tick and
  // doesn't yield, so it cannot observe a partially-applied update — but
  // concurrent `await updatePricing(...)` calls from separate fibers CAN
  // interleave without serialisation, hence the lock.
  const mutationLock = createAsyncLock();

  // Fix 4: Track cumulative per-model costs separately from the buffer.
  // modelTotals accumulates costs permanently (not affected by buffer eviction),
  // ensuring getCostByModel() stays consistent with getTotalCost().
  const modelTotals = new Map<string, KahanSum>();

  // PERF-03: Secondary index for O(1) getCostByTrace lookups
  const traceTotals = new Map<string, KahanSum>();

  // Wave-13 P0-6: Secondary index mapping traceId → SORTED array of record
  // indices that currently belong to that trace. Earlier versions stored only
  // the latest index (scalar) and had to do an O(n) backward scan after every
  // `records.shift()` to find the next-most-recent index when the evicted slot
  // was index 0 — O(n²) under streaming load.
  //
  // New layout:
  //   - Every recordUsage() pushes `records.length - 1` onto the traceId's list.
  //   - updateUsage() uses `list[list.length - 1]` for the freshest index.
  //   - On buffer eviction (records.shift()) the head-most index is slot 0, so
  //     the affected traceId's list shifts its front (O(1) amortised), while
  //     every OTHER traceId's list only needs each element decremented by 1.
  //     Decrement is implemented via a single integer offset applied at read
  //     time — so the amortised cost of eviction becomes O(unique traces on
  //     evicted record) rather than O(records).
  //
  // `evictionBias` is the cumulative number of shifts that have happened. All
  // indices stored in `traceIdIndex` arrays are RAW (original push order); the
  // effective slot for a raw value `r` is `r - evictionBias`.
  const traceIdIndex = new Map<string, number[]>();
  let evictionBias = 0;

  if (config?.pricing) {
    for (const p of config.pricing) {
      pricing.set(p.model, p);
    }
  }

  function computeCost(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): number {
    const p = pricing.get(usage.model);
    if (!p) return 0;

    // Guard against NaN/Infinity tokens propagating through budget enforcement.
    if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) {
      safeWarn(
        logger,
        `[harness-one/cost-tracker] Non-finite token count for model "${usage.model}" (input=${usage.inputTokens}, output=${usage.outputTokens}). Returning cost 0.`,
      );
      return 0;
    }

    let cost = 0;
    cost += (usage.inputTokens / 1000) * p.inputPer1kTokens;
    cost += (usage.outputTokens / 1000) * p.outputPer1kTokens;
    if (usage.cacheReadTokens && p.cacheReadPer1kTokens) {
      cost += (usage.cacheReadTokens / 1000) * p.cacheReadPer1kTokens;
    }
    if (usage.cacheWriteTokens && p.cacheWritePer1kTokens) {
      cost += (usage.cacheWriteTokens / 1000) * p.cacheWritePer1kTokens;
    }
    return Math.round(cost * 1_000_000) / 1_000_000;  // Round to 6 decimal places (micro-dollar precision)
  }

  function emitAlert(alert: CostAlert): void {
    // P2-13: dedupe within a time window, per alert type. A single budget
    // crossing during a streaming recordUsage() burst should produce exactly
    // one alert per type until the window elapses.
    if (alertDedupeWindowMs > 0) {
      const now = Date.now();
      const last = lastAlertTs[alert.type];
      if (last !== 0 && (now - last) < alertDedupeWindowMs) {
        return;
      }
      lastAlertTs[alert.type] = now;
    }
    // Wave-13 C-3: emit a structured warn + metric alongside every alert so
    // budget crossings surface in logs / observability backends, not just
    // via the user `onAlert()` callback (which may be unset).
    if (logger) {
      try {
        logger.warn('[harness-one/cost-tracker] budget alert', {
          type: alert.type,
          percent_used: alert.percentUsed,
          current_cost: alert.currentCost,
          budget: alert.budget,
        });
      } catch { /* logger failure non-fatal */ }
    }
    costAlertCounter?.add(1, { type: alert.type });
    for (const handler of alertHandlers) {
      handler(alert);
    }
  }

  /**
   * Wave-13 C-3: utility — report the current utilization fraction to the
   * metrics port after every recordUsage()/updateUsage() call, even when no
   * alert fires. Operators get a continuous signal rather than a sawtooth of
   * threshold crossings.
   */
  function reportUtilization(): void {
    if (!costUtilizationGauge || budget === undefined || budget <= 0) return;
    costUtilizationGauge.record(runningSum.total / budget);
  }

  // Issue 1: Standalone functions using closure references instead of `this`
  function checkBudgetFn(): CostAlert | null {
    if (budget === undefined || budget <= 0) return null;
    const currentCost = runningSum.total;
    const percentUsed = currentCost / budget;

    if (percentUsed >= 1.0) {
      return {
        type: 'exceeded',
        currentCost,
        budget,
        percentUsed,
        message: `Exceeded: ${(percentUsed * 100).toFixed(1)}% of budget used ($${currentCost.toFixed(4)} / $${budget.toFixed(2)})`,
      };
    }
    if (percentUsed >= criticalThreshold) {
      return {
        type: 'critical',
        currentCost,
        budget,
        percentUsed,
        message: `Critical: ${(percentUsed * 100).toFixed(1)}% of budget used ($${currentCost.toFixed(4)} / $${budget.toFixed(2)})`,
      };
    }
    if (percentUsed >= warningThreshold) {
      return {
        type: 'warning',
        currentCost,
        budget,
        percentUsed,
        message: `Warning: ${(percentUsed * 100).toFixed(1)}% of budget used ($${currentCost.toFixed(4)} / $${budget.toFixed(2)})`,
      };
    }
    return null;
  }

  function getAlertMessageFn(): string | null {
    if (budget === undefined) return null;
    const currentCost = runningSum.total;
    const percentUsed = currentCost / budget;

    if (percentUsed >= 1.0) {
      return `[BUDGET EXCEEDED] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Stop all non-essential operations.`;
    }
    if (percentUsed >= criticalThreshold) {
      return `[BUDGET CRITICAL] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Be extremely concise.`;
    }
    if (percentUsed >= warningThreshold) {
      return `[BUDGET WARNING] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Please be concise.`;
    }
    return null;
  }

  function isBudgetExceededFn(): boolean {
    if (budget === undefined || budget <= 0) return false;
    return runningSum.total >= budget;
  }

  function budgetUtilizationFn(): number {
    if (budget === undefined || budget <= 0) return 0;
    return runningSum.total / budget;
  }

  function shouldStopFn(): boolean {
    return isBudgetExceededFn();
  }

  return {
    setPricing(newPricing: ModelPricing[]): void {
      // P1-15: emit one-shot @deprecated warning. Preferred path is factory
      // config (`createCostTracker({ pricing })`). We keep this operational
      // indefinitely for backward compatibility.
      if (!setPricingDeprecationWarned) {
        setPricingDeprecationWarned = true;
        safeWarn(
          logger,
          '[harness-one/cost-tracker] @deprecated setPricing() mutates tracker state post-construction. Prefer passing `pricing` to createCostTracker() at factory time.',
        );
      }
      for (const p of newPricing) {
        pricing.set(p.model, p);
      }
    },

    async updatePricing(newPricing: ModelPricing[]): Promise<void> {
      // Wave-13 C-1: serialise against concurrent updatePricing/updateBudget.
      await mutationLock.withLock(async () => {
        for (const p of newPricing) {
          pricing.set(p.model, p);
        }
      });
    },

    recordUsage(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): TokenUsageRecord {
      // Strict-mode validation: fail loudly when the adapter has failed to
      // populate model or token counts. Permissive default preserves the
      // historical behavior where streaming adapters may record partial data.
      if (strictMode) {
        if (!usage.model || typeof usage.model !== 'string' || usage.model.length === 0) {
          throw new HarnessError(
            'CostTracker.recordUsage: usage.model is required in strict mode',
            HarnessErrorCode.CORE_INVALID_INPUT,
            'Provide a non-empty model identifier, or disable strictMode',
          );
        }
        if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) {
          throw new HarnessError(
            'CostTracker.recordUsage: inputTokens/outputTokens must be finite numbers in strict mode',
            HarnessErrorCode.CORE_INVALID_INPUT,
            'Ensure adapter populates usage, or disable strictMode',
          );
        }
      }

      // One-time warning for unpriced models (so operators can update pricing).
      if (warnUnpricedModels && usage.model && !pricing.has(usage.model) && !warnedUnpriced.has(usage.model)) {
        warnedUnpriced.add(usage.model);
        safeWarn(
          logger,
          `[harness-one/cost-tracker] No pricing registered for model "${usage.model}". Cost will be reported as 0. Call setPricing() to fix.`,
        );
      }

      const estimatedCost = computeCost(usage);
      const record: TokenUsageRecord = {
        ...usage,
        estimatedCost,
        timestamp: Date.now(),
      };
      records.push(record);

      // Wave-13 P0-6: Append raw (pre-bias) index to this traceId's sorted list.
      // Raw index space is monotone; effective slot = raw - evictionBias.
      if (usage.traceId) {
        const rawIdx = records.length - 1 + evictionBias;
        const list = traceIdIndex.get(usage.traceId);
        if (list) list.push(rawIdx);
        else traceIdIndex.set(usage.traceId, [rawIdx]);
      }

      // Fix 5: Use KahanSum for running total
      runningSum.add(estimatedCost);

      // ARCH-008: Per-key bucket resolution is delegated to the configured
      // EvictionStrategy. The default `'overflow-bucket'` strategy preserves
      // SEC-009 semantics: existing totals are never evicted, new keys past
      // capacity land in OVERFLOW_BUCKET_KEY. The throttled `signalOverflow`
      // callback fires once per minute (per kind) to alert operators.
      const modelSum = evictionStrategy.resolveKeyBucket(
        modelTotals,
        usage.model,
        maxModels,
        ({ key }) => signalOverflow('model', maxModels, key),
      );
      if (modelSum) modelSum.add(estimatedCost);

      if (usage.traceId) {
        const traceSum = evictionStrategy.resolveKeyBucket(
          traceTotals,
          usage.traceId,
          maxTraces,
          ({ key }) => signalOverflow('trace', maxTraces, key),
        );
        if (traceSum) traceSum.add(estimatedCost);
      }

      if (records.length > maxRecords) {
        const evicted = records.shift() as (typeof records)[number];
        runningSum.subtract(evicted.estimatedCost);
        // ARCH-008: cumulative-since-start strategies leave per-key totals
        // untouched; sliding-window strategies (`lru`) decrement them here.
        evictionStrategy.onRecordEvicted(evicted, modelTotals, traceTotals);

        // Wave-13 P0-6: O(1) amortised eviction bookkeeping. The evicted
        // record occupied effective slot 0 → raw index == evictionBias. Only
        // the affected traceId's list needs surgery: its head entry (the
        // minimum raw index) is popped; every other traceId is unchanged in
        // raw space. `evictionBias` is bumped so getters translate correctly.
        if (evicted.traceId) {
          const list = traceIdIndex.get(evicted.traceId);
          if (list && list.length > 0 && list[0] === evictionBias) {
            list.shift();
            if (list.length === 0) traceIdIndex.delete(evicted.traceId);
          }
        }
        evictionBias++;
      }

      // Check budget alerts after recording
      if (budget !== undefined) {
        // Wave-13 C-3: report utilization on every update, not only on
        // threshold crossings.
        reportUtilization();
        const alert = checkBudgetFn();
        if (alert) {
          emitAlert(alert);
        }
      }

      return record;
    },

    updateUsage(traceId: string, usage: Partial<Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp' | 'traceId' | 'model'>>): TokenUsageRecord | undefined {
      // Wave-13 P0-6: the freshest raw index lives at the tail of the list.
      // Translate via evictionBias to the live buffer slot. Any stale index
      // below bias would indicate a bookkeeping bug — treat as miss.
      const list = traceIdIndex.get(traceId);
      if (!list || list.length === 0) return undefined;
      const rawIdx = list[list.length - 1];
      const existingIndex = rawIdx - evictionBias;
      if (existingIndex < 0 || existingIndex >= records.length) return undefined;
      const existingRecord = records[existingIndex];
      if (!existingRecord) return undefined;

      if (usage.inputTokens !== undefined && usage.inputTokens < existingRecord.inputTokens) {
        throw new HarnessError(
          `Cannot reduce inputTokens from ${existingRecord.inputTokens} to ${usage.inputTokens}`,
          HarnessErrorCode.CORE_INVALID_INPUT,
          'Token counts can only increase via updateUsage()',
        );
      }
      if (usage.outputTokens !== undefined && usage.outputTokens < existingRecord.outputTokens) {
        throw new HarnessError(
          `Cannot reduce outputTokens from ${existingRecord.outputTokens} to ${usage.outputTokens}`,
          HarnessErrorCode.CORE_INVALID_INPUT,
          'Token counts can only increase via updateUsage()',
        );
      }

      // Wave-13 C-2: explicit field assignment avoids the conditional-spread
      // pattern that allocated `{}` / `{cacheReadTokens: ...}` temporaries on
      // every call. Uses a `Partial<...>` scratch object so optional fields
      // are only written when they carry a value (respecting the project-wide
      // `exactOptionalPropertyTypes: true` tsconfig).
      const updatedFields: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'> = {
        traceId: existingRecord.traceId,
        model: existingRecord.model,
        inputTokens: usage.inputTokens ?? existingRecord.inputTokens,
        outputTokens: usage.outputTokens ?? existingRecord.outputTokens,
      };
      if (usage.cacheReadTokens !== undefined) {
        (updatedFields as { cacheReadTokens?: number }).cacheReadTokens = usage.cacheReadTokens;
      } else if (existingRecord.cacheReadTokens !== undefined) {
        (updatedFields as { cacheReadTokens?: number }).cacheReadTokens = existingRecord.cacheReadTokens;
      }
      if (usage.cacheWriteTokens !== undefined) {
        (updatedFields as { cacheWriteTokens?: number }).cacheWriteTokens = usage.cacheWriteTokens;
      } else if (existingRecord.cacheWriteTokens !== undefined) {
        (updatedFields as { cacheWriteTokens?: number }).cacheWriteTokens = existingRecord.cacheWriteTokens;
      }

      const newCost = computeCost(updatedFields);
      const oldCost = existingRecord.estimatedCost;
      const costDelta = newCost - oldCost;

      const updatedRecord: TokenUsageRecord = {
        ...updatedFields,
        estimatedCost: newCost,
        timestamp: existingRecord.timestamp,
      };

      // Mutate in place (same array slot — no eviction impact)
      records[existingIndex] = updatedRecord;

      // Adjust running totals
      runningSum.add(costDelta);

      const modelSum = modelTotals.get(existingRecord.model);
      if (modelSum) {
        modelSum.add(costDelta);
      }

      // PERF-03: Adjust trace total for O(1) getCostByTrace
      const traceSum = traceTotals.get(traceId);
      if (traceSum) {
        traceSum.add(costDelta);
      }

      // Check budget alerts after update
      if (budget !== undefined) {
        const alert = checkBudgetFn();
        if (alert) {
          emitAlert(alert);
        }
      }

      return updatedRecord;
    },

    getTotalCost(): number {
      return runningSum.total;
    },

    // Fix 4: getCostByModel() returns from permanent modelTotals accumulator,
    // consistent with getTotalCost() even after buffer eviction.
    getCostByModel(): Record<string, number> {
      const result: Record<string, number> = {};
      for (const [model, sum] of modelTotals) {
        result[model] = sum.total;
      }
      return result;
    },

    getCostByTrace(traceId: string): number {
      return traceTotals.get(traceId)?.total ?? 0;
    },

    /**
     * Set the budget limit for cost alerting.
     *
     * Alerts are only re-evaluated on the next recordUsage() call, not
     * immediately on budget change. If the current cost already exceeds
     * the new budget, the alert will fire on the next recordUsage().
     *
     * @deprecated P1-15: prefer `createCostTracker({ budget })` at factory
     * time. Emits a one-shot `@deprecated` warning on first call; remains
     * operational for backward compatibility.
     */
    setBudget(newBudget: number): void {
      if (!setBudgetDeprecationWarned) {
        setBudgetDeprecationWarned = true;
        safeWarn(
          logger,
          '[harness-one/cost-tracker] @deprecated setBudget() mutates tracker state post-construction. Prefer passing `budget` to createCostTracker() at factory time.',
        );
      }
      budget = newBudget;
    },

    async updateBudget(newBudget: number): Promise<void> {
      // Wave-13 C-1: serialise against concurrent updatePricing/updateBudget.
      await mutationLock.withLock(async () => {
        budget = newBudget;
      });
    },

    checkBudget: checkBudgetFn,

    onAlert(handler: (alert: CostAlert) => void): () => void {
      alertHandlers.add(handler);
      return () => {
        alertHandlers.delete(handler);
      };
    },

    reset(): void {
      records.length = 0;
      runningSum.reset();
      modelTotals.clear();
      traceTotals.clear();
      traceIdIndex.clear();
      // Wave-13 P0-6: reset the bias so fresh records start at raw index 0.
      evictionBias = 0;
      // P2-13: reset dedupe state so alerts can re-fire after an explicit
      // reset (tests + operator-driven "checkpoint" workflows).
      lastAlertTs.warning = 0;
      lastAlertTs.critical = 0;
      lastAlertTs.exceeded = 0;
    },

    getAlertMessage: getAlertMessageFn,

    isBudgetExceeded: isBudgetExceededFn,

    budgetUtilization: budgetUtilizationFn,

    shouldStop: shouldStopFn,
  };
}
