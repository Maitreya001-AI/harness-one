/**
 * @harness-one/langfuse — Langfuse integration for harness-one.
 *
 * Provides trace export, prompt management, and cost tracking via Langfuse.
 *
 * @module
 */

import type { Langfuse } from 'langfuse';
import type { TraceExporter, Trace, Span } from 'harness-one/observe';
import type { PromptBackend, PromptTemplate } from 'harness-one/prompt';
import type { CostTracker, ModelPricing, Logger } from 'harness-one/observe';
import type { TokenUsageRecord, CostAlert } from 'harness-one/observe';
import { KahanSum, lruStrategy, safeWarn } from 'harness-one/observe';
import type { EvictionStrategy } from 'harness-one/observe';
import { HarnessError, HarnessErrorCode} from 'harness-one/core';

// ---------------------------------------------------------------------------
// SEC-A01 (T04) · Default sanitize for exported span attributes
// ---------------------------------------------------------------------------
//
// `createLangfuseExporter` is secure-by-default: when the caller does not
// supply `config.sanitize`, the exporter redacts sensitive keys (API keys,
// tokens, passwords, cookies, …) and drops prototype-polluting keys before
// shipping attributes to Langfuse. The caller may override by passing any
// `sanitize(attrs) => attrs`, but there is NO opt-out — the exporter can
// only be given a different scrubber, never a disabled one.
//
// The implementation is intentionally self-contained: core's
// `sanitizeAttributes` / `createRedactor` live in `infra/` and are not
// part of the public `harness-one/observe` surface. Inlining the same rules
// (mirrored 1:1 from `infra/redact.ts`) keeps the package's dependency
// on `harness-one` bounded to its public exports.

const LANGFUSE_REDACTED_VALUE = '[REDACTED]';

/**
 * Mirrors `DEFAULT_SECRET_PATTERN` in `packages/core/src/infra/redact.ts`.
 * Matches common secret-indicator tokens anywhere in a dotted/underscored
 * key path (e.g. `api_key`, `x-authorization`, `user.password`).
 */
const LANGFUSE_DEFAULT_SECRET_PATTERN =
  /(^|[._-])(api[_-]?key|authorization|auth[_-]?token|secret|token|password|passwd|credential|bearer|cookie|session[_-]?id|private[_-]?key|access[_-]?key|refresh[_-]?token)([._-]|$)/i;

/** Keys that pollute `Object.prototype` or similar when assigned. */
const LANGFUSE_POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isLangfusePollutingKey(key: string): boolean {
  return LANGFUSE_POLLUTING_KEYS.has(key);
}

function shouldLangfuseRedactKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  return LANGFUSE_DEFAULT_SECRET_PATTERN.test(key);
}

/**
 * Deep-redact a value tree using the built-in default rules. Returns a
 * fresh clone; the input is never mutated. Circular references become the
 * sentinel string `'[Circular]'`, matching core's `redactValue`.
 */
function langfuseRedactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => langfuseRedactValue(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isLangfusePollutingKey(k)) continue;
    out[k] = shouldLangfuseRedactKey(k)
      ? LANGFUSE_REDACTED_VALUE
      : langfuseRedactValue(v, seen);
  }
  return out;
}

/**
 * Default sanitize function used when `LangfuseExporterConfig.sanitize` is
 * not provided. Drops prototype-polluting keys and deep-redacts sensitive
 * values. Returns a new object; does not mutate the input.
 */
function defaultLangfuseSanitize(
  attrs: Record<string, unknown>,
): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (isLangfusePollutingKey(k)) continue;
    out[k] = shouldLangfuseRedactKey(k)
      ? LANGFUSE_REDACTED_VALUE
      : langfuseRedactValue(v, seen);
  }
  return out;
}

// ---------------------------------------------------------------------------
// TraceExporter
// ---------------------------------------------------------------------------

/** Configuration for the Langfuse trace exporter. */
export interface LangfuseExporterConfig {
  /** A pre-configured Langfuse client instance. */
  readonly client: Langfuse;
  /**
   * Sanitize span attributes before export (e.g., strip PII).
   *
   * SEC-A01 (Wave-5A · T04): When omitted, a built-in default sanitizer is
   * applied — it redacts keys matching the standard secret pattern
   * (`api_key`, `authorization`, `token`, `password`, `cookie`, …) and
   * drops prototype-polluting keys (`__proto__`, `constructor`, `prototype`).
   * Passing an explicit function fully replaces the default (no composition);
   * there is no opt-out, the exporter will always apply *some* sanitizer.
   */
  readonly sanitize?: (attributes: Record<string, unknown>) => Record<string, unknown>;
  /** Maximum number of trace entries to retain in the LRU map. Defaults to 1000. */
  readonly maxTraceMapSize?: number;
}

/**
 * Create a TraceExporter that sends traces and spans to Langfuse.
 *
 * - Traces map to Langfuse traces.
 * - Spans with LLM attributes (model, inputTokens) map to Langfuse generations.
 * - Other spans map to generic Langfuse spans.
 */
export function createLangfuseExporter(config: LangfuseExporterConfig): TraceExporter {
  const { client } = config;

  // Track Langfuse trace objects so spans can attach to the correct parent.
  const MAX_TRACE_MAP_SIZE = config.maxTraceMapSize ?? 1000;
  const traceMap = new Map<string, ReturnType<typeof client.trace>>();
  const traceTimestamps = new Map<string, number>();

  function touchTrace(traceId: string): void {
    // Delete-then-reinsert to maintain insertion-order = access-order in the Map.
    // This lets us treat the first entry as the least-recently-used (LRU).
    traceTimestamps.delete(traceId);
    traceTimestamps.set(traceId, Date.now());
  }

  function evictOldestTraces(): void {
    // Single-entry LRU eviction: remove only the oldest entry (the first key
    // in the Map, which preserves insertion/access order thanks to touchTrace).
    // This avoids the previous O(n log n) batch eviction that caused 20ms+
    // event-loop pauses when the cache contained complex traces.
    while (traceMap.size > MAX_TRACE_MAP_SIZE) {
      const oldest = traceTimestamps.keys().next().value;
      if (oldest === undefined) break;
      traceMap.delete(oldest);
      traceTimestamps.delete(oldest);
    }
  }

  return {
    name: 'langfuse',

    async exportTrace(trace: Trace): Promise<void> {
      let lfTrace = traceMap.get(trace.id);
      if (!lfTrace) {
        lfTrace = client.trace({
          id: trace.id,
          name: trace.name,
          metadata: trace.metadata,
        });
        traceMap.set(trace.id, lfTrace);
        touchTrace(trace.id);
        evictOldestTraces();
      } else {
        touchTrace(trace.id);
      }

      lfTrace.update({
        metadata: {
          ...trace.metadata,
          status: trace.status,
          spanCount: trace.spans.length,
        },
      });
    },

    async exportSpan(span: Span): Promise<void> {
      let lfTrace = traceMap.get(span.traceId);
      if (!lfTrace) {
        lfTrace = client.trace({ id: span.traceId, name: 'unknown' });
        traceMap.set(span.traceId, lfTrace);
        touchTrace(span.traceId);
        evictOldestTraces();
      } else {
        touchTrace(span.traceId);
      }

      // SEC-A01 (T04): secure-by-default sanitize. `config.sanitize` overrides,
      // undefined falls back to the built-in default redactor. There is no
      // opt-out — the exporter always applies some scrubber.
      const sanitize = config.sanitize ?? defaultLangfuseSanitize;
      const attrs = sanitize(span.attributes);

      // Prioritize explicit kind attribute. Fallback heuristics only apply when
      // harness.span.kind is not set, to avoid misclassifying non-LLM operations
      // that happen to have token counts or a model reference field.
      const isGeneration =
        attrs['harness.span.kind'] === 'generation' ||
        (attrs['harness.span.kind'] === undefined && (
          typeof attrs['model'] === 'string' ||
          (typeof attrs['inputTokens'] === 'number' && typeof attrs['outputTokens'] === 'number')
        ));

      if (isGeneration) {
        lfTrace.generation({
          name: span.name,
          startTime: new Date(span.startTime),
          ...(span.endTime !== undefined && { endTime: new Date(span.endTime) }),
          ...(attrs['model'] !== undefined && { model: attrs['model'] as string }),
          input: attrs['input'] as unknown,
          output: attrs['output'] as unknown,
          metadata: {
            ...attrs,
            events: span.events,
            status: span.status,
          },
          usage: {
            ...(attrs['inputTokens'] !== undefined && { input: attrs['inputTokens'] as number }),
            ...(attrs['outputTokens'] !== undefined && { output: attrs['outputTokens'] as number }),
          },
        });
      } else {
        lfTrace.span({
          name: span.name,
          startTime: new Date(span.startTime),
          ...(span.endTime !== undefined && { endTime: new Date(span.endTime) }),
          metadata: {
            ...attrs,
            events: span.events,
            status: span.status,
            ...(span.parentId !== undefined && { parentId: span.parentId }),
          },
        });
      }
    },

    async flush(): Promise<void> {
      await client.flushAsync();
    },

    /**
     * LM-015: Flush any buffered events **before** tearing down local state.
     * Without the pre-clear flush, an in-flight `flushAsync()` may still be
     * referencing `traceMap` entries we just cleared, producing confusing
     * warnings in production. A 5s Promise.race cap keeps shutdown bounded
     * even when the Langfuse endpoint is unreachable.
     */
    async shutdown(): Promise<void> {
      const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;
      try {
        await Promise.race([
          client.flushAsync(),
          new Promise<void>((resolve) =>
            setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS),
          ),
        ]);
      } catch (err) {
        safeWarn(undefined, '[harness-one/langfuse] flushAsync during shutdown failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      traceMap.clear();
      traceTimestamps.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// PromptBackend
// ---------------------------------------------------------------------------

/** Configuration for the Langfuse prompt backend. */
export interface LangfusePromptBackendConfig {
  /** A pre-configured Langfuse client instance. */
  readonly client: Langfuse;
}

/**
 * Create a PromptBackend that fetches prompt templates from Langfuse
 * prompt management.
 *
 * Langfuse prompts use `{{variable}}` placeholders which map directly
 * to harness-one template variables.
 */
export function createLangfusePromptBackend(config: LangfusePromptBackendConfig): PromptBackend {
  const { client } = config;
  const knownPromptNames = new Set<string>();

  function toPromptTemplate(
    name: string,
    lfPrompt: { prompt: unknown; version: number },
  ): PromptTemplate {
    if (typeof lfPrompt.prompt !== 'string') {
      throw new HarnessError(`Langfuse prompt "${name}" is not a string type`, HarnessErrorCode.ADAPTER_ERROR, 'Ensure the Langfuse prompt is configured as a text type');
    }
    const content = lfPrompt.prompt;
    const variableMatches = content.match(/\{\{(\w+)\}\}/g) ?? [];
    const variables = [...new Set(variableMatches.map((m) => m.replace(/\{\{|\}\}/g, '')))];

    return {
      id: name,
      version: String(lfPrompt.version),
      content,
      variables,
      metadata: {
        source: 'langfuse',
        fetchedAt: Date.now(),
      },
    };
  }

  return {
    async fetch(id: string): Promise<PromptTemplate | undefined> {
      try {
        const lfPrompt = await client.getPrompt(id);
        knownPromptNames.add(id);
        return toPromptTemplate(id, lfPrompt as { prompt: unknown; version: number });
      } catch (err) {
        // Log warning instead of silently swallowing — network/auth failures should be visible
        safeWarn(undefined, `[harness-one/langfuse] Failed to fetch prompt "${id}"`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    },

    async list(): Promise<PromptTemplate[]> {
      const templates: PromptTemplate[] = [];
      for (const name of knownPromptNames) {
        try {
          const lfPrompt = await client.getPrompt(name);
          templates.push(toPromptTemplate(name, lfPrompt as { prompt: unknown; version: number }));
        } catch (err) {
          safeWarn(undefined, `[harness-one/langfuse] Failed to fetch prompt "${name}" during list`, {
            error: err instanceof Error ? err.message : String(err),
          });
          knownPromptNames.delete(name);
        }
      }
      return templates;
    },

    /**
     * @throws Always throws - Langfuse prompt management is read-only via this
     * adapter. Use the Langfuse dashboard to manage prompts.
     */
    async push(): Promise<void> {
      throw new HarnessError(
        'Langfuse SDK does not support pushing prompts programmatically',
        HarnessErrorCode.CORE_UNSUPPORTED_OPERATION,
        'Use the Langfuse UI or REST API to create prompts',
      );
    },
  };
}

// ---------------------------------------------------------------------------
// CostTracker (Langfuse-backed)
// ---------------------------------------------------------------------------

/** Configuration for the Langfuse cost tracker. */
export interface LangfuseCostTrackerConfig {
  /** A pre-configured Langfuse client instance. */
  readonly client: Langfuse;
  /** Warning threshold (0-1). Defaults to 0.8. */
  readonly warningThreshold?: number;
  /** Critical threshold (0-1). Defaults to 0.95. */
  readonly criticalThreshold?: number;
  /** Maximum number of usage records to retain. Defaults to 10000. */
  readonly maxRecords?: number;
  /**
   * OBS-015: Optional hook invoked when the Langfuse client fails to export
   * (e.g., flushAsync rejects). When omitted, errors are routed to
   * `logger.error` (if provided) or `console.warn` as a last resort.
   */
  readonly onExportError?: (
    err: unknown,
    context: { op: 'flush' | 'record'; details?: unknown },
  ) => void;
  /**
   * OBS-015: Optional structured logger. When `onExportError` is not set,
   * export errors are reported via `logger.error`. Falls back to
   * `console.warn` when neither is configured.
   */
  readonly logger?: Logger;
}

/**
 * Runtime statistics for the Langfuse cost tracker. Exposed via
 * `getStats()` so operators can monitor export health.
 */
export interface LangfuseCostTrackerStats {
  /** Number of usage records currently retained (after eviction). */
  readonly records: number;
  /** Count of flush errors observed since tracker creation / last reset. */
  readonly flushErrors: number;
  /** Count of `budget_exceeded` Langfuse events emitted. */
  readonly budgetExceededEvents: number;
}

/**
 * Cost tracker shape returned by `createLangfuseCostTracker`. Extends the
 * core `CostTracker` contract with Langfuse-specific instrumentation.
 */
export interface LangfuseCostTracker extends CostTracker {
  /** Export-health counters. */
  getStats(): LangfuseCostTrackerStats;
}

/**
 * Create a CostTracker that records costs via Langfuse generations.
 *
 * Each usage record is exported as a Langfuse generation with cost metadata,
 * while also tracking totals locally for budget alerts.
 *
 * ARCH-008: This tracker uses the `lru` eviction strategy from
 * `harness-one/observe` — `getCostByModel()` and `getCostByTrace()` track
 * the *retained record window* (`maxRecords`). The core `createCostTracker`
 * defaults to `'overflow-bucket'` (cumulative since start, never evicts
 * per-key totals). The divergence is intentional: Langfuse pairs this local
 * tracker with a backend that retains the long-tail history, so the
 * in-process view is a sliding window matched to the bounded record buffer.
 */
export function createLangfuseCostTracker(config: LangfuseCostTrackerConfig): LangfuseCostTracker {
  // ARCH-008: explicit strategy reference so the divergence with the core
  // tracker is grep-able and substitutable.
  const evictionStrategy: EvictionStrategy = lruStrategy;
  const { client, onExportError, logger } = config;
  const maxRecords = config.maxRecords ?? 10_000;
  if (config.maxRecords !== undefined && config.maxRecords < 1) {
    throw new HarnessError('maxRecords must be >= 1', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a positive maxRecords value');
  }
  const pricing = new Map<string, ModelPricing>();
  const records: TokenUsageRecord[] = [];
  const alertHandlers: ((alert: CostAlert) => void)[] = [];
  let budget: number | undefined;

  // CQ-010(a): Compensated floating-point accumulation replaces the naive
  // running total plus the 1000-record recalibration workaround. KahanSum
  // keeps drift bounded without periodic O(N) reduce passes.
  const runningSum = new KahanSum();

  // CQ-010(b): Maintain per-model and per-trace totals incrementally. This
  // turns `getCostByModel` / `getCostByTrace` from O(N) array scans into
  // O(1) / O(k) lookups that scale with distinct keys, not total records.
  const modelTotals = new Map<string, KahanSum>();
  const traceTotals = new Map<string, KahanSum>();

  const warningThreshold = config.warningThreshold ?? 0.8;
  const criticalThreshold = config.criticalThreshold ?? 0.95;

  const warnedModels = new Set<string>();

  // OBS-003: Dedupe `budget_exceeded` event emission per (model + budget).
  // Keys are re-seeded on `setBudget` so a new budget produces a fresh
  // window of events, and fully cleared on `reset()`.
  const emittedBudgetExceeded = new Set<string>();

  // OBS-015: Export-health counters.
  let flushErrors = 0;
  let budgetExceededEvents = 0;

  function handleExportError(err: unknown, op: 'flush' | 'record', details?: unknown): void {
    if (op === 'flush') {
      flushErrors++;
    }
    if (onExportError) {
      try {
        onExportError(err, { op, details });
      } catch {
        // Never let a user callback break the record path.
      }
      return;
    }
    if (logger) {
      logger.error('[harness-one/langfuse] export error', {
        op,
        err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
        ...(details !== undefined ? { details } : {}),
      });
      return;
    }
    // Wave-5F T13: route final fallback through safeWarn (redaction-enabled).
    safeWarn(undefined, `[harness-one/langfuse] ${op} error`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  function computeCost(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): number {
    const p = pricing.get(usage.model);
    if (!p) {
      if (!warnedModels.has(usage.model)) {
        warnedModels.add(usage.model);
        safeWarn(undefined, `[harness-one/langfuse] No pricing configured for model "${usage.model}" — cost will be reported as $0`);
      }
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
    return cost;
  }

  // ARCH-008: thin wrapper around the LRU strategy's bucket resolution.
  // Capacity is set to Number.MAX_SAFE_INTEGER because Langfuse never
  // capped the per-key map (and the LRU strategy ignores the capacity hint
  // for non-overflow paths anyway). Kept as a function so the per-call
  // shape stays identical to the historical `addToKeyedMap` helper.
  function addToKeyedMap(map: Map<string, KahanSum>, key: string, delta: number): void {
    const sum = evictionStrategy.resolveKeyBucket(map, key, Number.MAX_SAFE_INTEGER);
    if (sum) sum.add(delta);
  }

  function emitAlert(alert: CostAlert): void {
    for (const handler of alertHandlers) {
      handler(alert);
    }
    // OBS-003: When the budget is actually exceeded, emit a Langfuse event
    // (deduped by model + budget) so downstream dashboards can alert. The
    // warning/critical thresholds are intentionally excluded — only true
    // exceedance triggers the stop signal.
    if (alert.type === 'exceeded') {
      tryEmitBudgetExceededEvent(alert);
    }
  }

  function tryEmitBudgetExceededEvent(alert: CostAlert): void {
    // The `reset()` path clears this set, and `setBudget()` clears it too,
    // so a fresh budget window re-emits once per affected model.
    const last = records[records.length - 1];
    const model = last?.model ?? 'unknown';
    const dedupeKey = `${model}::${alert.budget}`;
    if (emittedBudgetExceeded.has(dedupeKey)) return;
    emittedBudgetExceeded.add(dedupeKey);

    try {
      // Attach to the most recent trace id when available so the event is
      // visible in context. Otherwise create a synthetic tracking trace.
      const traceId = last?.traceId ?? 'budget-exceeded';
      const lfTrace = client.trace({ id: traceId, name: 'budget-exceeded' });
      lfTrace.event({
        name: 'budget_exceeded',
        level: 'ERROR',
        metadata: {
          model,
          budget: alert.budget,
          currentCost: alert.currentCost,
          percentUsed: alert.percentUsed,
          message: alert.message,
        },
      });
      budgetExceededEvents++;
    } catch (err) {
      // Emitting the signal must never crash the record path.
      handleExportError(err, 'record', { reason: 'budget_exceeded_event_failed' });
    }
  }

  const tracker: LangfuseCostTracker = {
    setPricing(newPricing: ModelPricing[]): void {
      for (const p of newPricing) {
        pricing.set(p.model, p);
      }
    },

    recordUsage(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): TokenUsageRecord {
      const estimatedCost = computeCost(usage);
      const record: TokenUsageRecord = {
        ...usage,
        estimatedCost,
        timestamp: Date.now(),
      };
      records.push(record);

      // CQ-010(a): KahanSum handles drift; no recalibration pass needed.
      runningSum.add(estimatedCost);
      // CQ-010(b): Maintain per-model / per-trace totals incrementally.
      addToKeyedMap(modelTotals, usage.model, estimatedCost);
      addToKeyedMap(traceTotals, usage.traceId, estimatedCost);

      if (records.length > maxRecords) {
        // records.length > maxRecords guarantees at least one element, so
        // shift() cannot return undefined — but we narrow defensively for TS.
        const evicted = records.shift();
        if (evicted) {
          runningSum.subtract(evicted.estimatedCost);
          // ARCH-008: delegate per-key total decrement to the strategy. For
          // `lruStrategy` this matches the historical "subtract from per-model
          // / per-trace KahanSum" behaviour.
          evictionStrategy.onRecordEvicted(evicted, modelTotals, traceTotals);
        }
      }

      // Export to Langfuse as a generation with cost metadata
      const trace = client.trace({ id: usage.traceId, name: 'cost-tracking' });
      trace.generation({
        name: `usage-${usage.model}`,
        model: usage.model,
        usage: {
          input: usage.inputTokens,
          output: usage.outputTokens,
        },
        metadata: {
          estimatedCost,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        },
      });

      // OBS-015: Flush errors surface through the configured hook / logger
      // instead of being swallowed with a bare console.warn. The error is
      // also counted so operators can observe degraded export health.
      client.flushAsync().catch((err: unknown) => {
        handleExportError(err, 'flush');
      });

      if (budget !== undefined) {
        const alert = tracker.checkBudget();
        if (alert) {
          emitAlert(alert);
        }
      }

      return record;
    },

    getTotalCost(): number {
      return runningSum.total;
    },

    getCostByModel(): Record<string, number> {
      // CQ-010(b): O(k) over distinct models — no per-record scan.
      const result: Record<string, number> = {};
      for (const [model, sum] of modelTotals) {
        result[model] = sum.total;
      }
      return result;
    },

    getCostByTrace(traceId: string): number {
      // CQ-010(b): O(1) lookup — no per-record filter/reduce.
      return traceTotals.get(traceId)?.total ?? 0;
    },

    setBudget(newBudget: number): void {
      if (!Number.isFinite(newBudget) || newBudget < 0) {
        throw new HarnessError(
          `Budget must be a non-negative finite number, got ${newBudget}`,
          HarnessErrorCode.CORE_INVALID_CONFIG,
          'Provide a non-negative number for the budget',
        );
      }
      budget = newBudget;
      // OBS-003: New budget => new dedupe window.
      emittedBudgetExceeded.clear();
    },

    checkBudget(): CostAlert | null {
      if (budget === undefined) return null;
      const currentCost = tracker.getTotalCost();
      const percentUsed = currentCost / budget;

      // CQ-010(c): actual >= hard budget is a distinct, stronger state than
      // `critical`. Surface it so callers can trigger shouldStop semantics.
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
    },

    onAlert(handler: (alert: CostAlert) => void): () => void {
      alertHandlers.push(handler);
      return () => {
        const idx = alertHandlers.indexOf(handler);
        if (idx >= 0) alertHandlers.splice(idx, 1);
      };
    },

    updateUsage(traceId: string, usage: Partial<Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp' | 'traceId' | 'model'>>): TokenUsageRecord | undefined {
      // Find the most recent record for this traceId
      let lastIdx = -1;
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].traceId === traceId) {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx === -1) return undefined;

      const existing = records[lastIdx];
      const oldCost = existing.estimatedCost;

      // Merge updated token fields
      const merged = {
        ...existing,
        ...(usage.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
        ...(usage.cacheReadTokens !== undefined && { cacheReadTokens: usage.cacheReadTokens }),
        ...(usage.cacheWriteTokens !== undefined && { cacheWriteTokens: usage.cacheWriteTokens }),
      };
      const newCost = computeCost(merged);
      merged.estimatedCost = newCost;

      records[lastIdx] = merged;
      const delta = newCost - oldCost;
      runningSum.add(delta);
      addToKeyedMap(modelTotals, merged.model, delta);
      addToKeyedMap(traceTotals, merged.traceId, delta);

      if (budget !== undefined) {
        const alert = tracker.checkBudget();
        if (alert) emitAlert(alert);
      }

      return merged;
    },

    reset(): void {
      records.length = 0;
      runningSum.reset();
      modelTotals.clear();
      traceTotals.clear();
      emittedBudgetExceeded.clear();
      flushErrors = 0;
      budgetExceededEvents = 0;
    },

    getAlertMessage(): string | null {
      if (budget === undefined) return null;
      const currentCost = tracker.getTotalCost();
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
    },

    isBudgetExceeded(): boolean {
      if (budget === undefined) return false;
      // CQ-010(c): Keep isBudgetExceeded / shouldStop / checkBudget=exceeded
      // on the same criterion so callers see consistent signals.
      return tracker.getTotalCost() >= budget;
    },

    budgetUtilization(): number {
      if (budget === undefined || budget === 0) return 0;
      return tracker.getTotalCost() / budget;
    },

    shouldStop(): boolean {
      return tracker.isBudgetExceeded();
    },

    getStats(): LangfuseCostTrackerStats {
      return {
        records: records.length,
        flushErrors,
        budgetExceededEvents,
      };
    },
  };

  return tracker;
}
