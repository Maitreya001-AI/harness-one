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

// Cost tracker
export type { ModelPricing, CostTracker } from './cost-tracker.js';
export { createCostTracker, OVERFLOW_BUCKET_KEY, KahanSum } from './cost-tracker.js';

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
