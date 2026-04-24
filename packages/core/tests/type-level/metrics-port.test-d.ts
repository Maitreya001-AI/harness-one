/**
 * N6 · MetricsPort cross-subpath identity.
 *
 * `MetricsPort` is declared once in `packages/core/src/core/metrics-port.ts`
 * and re-exported from `harness-one/observe` as the canonical public home
 * (ARCHITECTURE.md). Consumers reaching through different subpaths MUST
 * see the SAME type — otherwise two `MetricsPort` shapes would leak into
 * user code (one from each subpath), and passing an instance built for
 * one signature into a function typed against the other would "type-
 * check" yet silently drift.
 *
 * If this file fails, the ARCHITECTURE.md invariant has been broken:
 * someone has redeclared or re-wrapped `MetricsPort` on a non-canonical
 * path. Open an issue; do NOT "fix" by widening the type here.
 *
 * Not currently re-exported from `harness-one/core` on purpose — the
 * comment at the top of `core/core/index.ts` explicitly routes callers
 * to `harness-one/observe`. Re-exporting here would bloat the surface
 * without changing the shape; the identity check still covers the root
 * barrel, which IS a legitimate cross-subpath path.
 */
import { expectTypeOf } from 'expect-type';
import type {
  MetricsPort as ObserveMetricsPort,
  MetricAttributes as ObserveMetricAttributes,
  MetricCounter as ObserveMetricCounter,
  MetricGauge as ObserveMetricGauge,
  MetricHistogram as ObserveMetricHistogram,
} from 'harness-one/observe';
import type {
  MetricsPort as RootMetricsPort,
  MetricAttributes as RootMetricAttributes,
  MetricCounter as RootMetricCounter,
  MetricGauge as RootMetricGauge,
  MetricHistogram as RootMetricHistogram,
} from 'harness-one';

// ── 1. Primary invariant: MetricsPort is one type across subpaths ────────
expectTypeOf<ObserveMetricsPort>().toEqualTypeOf<RootMetricsPort>();

// ── 2. Supporting types follow the same invariant ────────────────────────
expectTypeOf<ObserveMetricAttributes>().toEqualTypeOf<RootMetricAttributes>();
expectTypeOf<ObserveMetricCounter>().toEqualTypeOf<RootMetricCounter>();
expectTypeOf<ObserveMetricGauge>().toEqualTypeOf<RootMetricGauge>();
expectTypeOf<ObserveMetricHistogram>().toEqualTypeOf<RootMetricHistogram>();

// ── 3. Surface shape pinned — methods stay function-valued and named ─────
// A renamed method would break consumer `port.counter(...)` calls;
// pinning each instrument method's signature catches the rename early.
expectTypeOf<ObserveMetricsPort['counter']>().toEqualTypeOf<
  (name: string, options?: { description?: string; unit?: string }) => ObserveMetricCounter
>();
expectTypeOf<ObserveMetricsPort['gauge']>().toEqualTypeOf<
  (name: string, options?: { description?: string; unit?: string }) => ObserveMetricGauge
>();
expectTypeOf<ObserveMetricsPort['histogram']>().toEqualTypeOf<
  (name: string, options?: { description?: string; unit?: string }) => ObserveMetricHistogram
>();

// ── 4. MetricAttributes keeps its low-cardinality value constraint ───────
expectTypeOf<ObserveMetricAttributes>().toEqualTypeOf<
  Readonly<Record<string, string | number | boolean | undefined>>
>();
