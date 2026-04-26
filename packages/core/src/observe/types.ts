/**
 * Type definitions for the observability module.
 *
 * @module
 */

/**
 * Attribute values allowed on traces and spans. Matches the OpenTelemetry
 * attribute type constraint (primitive or homogeneous primitive array) so
 * exporters don't silently drop nested objects or mixed arrays. Applies
 * as a *soft* constraint — `Trace` / `Span` declare
 * `Record<string, unknown>` because some callers pass pre-serialized
 * JSON blobs; new exporters should use `SpanAttributeValue`.
 */
export type SpanAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

/**
 * Typed attribute bag for spans and traces.
 *
 * Span-attribute keys follow a reserved-prefix discipline. Using a
 * non-reserved key without the `user.` prefix triggers a `logger.warn`
 * from `setSpanAttributes()` (the call still succeeds — this is a lint,
 * not an error). Reserved prefixes:
 *
 * - `system.*` — harness-one library-authored attributes (sampling
 *   decisions, internal correlation IDs, build metadata).
 * - `error.*` — attributes set by harness-one error paths
 *   (`error.message`, `error.category`, `error.stack`).
 * - `cost.*` — attributes set by `CostTracker` and the AgentLoop's
 *   per-iteration cost recording.
 * - `user.*` — free-form caller attributes. Use this prefix to avoid
 *   the warning when adding bespoke attributes.
 *
 * The allow-list in `setSpanAttributes()` also recognises a few legacy
 * shorthands (`harness.*`, `tool*`, `iteration`, `attempt`, `model`,
 * token counts, etc.) without warning. Unknown / non-prefixed keys are
 * still accepted — the warning is advisory, not fatal.
 */
export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

/**
 * A distributed trace containing spans.
 *
 * SEC-016: metadata is partitioned into `userMetadata` (caller-supplied,
 * subject to redaction) and `systemMetadata` (library-authored, consumed
 * by `shouldExport()` sampling hooks). Exporters that forward user
 * content to external services (Langfuse, etc.) MUST use `userMetadata`
 * only; `systemMetadata` stays internal.
 *
 * `userMetadata` and `systemMetadata` are **optional in the type** as of
 * the HC-012 ergonomics fix, so test fixtures and exporter mocks no
 * longer need to spell out `{}` literals. The TraceManager always
 * populates them with empty objects when materialising a real Trace,
 * so production readers never observe `undefined`.
 */
export interface Trace {
  readonly id: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime?: number;
  /** Caller-supplied metadata (may be redacted). */
  readonly userMetadata?: Record<string, unknown>;
  /** Library-authored metadata; `shouldExport()` hooks MUST only read this. */
  readonly systemMetadata?: Record<string, unknown>;
  readonly spans: readonly Span[];
  readonly status: 'running' | 'completed' | 'error';
}

/**
 * A single span within a trace.
 *
 * `attributes` and `events` are **optional in the type** as of the
 * HC-012 ergonomics fix, so test fixtures and exporter mocks no
 * longer need to spell out `{}` / `[]` literals. The TraceManager
 * always populates them with empty containers when materialising a
 * real Span, so production readers never observe `undefined`.
 */
export interface Span {
  readonly id: string;
  readonly traceId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime?: number;
  readonly attributes?: Record<string, unknown>;
  readonly events?: readonly SpanEvent[];
  readonly status: 'running' | 'completed' | 'error';
}

/** Severity levels supported on span events. Mirrors log levels. */
export type SpanEventSeverity = 'debug' | 'info' | 'warn' | 'error';

/**
 * An event recorded within a span.
 *
 * OBS-002: Events support an optional `severity` field. Exporters (OTel,
 * Langfuse) can map `severity: 'error'` to a span status and elevate the
 * event above info-level telemetry. Defaults to `'info'` when omitted.
 */
export interface SpanEvent {
  readonly name: string;
  readonly timestamp: number;
  readonly attributes?: Record<string, unknown>;
  readonly severity?: SpanEventSeverity;
}

/**
 * Record of token usage for cost tracking. Re-exported from L2 (`core/pricing.ts`)
 * which owns the pricing math that populates `estimatedCost`. Observe's public
 * API surface still ships this type via `harness-one/observe`.
 */
export type { TokenUsageRecord } from '../core/pricing.js';

/** A cost budget alert. */
export interface CostAlert {
  readonly type: 'warning' | 'critical' | 'exceeded';
  readonly currentCost: number;
  readonly budget: number;
  readonly percentUsed: number;
  readonly message: string;
}

/** Exporter interface for traces and spans. */
export interface TraceExporter {
  readonly name: string;
  exportTrace(trace: Trace): Promise<void>;
  exportSpan(span: Span): Promise<void>;
  flush(): Promise<void>;
  /** Optional: Initialize the exporter (e.g., connect to backend). */
  initialize?(): Promise<void>;
  /** Optional: Check if exporter is healthy. */
  isHealthy?(): boolean;
  /** Optional: Sampling — return false to skip this trace. */
  shouldExport?(trace: Trace): boolean;
  /**
   * P1-6 (tail-based sampling): Optional hook evaluated at `endTrace()` time
   * — after every span has been attached — to gate per-exporter export based
   * on the final trace shape. Return `false` to skip exporting this trace to
   * this exporter; `true` (or `undefined` / missing) to keep the default
   * head-based decision.
   *
   * Use this to implement "sample all errors" style tail strategies, e.g.:
   * ```ts
   * shouldSampleTrace: (trace) =>
   *   trace.status === 'error' || trace.spans.some(s => s.status === 'error'),
   * ```
   *
   * Important distinction vs. head-based sampling:
   *   - Head-based sampling (`defaultSamplingRate` / `setSamplingRate`) still
   *     applies for **in-memory retention / memory bounds** — a trace is
   *     either admitted or not at `startTrace()` time.
   *   - `shouldSampleTrace` is an **export-only gate**. The trace still lives
   *     in the in-memory map; only the call to `exporter.exportTrace(...)` is
   *     skipped.
   *   - When both `shouldExport` (head-time) and `shouldSampleTrace`
   *     (tail-time) are defined, both must return true for the export to
   *     proceed.
   */
  shouldSampleTrace?(trace: Readonly<Trace>): boolean;
  /** Optional: Called when exporter is being shut down. */
  shutdown?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Failure Taxonomy types
// ---------------------------------------------------------------------------

/** Known agent failure modes detectable from trace structure. */
export type FailureMode =
  | 'early_stop'
  | 'tool_loop'
  | 'context_forgetting'
  | 'repeated_tool_failure'
  | 'budget_exceeded'
  | 'timeout'
  | 'adapter_retry_storm'
  | 'unrecoverable_error'
  | 'unknown';

/** A classified failure detected in a trace. */
export interface FailureClassification {
  readonly mode: FailureMode | string;
  readonly confidence: number;
  readonly evidence: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly traceId: string;
  readonly spanIds?: readonly string[];
}

/** A pluggable failure detector — analyzes a trace and returns a detection or null. */
export interface FailureDetector {
  detect(
    trace: Trace,
  ): { confidence: number; evidence: string; details?: Readonly<Record<string, unknown>> } | null;
}

/** Configuration for creating a FailureTaxonomy. */
export interface FailureTaxonomyConfig {
  /** Override or extend built-in detectors. Key = failure mode name. */
  readonly detectors?: Readonly<Record<string, FailureDetector>>;
  /** Minimum confidence threshold for reporting. Default: 0.5. */
  readonly minConfidence?: number;
  /** Configurable thresholds for built-in detectors. */
  readonly thresholds?: {
    /** Minimum consecutive span run to trigger tool_loop. Default: 3. */
    readonly toolLoopMinRun?: number;
    /** Maximum span count for early_stop detection (traces with more are not flagged). Default: 2. */
    readonly earlyStopMaxSpans?: number;
    /** Structured budget-exceeded confidence (0-1). Default: 0.95. */
    readonly budgetExceededConfidence?: number;
    /**
     * Minimum retryable-error span count to trigger `adapter_retry_storm`.
     * Default: 3. Raise in environments where bursts of 3–4 retryable
     * adapter errors are tolerated noise rather than signal.
     */
    readonly adapterRetryStormMinErrors?: number;
  };
}

/** Failure taxonomy for classifying agent failures from traces. */
export interface FailureTaxonomy {
  /** Classify failures in a completed trace. Returns sorted by confidence descending. */
  classify(trace: Trace): readonly FailureClassification[];
  /** Register an additional detector at runtime. */
  registerDetector(mode: string, detector: FailureDetector): void;
  /** Get cumulative failure mode counts. */
  getStats(): Readonly<Record<string, number>>;
  /** Reset cumulative stats. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Cache Monitor types
// ---------------------------------------------------------------------------

/** Aggregate cache performance metrics. */
export interface CacheMetrics {
  readonly totalCalls: number;
  readonly avgHitRate: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheWriteTokens: number;
  readonly estimatedSavings: number;
}

/** A time-bucketed cache metrics entry. */
export interface CacheMetricsBucket {
  readonly timestamp: number;
  readonly calls: number;
  readonly avgHitRate: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** Configuration for creating a CacheMonitor. */
export interface CacheMonitorConfig {
  /** Pricing for savings estimation. */
  readonly pricing?: { readonly cacheReadPer1kTokens: number; readonly inputPer1kTokens: number };
  /** Maximum number of time-series buckets to retain. Default: 100. */
  readonly maxBuckets?: number;
}

/** Cache hit-rate monitor for tracking KV-cache performance. */
export interface CacheMonitor {
  /** Record a token usage sample. */
  record(usage: import('../core/types.js').TokenUsage, prefixMatchRatio?: number): void;
  /** Get aggregate metrics (O(1) — uses running aggregates). */
  getMetrics(): CacheMetrics;
  /** Get time-series data bucketed by interval. */
  getTimeSeries(bucketMs?: number): readonly CacheMetricsBucket[];
  /** Reset all recorded data. */
  reset(): void;
}
