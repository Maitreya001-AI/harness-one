/**
 * Re-export of the canonical {@link MetricsPort} that now lives in L2
 * (`core/core/metrics-port.ts`). Kept here so existing imports
 * (`from '.../observe/metrics-port'`) continue to compile; new code
 * should import from `../core/metrics-port.js` directly when inside
 * the core package, or from the public `harness-one/core` barrel.
 *
 * @module
 */
export {
  createNoopMetricsPort,
} from '../core/metrics-port.js';
export type {
  MetricsPort,
  MetricAttributes,
  MetricCounter,
  MetricGauge,
  MetricHistogram,
} from '../core/metrics-port.js';
