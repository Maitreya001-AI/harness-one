/**
 * Observe / **usage** sub-barrel — the cost/budget/metrics slice of the
 * observability surface. Wave-15 introduced this sub-barrel so callers
 * can opt into the cohesive "usage accounting" view (cost-tracker,
 * alerts, metrics port, eviction strategies) without pulling the tracing
 * pipeline along for the ride.
 *
 * Implementation files still live in `observe/*` — this module is a
 * documented entry point that lets future reorganizations happen without
 * breaking callers that target the subpath.
 *
 * @module
 */

export type { TokenUsageRecord, CostAlert } from './types.js';

export type { ModelPricing, CostTracker } from './cost-tracker.js';
export { createCostTracker, OVERFLOW_BUCKET_KEY, KahanSum } from './cost-tracker.js';

export type { EvictionStrategy, EvictionStrategyName } from './cost-tracker-eviction.js';
export {
  overflowBucketStrategy,
  lruStrategy,
  getEvictionStrategy,
  applyRecordCap,
} from './cost-tracker-eviction.js';

export type {
  MetricsPort,
  MetricAttributes,
  MetricCounter,
  MetricGauge,
  MetricHistogram,
} from '../core/metrics-port.js';
export { createNoopMetricsPort } from '../core/metrics-port.js';

export type {
  HarnessLifecycle,
  HarnessLifecycleState,
  HarnessHealth,
  HarnessComponentHealth,
  HarnessHealthCheck,
} from './lifecycle.js';
export { createHarnessLifecycle } from './lifecycle.js';
