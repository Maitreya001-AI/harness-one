/**
 * Observe / **trace** sub-barrel — the tracing-oriented slice of the
 * observability surface (trace manager, span exporters, logger, failure
 * taxonomy, dataset exporter). Wave-15 introduced this sub-barrel so
 * callers can opt into the cohesive "tracing pipeline" view instead of
 * reaching into the catch-all {@link ./index.js observe} barrel that also
 * exposes cost/usage primitives.
 *
 * Implementation files still live in `observe/*` — this module is a
 * documented entry point that lets future reorganizations happen without
 * breaking callers that target the subpath.
 *
 * @module
 */

export type {
  Trace,
  Span,
  SpanEvent,
  SpanEventSeverity,
  SpanAttributes,
  SpanAttributeValue,
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

export type { TraceManager, RetryMetrics } from './trace-manager.js';
export { createTraceManager, createConsoleExporter, createNoOpExporter } from './trace-manager.js';

export type { InstrumentationPort } from '../core/instrumentation-port.js';

export type { LogLevel, Logger, LoggerConfig } from './logger.js';
export { createLogger } from './logger.js';

export { createFailureTaxonomy } from './failure-taxonomy.js';
export { createCacheMonitor } from './cache-monitor.js';

export type { DatasetEntry, DatasetExporterConfig } from './dataset-exporter.js';
export { createDatasetExporter } from './dataset-exporter.js';

export { createDefaultLogger, safeWarn, safeError } from '../infra/safe-log.js';
