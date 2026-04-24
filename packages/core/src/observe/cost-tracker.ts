/**
 * Token cost tracking with budget alerts.
 *
 * ## Neighbour files
 *
 * Cost math lives in `../core/pricing.ts` and this subsystem retains three
 * sibling files that together make up the cost surface:
 *
 *   - `cost-tracker-types.ts` — the public `ModelPricing` / `CostTracker`
 *     types and the `OVERFLOW_BUCKET_KEY` sentinel.
 *   - `cost-tracker-eviction.ts` — the `EvictionStrategy` protocol and the
 *     two in-box strategies (`overflow-bucket`, `lru`). Pluggable, so it
 *     stays split.
 *   - `cost-alert-manager.ts` — the alert fan-out / dedupe / threshold
 *     engine. Inverted-control via `getCurrentCost()` thunk so it holds no
 *     reference to tracker state.
 *
 * Everything else (record buffer, running sums, per-model/per-trace totals,
 * eviction bookkeeping, alert wiring) lives in this file.
 *
 * @module
 */

import type { TokenUsageRecord } from '../core/pricing.js';
import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { createAsyncLock } from '../infra/async-lock.js';
import { KahanSum } from '../infra/kahan-sum.js';
import { safeWarn } from '../infra/safe-log.js';
import type { Logger } from './logger.js';
import type { MetricsPort } from '../core/metrics-port.js';
import {
  type EvictionStrategy,
  type EvictionStrategyName,
  getEvictionStrategy,
} from './cost-tracker-eviction.js';
// priceUsage / hasNonFiniteTokens live in the canonical pricing home
// (`core/pricing.ts`).
import { priceUsage, hasNonFiniteTokens } from '../core/pricing.js';
import type { ModelPricing, CostTracker } from './cost-tracker-types.js';
import { createCostAlertManager } from './cost-alert-manager.js';
import { createCostRecordBuffer } from './cost-record-buffer.js';
export type { EvictionStrategy, EvictionStrategyName } from './cost-tracker-eviction.js';
export { overflowBucketStrategy, lruStrategy, getEvictionStrategy } from './cost-tracker-eviction.js';
export type { ModelPricing, CostTracker } from './cost-tracker-types.js';
export { OVERFLOW_BUCKET_KEY } from './cost-tracker-types.js';
import { OVERFLOW_BUCKET_KEY } from './cost-tracker-types.js';

// Re-export KahanSum for back-compat: it used to live in this file.
export { KahanSum } from '../infra/kahan-sum.js';

/**
 * Create a new CostTracker instance.
 *
 * Eviction semantics are pluggable via `evictionStrategy`. The default
 * `'overflow-bucket'` matches the core behaviour:
 *
 *   - Per-model and per-trace cumulative totals are NEVER evicted; new keys
 *     past `maxModels` / `maxTraces` are aggregated under
 *     `OVERFLOW_BUCKET_KEY`.
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
  const buffer = createCostRecordBuffer({ maxRecords: config?.maxRecords ?? 10_000 });
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

  // The bounded record buffer (with per-trace lookup index + raw/effective
  // index translation) lives in `cost-record-buffer.ts` so this file only
  // owns running totals, alert dispatch, and pricing snapshots.

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
        // Pricing edits don't rewrite existing record costs, but a future
        // `recordUsage` may land on a re-priced model. Dropping the cache
        // keeps the snapshot fresh while staying O(1) on steady state.
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
      // Append to the bounded buffer; the buffer also owns the per-trace
      // index + raw/effective bias bookkeeping. Returns the evicted record
      // when the push pushed the buffer over `maxRecords`.
      const evicted = buffer.push(record);
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

      if (evicted) {
        runningSum.subtract(evicted.estimatedCost);
        // Cumulative-since-start strategies leave per-key totals untouched;
        // sliding-window strategies (`lru`) decrement them here.
        evictionStrategy.onRecordEvicted(evicted, modelTotals, traceTotals);
      }

      // Check budget alerts after recording. Report utilization on every
      // update, not only on threshold crossings, so dashboards see a
      // continuous signal.
      if (alertManager.getBudget() !== undefined) {
        reportUtilization();
        const alert = alertManager.checkBudget();
        if (alert) alertManager.emit(alert);
      }

      return record;
    },

    updateUsage(traceId: string, usage: Partial<Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp' | 'traceId' | 'model'>>): TokenUsageRecord | undefined {
      // The buffer owns the raw/effective index translation; we ask for the
      // freshest live record via a single lookup that returns a `replace`
      // closure for in-place mutation.
      const handle = buffer.getLatestForTrace(traceId);
      if (!handle) return undefined;
      const existingRecord = handle.record;

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

      // Mutate in place (same array slot — no eviction impact).
      handle.replace(updatedRecord);

      // Adjust running totals
      runningSum.add(costDelta);
      // Per-model total shifted; invalidate the cached snapshot.

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

    // Returns from the permanent `modelTotals` accumulator so the sum
    // stays consistent with getTotalCost() even after buffer eviction.
    //
    // A FRESH Map is constructed on every call: callers routinely mutate
    // the returned value in ad-hoc dashboards or inject synthetic
    // "all models" rows, and reusing a cached snapshot would leak those
    // mutations back into subsequent callers. Construction is O(N) over
    // `modelTotals`; for poll-driven consumers that matters only past
    // ~10k models, at which point the dashboard should be paging anyway.
    getCostByModel(): ReadonlyMap<string, number> {
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
      buffer.clear();
      runningSum.reset();
      modelTotals.clear();
      traceTotals.clear();
      // Reset dedupe state so alerts can re-fire after an explicit reset
      // (tests + operator-driven "checkpoint" workflows).
      alertManager.resetDedupe();
      // Reset overflow-signal throttle: without this, an overflow observed
      // before reset() could silently suppress the first overflow after
      // reset() for up to OVERFLOW_THROTTLE_MS.
      lastOverflowSignal.model = 0;
      lastOverflowSignal.trace = 0;
      // Forget unpriced-model warnings so tests/checkpoint cycles see the
      // first-time warn on every fresh run.
      warnedUnpriced.clear();
      // The snapshot is empty now; drop the cache.
    },

    getAlertMessage: () => alertManager.getAlertMessage(),

    isBudgetExceeded: () => alertManager.isBudgetExceeded(),

    budgetUtilization: () => alertManager.budgetUtilization(),

    shouldStop: () => alertManager.shouldStop(),
  };
}
