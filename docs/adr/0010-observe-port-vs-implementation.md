# ADR-0010 · Define `MetricsPort` in core; ship implementations as sibling packages

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: harness-one maintainers

## Context

Observability has many providers: OpenTelemetry, Langfuse, Datadog,
Honeycomb, Prometheus, custom in-house systems. Each ships a
TypeScript SDK whose semantics, dependency footprint, and lifecycle
guarantees differ. If the agent loop reaches into a specific SDK
directly, two things break:

1. **The zero-dependency promise of core** ([ADR-0004](./0004-zero-runtime-deps-in-core.md))
   — pulling in `@opentelemetry/api` (or Langfuse, or Datadog) makes
   core's install graph balloon.
2. **Replaceability** — users on a different observability stack
   either fork core or layer adapters on top of an unrelated SDK they
   don't actually use.

The same problem applies to `TraceExporter`, `Logger`, and any other
seam where a vendor SDK might want to plug in.

## Decision

> **Core defines `MetricsPort` (and `InstrumentationPort`,
> `TraceExporter`, `Logger`) as minimal interfaces in
> `packages/core/src/core/` and `packages/core/src/observe/`. Concrete
> backends ship in separate packages — `@harness-one/langfuse`,
> `@harness-one/opentelemetry`, etc. — that depend on core, not the
> other way round.**

Core ships a no-op default (`createNoopMetricsPort()`) so the loop
runs without configuration. Users who want real metrics install one
of the sibling packages and pass its returned port into
`createTraceManager` / `createCostTracker` / the secure preset.

## Alternatives considered

- **Direct SDK calls in core** (`opentelemetry.trace.getActiveSpan()`).
  Rejected: violates ADR-0004; locks every consumer onto OTel even
  if they use Langfuse.
- **Plugin discovery via package name conventions** (load
  `@harness-one/metrics-*` if present). Rejected: implicit magic;
  versioning and dependency resolution become a runtime concern;
  hard to type.
- **Single fat package with conditional exports** for each backend.
  Rejected: every consumer pays for every backend's transitive
  deps; bundle size for a Langfuse-only user includes OTel's
  graph.
- **Re-export the SDK types from core** as a "neutral surface" that
  happens to mirror OTel. Rejected: re-exports still take the
  dependency at type-resolution time; doesn't fix bundle size and
  ties our type contract to whichever SDK we copied.

## Consequences

### Positive

- Core stays at zero runtime deps. The metrics ports are pure
  TypeScript interfaces with no SDK imports.
- Users wire only the backend they need: a Langfuse user installs
  `@harness-one/langfuse`, an OTel user installs
  `@harness-one/opentelemetry`, neither pays for the other.
- The ports are small and stable (`counter`, `gauge`, `histogram`),
  which keeps the contract reviewable. Backends do the heavy lifting
  of mapping these primitives to their SDK's specific shapes.
- The same pattern (port in core, implementation in sibling) extends
  to `MemoryStore` ↔ `@harness-one/redis`, `EmbeddingModel` ↔
  user-provided implementations, etc. — it's a load-bearing pattern
  for the whole project, not a one-off.

### Negative

- The port has to expose the lowest-common-denominator of metrics
  surfaces. Backends that offer richer features (exemplars, OTel
  baggage, Langfuse trace links) need extra wiring outside the
  port — typically a backend-specific configuration argument on the
  cost tracker or trace manager.
- Adapter authors carry the burden of mapping our port shape to
  their SDK. We reduce that cost with shared helpers
  (`isWarnActive`, `KahanSum`, `lruStrategy`) but the mapping is
  still per-backend code.
- Users who want "observability that just works" out of the box have
  to know the package layout. The README and the secure preset
  cover the common cases, but the discovery story isn't
  zero-config.

## Consequences (sibling pattern)

This ADR is intentionally narrow ("observability"), but the same
shape governs:

- `MemoryStore` defined in `packages/core/src/memory/store.ts`,
  Redis implementation in `@harness-one/redis`.
- `SchemaValidator` defined in `packages/core/src/tools/`, Ajv
  implementation in `@harness-one/ajv`.
- `TokenCounter` (token estimation) defined in core,
  tiktoken-backed implementation in `@harness-one/tiktoken`.

When a future contributor asks "should this new pluggable thing live
in core?", the answer is: define the port in core, ship the
implementation as a sibling package.

## Evidence

- `packages/core/src/core/metrics-port.ts` — `interface MetricsPort
{ counter; gauge; histogram }`, `createNoopMetricsPort()`.
- `packages/core/src/core/instrumentation-port.ts` — companion
  `InstrumentationPort` interface; "any existing `TraceManager`
  instance is a valid `InstrumentationPort`".
- `packages/langfuse/src/cost-tracker.ts` — implements
  `CostTracker` from core; declares `langfuse` as the only runtime
  dep.
- `packages/opentelemetry/src/index.ts` — imports `TraceExporter`,
  `MetricsPort` from `harness-one/observe`; provides an OTel
  implementation.
- `docs/architecture/06-observe.md` — public-facing description of
  the port-vs-implementation split for observability.
