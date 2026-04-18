# Migration Guide

This document tracks load-bearing API changes across the `harness-one`
monorepo. While we're pre-1.0 we delete deprecated surface in-place
rather than carrying both shapes — every entry below is a breaking
change landed in the noted wave. Source re-exports exist where they
add no cost, but the "old name" is never the recommended path.

## Wave-18 — post-Wave-17 deep review

Five residual issues identified in a fresh Wave-17 architecture audit.
Unreleased project → breaking changes land without aliases.

### Config shape: drop `AgentLoopConfigV2`

Wave-14 shipped a nested `AgentLoopConfigV2` alongside the flat
`AgentLoopConfig`. Carrying two shapes meant every test, example, and
downstream caller had to pick one and the flatten/isNested bridge sat
in the hot path forever. Wave-18 collapses the surface to the flat
`AgentLoopConfig`; the nested shape, its five sub-bundles, and the
bridge helpers are gone.

Removed types: `AgentLoopConfigV2`, `AgentLoopExecutionConfig`,
`AgentLoopLimitsConfig`, `AgentLoopResilienceConfig`,
`AgentLoopObservabilityConfig`, `AgentLoopPipelinesConfig`.

Removed functions: `flattenNestedAgentLoopConfig`,
`isNestedAgentLoopConfig`. The `createAgentLoop(AgentLoopConfigV2)`
overload is gone too.

```diff
 createAgentLoop({
   adapter,
-  limits: { maxIterations: 40, maxTotalTokens: 10_000 },
-  resilience: { maxAdapterRetries: 2, baseRetryDelayMs: 500 },
-  observability: { logger, traceManager: tm },
-  pipelines: { input: inputPipeline, output: outputPipeline },
-  execution: { parallel: true, maxParallelToolCalls: 3 },
+  maxIterations: 40,
+  maxTotalTokens: 10_000,
+  maxAdapterRetries: 2,
+  baseRetryDelayMs: 500,
+  logger,
+  traceManager: tm,
+  inputPipeline,
+  outputPipeline,
+  parallel: true,
+  maxParallelToolCalls: 3,
 });
```

### `LRUCache` fires `onEvict` on every removal path

Previously, only capacity-driven eviction fired the `onEvict` hook;
`delete()` and `clear()` silently orphaned side-tables. Wave-18
unified the semantics: every exit path notifies the hook.

Callers that wrap `LRUCache` and ALSO maintain their own side-table
that explicitly subtracts on `delete()` / `clear()` must stop
double-counting — `onEvict` will now drive the side-table on those
paths too.

### Error code fix: `stream-aggregator` per-call arg overflow

Streamed tool calls whose arguments exceed `maxToolArgBytes` now emit
`HarnessErrorCode.ADAPTER_PAYLOAD_OVERSIZED` on both the with-id and
no-id accumulation paths. The no-id path previously emitted
`CORE_TOKEN_BUDGET_EXCEEDED`. Alert rules keying on error code should
drop the `CORE_TOKEN_BUDGET_EXCEEDED` branch for this scenario and
consolidate onto `ADAPTER_PAYLOAD_OVERSIZED`.

### New helper on `/advanced`: `releaseExternalSignal`

Consumers composing their own iteration coordinator (via the
primitives on `harness-one/advanced`) can now call
`releaseExternalSignal(deps, state)` to detach the external-abort
listener installed by `startRun`. Idempotent; `finalizeRun` and
`AgentLoop.dispose` both route through it.

## Wave-17 — unreleased cleanup

Seven structural issues identified in the Wave-16 post-review. Every
item is breaking and lands without a deprecation window because the
package has not been published.

### Hook rename: `onCost` → `onTokenUsage`

The per-iteration hook shipped on `AgentLoopHook` was named `onCost`
but its payload only ever carried raw `TokenUsage` — no dollar cost.
Dollar cost is computed separately by `CostTracker`. The hook is
renamed so the name matches the payload.

```diff
 createAgentLoop({
   adapter,
   hooks: [{
-    onCost: ({ iteration, usage }) => metrics.add(usage),
+    onTokenUsage: ({ iteration, usage }) => metrics.add(usage),
   }],
 });
```

### Public surface split: `harness-one/core` + `harness-one/advanced`

`harness-one/core` was exporting ~150 symbols mixing the narrow
end-user API with extension-point primitives. Wave-17 moves the
extension primitives to a new `harness-one/advanced` subpath and
keeps `harness-one/core` focused on the end-user surface (message
types, `createAgentLoop`, hooks, errors, model pricing, the two
observability ports).

Moved to `harness-one/advanced`:

- `createMiddlewareChain`, `MiddlewareChain`, `MiddlewareContext`, `MiddlewareFn`
- `StreamAggregator` + its event/chunk/message/options types
- `OutputParser`, `createJsonOutputParser`, `parseWithRetry`
- `createFallbackAdapter`, `FallbackAdapterConfig`
- `toSSEStream`, `formatSSE`, `SSEChunk`
- `createSequentialStrategy`, `createParallelStrategy`
- `categorizeAdapterError`
- `createCustomErrorCode`, `HarnessErrorDetails`
- `pruneConversation`, `PruneResult`
- `createResilientLoop`, `ResilientLoop`, `ResilientLoopConfig`, `ResiliencePolicy`
- Iteration coordinator: `startRun`, `checkPreIteration`, `startIteration`, `finalizeRun`, `CoordinatorDeps`, `CoordinatorState`, `StartRunResult`
- Validators: `requirePositiveInt`, `requireNonNegativeInt`, `requireFinitePositive`, `requireFiniteNonNegative`, `requireUnitInterval`, `validatePricingEntry`, `validatePricingArray`, `PricingNumericFields`
- Pricing math: `priceUsage`, `hasNonFiniteTokens`
- Backoff: `ADAPTER_RETRY_JITTER_FRACTION`, `AGENT_POOL_IDLE_JITTER_FRACTION`, `computeBackoffMs`, `computeJitterMs`, `createBackoffSchedule`, `BackoffConfig`, `BackoffSchedule`
- Trusted system message: `createTrustedSystemMessage`, `isTrustedSystemMessage`, `sanitizeRestoredMessage`
- Test utilities: `createMockAdapter`, `createFailingAdapter`, `createStreamingMockAdapter`, `createErrorStreamingMockAdapter`, `MockAdapterConfig`
- `AgentLoopTraceManager`

The root `harness-one` barrel continues to re-export `createResilientLoop`,
`createMiddlewareChain`, and the relevant types — those are part of the
advertised UJ-1 surface — so top-level imports of those names continue
to resolve. Deep imports change path:

```diff
-import { createMiddlewareChain } from 'harness-one/core';
+import { createMiddlewareChain } from 'harness-one/advanced';
```

### Layer promotion: `TokenUsageRecord` moved to L2

`TokenUsageRecord` previously lived in `core/observe/types.ts` (L3)
but was consumed by the L2 pricing module. Wave-17 moves it to
`core/core/pricing.ts` (L2) alongside `ModelPricing`, restoring the
"L2 depends on L1 only" rule. `harness-one/observe` re-exports the
type so consumers who reach for it through the observe surface keep
working.

### Layer tightening: `agent-pool` depends on `InstrumentationPort` (L2), not `TraceManager` (L3)

`orchestration/agent-pool.ts` previously typed its `traceManager`
field against the concrete L3 `TraceManager`. It now uses the L2
`InstrumentationPort` — the minimal tracing contract. `TraceManager`
structurally satisfies the port, so consumer code needs no changes.

### Renamed error codes

Two long-aliased codes are removed. Consumers matching on them must
switch to `MEMORY_CORRUPT`.

| Removed | Use |
| --- | --- |
| `HarnessErrorCode.MEMORY_STORE_CORRUPTION` | `HarnessErrorCode.MEMORY_CORRUPT` |
| `HarnessErrorCode.MEMORY_DATA_CORRUPTION` | `HarnessErrorCode.MEMORY_CORRUPT` |

### Removed: `GuardrailBlockedError` class

The runtime guardrail pipeline has been throwing
`new HarnessError(reason, HarnessErrorCode.GUARD_VIOLATION, …)` since
Wave-14. The `GuardrailBlockedError` subclass was kept as a back-compat
`instanceof` target; it's gone now. Match on the code instead:

```diff
-try { /* … */ } catch (e) { if (e instanceof GuardrailBlockedError) … }
+try { /* … */ } catch (e) {
+  if (e instanceof HarnessError && e.code === HarnessErrorCode.GUARD_BLOCKED) …
+}
```

### Removed: `createHandoff(orchestrator, …)` overload

`createHandoff` now only accepts a `MessageTransport`. The
`AgentOrchestrator` returned by `createOrchestrator` structurally
satisfies `MessageTransport`, so call sites that passed an
orchestrator directly continue to compile without changes.

### Removed: `evictedParentsTtlMs` from `OTelExporterConfig`

The field was a no-op since Wave-12 P1-9 (time-based expiry was
removed to eliminate the child-arrival race). Pass `maxEvictedParents`
instead; eviction is purely size-based.

### Removed: redact re-exports on `harness-one/observe`

`createRedactor`, `redactValue`, `sanitizeAttributes`, `REDACTED_VALUE`,
`DEFAULT_SECRET_PATTERN`, `POLLUTING_KEYS`, `RedactConfig`, `Redactor`
are only available through the canonical `harness-one/redact` subpath.

### Removed: legacy OpenAI global warn state

`_globalZeroUsageWarnedModelsDeprecated` is gone. `_resetOpenAIWarnState`
retains its signature but only clears per-instance state and the
convert-time unknown-schema-key dedupe.

### KNOWN_KEYS validator type-enforced

`@harness-one/preset`'s `validate-config.ts` now types the
unknown-key allow-list against `HarnessConfigBase | SecurePresetOptions`
so adding a field to the config surface raises a TypeScript error
in `validate-config.ts` until the allow-list is updated in step.

## Layer promotions (Wave-15, retained for reference)

The canonical homes changed to stop L3→L3 imports. Every symbol
listed stays reachable from its prior location through a re-export.

| Symbol | Old canonical home | New canonical home |
| --- | --- | --- |
| `MetricsPort`, `MetricCounter`, `MetricGauge`, `MetricHistogram`, `MetricAttributes`, `createNoopMetricsPort` | `harness-one/observe` | `harness-one/core` |
| `InstrumentationPort` | `harness-one/observe` | `harness-one/core` |
| `ModelPricing`, `priceUsage`, `hasNonFiniteTokens` | `harness-one/observe` | `harness-one/advanced` (Wave-17) |
| `HarnessError`, `HarnessErrorCode` | `harness-one/core` (impl file) | `core/infra/errors-base.ts` |
| `Brand`, `TraceId`, `SpanId`, `SessionId` | `harness-one/core` (impl file) | `core/infra/brands.ts` |
| `Streaming` + `Usage` subpaths | — | `harness-one/observe/trace`, `harness-one/observe/usage` |

## How to file a breaking change

1. Implement the change in-place (no `@deprecated` alias); this
   project treats pre-1.0 churn as expected.
2. Add a section under the current wave in this file: diff the
   before/after, note any re-export that preserves the old name,
   call out runtime (not just type) effects.
3. If the removal is load-bearing, add a changeset under
   `.changeset/` so the change appears in the next published
   changelog.
