/**
 * MetricsPort — minimal counter / gauge / histogram surface.
 *
 * Wave-15 promoted this from observe (L3) to core/core (L2) because the
 * orchestration subsystem depends on the surface and L3→L3 imports violate
 * the layering contract (see docs/ARCHITECTURE.md). The observe barrel
 * re-exports these types for backward compatibility.
 *
 * This module intentionally does NOT import `@opentelemetry/api` — the
 * interface is vendor-neutral so consumers can bind any backend
 * (StatsD, Prometheus push gateway, custom aggregator). The OTel bridge
 * lives in `@harness-one/opentelemetry`.
 *
 * @module
 */

/** Attribute set attached to a metric observation. Keep cardinality low. */
export type MetricAttributes = Readonly<Record<string, string | number | boolean | undefined>>;

/** Monotonically increasing counter (e.g. `harness.iterations.total`). */
export interface MetricCounter {
  add(value: number, attrs?: MetricAttributes): void;
}

/** Point-in-time gauge (e.g. `harness.inflight.requests`). */
export interface MetricGauge {
  record(value: number, attrs?: MetricAttributes): void;
}

/** Bucketed histogram (e.g. `harness.iteration.latency.ms`). */
export interface MetricHistogram {
  record(value: number, attrs?: MetricAttributes): void;
}

/**
 * Port that hands out typed instruments. Implementations MAY cache
 * instruments by name; callers should not assume identity between
 * repeated `counter(name)` calls.
 */
export interface MetricsPort {
  counter(name: string, options?: { description?: string; unit?: string }): MetricCounter;
  gauge(name: string, options?: { description?: string; unit?: string }): MetricGauge;
  histogram(name: string, options?: { description?: string; unit?: string }): MetricHistogram;
}

const NOOP_COUNTER: MetricCounter = { add: () => {} };
const NOOP_GAUGE: MetricGauge = { record: () => {} };
const NOOP_HISTOGRAM: MetricHistogram = { record: () => {} };

/**
 * Returns a no-op {@link MetricsPort}. Used when no metrics backend is
 * wired in — callers can always invoke `metrics.counter(...).add(1)`
 * without null-checks.
 */
export function createNoopMetricsPort(): MetricsPort {
  return {
    counter: () => NOOP_COUNTER,
    gauge: () => NOOP_GAUGE,
    histogram: () => NOOP_HISTOGRAM,
  };
}
