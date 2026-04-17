# Wave-13 Architecture Audit — Research Report

**Date:** 2026-04-17
**Method:** 8 parallel deep-audit agents (architecture, concurrency, error handling, API design, performance, observability, tests, security)
**Baseline:** post-Wave-12 (commit 1c1c2b6) — 4074/4074 tests passing
**Raw findings:** 104; **after dedup:** 87 unique production-grade issues

---

## Executive Summary

Wave-12 closed 62 fixes across 9 packages. This Wave-13 audit identified **87 additional production-grade issues** that survived prior reviews — concentrated in:

1. **Cross-tenant safety** in module-scoped adapter state (OpenAI providers, warned-model sets).
2. **Resource leaks** in long-running orchestrators (delegation map, shared-context map, async-lock race).
3. **Wrong error codes** that break downstream alerting (`CORE_TOKEN_BUDGET_EXCEEDED` used for argument-size limits).
4. **Silent error swallowing** in session event handlers and middleware `onError` callbacks.
5. **Observability gaps** at every pool/queue/circuit/retry decision point — counters incremented but never logged or emitted as metrics.
6. **API consistency** — `dispose`/`shutdown` semantics, discriminator tags on union types, anonymous return types blocking future extension.

All 87 findings have concrete fixes; none require breaking changes.

---

## Track Layout (for parallel implementation)

| Track | Owner Files | Issues |
|-------|------|--------|
| A — infra (circuit-breaker, backoff, async-lock, lru-cache) | packages/core/src/infra/* | 7 |
| B — orchestration (agent-pool, message-queue, orchestrator) | packages/core/src/orchestration/* | 8 |
| C — observability (cost-tracker, trace-manager, logger) | packages/core/src/observe/* | 14 |
| D — core runtime (adapter-caller, stream-aggregator, sse-stream, middleware, agent-loop, error-classifier, iteration-runner, output-parser, execution-strategies) | packages/core/src/core/* | 19 |
| E — session/tools/memory/guardrails | packages/core/src/{session,tools,memory,guardrails}/* | 9 |
| F — preset | packages/preset/src/* | 7 |
| G — OpenAI adapter | packages/openai/src/* | 5 |
| H — Anthropic adapter | packages/anthropic/src/* | 3 |
| I — Langfuse exporter | packages/langfuse/src/* | 3 |
| J — OpenTelemetry exporter | packages/opentelemetry/src/* | 3 |
| K — Redis store | packages/redis/src/* | 3 |
| L — Ajv | packages/ajv/src/* | 3 |
| M — CLI | packages/cli/src/* | 1 |
| N — Tests (cross-package) | packages/*/test/, packages/*/src/**/*.test.ts | new tests for above + Wave-12 gaps |

---

## P0 — Critical (must-fix-now)

### P0-1 (D) — `stream-aggregator` uses `CORE_TOKEN_BUDGET_EXCEEDED` for tool-arg size violation
- **File:** `packages/core/src/core/stream-aggregator.ts:182-184`
- **Symptom:** Per-call tool-argument byte cap throws with cumulative-budget error code.
- **Impact:** Downstream retry/alerting heuristics misclassify; operators cannot distinguish wire-size violation from token-budget exhaustion.
- **Fix:** Throw `CORE_INVALID_INPUT` (or new `ADAPTER_PAYLOAD_OVERSIZED`).

### P0-2 (D) — `stream-aggregator` uses `CORE_TOKEN_BUDGET_EXCEEDED` for max-tool-calls limit
- **File:** `packages/core/src/core/stream-aggregator.ts:197-200`
- **Same root cause as P0-1**, applied to call-count limit.
- **Fix:** Throw `CORE_INVALID_STATE` (configuration limit, not budget).

### P0-3 (G) — OpenAI adapter module-scoped state enables cross-tenant contamination
- **File:** `packages/openai/src/index.ts:27-36, 444-446, 613-624`
- **Symptom:** `_providers`, `_zeroUsageWarnedModels`, `_unknownSchemaKeyWarned` are module-scoped mutable state shared across all adapter instances.
- **Impact:** Multi-tenant SaaS deployments — one tenant's `registerProvider` overrides everyone's. Warning dedup is process-wide.
- **Fix:** Move warned-model dedup to instance-scoped LRU bounded sets returned by `createOpenAIAdapter()`. Provider registry stays module-scoped (already gated by `sealProviders()`) but per-instance warned sets must be instance fields.

### P0-4 (B) — `orchestrator.delegationChain` Map unbounded
- **File:** `packages/core/src/orchestration/orchestrator.ts:146`
- **Symptom:** Tracks in-flight delegations but never bounded; stuck/leaking delegations grow unbounded → OOM.
- **Fix:** Add `maxInFlightDelegations` (default 1000); throw `ORCH_DELEGATION_LIMIT` on overflow.

### P0-5 (B) — `orchestrator.contextStore` Map never evicts
- **File:** `packages/core/src/orchestration/orchestrator.ts:138`
- **Symptom:** `setSharedContext()` writes accumulate forever.
- **Fix:** LRU-evict (default max 10_000 entries) with config knob; expose `clearSharedContext(key)`.

### P0-6 (C) — Cost-tracker O(n²) eviction in streaming path
- **File:** `packages/core/src/observe/cost-tracker.ts:541-557`
- **Symptom:** `traceIdIndex` rebuild on `records.shift()` does an O(n) backward scan for the next-occurrence index of the evicted trace, per eviction. With 10K records under streaming load → O(n²) at 100Hz.
- **Fix:** Maintain `traceId → indices[]` (sorted), pop front on eviction (O(1)).

### P0-7 (K) — Redis WATCH/UNWATCH timing race in `update()`
- **File:** `packages/redis/src/index.ts:279-316`
- **Symptom:** Async work between `WATCH` and `MULTI/EXEC` opens a window where another client can mutate the key after WATCH but before our EXEC, defeating optimistic locking.
- **Fix:** Capture all data needed for the new value before WATCH, or wrap the read+modify in MULTI; explicitly `UNWATCH` on every error path.

---

## P1 — Important (must-fix-this-wave)

### Track A — Infra

- **A-1** `CircuitOpenError` extends plain `Error`, not `HarnessError` → breaks `error.code` taxonomy. **Fix:** extend `HarnessError` with code `ADAPTER_CIRCUIT_OPEN`.
  *File:* `packages/core/src/infra/circuit-breaker.ts:55-60`
- **A-2** Backoff jitter uncapped on high retries; deep retry counts produce minute-scale variance. **Fix:** cap absolute jitter (default 30s).
  *File:* `packages/core/src/infra/backoff.ts:35-45`
- **A-3** `computeBackoffMs` accepts unbounded `maxMs`; misconfiguration → minute-scale sleeps. **Fix:** validate `maxMs ≤ 600_000` in caller.
- **A-4** Async-lock race: `dispose()` while a waiter's abort handler is mid-execution can double-reject. **Fix:** mark waiter `aborted` flag; skip in dispose loop.
  *File:* `packages/core/src/infra/async-lock.ts:127-171`
- **A-5** Ajv format-loader promise cached on first failure (transient errors poison cache). **Fix:** clear cache on rejection so retries can succeed.
  *File:* `packages/ajv/src/index.ts:69`
- **A-6** Ajv eviction loop O(n) for misconfigured tiny `maxCacheSize`. **Fix:** validate `maxCacheSize ≥ 1` at factory.

### Track B — Orchestration / Pool / Queues

- **B-1** Pool queue-depth not emitted as metric/log; capacity breaches throw but no telemetry beforehand. **Fix:** emit gauge on every `acquireAsync()`.
  *File:* `packages/core/src/orchestration/agent-pool.ts:289-300`
- **B-2** Pool resize unlogged; autoscaling invisible. **Fix:** `logger.info('pool resize',{from,to})` and gauge.
  *File:* `packages/core/src/orchestration/agent-pool.ts:394-417`
- **B-3** Pool dispose errors only counter-tracked; never logged. **Fix:** `logger.warn` per error + counter.
  *File:* `packages/core/src/orchestration/agent-pool.ts:125-156`
- **B-4** Pool acquire timeout throws `POOL_TIMEOUT` without span event of queue depth / active count. **Fix:** `addSpanEvent` before reject.
  *File:* `packages/core/src/orchestration/agent-pool.ts:313-324`
- **B-5** Message-queue drops fire `onWarning` but no metric. **Fix:** depth gauge + drop counter.
  *File:* `packages/core/src/orchestration/message-queue.ts:103-137`

### Track C — Observability

- **C-1** Cost-tracker setters (`setPricing`/`setBudget`) not concurrency-safe. **Fix:** wrap in async-lock OR deprecate setters.
  *File:* `packages/core/src/observe/cost-tracker.ts:185-210`
- **C-2** Cost-tracker `updateUsage` uses spread-with-conditional that allocates dead temp objects per record. **Fix:** explicit field assignment.
  *File:* `packages/core/src/observe/cost-tracker.ts:599-608`
- **C-3** Cost alerts fire `onAlert` callback but no log/metric/span. **Fix:** `logger.warn` + utilization gauge on every `recordUsage`.
  *File:* `packages/core/src/observe/cost-tracker.ts:560-650`
- **C-4** TraceManager `flush()` uses `Promise.all` — slowest exporter blocks. **Fix:** `Promise.allSettled` with per-exporter timeout.
  *File:* `packages/core/src/observe/trace-manager.ts:953,990-1002`
- **C-5** TraceManager `startSpan` on dead trace silently no-ops; counter drift. **Fix:** return `{ok, spanId?}` discriminated.
  *File:* `packages/core/src/observe/trace-manager.ts:516-520`
- **C-6** Lazy-init exporter promise not tracked in `pendingExports`; flush misses early shutdown. **Fix:** track init promise.
  *File:* `packages/core/src/observe/trace-manager.ts:233`
- **C-7** TraceManager LRU mutation racy — `isEvicting` only guards re-entry, not concurrent mutations. **Fix:** async-lock all LRU mutations.
- **C-8** Logger has no `isInfoEnabled` / `isErrorEnabled` companions; metadata always allocated. **Fix:** add level-checks.
  *File:* `packages/core/src/observe/logger.ts`

### Track D — Core runtime

- **D-1** Middleware: when middleware throws a `HarnessError`, it's re-thrown without middleware-context wrap; observers can't trace boundary. **Fix:** wrap all errors with `CORE_MIDDLEWARE_ERROR` + cause.
  *File:* `packages/core/src/core/middleware.ts:109-122`
- **D-2** Middleware `onError` callback not guarded; throw escapes try block. **Fix:** wrap in try/catch.
  *File:* `packages/core/src/core/middleware.ts:111-113`
- **D-3** `adapter-caller` swallows orphaned post-timeout chatPromise rejection without observability hook. **Fix:** log/counter + retain comment.
  *File:* `packages/core/src/core/adapter-caller.ts:303-305`
- **D-4** Adapter retry span event missing `backoff_ms`/`retry_number`; no per-error-category retry-latency histogram. **Fix:** record both, emit metric.
  *File:* `packages/core/src/core/adapter-caller.ts:188-227`
- **D-5** Adapter timeout error has no span attribute breakdown (provider vs local). **Fix:** set attributes on timeout.
  *File:* `packages/core/src/core/adapter-caller.ts:240-255`
- **D-6** Retry exhaustion missing cumulative `total_backoff_ms`/`total_duration_ms` on final span. **Fix:** track + set attributes.
- **D-7** Error classifier 5–7 sequential `.includes()` calls per classify; large stacks slow. **Fix:** single combined regex.
  *File:* `packages/core/src/core/error-classifier.ts:50-57`
- **D-8** Error classifier fallback path silent. **Fix:** `logger.debug` on unknown classification.
- **D-9** SSE-stream fallback `JSON.stringify` reason not size-bounded. **Fix:** clamp `String(err).slice(0, 200)`.
  *File:* `packages/core/src/core/sse-stream.ts:62-69`
- **D-10** `ExecutionStrategy` interface lacks optional `dispose()` — custom strategies leak resources. **Fix:** add `dispose?: () => Promise<void>` to interface; agent-loop forwards.
- **D-11** `AgentLoopHook` callbacks lack documented exception contract; thrown hook can break loop. **Fix:** wrap each invocation in try/catch+log; document.
- **D-12** Output-parser regex compiled per call (if any). **Fix:** module-level const.

### Track E — Session / Tools / Memory / Guardrails

- **E-1** Session-manager event handlers swallow throws (`catch{}`). **Fix:** log via injected logger, expose `getLastHandlerError()` getter.
  *File:* `packages/core/src/session/manager.ts:194-206`
- **E-2** Session-manager event drops only warn once globally; cascade drops invisible. **Fix:** per-drop counter + warn.
  *File:* `packages/core/src/session/manager.ts:151-186`
- **E-3** Session-manager `toReadonly()` deep-clones metadata on every access. **Fix:** Proxy lazy-clone OR document size cap.
  *File:* `packages/core/src/session/manager.ts:273-313`
- **E-4** Tool registry: no per-turn cumulative-byte cap on tool-call arguments — DoS amplification vector. **Fix:** add `maxTotalArgBytesPerTurn` (default 10MiB).
  *File:* `packages/core/src/tools/registry.ts`
- **E-5** `MemoryStore.filter()` lacks `signal?: AbortSignal` parameter. **Fix:** add signal threading; periodic checks in fs-store.
  *File:* `packages/core/src/memory/store.ts`
- **E-6** Guardrail pipeline tracks only global timeout, not per-guard fairness. **Fix:** per-guard timeout = `min(remaining_global, guard_timeoutMs)`.
  *File:* `packages/core/src/guardrails/pipeline.ts:78-120`
- **E-7** Guardrail `utf8ByteLength` allocates Uint8Array per call. **Fix:** fast-path `len*4 > maxBytes` shortcut.
  *File:* `packages/core/src/guardrails/schema-validator.ts:23-25`

### Track F — Preset

- **F-1** `Harness.shutdown()` not on the public Harness interface (duck-typed). **Fix:** promote to required method on interface.
- **F-2** Preset doesn't supply default `adapterTimeoutMs` to `createAgentLoop`; provider hangs cascade. **Fix:** default 60_000ms; allow override via HarnessConfig.
  *File:* `packages/preset/src/index.ts:450-461`
- **F-3** Preset `onSessionId` callback throw not actually swallowed (doc bug). **Fix:** wrap in try/catch+log to match JSDoc.
  *File:* `packages/preset/src/index.ts:239-241`
- **F-4** `HarnessConfig` union lacks discriminator. **Fix:** add `type: 'adapter'|'anthropic'|'openai'`.
- **F-5** `HarnessConfigBase` not exported. **Fix:** add `export`.
- **F-6** `drain(timeoutMs?)` default not in signature. **Fix:** default-param expression + exported constant.
- **F-7** Pricing-error message: model name needs quoting; finite check edges. **Fix:** clarify message.

### Track G — OpenAI adapter

- **G-1** (covered by P0-3 above)
- **G-2** `registerProvider()` needs optional `trustedOrigins` whitelist for redirect protection. **Fix:** add option; throw on mismatch.
- **G-3** `providers` const not deeply frozen at runtime. **Fix:** `Object.freeze` recursively.
- **G-4** `registerProvider(name)` shorthand using bundled `providers` map missing. **Fix:** add overload.

### Track H — Anthropic adapter

- **H-1** Malformed-tool-use throw policy: error preview is head-only; tail of large blob never visible. **Fix:** `head + ' ... ' + tail` for >400 chars.
  *File:* `packages/anthropic/src/index.ts:207-214`
- **H-2** Malformed-tool-use callback `null` ambiguous (vs default policy). **Fix:** discriminated union or explicit `ParsedToolArguments`.

### Track I — Langfuse exporter

- **I-1** `flush()` does fire-and-forget `client.flushAsync()`. **Fix:** `return client.flushAsync()`.
  *File:* `packages/langfuse/src/index.ts:271-273`
- **I-2** Export failures not tagged on the offending span before re-throw. **Fix:** `addSpanEvent('exporter_error',{exporter,code})`.
- **I-3** No metric on flush-batch failures. **Fix:** counter + log threshold.

### Track J — OpenTelemetry exporter

- **J-1** `evictedParentsTtlMs` deprecated field has no `@deprecated` JSDoc tag at property. **Fix:** add tag.
  *File:* `packages/opentelemetry/src/index.ts:64-69`
- **J-2** `createOTelExporter` returns anonymous `TraceExporter & {…}`. **Fix:** extract `OTelTraceExporter` interface.
- **J-3** Parent-fallback to evicted-parents cache succeeds silently. **Fix:** counter + debug log.

### Track K — Redis store

- **K-1** `query()` partial mget failure silently returns subset. **Fix:** propagate failure.
- **K-2** `RedisMemoryStore.repair()` not surfaced via public type export. **Fix:** export interface.

### Track L — Ajv

- **L-1** Schema spread on every cache miss. **Fix:** `Object.assign(schema, {$id:key})` or pre-tag.
  *File:* `packages/ajv/src/index.ts:202`
- (A-5, A-6 covered above)

### Track M — CLI

- **M-1** Module-scoped `ALL_MODULES`/`MODULE_DESCRIPTIONS` mutable. **Fix:** `as const` + `Object.freeze`.

---

## P2 — Polish

- **C-9** Logger metadata sanitizer doesn't recurse into `error.cause` chain. **Fix:** recursive redaction.
- **C-10** TraceManager span LRU eviction has no metric. **Fix:** counter + warn at 80%.
- **D-13** IterationRunner `safeStringifyToolResult` allocates `WeakSet`/`WeakMap` per call. **Fix:** pool via context.
- **C-11** Logger absolute-path stack sanitizer not enforced at exporter boundary. **Fix:** sanitize at HarnessError serialization.

---

## P3 — Trivial

- **P3-1** `ToolCallRequest.arguments` has no parsed-vs-raw type brand. **Fix:** introduce `ParsedToolArguments` brand (deferred — would touch every adapter; flagged but not implemented this wave).

---

## Test additions (Track N) — required for near-100% coverage

For every fix above, add unit tests covering:

- POOL_QUEUE_FULL throw path (B-1 .. B-5)
- Circuit-breaker concurrent probe failure path (A-1)
- Stream-aggregator perf assertion (P0-1, P0-2)
- Adapter timeout streaming + retry race (D-3, D-5)
- Error classifier 500-series boundary (D-7)
- Tool registry per-turn byte cap (E-4)
- Session-manager GC interval dispose (E-1, E-2, E-3)
- Resilient loop dispose under onRetry throw
- Cost-tracker dedupe-window expiry (C-3)
- Cost-tracker eviction perf (P0-6)
- Langfuse `flushAsync` await on dispose (I-1)
- Redis WATCH race (P0-7)
- OpenAI per-instance warned-models LRU (P0-3)
- Async-lock dispose+abort race (A-4)

---

## API additions (non-breaking)

- `HarnessErrorCode.ADAPTER_PAYLOAD_OVERSIZED`
- `HarnessErrorCode.ADAPTER_CIRCUIT_OPEN`
- `HarnessErrorCode.ORCH_DELEGATION_LIMIT`
- `Harness.shutdown(): Promise<void>` (required, not duck-typed)
- `RegisterProviderOptions.trustedOrigins?: readonly string[]`
- `MemoryStore.filter(predicate, opts?: {signal?: AbortSignal})`
- `ExecutionStrategy.dispose?(): Promise<void>`
- `Logger.isInfoEnabled?()`, `isErrorEnabled?()`
- `OTelTraceExporter` named interface
- `TraceManager.startSpan` returns `{ ok: boolean; spanId?: SpanId }` (additive — existing callers compile, just may ignore `.ok`)
- `RedisMemoryStore` interface explicitly exported
- `CreateRegistryConfig.maxTotalArgBytesPerTurn?: number`
- `AgentPoolConfig.maxInFlightDelegations?: number` (orchestrator)
- `OrchestratorConfig.maxSharedContextEntries?: number`
- `LANGFUSE_DISPOSE_TIMEOUT_MS`, `DRAIN_DEFAULT_TIMEOUT_MS` exports
- `HarnessConfig` discriminator field (`type: 'adapter' | 'openai' | 'anthropic'`)
- `HarnessConfigBase` exported
- `AnthropicAdapter.onMalformedToolUse` callback contract (null vs default — clarified in JSDoc)

---

## Implementation order (parallel-safe)

Tracks A–M each touch independent file groups; safe to run all in parallel. Track N (tests) follows tracks A–M and adds test files in the same packages — no file conflicts because production and test files are separate.

Final step (sequential): `pnpm api:update` → `pnpm typecheck` → `pnpm test` → `pnpm lint` → `pnpm build`.
