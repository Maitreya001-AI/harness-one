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
