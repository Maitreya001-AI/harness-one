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
// other sub-systems that don't need the full TraceManager surface. Canonical
// L2 home is `core/instrumentation-port.ts`; re-exported here so consumers
// wiring exporters see it alongside `TraceManager` / `TraceExporter`.
export type { InstrumentationPort } from '../core/instrumentation-port.js';

// Cost tracker
export type { ModelPricing, CostTracker } from './cost-tracker.js';
export { createCostTracker, OVERFLOW_BUCKET_KEY, KahanSum } from './cost-tracker.js';

// Default pricing snapshot for opt-in convenience use with createCostTracker.
// See `default-pricing.ts` for the WARNING about vendor pricing drift.
export {
  defaultModelPricing,
  DEFAULT_PRICING_SNAPSHOT_DATE,
  getDefaultPricing,
} from './default-pricing.js';

// ── Cross-subpath ergonomic re-export (zero runtime cost) ──────────────────
//
// `TokenUsage` is the per-iteration token-count shape returned by
// AgentLoop / adapters. Its canonical home is `harness-one/core`, but
// every cost-aware consumer already importing from `harness-one/observe`
// reaches for it here first. Re-exporting as type-only keeps the bundle
// cost zero. See HARNESS_LOG HC-007.
export type { TokenUsage } from '../core/types.js';

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

// Safe-log primitive (fallback logger + safeWarn/safeError/isWarnActive helpers)
export {
  createDefaultLogger,
  safeWarn,
  safeError,
  isWarnActive,
} from '../infra/safe-log.js';

// MetricsPort — vendor-neutral counter/gauge/histogram surface. Canonical
// L2 home is `../core/metrics-port.js`; re-exported here so the observe
// barrel exposes the symbols alongside the trace / cost APIs callers
// typically reach for together.
export type {
  MetricsPort,
  MetricAttributes,
  MetricCounter,
  MetricGauge,
  MetricHistogram,
} from '../core/metrics-port.js';
export { createNoopMetricsPort } from '../core/metrics-port.js';

// Lifecycle state machine + aggregated health.
export type {
  HarnessLifecycle,
  HarnessLifecycleState,
  HarnessHealth,
  HarnessComponentHealth,
  HarnessHealthCheck,
} from './lifecycle.js';
export { createHarnessLifecycle } from './lifecycle.js';

