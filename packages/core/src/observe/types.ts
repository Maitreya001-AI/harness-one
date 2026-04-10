/**
 * Type definitions for the observability module.
 *
 * @module
 */

/** A distributed trace containing spans. */
export interface Trace {
  readonly id: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime?: number;
  readonly metadata: Record<string, unknown>;
  readonly spans: readonly Span[];
  readonly status: 'running' | 'completed' | 'error';
}

/** A single span within a trace. */
export interface Span {
  readonly id: string;
  readonly traceId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime?: number;
  readonly attributes: Record<string, unknown>;
  readonly events: readonly SpanEvent[];
  readonly status: 'running' | 'completed' | 'error';
}

/** An event recorded within a span. */
export interface SpanEvent {
  readonly name: string;
  readonly timestamp: number;
  readonly attributes?: Record<string, unknown>;
}

/** Record of token usage for cost tracking. */
export interface TokenUsageRecord {
  readonly traceId: string;
  readonly spanId?: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly estimatedCost: number;
  readonly timestamp: number;
}

/** A cost budget alert. */
export interface CostAlert {
  readonly type: 'warning' | 'critical';
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
  | 'hallucination'
  | 'budget_exceeded'
  | 'timeout'
  | 'unrecoverable_error'
  | 'unknown';

/** A classified failure detected in a trace. */
export interface FailureClassification {
  readonly mode: FailureMode;
  readonly confidence: number;
  readonly evidence: string;
  readonly traceId: string;
  readonly spanIds?: readonly string[];
}

/** A pluggable failure detector — analyzes a trace and returns a detection or null. */
export interface FailureDetector {
  detect(trace: Trace): { confidence: number; evidence: string } | null;
}

/** Configuration for creating a FailureTaxonomy. */
export interface FailureTaxonomyConfig {
  /** Override or extend built-in detectors. Key = failure mode name. */
  readonly detectors?: Readonly<Record<string, FailureDetector>>;
  /** Minimum confidence threshold for reporting. Default: 0.5. */
  readonly minConfidence?: number;
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
