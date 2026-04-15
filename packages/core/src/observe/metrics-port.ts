/**
 * MetricsPort — minimal counter / gauge / histogram surface.
 *
 * Wave-5D ARCH-5: harness-one emits structured traces today but has no
 * first-class metric surface, which forces ops to reverse-engineer
 * span attributes into counters. `MetricsPort` sits alongside
 * {@link InstrumentationPort} / {@link TraceExporter} as the canonical
 * metric sink. Adapters (`@harness-one/opentelemetry`) implement this
 * interface in terms of `@opentelemetry/api` `Metrics`; callers who
 * don't wire one up get the no-op port (cheap, honest).
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
