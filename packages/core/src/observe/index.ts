// Observe module — public exports

// Types
export type {
  Trace,
  Span,
  SpanEvent,
  SpanEventSeverity,
  SpanAttributes,
  SpanAttributeValue,
  TokenUsageRecord,
  CostAlert,
  TraceExporter,
  FailureMode,
  FailureClassification,
  FailureDetector,
  FailureTaxonomyConfig,
  FailureTaxonomy,
  CacheMetrics,
  CacheMetricsBucket,
  CacheMonitorConfig,
  CacheMonitor,
} from './types.js';

// Trace manager
export type { TraceManager, RetryMetrics } from './trace-manager.js';
export { createTraceManager, createConsoleExporter, createNoOpExporter } from './trace-manager.js';

// Instrumentation port (ARCH-012) — slim tracing contract used by RAG and
// other sub-systems that don't need the full TraceManager surface.
export type { InstrumentationPort } from './instrumentation-port.js';

// Cost tracker
export type { ModelPricing, CostTracker } from './cost-tracker.js';
export { createCostTracker, OVERFLOW_BUCKET_KEY, KahanSum } from './cost-tracker.js';

// ARCH-008: pluggable eviction strategy shared with @harness-one/langfuse.
export type { EvictionStrategy, EvictionStrategyName } from './cost-tracker-eviction.js';
export {
  overflowBucketStrategy,
  lruStrategy,
  getEvictionStrategy,
  applyRecordCap,
} from './cost-tracker-eviction.js';

// Logger
export type { LogLevel, Logger, LoggerConfig } from './logger.js';
export { createLogger } from './logger.js';

// Failure Taxonomy
export { createFailureTaxonomy } from './failure-taxonomy.js';

// Cache Monitor
export { createCacheMonitor } from './cache-monitor.js';

// Dataset Exporter
export type { DatasetEntry, DatasetExporterConfig } from './dataset-exporter.js';
export { createDatasetExporter } from './dataset-exporter.js';

// Safe-log primitive (fallback logger + safeWarn/safeError helpers)
export { createDefaultLogger, safeWarn, safeError } from '../infra/safe-log.js';

// Wave-5D ARCH-5: MetricsPort (vendor-neutral metric interface).
export type {
  MetricsPort,
  MetricAttributes,
  MetricCounter,
  MetricGauge,
  MetricHistogram,
} from './metrics-port.js';
export { createNoopMetricsPort } from './metrics-port.js';

// Wave-5D ARCH-6: lifecycle state machine + aggregated health.
export type {
  HarnessLifecycle,
  HarnessLifecycleState,
  HarnessHealth,
  HarnessComponentHealth,
  HarnessHealthCheck,
} from './lifecycle.js';
export { createHarnessLifecycle } from './lifecycle.js';

/**
 * Secret redaction primitives — historically re-exported from `observe`
 * for convenience, but the canonical public path is now
 * `harness-one/redact`. The re-exports below remain for back-compat
 * through the next minor version; see MIGRATION.md for the removal
 * schedule.
 *
 * @deprecated Import from `harness-one/redact` instead.
 */
export type { RedactConfig, Redactor } from '../infra/redact.js';
/** @deprecated Import from `harness-one/redact` instead. */
export {
  createRedactor,
  redactValue,
  sanitizeAttributes,
  REDACTED_VALUE,
  DEFAULT_SECRET_PATTERN,
  POLLUTING_KEYS,
} from '../infra/redact.js';
