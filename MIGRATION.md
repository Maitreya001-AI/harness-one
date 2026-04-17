# Migration Guide

This document tracks deprecations and removal schedules across the
`harness-one` monorepo. Every `@deprecated` symbol in the source tree
should have a row here; removal lands no earlier than the noted version.

Follow [SemVer](https://semver.org/): deprecated symbols continue to
work in every `0.x.y` release and are only removed in a major-version
bump. The "Removal target" column below is informational — we reserve
the right to extend deprecation windows when meaningful consumers are
still on the old API.

## Active deprecations

### Error codes

| Symbol | Replacement | Removal target | Notes |
| --- | --- | --- | --- |
| `HarnessErrorCode.MEMORY_STORE_CORRUPTION` | `HarnessErrorCode.MEMORY_CORRUPT` | `v2.0` | Round-3 canonicalised on the `MEMORY_CORRUPT` name. Back-compat enum entry kept so existing `catch (e) { if (e.code === MEMORY_STORE_CORRUPTION) ... }` still matches. |
| `HarnessErrorCode.MEMORY_DATA_CORRUPTION` | `HarnessErrorCode.MEMORY_CORRUPT` | `v2.0` | Same as above — alternate spelling that some wave-12 callers relied on. |

### Error classes

| Symbol | Replacement | Removal target | Notes |
| --- | --- | --- | --- |
| `GuardrailBlockedError` | `new HarnessError(reason, HarnessErrorCode.GUARD_VIOLATION, suggestion)` | `v2.0` | The runtime guardrail pipeline (`core/guardrail-runner.ts`) now throws the typed `HarnessError` form directly. `GuardrailBlockedError` is still exported for `instanceof` checks; new code should match on `err.code === HarnessErrorCode.GUARD_VIOLATION` instead. |

### Public barrels

| Symbol | Replacement | Removal target | Notes |
| --- | --- | --- | --- |
| `createRedactor` from `harness-one/observe` | `harness-one/redact` | `v2.0` | Redaction primitives hoisted to a dedicated subpath. The `harness-one/observe` re-exports remain but are flagged `@deprecated`. |
| `redactValue` / `sanitizeAttributes` from `harness-one/observe` | `harness-one/redact` | `v2.0` | Same as above. |
| `REDACTED_VALUE` / `DEFAULT_SECRET_PATTERN` / `POLLUTING_KEYS` from `harness-one/observe` | `harness-one/redact` | `v2.0` | Same as above. |
| `type RedactConfig` / `type Redactor` from `harness-one/observe` | `harness-one/redact` | `v2.0` | Same as above. |

### Function signatures

| Symbol | Replacement | Removal target | Notes |
| --- | --- | --- | --- |
| `createHandoff(orchestrator: AgentOrchestrator, ...)` overload | `createHandoff(transport: MessageTransport, ...)` | `v2.0` | `AgentOrchestrator` structurally satisfies `MessageTransport`, so no call-site changes are required — the type hint will simply prefer the more-specific overload going forward. |
| Flat `AgentLoopConfig` shape | Nested `AgentLoopConfigV2` (`{ limits, resilience, observability, pipelines, execution }`) | Not scheduled | Flat form remains fully supported. `createAgentLoop` accepts either shape; prefer the nested form in new code for ergonomic grouping. |

### Harness configuration

| Symbol | Replacement | Removal target | Notes |
| --- | --- | --- | --- |
| Passing both `adapter` and `client` on `HarnessConfig` | Pick one: `AdapterHarnessConfig` ({ adapter }) XOR `{Anthropic,OpenAI}HarnessConfig` ({ provider, client }) | `v2.0` (compile error today) | Wave-14 made the XOR a compile-time error via a discriminated union, plus a runtime guard with an explicit migration message. Consumers passing both were silently using the `adapter` branch before. |

### Cost tracker

| Symbol | Replacement | Removal target | Notes |
| --- | --- | --- | --- |
| `getCostByModel(): Record<string, number>` | `getCostByModelMap(): ReadonlyMap<string, number>` | Not scheduled | Both methods are supported. The Map variant supports O(1) membership tests and ordered iteration without the boxing overhead of `Object.entries()`. Prefer the Map view in new code. |

### Layer promotions (Wave-15)

Non-breaking: every symbol below stays exported from its prior location.
The canonical home changed to stop L3→L3 imports.

| Symbol | Old canonical home | New canonical home | Notes |
| --- | --- | --- | --- |
| `MetricsPort`, `MetricCounter`, `MetricGauge`, `MetricHistogram`, `MetricAttributes`, `createNoopMetricsPort` | `harness-one/observe` | `harness-one/core` | L3→L3 edge removed. Observe re-exports. |
| `InstrumentationPort` | `harness-one/observe` | `harness-one/core` | L3→L3 edge removed. Observe re-exports. |
| `ModelPricing`, `priceUsage`, `hasNonFiniteTokens` | `harness-one/observe` | `harness-one/core` | Pricing is cross-cutting; observe/preset re-export. |
| `HarnessError`, `HarnessErrorCode`, `HarnessErrorDetails` | `harness-one/core` (impl file) | `core/infra/errors-base.ts` | Enables the "L1 imports nothing" rule. `harness-one/core` re-exports. |
| `Brand`, `TraceId`, `SpanId`, `SessionId` | `harness-one/core` (impl file) | `core/infra/brands.ts` | Same rationale as above. |
| `Streaming` + `Usage` subpaths | — | `harness-one/observe/trace`, `harness-one/observe/usage` | Cohesive sub-barrels added for callers that want the tracing pipeline OR the cost/usage view, not both. |

### Wave-15 additions

Non-breaking additive surface — prefer these in new code.

| Addition | Where | Notes |
| --- | --- | --- |
| `createCustomErrorCode(namespace, code)` | `harness-one/core` | Namespaced custom codes that ride on `ADAPTER_CUSTOM` for switch-exhaustiveness. |
| `createBackoffSchedule(config)` / `BackoffSchedule` | `harness-one/core` | Reusable backoff sleeper sharing the infra/backoff math. |
| `applyRecordCap({...})` | `harness-one/observe` | Shared record-eviction loop used by core and `@harness-one/langfuse` cost trackers. |
| `serializePayloadSafe(payload, {...})` | `harness-one/orchestration` | Shared depth+byte cap extracted from `handoff.ts` so future cross-agent payloads can reuse it. |
| `validateHarnessRuntimeConfig(config)` / `validateHarnessConfigAll(config)` | `@harness-one/preset` | Unified preset validation (numeric + structural), consolidating what used to live in two separate modules. |
| `SessionStore<T>` + `createSessionManager({ store })` | `harness-one/session` | Pluggable session storage backend for distributed deployments. |
| `LRUCacheOptions.onEvict` | infra (via `harness-one/core`) | Synchronous eviction hook for side-table accounting. |
| Iteration coordinator (`startRun`, `checkPreIteration`, `startIteration`, `finalizeRun`, `CoordinatorDeps`, `CoordinatorState`) | `harness-one/core` | Event-sequencing state machine extracted from AgentLoop. |
| `TraceManagerConfig.redactor?: Redactor` | `harness-one/observe` | Inject a shared Redactor instance rather than compiling one per component. |
| `ResiliencePolicy` (alias for `RetryPolicy`) | `harness-one/core` | Clarifies that retry+breaker is one composed policy. |

### Wave-16 deprecation / removal schedule

| Symbol | Replacement | Removal target | Notes |
| --- | --- | --- | --- |
| `harness-one/observe/metrics-port` re-export path | `harness-one/core` | `v0.3.0` | Wave-15 moved the canonical `MetricsPort` home to L2. The thin `observe/metrics-port.ts` re-export now carries an explicit removal pin. External consumers: switch the import path; internal code must import from `../core/metrics-port.js` directly. |
| `observe/cost-math.ts` module | `harness-one/core` (for `priceUsage` / `hasNonFiniteTokens`) + `cost-tracker.ts` (for `KahanSum`) | Removed in Wave-16 | Duplicated primitives that already lived in `core/pricing.ts`; `KahanSum` moved inline into `observe/cost-tracker.ts` since that's its only caller. No public API change — the public re-exports (`KahanSum`, `priceUsage`, `hasNonFiniteTokens`) keep working. |

### Wave-16 additions (non-breaking)

| Addition | Where | Notes |
| --- | --- | --- |
| Validator consolidation — `requirePositiveInt` / `requireNonNegativeInt` / `requireFinitePositive` / `requireFiniteNonNegative` / `requireUnitInterval` now used by admission controller, circuit breaker, execution strategies, trace sampler, trace manager, agent-loop validation, `@harness-one/ajv`, `@harness-one/langfuse` | `harness-one/core` | Error messages for `maxIterations` / `maxTotalTokens` / `maxStreamBytes` / `maxToolArgBytes` / `toolTimeoutMs` kept verbatim; `maxTraces` / `maxRecords` / `samplingRate` / `flushTimeoutMs` / `baseRetryDelayMs` / `maxAdapterRetries` / `maxConcurrency` / `maxInflight` / `failureThreshold` / `resetTimeoutMs` / `budget` / `defaultTTL` / `maxCacheSize` normalised. Integration tests assert the delegation so future drift is caught. |
| `resolveCandidateIds(filter, indexes)` / `unionTagSets` / `intersect` | `core/memory/memory-query.ts` | Set-algebra helpers extracted from `createInMemoryStore` so the store owns CRUD + index maintenance and the query logic is unit-tested in isolation. |
| `invokeAsync(fn)` guard in `trace-exporter-coordinator` | `core/observe/trace-exporter-coordinator.ts` | Ensures a sync-throwing `exporter.flush()` / `shutdown()` rejects cleanly instead of unwinding past `Promise.allSettled`. Regression tests landed alongside. |
| Adapter package splits — `@harness-one/redis` → `keys.ts` / `codec.ts` / `query.ts` / `update-txn.ts` / `compact.ts`; `@harness-one/langfuse` → `cost-pricing.ts` / `cost-export.ts`; `@harness-one/opentelemetry` → `span-map.ts` / `attributes.ts` | respective package `src/` | Public API unchanged — `createRedisStore`, `createLangfuseCostTracker`, and `createOTelExporter` still live in `src/index.ts` / `src/cost-tracker.ts`. The split removes the monolithic single-file adapters flagged in the Wave-16 review. |

## Removed in prior waves

This section records historical deprecations that have already been
removed. It is not exhaustive — see `CHANGELOG.md` for the full
history. Only load-bearing renames that consumers might still need to
look up are captured here.

- (No prior removals yet — tracking begins in Wave-14.)

## How to file a deprecation

When flagging a new `@deprecated` symbol:

1. Add a `@deprecated` JSDoc tag with a one-sentence migration hint.
2. Add a row to the appropriate table in this file (Symbol,
   Replacement, Removal target, Notes).
3. If the removal is load-bearing, add a changeset under
   `.changeset/` so the deprecation appears in the next published
   changelog.
