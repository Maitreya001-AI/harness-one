# ADR-0005 · Unify trace, cost, and token usage on one identifier

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: harness-one maintainers

## Context

A single `AgentLoop.run()` call produces three separate streams of
observability data:

- **Trace spans** (`TraceManager`) — per-iteration spans, tool spans,
  guardrail spans, error spans.
- **Token usage records** (`TokenUsage` events from the adapter) —
  input/output/cache tokens per LLM call.
- **Cost records** (`CostTracker.recordUsage`) — currency-denominated
  estimates derived from the token counts and a `ModelPricing` table.

If these three are not joined by a shared key, dashboards lie. The
cost panel can show "$1.23 spent" while the trace view shows zero
spans for the same run, because the cost record was buffered after
the trace span closed and the join key drifted. We have hit this in
Langfuse and OTel both.

## Decision

> **Cost records carry the same `traceId` as the trace span they were
> emitted under. `CostTracker.recordUsage()` accepts `traceId` as a
> required field; the loop wires the active trace's id into the
> usage event before recording it.**

`CostTracker` indexes records by `traceId` (`getCostByTrace(traceId)`,
`updateUsage(traceId, …)`), and exposes a `MetricsPort` gauge
(`harness.cost.utilization`) that fires on every `recordUsage()` so a
metrics backend sees the same join key the trace view uses.
Adapter-side, every `ChatResponse.usage` is also keyed to the active
iteration via the `onTokenUsage` hook, which carries the same
iteration index that the surrounding trace span carries.

## Alternatives considered

- **Independent IDs per stream** (cost id, trace id, usage id, joined
  later by timestamp). Rejected: timestamp joins are unreliable
  across process boundaries and clock skew; the join failure mode
  is silent.
- **Bundle everything onto the trace span** as span attributes —
  `span.cost`, `span.tokens`. Rejected: cost is recomputed when
  pricing tables update; spans are append-only after close. We
  needed an out-of-band store (`CostTracker`) anyway, so the right
  fix is to make it share the trace key, not collapse into the span.
- **Provide a higher-level "agent run record"** that aggregates the
  three. Rejected: that's a downstream consumer's responsibility.
  Users who want one can join on `traceId` themselves; we just
  guarantee the key is shared.

## Consequences

### Positive

- A single `traceId` joins span data, token records, and cost rows
  in any storage backend. The Langfuse exporter and the OTel
  exporter both use it without extra wiring.
- The `harness.cost.utilization` metric is correlated with the same
  span tree the trace UI shows, so on-call can pivot from a budget
  alert into the offending trace in one click.
- `CostTracker.getCostByTrace(traceId)` gives a precise per-run cost
  number, suitable for billing or quota enforcement.

### Negative

- Every adapter response that carries `usage` must propagate
  `traceId` into the cost record. Forgetting it leaves the cost
  recorded under no trace. We catch this in tests but cannot prevent
  it at the type level today.
- `CostTracker` is bounded; very long runs that produce more usage
  records than the buffer holds can fall out of the recent-window
  query (`getTotalCost()`). Per-trace and per-model totals are
  immune (never evicted), but per-record drill-down is not.
- The join key is a string; care is needed to avoid mixing `traceId`
  with `spanId` at recording time. We use branded types
  (`infra/brands.ts`) to keep them apart in TypeScript.

## Evidence

- `packages/core/src/observe/cost-tracker.ts` — `recordUsage(usage)`
  takes `traceId`; `getCostByTrace(traceId)` and
  `updateUsage(traceId, …)` index by it.
- `packages/core/src/observe/cost-tracker.ts` — `costUtilizationGauge =
metricsPort?.gauge('harness.cost.utilization', …)` fires on every
  `recordUsage()`.
- `packages/core/src/core/iteration-runner.ts` — `runHook('onTokenUsage',
{ iteration, usage })` fires per-iteration so token usage events
  carry the same iteration the surrounding trace span carries.
- `packages/core/src/infra/brands.ts` — `TraceId`, `SpanId`,
  `SessionId` branded types prevent ID mixups at the type level.
- `packages/core/src/observe/cost-record-buffer.ts` — the per-trace
  lookup index that lets `getCostByTrace`/`updateUsage` work in O(1).
