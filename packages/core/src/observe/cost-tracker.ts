/**
 * Token cost tracking with budget alerts.
 *
 * @module
 */

import type { TokenUsageRecord } from './types.js';
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
import { KahanSum, priceUsage, hasNonFiniteTokens } from './cost-math.js';
import type { ModelPricing, CostTracker } from './cost-tracker-types.js';
import { createCostAlertManager } from './cost-alert-manager.js';
export type { EvictionStrategy, EvictionStrategyName } from './cost-tracker-eviction.js';
export { overflowBucketStrategy, lruStrategy, getEvictionStrategy } from './cost-tracker-eviction.js';
export type { ModelPricing, CostTracker } from './cost-tracker-types.js';
export { OVERFLOW_BUCKET_KEY } from './cost-tracker-types.js';
import { OVERFLOW_BUCKET_KEY } from './cost-tracker-types.js';

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
export { KahanSum } from './cost-math.js';

/**
 * Create a new CostTracker instance.
 *
 * Eviction semantics are pluggable via `evictionStrategy`. The default
 * `'overflow-bucket'` matches the core behaviour:
 *
 *   - Per-model and per-trace cumulative totals are NEVER evicted; new keys
 *     past `maxModels` / `maxTraces` are aggregated under
 *     {@link OVERFLOW_BUCKET_KEY}.
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
   * Select per-key total semantics. Defaults to `'overflow-bucket'`
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
   * Invoked at most once per minute (per tracker) when either `modelTotals`
   * or `traceTotals` is at capacity and a new key is being folded into the
   * `__overflow__` bucket. Use for operator alerting. If not provided, a
   * warning is emitted via the structured logger at the same cadence.
   */
  onOverflow?: (info: { kind: 'model' | 'trace'; capacity: number; rejectedKey: string }) => void;
  /** Optional logger for structured warning output. Falls back to the redaction-enabled default logger. */
  logger?: Logger;
  /**
   * Suppress duplicate budget alerts emitted within this window (per alert
   * type: `warning` / `critical` / `exceeded`). Streaming `recordUsage()`
   * calls frequently fire many updates per second; without dedupe a single
   * budget crossing can flood alert handlers. Default: 500ms. Set to `0` to
   * disable dedupe.
   */
  alertDedupeWindowMs?: number;
  /**
   * Optional metrics port used to emit a running `harness.cost.utilization`
   * gauge on every `recordUsage()` call plus a `harness.cost.alerts.total`
   * counter when an alert fires. Defaults to a no-op sink so existing
   * callers see no behaviour change.
   */
  metrics?: MetricsPort;
}): CostTracker {
  const pricing = new Map<string, ModelPricing>();
  const records: TokenUsageRecord[] = [];
  const maxRecords = config?.maxRecords ?? 10_000;
  const maxModels = config?.maxModels ?? 1000;
  const maxTraces = config?.maxTraces ?? 10_000;
  const strictMode = config?.strictMode ?? false;
  const warnUnpricedModels = config?.warnUnpricedModels ?? true;
  const onOverflow = config?.onOverflow;
  const logger = config?.logger;
  // Lazy-resolved metric instruments. We intentionally resolve them once per
  // tracker so implementations that cache by name keep a stable identity;
  // no-op sinks cost nothing.
  const metricsPort = config?.metrics;
  const costUtilizationGauge = metricsPort?.gauge('harness.cost.utilization', {
    description: 'Fraction of budget consumed (0..1+) reported after every recordUsage()',
    unit: '1',
  });

  // Running total uses Kahan summation to avoid float drift. Created early
  // so the alert manager's `getCurrentCost` thunk closes over it.
  const runningSum = new KahanSum();

  // Budget alerts, thresholds, and handler fan-out live on a dedicated
  // component. Alert-counter metric emission is wired through this manager.
  const alertManager = createCostAlertManager({
    ...(config?.budget !== undefined && { budget: config.budget }),
    ...(config?.alertThresholds !== undefined && {
      alertThresholds: config.alertThresholds,
    }),
    ...(config?.alertDedupeWindowMs !== undefined && {
      alertDedupeWindowMs: config.alertDedupeWindowMs,
    }),
    ...(logger !== undefined && { logger }),
    ...(metricsPort !== undefined && { metrics: metricsPort }),
    getCurrentCost: () => runningSum.total,
  });
  // Pluggable eviction strategy. Accept a string or an object so tests can
  // inject custom strategies.
  const evictionStrategy: EvictionStrategy =
    typeof config?.evictionStrategy === 'object'
      ? config.evictionStrategy
      : getEvictionStrategy(config?.evictionStrategy ?? 'overflow-bucket');
  /**
   * Tracks models we've already warned about so we emit one warning per
   * unpriced model, not one per record.
   */
  const warnedUnpriced = new Set<string>();

  // Throttle overflow signals to once per minute (per kind). We never evict
  // existing entries (caller keys could otherwise wipe legitimate totals),
  // so the hot-path cost is a single `Map.size` comparison and (at most)
  // one lookup — O(1), does not scale with `maxModels`.
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
        // Log instead of silently swallowing — the record path must not
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

  // Internal async lock serialising post-construction mutators
  // (`updatePricing`, `updateBudget`). The synchronous hot path
  // (`recordUsage`, `updateUsage`, `checkBudget`) is single-JS-tick and
  // doesn't yield, so it cannot observe a partially-applied update — but
  // concurrent `await updatePricing(...)` calls from separate fibers CAN
  // interleave without serialisation, hence the lock.
  const mutationLock = createAsyncLock();

  // Track cumulative per-model costs separately from the buffer.
  // modelTotals accumulates costs permanently (not affected by buffer eviction),
  // ensuring getCostByModel() stays consistent with getTotalCost().
  const modelTotals = new Map<string, KahanSum>();

  // Secondary index for O(1) getCostByTrace lookups.
  const traceTotals = new Map<string, KahanSum>();

  // Secondary index mapping traceId → SORTED array of record indices that
  // currently belong to that trace.
  //
  // Layout:
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
    if (hasNonFiniteTokens(usage)) {
      safeWarn(
        logger,
        `[harness-one/cost-tracker] Non-finite token count for model "${usage.model}" (input=${usage.inputTokens}, output=${usage.outputTokens}). Returning cost 0.`,
      );
      return 0;
    }
    return priceUsage(usage, pricing.get(usage.model));
  }

  /**
   * Report the current utilization fraction to the metrics port after every
   * recordUsage()/updateUsage() call, even when no alert fires. Operators
   * get a continuous signal rather than a sawtooth of threshold crossings.
   */
  function reportUtilization(): void {
    if (!costUtilizationGauge) return;
    const currentBudget = alertManager.getBudget();
    if (currentBudget === undefined || currentBudget <= 0) return;
    costUtilizationGauge.record(runningSum.total / currentBudget);
  }

  return {
    async updatePricing(newPricing: ModelPricing[]): Promise<void> {
      // Serialise against concurrent updatePricing/updateBudget.
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
          `[harness-one/cost-tracker] No pricing registered for model "${usage.model}". Cost will be reported as 0. Pass \`pricing\` to createCostTracker() or call updatePricing() to fix.`,
        );
      }

      const estimatedCost = computeCost(usage);
      const record: TokenUsageRecord = {
        ...usage,
        estimatedCost,
        timestamp: Date.now(),
      };
      records.push(record);

      // Append raw (pre-bias) index to this traceId's sorted list. Raw index
      // space is monotone; effective slot = raw - evictionBias.
      if (usage.traceId) {
        const rawIdx = records.length - 1 + evictionBias;
        const list = traceIdIndex.get(usage.traceId);
        if (list) list.push(rawIdx);
        else traceIdIndex.set(usage.traceId, [rawIdx]);
      }

      runningSum.add(estimatedCost);

      // Per-key bucket resolution is delegated to the configured
      // EvictionStrategy. The default `'overflow-bucket'` strategy: existing
      // totals are never evicted, new keys past capacity land in
      // OVERFLOW_BUCKET_KEY. The throttled `signalOverflow` callback fires
      // once per minute (per kind) to alert operators.
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
        // Cumulative-since-start strategies leave per-key totals untouched;
        // sliding-window strategies (`lru`) decrement them here.
        evictionStrategy.onRecordEvicted(evicted, modelTotals, traceTotals);

        // O(1) amortised eviction bookkeeping. The evicted record occupied
        // effective slot 0 → raw index == evictionBias. Only the affected
        // traceId's list needs surgery: its head entry (the minimum raw
        // index) is popped; every other traceId is unchanged in raw space.
        // `evictionBias` is bumped so getters translate correctly.
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
      if (alertManager.getBudget() !== undefined) {
        // Report utilization on every update, not only on threshold crossings.
        reportUtilization();
        const alert = alertManager.checkBudget();
        if (alert) alertManager.emit(alert);
      }

      return record;
    },

    updateUsage(traceId: string, usage: Partial<Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp' | 'traceId' | 'model'>>): TokenUsageRecord | undefined {
      // The freshest raw index lives at the tail of the list. Translate via
      // evictionBias to the live buffer slot. Any stale index below bias
      // would indicate a bookkeeping bug — treat as miss.
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

      // Explicit field assignment avoids the conditional-spread pattern that
      // allocated `{}` / `{cacheReadTokens: ...}` temporaries on every call.
      // Uses a `Partial<...>` scratch object so optional fields are only
      // written when they carry a value (respecting the project-wide
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

      // Adjust trace total for O(1) getCostByTrace.
      const traceSum = traceTotals.get(traceId);
      if (traceSum) {
        traceSum.add(costDelta);
      }

      // Check budget alerts after update
      if (alertManager.getBudget() !== undefined) {
        const alert = alertManager.checkBudget();
        if (alert) alertManager.emit(alert);
      }

      return updatedRecord;
    },

    getTotalCost(): number {
      return runningSum.total;
    },

    // getCostByModel() returns from permanent modelTotals accumulator,
    // consistent with getTotalCost() even after buffer eviction.
    getCostByModel(): Record<string, number> {
      const result: Record<string, number> = {};
      for (const [model, sum] of modelTotals) {
        result[model] = sum.total;
      }
      return result;
    },

    getCostByModelMap(): ReadonlyMap<string, number> {
      // Snapshot a frozen copy so callers cannot mutate the internal
      // KahanSum map. The snapshot preserves insertion order.
      const snapshot = new Map<string, number>();
      for (const [model, sum] of modelTotals) {
        snapshot.set(model, sum.total);
      }
      return snapshot;
    },

    getCostByTrace(traceId: string): number {
      return traceTotals.get(traceId)?.total ?? 0;
    },

    async updateBudget(newBudget: number): Promise<void> {
      // Serialise against concurrent updatePricing/updateBudget.
      await mutationLock.withLock(async () => {
        alertManager.updateBudget(newBudget);
      });
    },

    checkBudget: () => alertManager.checkBudget(),

    onAlert: (handler) => alertManager.registerHandler(handler),

    reset(): void {
      records.length = 0;
      runningSum.reset();
      modelTotals.clear();
      traceTotals.clear();
      traceIdIndex.clear();
      // Reset the bias so fresh records start at raw index 0.
      evictionBias = 0;
      // Reset dedupe state so alerts can re-fire after an explicit reset
      // (tests + operator-driven "checkpoint" workflows).
      alertManager.resetDedupe();
    },

    getAlertMessage: () => alertManager.getAlertMessage(),

    isBudgetExceeded: () => alertManager.isBudgetExceeded(),

    budgetUtilization: () => alertManager.budgetUtilization(),

    shouldStop: () => alertManager.shouldStop(),
  };
}
