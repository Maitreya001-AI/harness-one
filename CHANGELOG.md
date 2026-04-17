# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Changed — Wave-15 (post-Wave-14 architecture review — 20 findings resolved)

Driven by a fresh blue-team architecture review against the post-Wave-14
baseline. All 20 findings addressed; every change is non-breaking via
re-exports or additive surface. See `MIGRATION.md § Wave-15 additions`
for the full table and `docs/ARCHITECTURE.md` for the updated layering
contract.

**Layering contract (blockers):**
- `MetricsPort`, `InstrumentationPort` hoisted from observe (L3) to
  `core/core` (L2); orchestration / rag stop importing from sibling L3.
- `HarnessError`, `HarnessErrorCode`, branded-id types (`TraceId`,
  `SpanId`, `SessionId`) moved to `core/infra/errors-base.ts` +
  `core/infra/brands.ts`. Infra no longer imports from core/*; the
  Wave-14 eslint carve-out is gone. "L1 imports nothing" is now
  strict.

**God-object splits / dedup (majors):**
- `core/iteration-coordinator.ts` extracted from `agent-loop.ts`
  (632 → 340 LOC). AgentLoop now composes the event-sequencing state
  machine (startRun / checkPreIteration / startIteration /
  finalizeRun) instead of owning it. Focused test file added.
- `observe/trace.ts` + `observe/usage.ts` sub-barrels split the
  observability surface into tracing pipeline vs cost/usage
  accounting. New package-json subpaths: `harness-one/observe/trace`,
  `harness-one/observe/usage`.
- `createCustomErrorCode(namespace, code)` — namespaced custom codes
  ride on `ADAPTER_CUSTOM` for switch-exhaustiveness. Subsystems stop
  mutating the closed `HarnessErrorCode` enum for new codes.
- `orchestration/safe-payload.ts` owns the shared depth + byte cap
  used by handoff.
- `observe/applyRecordCap()` centralises the record-eviction loop
  shared by core + `@harness-one/langfuse` cost trackers.
- `preset/validate-config.ts` merged the numeric/provider validator
  that lived inside `build-harness/run.ts`. New
  `validateHarnessRuntimeConfig` and `validateHarnessConfigAll`
  exports.
- `core/pricing.ts` is the canonical home for `ModelPricing`,
  `priceUsage`, `hasNonFiniteTokens`, and the validator re-exports.

**Additive primitives (minors):**
- `createBackoffSchedule(config)` / `BackoffSchedule` — reusable
  backoff sleeper.
- `LRUCacheOptions.onEvict` — synchronous eviction hook.
- `StreamAggregator.initialize()` / `finalize()` — explicit lifecycle
  aliases.
- `SessionStore<T>` + `createSessionManager({ store })` — pluggable
  session backend for distributed deployments.
- `TraceManagerConfig.redactor?: Redactor` — inject a shared Redactor
  instance rather than compiling one per component.
- `ResiliencePolicy` alias — documents that `RetryPolicy` is the
  composed breaker+retry primitive.

**Documentation:** `docs/ARCHITECTURE.md` and `MIGRATION.md` revised
with Wave-15 promotions and the full additive surface table.

**Environment:** 4403 tests passing (+11 over Wave-14); typecheck /
test / lint / build / api:update all clean across 12 workspaces.

### Fixed — Wave-13 (eight-angle audit — 70+ production-grade fixes)

Driven by eight parallel deep-audit agents (architecture, concurrency, error
handling, API design, performance, observability, tests, security) against the
post-Wave-12 baseline — see `docs/forge-fix/wave-13/research-report.md`
for the full finding set and `docs/forge-fix/wave-13/` for track-level plans.

**P0 — data loss / crash / isolation:**
- `stream-aggregator` per-call tool-argument size cap now throws
  `ADAPTER_PAYLOAD_OVERSIZED` (previously misclassified as cumulative
  `CORE_TOKEN_BUDGET_EXCEEDED`); max-tool-call count uses `CORE_INVALID_STATE`
  so downstream retry/alerting heuristics can distinguish wire-size caps from
  token-budget exhaustion.
- OpenAI adapter module-scoped `_zeroUsageWarnedModels` moved into per-instance
  bounded-LRU state — prevents cross-tenant warning-dedupe contamination.
- Orchestrator `delegationChain` cap (`maxDelegationChainEntries`, default
  10 000) stops unbounded map growth when delegations never complete.
- Orchestrator `contextStore` cap (`maxSharedContextEntries`, default 10 000)
  + new `sharedContext.delete(key)` method for long-running tenants.
- Cost-tracker eviction rewritten from O(n²) backward-scan to amortised O(1)
  via `traceIdIndex: Map<string, number[]>` + `evictionBias` offset.
- Redis `update()` hardened: data prepared before `WATCH`, `UNWATCH` on every
  error path, no `await` between `MULTI` and `EXEC`.

**P1 — resilience, observability, API hardening:**
- `CircuitOpenError` now extends `HarnessError` with
  `ADAPTER_CIRCUIT_OPEN` code; `onStateChange` callback receives a context
  object carrying consecutive-failure count and last-failure error.
- `computeBackoffMs` validates `maxMs ≤ 600 000 ms`, `baseMs ≤ 300 000 ms`,
  `jitterFraction ∈ [0, 1]`; new optional `maxAbsoluteJitterMs` cap.
- `async-lock` `dispose()` + abort handler race eliminated via per-waiter
  `aborted` flag — double-reject no longer possible.
- Agent-pool emits depth gauge on every `acquireAsync`, warn + counter before
  `POOL_QUEUE_FULL`, info log on `resize()`, warn + counter on dispose-error,
  span event on `POOL_TIMEOUT`.
- Message-queue emits depth gauge on every push, drop counter on overflow;
  structured warn when logger is injected.
- Middleware now wraps thrown `HarnessError`s with `CORE_MIDDLEWARE_ERROR`
  preserving the original as `.cause` so observability retains the
  middleware-boundary context; throwing `onError` callbacks are themselves
  try/catch-guarded.
- Adapter-caller orphaned post-timeout rejections now debug-logged; retry
  span events carry `backoff_ms` / `retry_number`; timeout failures set
  `timeout_ms` / `adapter` span attributes; exhaustion span carries
  `total_backoff_ms` / `total_duration_ms`.
- Error-classifier replaces the `.includes()` chain with four pre-compiled
  regexes; fallback path debug-logs the unclassified message.
- `ExecutionStrategy.dispose?()` optional hook added; `AgentLoop.dispose()`
  forwards to the strategy.
- `AgentLoopHook` JSDoc now states the must-not-throw contract explicitly.
- Session-manager handler errors route through `logger.error` with
  `{eventType, error, handlerErrorCount}`; `getLastHandlerError()` getter
  added; drop warnings rate-limited to ≥1s but counter increments on every
  drop.
- Tool registry gains `maxTotalArgBytesPerTurn` (default 10 MiB) — DoS
  amplification via oversized tool-call arguments now fails fast with
  `ADAPTER_PAYLOAD_OVERSIZED`.
- `MemoryStore.query()` accepts `opts.signal?: AbortSignal`; fs-store checks
  every 50-entry batch; aborts throw `CORE_ABORTED`.
- Guardrail pipeline: per-guard `effectiveTimeout = min(remaining_global,
  guard_timeoutMs)`; emits `guard_timeout` span event.
- Guardrail `utf8ByteLength` short-circuits with upper-bound estimate when
  `s.length * 4 > cap`, skipping `TextEncoder.encode` allocation in the
  rejection path.
- Cost-tracker adds async-serialised `updatePricing()` / `updateBudget()`
  companions to the synchronous setters; explicit field assignment replaces
  conditional-spread allocations in `updateUsage`; budget alerts emit
  `harness.cost.alerts.total` counter, `logger.warn`, and a running
  `harness.cost.utilization` gauge.
- TraceManager `flush()` / `initialize()` swapped `Promise.all` →
  `Promise.allSettled` with per-exporter timeout so one stuck exporter no
  longer blocks shutdown. Dead-trace `startSpan` increments a counter +
  debug-logs instead of silently no-oping (`strictSpanCreation` flag throws
  `TRACE_NOT_FOUND`). Lazy exporter init tracked in `pendingExports` so
  `flush()` awaits it. LRU eviction emits counter + one-shot warn at 80%
  capacity.
- Logger gains `isInfoEnabled?()`, `isErrorEnabled?()`, `isDebugEnabled?()`
  companions; `createSafeReplacer` now renders `Error.cause` chains
  recursively (cycle-guarded, depth-capped at 8) with stack-sanitisation at
  every layer. New `sanitizeErrorForExport(err)` helper.
- Preset promotes `shutdown()` to the `Harness` interface, defaults
  `adapterTimeoutMs` to 60 s, wraps `onSessionId` callback throws, exports
  `HarnessConfigBase`, adds optional `type` discriminator on
  `HarnessConfig`, exports `DRAIN_DEFAULT_TIMEOUT_MS`.
- OpenAI adapter `registerProvider()` accepts optional `trustedOrigins`
  whitelist guarding against malicious redirects; `providers` const
  delivered through a `Proxy` that returns frozen objects; `registerProvider(name)`
  shorthand resolves baseURL from bundled `providers`.
- Anthropic `onMalformedToolUse` semantics clarified: callback return value
  `null` → empty `{}`, `undefined` → default throw policy. Throw-policy
  preview shows head + tail for payloads over 400 chars.
- Langfuse exporter `flush()` now awaits `client.flushAsync()`; export
  failures tag the offending span with `exporter_error` event; flush-batch
  failures emit counter + warn.
- OTel exporter extracts `OTelTraceExporter` named interface; tags
  `evictedParentsTtlMs` with `@deprecated`; evicted-parent cache fallback
  increments counter + debug-logs.
- Redis `query()` default throws `MEMORY_CORRUPT` on partial MGET failure
  (`partialOk?: boolean` preserves legacy skip-and-continue); `RedisMemoryStore`
  interface explicitly exported with `repair()` surfaced.
- Ajv `compileWithCache` avoids the per-miss object-spread allocation; format
  loader cache clears on rejection so transient failures can retry;
  `maxCacheSize` validated at factory entry.
- CLI `ALL_MODULES` and `MODULE_DESCRIPTIONS` frozen at module load.

**New API (non-breaking, all additive):**
- `HarnessErrorCode.ADAPTER_PAYLOAD_OVERSIZED`, `ORCH_DELEGATION_LIMIT`,
  `ORCH_CONTEXT_LIMIT`
- `SharedContext.delete(key: string): boolean`
- `OrchestratorConfig.maxDelegationChainEntries?`,
  `maxSharedContextEntries?`
- `ExecutionStrategy.dispose?()`
- `MemoryStore.query(pred, opts?: { signal?: AbortSignal })`
- `CircuitStateChangeContext { consecutiveFailures, lastFailureError?,
  lastFailureTimeMs? }`
- `BackoffConfig.maxAbsoluteJitterMs?`; `BACKOFF_MAX_MS_CEILING`,
  `BACKOFF_BASE_MS_CEILING` exports
- `Logger.isInfoEnabled?()`, `isErrorEnabled?()`, `isDebugEnabled?()`,
  `sanitizeErrorForExport()` helper
- `AgentPoolConfig.logger?`, `metrics?`, `traceManager?`, `poolId?`
- `MessageQueueConfig.logger?`, `metrics?`
- `CreateRegistryConfig.maxTotalArgBytesPerTurn?`
- `SessionManagerConfig.logger.error?`, `maxMetadataBytes?`;
  `SessionManager.getLastHandlerError()`, `handlerErrorCount`,
  `droppedEventCount`
- `RegisterProviderOptions.trustedOrigins?`
- `TraceManagerConfig.strictSpanCreation?`
- `OTelTraceExporter` named interface
- `RedisStoreConfig.partialOk?`
- `AnthropicAdapterConfig.onMalformedToolUse` accepts callback returning
  `Record<string, unknown> | null | undefined` with documented semantics
- Preset `HarnessConfigBase` exported; `adapterTimeoutMs?` field;
  `DRAIN_DEFAULT_TIMEOUT_MS`, `DEFAULT_ADAPTER_TIMEOUT_MS`
- Langfuse `LangfuseCostTracker.updatePricing()`, `updateBudget()`

**Coverage:** 4288 tests passing (+214 Wave-13 tests). Typecheck clean across
all 12 workspaces. Lint clean. Build succeeds. `api:update` regenerated all
baselines.

### Fixed — Wave-12 (deep architecture research — 62 production-grade fixes)

Driven by a six-angle parallel audit (concurrency, error handling, API design,
performance, observability, tests) — see `docs/forge-fix/wave-12/research-report.md`
for full findings.

**P0 — data loss / crash:**
- `agent-pool` `pendingQueue` is now bounded (`maxPendingQueueSize`, default 1000); excess acquires fail fast with `POOL_QUEUE_FULL`.
- `circuit-breaker` half-open probe guarded by a Promise-based single-slot mutex — concurrent probes no longer race on `consecutiveFailures`.
- `stream-aggregator` text + tool-call argument accumulation switched from `+=` concatenation to `string[]` buffers (avoids O(n^2) on large streams).
- `agent-loop.ts` conversation prune uses in-place overwrite instead of `splice(...spread)`.
- OpenAI adapter stream controller cleanup: replaced unsafe `as unknown as T` double-cast with a guarded narrow.

**P1 — resilience, observability, API hardening:**
- 5xx status codes (502/503/504, gateway/unavailable) now classified as `ADAPTER_UNAVAILABLE` (previously fell through to generic `ADAPTER_ERROR`).
- Tool-call JSON parse errors preserve the original `SyntaxError` as `cause` with position hint.
- Anthropic malformed tool_use: new `onMalformedToolUse` option (`warn`/`throw`/custom handler); raw argument string preserved on warn.
- `adapter.chat()` accepts an optional `adapterTimeoutMs` so non-streaming calls can no longer hang forever.
- `batchUnlink` partial-failure now logged via `logger.warn` with bounded sample errors.
- Trace sampling supports per-exporter `shouldSampleTrace(trace)` tail-gate, enabling "sample-all-errors, 5%-successes" patterns.
- Logger accepts optional `getContext()` hook → auto-injects `trace_id`/`span_id` per log call.
- Langfuse `flushAsync()` promises tracked in `pendingFlushes`; `dispose(timeoutMs)` awaits them; catch wrapped to prevent unhandled rejections.
- OTel `evictedParents` retention is now size-based only (TTL path removed); `stringifyComplexAttributes` config added for opt-in JSON serialization.
- `trace-manager.flush()`/`dispose()` bounded by `flushTimeoutMs` (default 30s).
- Session event queue prioritizes `created`/`destroyed`/`error` over routine events under pressure.
- Session `toReadonly()` deep-clones metadata (was shallow).
- `_zeroUsageWarnedModels` bounded to 256 FIFO entries.
- OpenAI provider registry: duplicate `registerProvider` with divergent `baseURL` throws unless `{ allowOverride: true }`; reentrancy guard.
- OpenAI `toOpenAIParameters` memoized via `WeakMap`.
- Preset `guardrails` config is deeply `readonly`.
- Preset `harness.run()` accepts `onSessionId` callback so callers can learn the auto-generated session id.
- Langfuse `traceMap` entries deleted on `.update()` failure; `events[].attributes` now sanitized.
- SSE stream `JSON.stringify` guarded; yields error envelope instead of crashing.
- Cost-tracker `setPricing`/`setBudget` marked `@deprecated` (one-shot warning); factory-time config preferred.

**P2 — polish, micro-optimizations, test gaps:**
- Abort listener registered before timer in `adapter-caller` backoff (closes micro-race).
- `retryableErrors` lookup converted to `Set<string>`.
- `serializeToolResult` depth-limited (default 10) with cycle breaking and size truncation marker.
- `computeJitterMs` output clamped to `idleTimeout * 0.1`.
- Logger warn/info/error/debug signatures tightened to `Readonly<Record<string, unknown>>`; stack-trace paths sanitized.
- `setSamplingRate` gets a matching `getSamplingRate()` accessor.
- Cost-tracker budget-alert dedup window (`alertDedupeWindowMs`, default 500ms) prevents alert flood on streaming.
- OpenAI + Anthropic `filterExtra` allow-lists pre-built as `Set<string>`; internal schema transformers marked `@internal`; unknown-key warnings deduped.
- Anthropic streaming tool-call arguments buffered (not re-yielded as growing prefix).
- `AdapterHarnessConfig` marked `@internal`; `Harness.initialize()` gets full TSDoc.
- `context/budget.ts` pins clamp-at-0 semantics; adds sticky `hasOverflowed()`.
- Property tests (deterministic mulberry32 PRNG) added for `backoff` bounds/monotonicity, `lru-cache` size invariant + MRU promotion, tiktoken fallback token-count monotonicity.
- New coverage: `onRetry` throw propagation, MessageQueue `since` strict-`>` boundary, backpressure throw + no-onEvent semantics, sse-stream circular-ref/throwing-getter, output-parser CRLF edge.

**API additions (non-breaking):**
- `Logger.getContext?()`, `Logger.isWarnEnabled?()`, `sanitizeStackTrace()` export.
- `TraceExporter.shouldSampleTrace?()`, `TraceManager.getSamplingRate()`.
- `PoolConfig.maxPendingQueueSize`, `AdapterCallerConfig.adapterTimeoutMs`.
- `createHarness().run()` option `onSessionId?: (id: string) => void`.
- `RunBudget.hasOverflowed()`.
- `LangfuseCostTracker.dispose(timeoutMs?)`.
- `OpenTelemetryExporter` config: `stringifyComplexAttributes?: boolean`.
- Anthropic adapter config: `onMalformedToolUse?: 'warn' | 'throw' | handler`.
- OpenAI `registerProvider` options: `{ allowOverride?: boolean }`.
- `CostTrackerConfig.alertDedupeWindowMs?`.

**New HarnessErrorCode enum values:** `ADAPTER_UNAVAILABLE`, `POOL_QUEUE_FULL`.

**Test counts** (all passing): core 3080, preset 261, openai 105, langfuse 113, opentelemetry 45, anthropic 55, cli 92, devkit 211, redis 62, tiktoken 23, ajv 27 → **4074 total**.

---

### Fixed — Wave-6A (production architecture audit — 14 fixes)

**Memory leak prevention:**
- `EventBus.on()` unsubscribe now removes empty handler Sets from the Map — prevents long-running apps from accumulating empty Sets for every event name.
- `EventBus.off()` applies the same cleanup.
- `SessionManager` pending events queue capped at 1000 entries — prevents unbounded growth from cascading event handlers.

**Error handling robustness:**
- `EventBus.emit()` wraps `onHandlerError` in try/catch — a throwing error-handler no longer breaks delivery of remaining handlers.
- `withSelfHealing` now surfaces `failureReason` on regenerate() failures instead of discarding the error message.
- JSON Schema validator rejects dangerous property names (`__proto__`, `constructor`, `prototype`) in `required` with an explicit error instead of silently skipping.

**Concurrency safety:**
- `MiddlewareChain.execute()` snapshots middlewares via `Array.from()` instead of `Set.values()` — prevents iterator invalidation if the Set is mutated during async execution.

**Security hardening:**
- `createRateLimiter` now throws `CORE_INVALID_CONFIG` when `distributed: true` — previously silently fell back to a no-op, allowing unlimited requests.
- `createPIIDetector` validates custom patterns against ReDoS before accepting them.
- `redact.ts` resets `lastIndex` after `test()` on global-flag regex patterns.
- `stableStringify` in cache-stability handles circular references via WeakSet — prevents stack overflow on cyclic message content.

**Performance:**
- `schema-validator.ts` reuses a module-level TextEncoder instance instead of allocating one per call.
- `MessageQueue.dequeue()` clamps negative limit to 0 — prevents undefined splice behavior.

**Data consistency:**
- `InMemoryStore` eviction removed redundant grade-index deletion that could corrupt the index when `victimEntry` was falsy.
- `createLangfuseCostTracker.setBudget()` validates input is a non-negative finite number.
- `@harness-one/ajv` uses WeakMap-based identity caching for circular schemas — prevents LRU cache thrashing.

### Fixed — Wave-5H (deep architecture review — 23 fixes)

**Input validation hardening:**
- `createParallelStrategy` now validates `maxConcurrency >= 1` — previously accepted 0 (deadlock) or negative values.
- `createCircuitBreaker` validates `failureThreshold >= 1` and `resetTimeoutMs >= 1` — previously accepted invalid values silently.
- `createFallbackAdapter` rejects empty `adapters` array — previously caused cryptic `undefined` access at runtime.
- `pruneConversation` safely handles `maxMessages < 1` — returns empty array with warning instead of crashing.
- `computeBackoffMs` clamps negative `attempt` to 0 — prevents fractional delay from `Math.pow(2, -n)`.

**Production-readiness (no console.warn in library code):**
- `TraceManager` — all `console.warn` fallbacks removed from `reportExportError()`, `ensureInitialized()`, and `dispose()`. Export errors route to injected `logger` or `onExportError`; silently swallowed when neither is provided.
- `CostTracker.alertHandlers` migrated from Array to Set (O(1) unsubscribe, consistent with session/orchestrator patterns).
- Guardrail pipeline timeout timers now call `.unref()` to prevent hanging Node.js processes.

**Concurrency safety:**
- `FallbackAdapter.handleSuccess()` now executes under `switchLock` — prevents race between concurrent success and failure counter resets.
- `createParallelStrategy` checks abort `signal` before starting each tool call — previously in-flight parallel tools ignored abort.

**API consistency:**
- `SessionManager.list()` now filters out expired sessions — previously leaked internal state (expired sessions with status 'expired' in results).
- `SessionManager.activeSessions` simplified to O(1) — previously O(n) scan on every access.
- `RAGPipeline.clear()` now resets `getIngestMetrics()` counters and calls `retriever.clear()` if available — previously left stale metrics and retriever index.
- `HarnessLifecycle` gains `dispose()` method — releases registered health check references and transitions to shutdown.
- `Orchestrator.dispose()` now resets `droppedMessages` counter.

### Fixed — Wave-5G follow-up (post-audit hardening)

- **Timer leak in `output-parser.ts` `parseWithRetry()`** — `Promise.race` timeout handle is now always cleared via `try/finally`, matching the pattern in `self-healing.ts`. Previously, each retry iteration leaked one timer.
- **`tools/registry.ts` JSON.parse size guard** — `execute()` now rejects arguments exceeding 5 MiB (matching `AgentLoop.maxToolArgBytes` default) before parsing, preventing DoS via direct `registry.execute()` calls that bypass AgentLoop's streaming guard.
- **Rate limiter eviction callback ordering** — internal LRU/bucket state is now cleaned up BEFORE the `onEviction` callback fires, so callbacks that query the limiter during eviction see consistent state.
- **`clearTokenizerRegistry()` exported from `infra/token-estimator.ts`** — test suites can now call this in `afterEach` to restore isolation. The global registry previously persisted across tests with no reset mechanism.
- **Agent pool idle jitter unified** — `Math.random()` in `agent-pool.ts:startIdleTimer()` replaced with `computeJitterMs()` from `infra/backoff.ts` for consistency and testability.
- **Orchestrator metadata redaction** — `OrchestratorConfig.redactMetadata` option added; when set, `getAgent()`/`listAgents()` apply the redactor before returning metadata, preventing sensitive field leakage.
- **`withAbortableTimeout()` utility** (`infra/abortable-timeout.ts`) — unified `Promise.race + AbortSignal + setTimeout` helper with guaranteed cleanup. New `CORE_TIMEOUT` error code added.
- **`computeJitterMs()` helper** (`infra/backoff.ts`) — additive jitter for timers (idle timeouts, GC intervals) without exponential scaling.
- **`createRandomStrategy()` JSDoc** — explicitly documents that `Math.random()` is non-cryptographic and intended only for load-balancing.

### Changed — Wave-5G follow-up (documentation)

- **Backoff `maxMs` behavior change documented** — Wave-5G's backoff unification implicitly capped `AdapterCaller` retry delay at 10s (default `maxMs`); previously delay grew unbounded with `baseRetryDelayMs * 2^attempt`. This is an improvement (prevents multi-minute backoffs at high retry counts) but was undocumented.

### Added — Wave-5D (first pass, observability + lifecycle)

- **`MetricsPort` interface + `createNoopMetricsPort()`** on the `harness-one/observe` subpath. Vendor-neutral `counter` / `gauge` / `histogram` instruments alongside the existing `TraceExporter` / `InstrumentationPort` surface. The OTel bridge ships separately (will land in `@harness-one/opentelemetry`); the no-op port lets callers emit metrics unconditionally without null-checks when no backend is wired up. (ARCH-5)
- **`HarnessLifecycle` state machine + `health()`** on `harness-one/observe`. States `init → ready → draining → shutdown` with one-way transitions enforced at runtime (`CORE_INVALID_STATE` on misuse) and a `forceShutdown()` escape hatch for crash paths. `registerHealthCheck(name, check)` + `health()` aggregate component probes; thrown probes surface as `{ status: 'down', detail }` rather than poisoning the aggregate. Hosts now have one place to ask "is the harness accepting new work?". (ARCH-6)
- **`createAdmissionController` (in-process per-tenant token bucket)** on `harness-one/infra`. Configurable `maxInflight` (default 128) + `defaultTimeoutMs` (default 5000). `acquire(tenantId, { signal, timeoutMs })` is fail-closed on timeout (throws `POOL_TIMEOUT`) and abort-aware. `withPermit(tenantId, fn)` releases the permit in a `finally` regardless of fn outcome. Cross-process Redis-backed coordination is deferred to **5D.1**. (ARCH-8)

> **Deferred to Wave-5D.1** (require PRD + ADR competition before implementation):
> 1. Consolidating `CostTracker` into a single source of truth (currently Wave-5A core + Wave-4 langfuse adapter both maintain accounts).
> 2. Conversation-store reconciler that crash-recovers `session` ↔ `memory` ↔ `conversation` divergence after partial writes.
> 3. Promoting `AdmissionController` to a Redis-backed cross-process token bucket with optional in-process fallback.
> 4. Demoting `@harness-one/langfuse` from a peer trace pipeline to a secondary `TraceExporter` so OTel becomes the canonical observability stack.

### Changed (BREAKING — Wave-5E, trust-boundary typing)

- **`SystemMessage._trust` brand + `createTrustedSystemMessage()`** (`harness-one/core`). Restored messages claiming `role: 'system'` without the brand are downgraded to `user` by `sanitizeRestoredMessage()`; an attacker who can write to the session store can no longer elevate a user turn into a system prompt. The brand is a process-local `Symbol` and so is not JSON-serialisable — persisted system messages must be re-minted by host code after restore. (SEC-A07)
- **`RedisStoreConfig.tenantId` (multi-tenant key isolation)** in `@harness-one/redis`. Default `'default'` with a one-shot warn so single-tenant deployments stay explicit. Keys flip from `prefix:id` to `prefix:{tenantId}:id`; index key follows. Colon in `tenantId` rejected at construction. **Migration**: multi-tenant deployments must wire `tenantId` per request scope; existing data must be migrated by re-keying or by writing through both prefixes during a rollover window. (SEC-A08)
- **Memory entry size + reserved-key enforcement.** `assertMemoryEntrySize()` enforces `DEFAULT_MAX_CONTENT_BYTES = 1 MiB` and `DEFAULT_MAX_METADATA_BYTES = 16 KiB`; `RESERVED_METADATA_KEYS = ['_version', '_trust']` (harness-internal markers — `tenantId` / `sessionId` stay userland filter dimensions). `createInMemoryStore.write()` calls the assertion. (SEC-A08)
- **`createContextBoundary` rejects non-segment prefixes.** Policy prefixes (`allowRead`/`denyRead`/`allowWrite`/`denyWrite`) MUST end with `.` or `/` or construction throws `CORE_INVALID_CONFIG`. Closes the substring leak where `'admin'` would also match `'administrator'`. (SEC-A09)
- **`HandoffManager.createSendHandle(from)` (sealed sender handle).** Closure-captured `from` identity; the handle exposes `.from` read-only and `send(to, payload)` always uses the bound value. The 3-arg `send(from, to, payload)` form is retained for single-agent callers and tests, but multi-agent deployments should issue handles instead. (SEC-A10)
- **`HandoffConfig.maxPayloadBytes` (default 64 KiB) + `maxPayloadDepth` (default 16).** Depth check runs **before** `JSON.stringify`, so circular references throw `ORCH_HANDOFF_SERIALIZATION_ERROR` instead of a bare `SyntaxError`. (SEC-A11)
- **`additionalProperties: false` is now enforced** by the core `infra/json-schema.ts` validator. Previously declared-but-ignored; tool schemas declaring it now reject unknown keys at validation time. (SEC-A05)
- **`runRagContext(pipeline, chunks, meta)`** added to `harness-one/guardrails`. Scans each retrieved chunk through the input pipeline; the first non-`allow` verdict short-circuits and poisons the whole retrieval set. Consumers MUST call this before concatenating chunks into the prompt context — an injection in a RAG document otherwise bypasses input guardrails entirely. (SEC-A16)

### Changed — Wave-5F (cleanup batch)

- **Adapter default loggers route through core's `createDefaultLogger()`** in `@harness-one/anthropic`, `@harness-one/openai`, `@harness-one/ajv`, `@harness-one/redis`. Hand-rolled `console.warn`/`console.error` fallback shims removed; the core singleton redacts secrets and emits structured JSON lines. (T12 / T13)
- **`@harness-one/langfuse` inline `console.warn` migrated to `safeWarn`** so prompt-fetch failures and missing-pricing warnings surface through the redacted default logger. (T13)
- **`packages/core/src/context/checkpoint.ts` IDs use `prefixedSecureId('cp')`** (crypto.randomBytes) instead of `Math.random().toString(36)`; checkpoint handles cannot be guessed from observed timestamps. (SEC-A14)
- **`packages/core/src/observe/trace-manager.ts` sampling uses `crypto.randomInt`** instead of `Math.random()`. Sampling decisions are no longer predictable from observed trace output. (SEC-A15)
- **`harness-one/infra` exports `unrefTimeout` / `unrefInterval`** — long-lived library timers must never hold the host event loop open. The per-call tool-timeout in `tools/registry.ts` switched to `unrefTimeout`. (m-2)
- **`@harness-one/preset` pricing validation rejects `NaN` / `Infinity`** alongside negatives (input/output/cacheRead/cacheWrite rates). Previously NaN would silently produce NaN cost attributions downstream. (m-4)

### Added — Wave-5G (architecture hardening)

- **Circuit breaker** (`infra/circuit-breaker.ts`): `createCircuitBreaker()` with configurable `failureThreshold` (default 5) and `resetTimeoutMs` (default 30s). State machine: closed → open → half_open. Integrated into `AdapterCaller` via optional `circuitBreaker` config — when the circuit is OPEN, calls fast-fail with `ADAPTER_CIRCUIT_OPEN` without reaching the LLM provider. New `HarnessErrorCode.ADAPTER_CIRCUIT_OPEN` added.
- **Unified backoff utility** (`infra/backoff.ts`): `computeBackoffMs(attempt, config?)` consolidates duplicated exponential backoff + jitter logic from `AdapterCaller`, `self-healing.ts`, and `agent-pool.ts`. Supports configurable `baseMs`, `maxMs`, `jitterFraction`, and injectable `random` source for deterministic testing.
- **Graceful shutdown handler** (`@harness-one/preset/shutdown`): `createShutdownHandler(harness, options?)` registers SIGTERM/SIGINT handlers that drain the harness and dispose resources. Returns a cleanup function for test teardown. Double-signal forces exit.
- **Config validation** (`@harness-one/preset/validate-config`): `validateHarnessConfig()` performs structural validation (provider enum, guardrail sensitivity enum, PII types, tokenizer shape, unknown keys) at construction time with actionable `CORE_INVALID_CONFIG` errors.
- **`SecureHarness` type** — `createSecurePreset` now returns `SecureHarness` (extends `Harness`) with `lifecycle: HarnessLifecycle` and `metrics: MetricsPort` auto-wired. Lifecycle transitions to `ready` after construction; `shutdown()`/`drain()` coordinate with lifecycle state machine.
- **RAG multi-tenant chunk isolation** (SEC-010): `createInMemoryRetriever` gains `indexScoped(chunks, tenantId)` method. When `tenantId` / `scope` is supplied to `retrieve()`, only chunks indexed under that tenant (or globally unscoped chunks) are considered, preventing cross-tenant data leakage.
- **Expanded test utilities** (`core/test-utils.ts`): `createFailingAdapter`, `createStreamingMockAdapter`, `createErrorStreamingMockAdapter` — consolidate duplicated mock adapter patterns from 6+ test files.

### Changed — Wave-5G (architecture hardening)

- **`@typescript-eslint/no-floating-promises`** documented as a code-review standard. Requires typed linting (`parserOptions.project`) to enforce — package-level ESLint configs that wire up project references can enable it.
- **TraceManager IDs use `prefixedSecureId`** instead of predictable `id-${counter}-${timestamp}`. Trace IDs prefixed `tr-`, span IDs prefixed `sp-`. Eliminates enumeration risk in multi-tenant deployments. (SEC-002)
- **AgentPool IDs use `prefixedSecureId('pa')`** instead of `pool-agent-${counter}`. (SEC-002)
- **`console.warn` replaced with structured `safeWarn`** in `cost-tracker.ts` (overflow + unpriced model warnings) and `conversation-store.ts` (unbounded growth warning). All warnings now flow through the redaction-enabled default logger. (SEC-001)
- **`cache-stability.ts` uses stable JSON serialization** — `messageKey()` now uses `stableStringify()` (sorted object keys) instead of `JSON.stringify` to prevent hash collisions when property insertion order varies.
- **`AdapterCaller` backoff delegates to `computeBackoffMs`** — removes duplicated Math.pow + Math.random logic.
- **`self-healing.ts` backoff delegates to `computeBackoffMs`** — same deduplication.

### Changed (BREAKING — Wave-5C PR-3)

- **F-1: Root `harness-one` barrel trimmed to 19 curated value symbols.**
  Previously exported ~40 factories + utilities; now re-exports only the
  core user-journey primitives (UJ-1..UJ-5 per `wave-5c-prd-v2.md` §5).
  Every other runtime factory must be imported from its owning subpath
  (`harness-one/core`, `harness-one/tools`, `harness-one/guardrails`,
  `harness-one/observe`, `harness-one/session`, `harness-one/infra`) or
  from a sibling package (`@harness-one/cli`, `@harness-one/devkit`,
  `@harness-one/preset`). Type-only re-exports remain unbounded per ADR
  §5.2 (zero runtime bundle cost). Per R-01 lead decision,
  `createSecurePreset` is NOT re-exported from the root — import it
  exclusively from `@harness-one/preset` to avoid a three-leg dependency
  cycle.

  Surviving root exports: `createAgentLoop`, `AgentLoop`,
  `createResilientLoop`, `createMiddlewareChain`, `HarnessError`,
  `HarnessErrorCode`, `MaxIterationsError`, `AbortedError`,
  `GuardrailBlockedError`, `ToolValidationError`,
  `TokenBudgetExceededError`, `defineTool`, `createRegistry`,
  `createPipeline`, `createTraceManager`, `createLogger`,
  `createCostTracker`, `createSessionManager`, `disposeAll`.

- **F-6: `HarnessErrorCode` closed + module-prefixed.** The type is no
  longer widened with `(string & {})`; switch-exhaustiveness now holds.
  Members renamed to module-prefixed form. 1:1 rename mapping:

  | Old member                | New member                             |
  |---------------------------|----------------------------------------|
  | `UNKNOWN`                 | `CORE_UNKNOWN`                         |
  | `INVALID_CONFIG`          | `CORE_INVALID_CONFIG`                  |
  | `INVALID_STATE`           | `CORE_INVALID_STATE`                   |
  | `INTERNAL_ERROR`          | `CORE_INTERNAL_ERROR`                  |
  | `MAX_ITERATIONS`          | `CORE_MAX_ITERATIONS`                  |
  | `ABORTED`                 | `CORE_ABORTED`                         |
  | `MEMORY_CORRUPT`          | `MEMORY_DATA_CORRUPTION`               |
  | `STORE_CORRUPTION`        | `MEMORY_DATA_CORRUPTION`               |
  | `GUARDRAIL_VIOLATION`     | `GUARD_VIOLATION`                      |
  | `GUARDRAIL_BLOCKED`       | `GUARD_BLOCKED`                        |
  | `INVALID_PIPELINE`        | `GUARD_INVALID_PIPELINE`               |
  | `CLI_PARSE_ERROR`         | `CLI_PARSE_ERROR` (unchanged)          |
  | `ADAPTER_INVALID_EXTRA`   | `ADAPTER_INVALID_EXTRA` (unchanged)    |
  | `ADAPTER_CUSTOM`          | `ADAPTER_CUSTOM` (unchanged)           |

  New codes added alongside the rename: `CORE_INVALID_INPUT`,
  `CORE_INVALID_ID`, `CORE_INVALID_KEY`, `CORE_INVALID_PATTERN`,
  `CORE_INVALID_BUDGET`, `CORE_TOKEN_BUDGET_EXCEEDED`,
  `ADAPTER_UNKNOWN`/`_ERROR`/`_AUTH`/`_NETWORK`/`_PARSE`/`_RATE_LIMIT`,
  `PROVIDER_REGISTRY_SEALED`, `TOOL_VALIDATION`/`_INVALID_SCHEMA`/
  `_CAPABILITY_DENIED`, `SESSION_*`, `MEMORY_*`, `TRACE_*`, `ORCH_*`,
  `PROMPT_*`, `RAG_*`, `EVOLVE_*`, `CONTEXT_*`, `LOCK_*`, `POOL_*`,
  `EVAL_*`.

  Adapter sub-codes remain open by contract — third-party adapters throw
  with `HarnessErrorCode.ADAPTER_CUSTOM` and populate
  `details.adapterCode` with vendor-specific strings. See ADR §5.2 + §6
  for migration examples.

  **IMPORTANT — value import required.** `import type { HarnessErrorCode }`
  silently drops the runtime `Object.values()` record. The new custom
  lint rule `harness-one/no-type-only-harness-error-code` flags this at
  lint time.

- **F-8 (partial): api-extractor CI gate activated in snapshot-diff mode.**
  A new `api-check` workflow re-runs api-extractor on every PR, fails if
  any `packages/*/etc/*.api.md` snapshot is out of date, and requires a
  `## API change rationale` section (≥20 chars) in the PR body. Stability-
  tag enforcement (strict mode) stays OFF in main per PD-3 — Wave-5C.1
  will flip it after the tag audit.

- **F-14: `@harness-one/core`, `/runtime`, `/sdk`, `/framework` reserved.**
  Placeholder packages published at `0.0.0-reserved` to squat names
  against typo-squatters (pending org-admin npm token — R-3.C). The
  current runtime remains the unscoped `harness-one` package; scoped
  names are reservations only.

### Changed (Internal)

- **Wave-5B — AgentLoop decomposition** (2026-04-15). `AgentLoop` 拆为
  `AgentLoop` + `IterationRunner` + `AdapterCaller` + `StreamHandler` +
  `guardrail-helpers`。`run()` 从 ~600 LOC god-method 收缩为 65 LOC 编排骨架。
  `AdapterCaller` 成为唯一重试 + 指数退避所有者；`StreamHandler` 以
  `StreamResult` 判别联合承载错误类别，`AgentLoop._lastStreamErrorCategory`
  实例侧信道删除。`ExecutionStrategy.execute()` 的 `options` 收紧为
  `Readonly<>`。纯内部重构——公共 API（`AgentLoop` / `createAgentLoop` /
  `AgentLoopConfig` / `AgentEvent`）保持行为与签名不变。设计见
  `docs/forge-fix/wave-5/wave-5b-adr-v2.md`。

---

## [1.0.0-rc.1] — 2026-04-14 (Wave-5A)

**Wave-5A — Security defaults flip.** Closes 6 P0 blockers from the
2026-04-14 adversarial architecture review
(`docs/forge-fix/wave-5/decisions.md`). First **breaking** release
targeting 1.0-rc quality: all security defaults move from opt-in to
fail-closed. Existing callers must adopt `createSecurePreset` or
explicitly opt out.

**3,721 → 3,770 tests** (+49); typecheck clean across 9 packages; 18
atomic commits on `wave-5/production-grade`.

### Added

- **`@harness-one/preset`: `createSecurePreset(config)` — fail-closed
  production entry** (T14). Recommended replacement for `createHarness`.
  Wraps with all Wave-5A defaults enabled and seals providers after
  construction. Guardrail levels `'minimal' | 'standard' | 'strict'`.
- **`harness-one/_internal/safe-log`** (T01) — `createDefaultLogger()`
  (redaction-on console wrapper), `safeWarn`/`safeError` helpers.
- **Tool capability taxonomy** (T09) — `ToolCapability` =
  `'readonly' | 'filesystem' | 'network' | 'shell' | 'destructive'`.
  `defineTool({ capabilities })` + `createRegistry({ allowedCapabilities })`.
  `createPermissiveRegistry()` for opt-out.
- **`sealProviders()` / `isProvidersSealed()`** (T11,
  `@harness-one/openai`) — explicit, idempotent, per-module-instance
  seal against runtime provider-registry tampering.
- **`AgentLoopConfig.inputPipeline` / `outputPipeline`** (T10) —
  guardrail pipeline hook points at fixed positions (runInput →
  runToolOutput → runOutput). Hard-block closes streaming via
  AbortController + yields `guardrail_blocked` AgentEvent + excludes
  `GUARDRAIL_VIOLATION` from retry path.
- **Error codes** (T07) — `ADAPTER_INVALID_EXTRA`,
  `TOOL_CAPABILITY_DENIED`, `PROVIDER_REGISTRY_SEALED`,
  `GUARDRAIL_VIOLATION`.

### Changed (Breaking)

- **Redaction default-on** (T02/T03/T04). `createLogger()`,
  `createTraceManager()`, `langfuseExporter.exportSpan` all redact by
  default. Pass `redact: false` (logger/trace) or custom `sanitize`
  function (langfuse) to override. Langfuse has no "off" switch — must
  provide a replacement function.
- **`LLMConfig.extra` allow-list** (T05/T06). Anthropic + OpenAI
  adapters filter `extra` against per-provider allow-lists. Unknown
  keys default to filter+warn; `strictExtraAllowList: true` throws
  `ADAPTER_INVALID_EXTRA` before any network call.
- **Tool registry production defaults** (T08). `maxCallsPerTurn=20`
  (was `Infinity`), `maxCallsPerSession=100` (was `Infinity`),
  `timeoutMs=30000` (was undefined).
- **Tool registry `allowedCapabilities` default `['readonly']`** (T09) —
  fail-closed. Tools declaring `network`/`shell`/etc. must widen the
  registry or use `createPermissiveRegistry()`.

### Migration

```diff
- import { createHarness } from '@harness-one/preset';
+ import { createSecurePreset } from '@harness-one/preset';
- const harness = createHarness({ provider: 'anthropic', client, ... });
+ const harness = createSecurePreset({ provider: 'anthropic', client, ... });
```

Tool definitions gain a `capabilities` field:
```diff
  defineTool({
    name: 'fetch_url',
+   capabilities: ['network'],
    execute: async () => { /* ... */ },
  });
```

See `.changeset/wave-5a-security-defaults.md` for the full migration guide.

### Deferred

- T12/T13 (`safeWarn` migration for adapter packages) — cosmetic, no
  security impact. Scheduled for Wave-5F cleanup.

---

## [0.4.0] — 2026-04-13

The **wave-4 new-perspective deep-research audit** release. Five parallel
research agents audited angles the prior 147 / 50 / 123 issue waves had
not entered: concurrency correctness, architectural elegance, hot-path
latency, type safety, and lifecycle / multi-tenant safety. 68 unique
findings were distilled from 80 raw reports — see
`docs/history/RESEARCH-2026-04-13-wave4.md` for the full provenance.

**3,543 → 3,678 tests** (+135); typecheck + lint clean across all 9
packages. 0 breaking changes under the 0.x minor contract — surface
changes are gated behind `@deprecated` and scheduled for 0.5.0.

### Added — foundational primitives

- `harness-one/_internal/disposable` — `Disposable` interface,
  `disposeAll()` helper, and `DisposeAggregateError`. Every stateful
  factory (SessionManager, TraceManager, AgentPool, Orchestrator,
  Harness) now composes through this contract.
- `harness-one/_internal/async-lock` — FIFO single-owner mutex with
  `AbortSignal` support (`acquire()` + `withLock<T>(fn)`). Used to
  serialise TOCTOU-prone critical sections across async boundaries.
- `harness-one/_internal/lazy-async` — `createLazyAsync<T>()` stores
  the in-flight promise synchronously so concurrent first-callers share
  one init, and clears the cached promise on rejection so a later call
  retries.

### Added — extension points

- `AgentLoopHook` interface (`onIterationStart` / `onToolCall` /
  `onCost` / `onIterationEnd`) for iteration-level instrumentation;
  hook errors are logged via the injected logger and never break the
  loop.
- `InstrumentationPort` (`observe/instrumentation-port.ts`) — minimal
  tracing surface accepted by RAG and other sub-systems instead of the
  concrete `TraceManager`. TraceManager satisfies the port
  structurally, so existing consumers are unchanged.
- `EvictionStrategy` (`observe/cost-tracker-eviction.ts`) — pluggable
  overflow-bucket (default, preserves SEC-009) and lru strategies for
  `CostTracker`. Langfuse wires `lruStrategy`; a conformance suite
  runs against both.
- `harness-one/essentials` — curated entry point with the 12
  most-used symbols: `AgentLoop`, `createAgentLoop`, `HarnessError`,
  `MaxIterationsError`, `AbortedError`, `defineTool`, `createRegistry`,
  `createTraceManager`, `createLogger`, `createSessionManager`,
  `createMiddlewareChain`, `createPipeline`.
- `Harness.initialize?()` — optional warmup (exporter `initialize()`
  + tokenizer warm) behind an idempotent latch. Calling `run()` before
  `initialize()` still works with a documented cold-start penalty.

### Added — type safety

- Opaque branded `TraceId` / `SpanId` / `SessionId` types via
  `Brand<string, …>` plus `asTraceId` / `asSpanId` / `asSessionId`
  helpers in `_internal/ids.ts`. Cross-assignment (sessionId → spanId)
  now fails the typecheck.
- `ToolResult` gains a `kind: 'success' | 'error'` discriminator
  alongside the legacy `success: boolean` — exhaustive `switch`
  blocks are now type-safe.
- `memory/_schemas` runtime type-guards (`isMemoryEntry`,
  `isRelayState`); corrupt entries throw
  `HarnessError('MEMORY_CORRUPT')` instead of silently casting.
- `HarnessErrorCode` union documents `INVALID_CONFIG` /
  `INTERNAL_ERROR` / `CLI_PARSE_ERROR` / `MEMORY_CORRUPT` /
  `DEPRECATED_EVENT_BUS` / `DELEGATION_CYCLE` /
  `SELF_HEALING_ABORTED`.

### Changed — shutdown & lifecycle

- `Harness.shutdown()` / `drain()` are now a sequential DAG behind a
  `shutdownPromise` latch: `loop.dispose?.()` → `sessions.dispose()` →
  `middleware.clear()` → `traces.dispose()` → per-exporter
  `shutdown()` inside a 5 s `Promise.race`. Concurrent callers share
  the same pass.
- `AgentPool.dispose()` is now async, idempotent, and awaits every
  `loop.dispose?.()`; pending acquires are rejected cleanly.
- `LangfuseExporter.shutdown()` awaits `client.flushAsync()` (5 s cap)
  before clearing `traceMap` / `traceTimestamps`.
- `TraceManager.ensureInitialized` uses `createLazyAsync` per-exporter
  — concurrent first-exports share one init, and a failed init is
  re-tried on the next export.
- `TraceManager.startTrace` returns a dead handle (no admission to the
  `traces` map) when every exporter reports `isHealthy() === false`,
  so zombie traces no longer pile up.
- `TraceManager.startTrace` now actively evicts when `maxTraces` is
  reached — memory is capped even when exporters are unhealthy and
  traces never end.

### Changed — concurrency correctness

- `orchestrator.delegate()` wraps cycle-check + `strategy.select` +
  chain mutation in a per-source `AsyncLock`; concurrent delegations
  can no longer bypass `DELEGATION_CYCLE` detection.
- RAG retriever LRU "touch" uses a per-cache-key `createLazyAsync` —
  10 parallel identical retrieves call the embedder exactly once; the
  lazy slot clears on rejection so a later call retries.
- Guardrail self-healing uses a new `sleepWithAbort` helper that
  clears both the timer and the abort listener on every path; abort
  during backoff throws `HarnessError('SELF_HEALING_ABORTED')`.
- Agent-loop's external-signal listener body is gated on
  `_status === 'disposed'` — a late-firing signal is a no-op.
- `FallbackAdapter.pendingSwitch` (previously a racy `Promise | null`)
  replaced with `createAsyncLock` + a stale-adapter guard — 10
  concurrent failures advance the adapter index exactly once.
- `TraceManager` captures `samplingRateSnapshot` at `startTrace`;
  `exportTraceTo` reads the snapshot, so a mid-flight
  `setSamplingRate(0)` no longer drops in-flight traces.

### Changed — hot-path performance

- Agent-loop streaming loop no longer allocates per chunk: the
  strategy-options bag is hoisted and frozen at construction; the
  `accumulatedToolCalls` Map is paired with a `toolCallList` array so
  delta handling mutates in place; `Promise.allSettled` consumes the
  `pendingExports` Set directly.
- Middleware chain and session event handlers switched from array to
  `Set<fn>` — insertion-order iteration preserved, duplicate
  registration deduped, unsubscribe is O(1) (was O(n) `indexOf` +
  `splice`).
- `MessageQueue.iterateMessages()` — new zero-copy generator with the
  same `type` / `since` filter semantics; `getMessages()` documented
  as allocating.
- `TraceManager` builds one frozen readonly span snapshot (with a
  frozen `events` array) per export and reuses it across every
  exporter — no more per-exporter deep clone.
- `TraceManager` LRU replaced with a per-trace doubly-linked list
  (`lruPrev` / `lruNext` / `inLru`); append / remove / shift are all
  O(1) (was O(n) index rebuild per eviction).
- Logger gates all work behind the level check; replacer is
  constructed only when actually stringifying; text-mode calls with
  no metadata skip `JSON.stringify` entirely.

### Changed — module elegance

- `StreamAggregator` extracted from the agent-loop god-module into
  `core/stream-aggregator.ts` — behaviour-preserving refactor;
  `handleStream` is now a thin wrapper.
- `AgentLoopTraceManager` hoisted to `core/trace-interface.ts`.
- Validation-error paths in `LRUCache`, `output-parser`, `cli/parser`,
  and `tiktoken` route through `HarnessError` instead of ad-hoc
  `throw new Error(...)`. Tiktoken emits a one-time warn via the
  swappable `setTiktokenFallbackWarner` sink.
- `guardrails/pipeline` replaces `as unknown as` double-casts with a
  module-scoped `WeakMap<GuardrailPipeline, PipelineInternalData>`.
- Preset config validation now requires `Number.isInteger && > 0`
  for `maxIterations` / `maxTotalTokens` / `guardrails.rateLimit.max`
  / `guardrails.rateLimit.windowMs`; `budget` requires
  `Number.isFinite && > 0`.
- Preset emits a `logger.warn` when a custom function / object
  tokenizer is supplied without `config.model` — previously a silent
  no-op.
- `setSpanAttributes()` emits one-warn-per-key when the attribute
  prefix is outside `{system., error., cost., user.}`; silent when no
  logger is configured. Reserved prefix convention is documented.

### Deprecated

- `AgentLoop` class export — prefer `createAgentLoop()` factory.
  Removal planned for 0.5.0.
- `Harness.eventBus` — now a `Proxy` dead stub that warns once on
  property read and throws `HarnessError('DEPRECATED_EVENT_BUS')` on
  any method call. Removal planned for 0.5.0.

### Docs

- `docs/history/RESEARCH-2026-04-13-wave4.md` — the five-agent synthesis
  report driving this release. Includes per-cluster severity breakdown
  (P0 14 / P1 33 / P2 21), raw transcripts, and next-wave
  recommendations.

---

## [0.3.0] — 2026-04-13

The 123-issue production-readiness audit release. Based on a fresh
six-axis review (security, performance, code quality, spec compliance,
observability, documentation + tests) run after the 0.2.0 architecture
release. Closes 16 security findings (2 critical), 20 performance
findings (6 P0 leaks / hangs), 30 code-quality findings, 18 spec-
compliance findings, 24 docs / observability findings, and 15 test-
quality items. **3,190 → 3,543 tests** (+353); typecheck + lint clean
across all 9 packages.

### Added — security foundations

- `harness-one/_internal/redact` — shared `createRedactor()` and
  `sanitizeAttributes()` utilities. Default deny pattern scrubs
  `apiKey`, `authorization`, `token`, `password`, `cookie`,
  `session_id`, `private_key`, `credential`, `bearer`; rejects
  prototype-polluting keys (`__proto__`, `constructor`, `prototype`).
- `harness-one/_internal/ids` — `secureId()` / `shortSecureId()` /
  `uuid()` / `prefixedSecureId(prefix)` backed by `node:crypto`.
- `createLogger({ redact, correlationId })` — redacts meta fields,
  injects a correlation identifier into every record, propagates to
  child loggers.
- `createTraceManager({ redact })` — attribute-level redaction runs at
  ingest so exporters (OTel, Langfuse) never see sensitive values;
  new `systemMetadata` / `userMetadata` namespaces keep untrusted
  callers out of sampling decisions.
- `guardrails/schema-validator` — configurable `maxJsonBytes`
  (default 1 MiB) enforced before `JSON.parse`.
- `guardrails/self-healing` — regeneration timeout always cleared
  via `finally`; no more event-loop retention under burst load.
- `guardrails/content-filter` — broader ReDoS heuristic covers
  `(a|a?)+` and overlapping-prefix alternation; pattern `lastIndex`
  reset defensively before every `.test()`.
- `guardrails/rate-limiter` — `onEviction(evicted)` callback signals
  flood-based bucket loss; optional `bucketMs` time-bucketed mode.
- `guardrails/injection-detector` — `extraPatterns` validated via the
  shared ReDoS check; base64 pattern bounded to `{8,1024}`.
- `openai.registerProvider(name, config, { force? })` — validates
  URL + requires `https://` (except localhost), refuses to overwrite
  built-ins without `force: true`.
- `memory/fs-io` — entry IDs validated against
  `/^[A-Za-z0-9_-]{1,128}$/` before join; post-join path containment
  check; `memory/testkit.ts` conformance suite runs against the
  in-memory, fs-store, and Redis backends to prove uniform tag-OR
  semantics.
- `redis` store gains `repair()` method (replaces the prior
  victim-triggered auto-delete of corrupt entries).
- `rag/retriever` cache keyed by `tenantId` + configurable
  `maxQueryLength` (default 16 KiB).
- `orchestration` shared context rejects polluting keys, normalizes
  Unicode case before policy `startsWith`, requires explicit
  trailing-separator semantics for prefix matches.
- `observe/cost-tracker` — attacker-controlled model/trace keys no
  longer evict legitimate totals; overflow aggregated into a
  synthetic `__overflow__` bucket with optional `onOverflow` hook.
- `_internal/json-schema` — `hasOwnProperty` checks on required
  field and property walks; rejects prototype-polluting property
  names; compiled `RegExp` pattern cache (bounded LRU).

### Added — resource / perf hardening

- Session `dispose()` wraps teardown in try/finally so
  `clearInterval(gcTimer)` always runs; `evictLRU` amortized via a
  threshold window (`max + max(1, floor(max * 5%))`).
- Agent-loop tool-timeout guarded by a `settled` flag — racing timer
  callbacks bail out instead of double-resolving.
- Agent-loop external-signal listener removal wrapped in try/catch so
  an exception in the listener teardown can't leave the listener
  registered.
- Agent-loop `JSON.stringify(toolResult)` is depth-bounded (max 10)
  and size-bounded (default 1 MiB) with a `[result too large]`
  placeholder for over-limit payloads.
- `TraceManager.pendingExports.delete` runs under
  `.catch().finally()` so rejected exports never leak Set entries;
  `endTrace` now O(1) via a secondary `Map<traceId, index>`.
- Memory `compact()` indexed iteration over a pre-sorted slice
  (replaces O(n²) shift loop); query path iterates `.values()` lazily
  when no indexed filter applies.
- Orchestration `handoff` uses binary search within priority tiers
  (O(log n) insertion) instead of linear scan + splice.
- Orchestration event handlers backed by `Set` (O(1) unsubscribe).
- `core/output-parser` caches `JSON.stringify(schema)` via `WeakMap`.
- `@harness-one/ajv` LRU-caches compiled validators (default 256).
- `@harness-one/tiktoken` exports `disposeTiktoken()` — iterates the
  cache, calls `.free()` on native encoders, clears the registry.

### Added — correctness / contract

- `fallback-adapter` replaces recursive retry with a bounded loop —
  eliminates stack overflow on repeated provider failures.
- `memory/relay` `checkpoint()` / `addArtifact()` now route through
  the same optimistic-concurrency helper as `save()`; throws
  `RELAY_CONFLICT` on version mismatch; `lastKnownVersion` advanced
  on every successful write.
- `memory/fs-store.write()` unlinks the prior entry file when
  overwriting an existing key — fixes slow disk leak.
- `core/middleware.use(fn)` returns an `unsubscribe()` function;
  `clear()` added; de-duplication contract documented.
- `core/resilience` disposes the inner `AgentLoop` between retries.
- `session/conversation-store` accepts `maxSessions` and
  `maxMessagesPerSession` with LRU eviction (default unbounded,
  warns on threshold cross).
- `orchestration/agent-pool.acquireAsync({ signal })` removes the
  pending entry and rejects with `AbortError` when the caller aborts.
- `@harness-one/openai` adapter extracts
  `prompt_tokens_details.cached_tokens` → `TokenUsage.cacheReadTokens`;
  emits a one-time `console.warn` on zero-token non-stream
  responses (matching the stream path).
- Both `@harness-one/anthropic` and `@harness-one/openai` adapters
  merge `params.config.extra` into the provider request body —
  previously a MUST violation of `docs/provider-spec.md`.
- `@harness-one/anthropic` adapter rethrows stream failures as
  `HarnessError('PROVIDER_ERROR')` when the external signal is not
  aborted; previously silently swallowed.
- `@harness-one/opentelemetry` exporter passes real
  `harness.startTime` / `harness.endTime` into OTel spans (durations
  were clocking as zero). Spans whose direct parent is missing fall
  back to the per-trace OTel root context so the hierarchy stays
  connected.
- CLI `ALL_MODULES` / templates include `orchestration` and `rag`;
  `audit` recognizes imports from those submodules.
- `@harness-one/preset` `Harness.tokenizer` exposes the custom
  function / object tokenizer (previously stored but unreachable).

### Added — observability

- Logger `correlationId`, span-event `severity`, redaction on span
  attributes, and namespace split for trusted vs caller metadata all
  covered above.
- `@harness-one/langfuse` now shares core's `KahanSum` for running
  sums and maintains per-model / per-trace totals incrementally;
  new `exceeded` branch on `checkBudget`; emits a `budget_exceeded`
  event when the hard budget is crossed (deduped by model); flush
  errors route through `onExportError` / `logger.error` with a
  `flushErrors` counter; `getStats()` method added.
- `@harness-one/opentelemetry` — dropped-attribute counter, semconv
  mapping table (`harness.cache.hit_ratio` → `cache.hit_ratio`,
  etc.), and evicted-parent LRU with configurable `evictedParentsTtlMs`
  / `maxEvictedParents`.
- RAG pipeline emits a child span per chunk and records ingestion
  metrics: `{ attempted, succeeded, failed, byFailureReason }`.
- Orchestrator dropped-message accounting cumulated via `getMetrics()`;
  structured logger warn always fires (was optional callback only).

### Added — docs / examples

- Per-package `README.md` for every workspace package.
- `LICENSE` (MIT), `CONTRIBUTING.md`, `NOTICE` at repo root.
- `docs/guides/fallback.md` — troubleshooting fallback adapter
  failures (categories that trigger failover, how to log
  `adapter_switched`, recovery strategies).
- `docs/architecture/06-observe.md` — `harness.*` OTel attribute
  conventions, cache-monitor → OTEL_SEMCONV rename table.
- `docs/architecture/12-orchestration-multi-agent.md` — delegation
  cycle detection contract and error code.
- `examples/observe/cache-monitor-integration.ts` — RAG-query cache
  instrumentation pattern.
- `examples/observe/error-handling.ts` — production error handling
  with `toolError` categorization, error spans, fallback recovery.
- PRD / provider-spec / architecture docs corrected for
  `createContextManager`, factory names (`createPipeline`,
  `createInMemoryStore`, `createFileSystemStore`, `createEvalRunner`),
  `StreamChunk` shape, `HarnessError` constructor order, `compress()`
  return type (`CompressResult`), `DoneReason` variants (including
  `'error'`), Node `>= 18` engines, dependency graph, REQ-017
  maturity scoring scope, and §7 Security network-call wording.
- `toolSuccess` / `toolError` / `KahanSum` gained `@example` JSDoc.

### Fixed — test quality

- Prompt registry time tests use `vi.spyOn(Date, 'now')` (was
  mutating global).
- Self-healing exponential-backoff test runs under fake timers
  (was ~1.5 s of real wall clock).
- Fs-store test drops assertions on `_index.json.tmp` internal
  sentinel.
- Checkpoint manager boundary `maxCheckpoints: 1` explicitly
  covered.
- Eval runner concurrency test asserts both lower and upper bound.
- Trace lifecycle recovery path explicitly tested.
- Fallback adapter gains concurrent-failure-recovery tests under
  fake timers.
- Langfuse PROVIDER_ERROR non-string prompt path covered;
  `maxRecords: undefined` default-fallback smoke-tested.

### Changed

- `createLogger`: `redact`, `correlationId`, and `output`
  replacer-caching are now standard config; no breaking change
  for callers that omit them.
- `createTraceManager` accepts `redact` and splits `metadata` into
  `systemMetadata` / `userMetadata`. Legacy `metadata` still
  accepted and aliased to `userMetadata` for backwards compatibility.
- `MemoryStore.query({ tags })` is documented as OR across all
  backends (previously Redis implemented AND).
- `costTracker.getTotalCost()` is documented as "recent-window"
  (reflects the rolling buffer) while `getCostByModel` /
  `getCostByTrace` are cumulative since start.

### Security

- All weak identifier sites swapped to crypto-random: session
  manager, trace manager, memory store, fs-store. Session IDs are
  no longer enumerable.
- Prototype-pollution vectors closed in the minimal JSON-schema
  validator and orchestrator shared-context.
- Path traversal via `MemoryStore.read(id)` / `write(id)` blocked
  at the fs-io boundary.
- Provider registry (`@harness-one/openai`) hardened against
  supply-chain SSRF.
- Langfuse / OTel span attributes, log meta, and trace metadata
  all pass through redaction before reaching the wire.

---

## [0.2.0] — 2026-04-13

The 50-issue architecture-review release. Based on the 7-axis deep
architectural review (see
`~/Documents/harness-one_Architecture_Review_20260412/`), this release
closes every identified gap — 8 P0, 22 P1, and 20 P2 findings —
organized into eight focused commits. Also renames the batteries-included
preset package.

### Breaking

- **Package rename**: `harness-one-full` → `@harness-one/preset`. Runtime
  behavior is identical; migration is a one-line rename. See
  `.changeset/rename-preset.md` for the diff.
- `HarnessConfig.langfuse`: previously accepted any object; now validates
  the client has a `.trace()` method at construction and throws
  `HarnessError('INVALID_CONFIG')` otherwise.
- `createConversationStore`, `createInMemoryStore`, and `createRelay` may
  now throw `HarnessError('STORE_CORRUPTION')` when loaded data fails
  schema validation — previously these paths cast `JSON.parse(...) as T`
  and admitted malformed shapes silently.
- `AgentLoop.run()` is no longer re-entrant: a second concurrent call on
  the same instance throws `HarnessError('INVALID_STATE')`.

### Added — contract completeness (Wave 1)

- `TraceExporter` lifecycle hooks are now actually invoked by
  `TraceManager`:
  - `initialize?()` called lazily on first export (or eagerly via
    `tm.initialize()`)
  - `isHealthy?()` gates each export attempt
  - `shouldExport?(trace)` gates trace export (per-trace sampling)
- `createTraceManager({ defaultSamplingRate, logger })` — global sampling
  rate with runtime `tm.setSamplingRate(rate)`; structured logger option
  replaces `console.warn` fallback.
- `TraceManager.flush()` / `dispose()` now wait for pending in-flight
  span/trace exports before returning.
- AgentLoop iteration spans carry `iteration`, `adapter`,
  `conversationLength`, `streaming`, `toolCount`, `inputTokens`,
  `outputTokens` — previously only the last two.
- Adapter retries emit an `adapter_retry` span event with `attempt`,
  `errorCategory`, and error preview.
- Tool spans carry `toolName` and `toolCallId` attributes plus
  `errorMessage` on failure — previously the tool name was only in the
  span name.
- `harness.run()` emits guardrail checks as child spans of a
  `harness.run` trace (`guardrail:input`, `guardrail:output`,
  `guardrail:tool-args`, `guardrail:tool-result`) — previously the
  guardrail pipeline's internal events never reached observability.
- Anthropic adapter: when a tool-call's `arguments` field is not a JSON
  object, substitute `{}` with a `console.warn` instead of casting the
  raw string to `Record<string, unknown>`.
- `AgentAdapter.name` is now part of the interface; built-in adapters
  set `"<provider>:<model>"` (e.g., `"anthropic:claude-sonnet-4"`).

### Added — persistence safety (Wave 2)

- New `harness-one/memory` runtime validators:
  `validateMemoryEntry`, `validateIndex`, `validateRelayState`,
  `parseJsonSafe`. Every `JSON.parse(...) as T` at a disk/network
  boundary now validates shape first.
- Applied at: `memory/fs-io.ts` (readIndex, readEntry),
  `memory/relay.ts` (both load paths), `redis/src/index.ts` (getEntry,
  query, update, compact).

### Added — release pipeline (Wave 3)

- `@changesets/cli` wired in: root `changeset` / `version` / `release`
  scripts; `.changeset/config.json` fixes `harness-one` and
  `harness-one-full` in lockstep.
- CI:
  - `test:coverage` enforces per-package thresholds (lines/statements
    80%, branches 75%).
  - New "Verify build artifacts" step asserts each `packages/*/dist`
    ships `.js.map` and `.d.ts.map` files.
  - New `changeset-check` job on PRs fails when changes under
    `packages/` aren't accompanied by a changeset.

### Added — hot-path performance (Wave 4)

- Token estimator: single O(n) char-code scan (was two `text.match`
  calls per estimate). Precomputed ASCII bitmap for code/punctuation;
  numeric range compares for CJK.
- Session manager: two-structure LRU (`unlockedOrder` Map +
  `lockedIds` Set) gives O(1) eviction instead of potentially walking
  all sessions when most are locked. O(1) capacity check too.
- PII detector: digit/"@" preflights skip whole classes of regex
  invocations for alpha-only content.
- Injection detector: large payloads (>100KB) check prefix+suffix
  slices instead of sliding overlapping windows across the whole
  content — injection attempts cluster at boundaries.
- Conversation pruner: index-based slicing with single array
  allocation (was 3-5 intermediate `Array.slice` copies).

### Added — extensibility seams (Wave 5)

- `ToolMiddleware<TParams>` type + `ToolDefinition.middleware` field:
  onion-style wrappers for retry, auth, circuit-breaker, timing around
  a tool's `execute` without modifying the tool itself.
- `MemoryStoreCapabilities` type + `MemoryStore.capabilities` and
  `MemoryStore.writeBatch?()` — third-party backends declare atomic
  guarantees, TTL support, batch writes.
- `ConversationStoreCapabilities` — symmetric capability declarations
  for atomic append/save/delete and distributed semantics.
- `createAgentLoop(config)` factory alias for `new AgentLoop(config)` —
  consistent `createX()` style; class remains exported for subclassers.
- `docs/provider-spec.md` — canonical `AgentAdapter` contract,
  required/optional fields, conformance checklist for new adapters.
- `runMemoryStoreConformance(runner, factory)` testkit in
  `harness-one/memory` — framework-agnostic conformance suite for
  `MemoryStore` implementations.

### Added — observability + ergonomics (Wave 6)

- `CostTracker` gets `strictMode` (throws on missing model / non-finite
  tokens) and `warnUnpricedModels` (one-time warning per model without
  pricing registered).
- `SpanAttributes` / `SpanAttributeValue` strong types re-exported from
  `harness-one/observe`; matches OTel attribute constraint.
- New root `harness-one` entry re-exports the commonly-used APIs from
  every submodule so users can `import { AgentLoop, createRegistry,
  createTraceManager } from 'harness-one'`. Submodule imports remain
  available for tree-shaking.
- `Orchestrator.toReadonly()` now deep-clones `agent.metadata` via
  `structuredClone` so callers cannot mutate nested state.
- `createHarness({ logger })` — harness-level warnings (no-budget,
  default session, conversation-append failure) route through a
  user-supplied logger.

### Added — `harness.run()` safety

- `harness.run(messages, { sessionId })` — per-request session id so
  concurrent runs don't interleave messages in the hard-coded `"default"`
  bucket. First `"default"` use logs a one-time warning.
- `createHarness` warns once at construction when no `budget` is set —
  production deployments without a budget have unbounded token spend.

### Fixed — P2 polish (Wave 8)

- `AgentLoop.run()` re-entrancy guard throws `INVALID_STATE` instead of
  silently racing state.
- `output-parser.ts` wraps `JSON.parse` and converts `SyntaxError` into
  `HarnessError('PARSE_INVALID_JSON')` with `cause` preserved.
- `registerTokenizer(model, tokenizer)` returns boolean (true = newly
  installed, false = overwrote existing).

### Tests

- 3200 tests pass (up from 3104 at the start of the release).
- ~100 new tests across Waves 1, 2, 5, 7.
- New E2E file `packages/full/src/__tests__/e2e.test.ts` exercises
  `createHarness` with a real (unmocked) `AgentLoop`.

---

## [0.1.2] — 2026-04-12

47 production-readiness issues resolved from comprehensive audit
(see `docs/history/AUDIT-2026-04-12.md` and `docs/forge-fix/audit-47-fixes-20260412/`).
All 3104 tests pass; ~54 regression tests added.

### Fixed

#### Security & correctness

- **Guardrails / content-filter**: Reset custom-pattern `lastIndex` and
  match against normalized content — closes a guardrail-bypass vector
  where stateful `RegExp` and un-normalized input could skip detections.
- **Context / cache-stability**: `JSON.stringify` non-string `Message.content`
  when computing `messageKey` so prefix-cache keys stay stable for
  structured content.
- **Context / checkpoint**: Validate `maxCheckpoints >= 1` and append a
  random suffix to checkpoint IDs to eliminate same-millisecond collisions.
- **Context / compress**: Summarizer calls wrapped in try-catch with a
  truncation fallback; a summarizer fault no longer kills the run.
- **OpenAI adapter**: Warn on zero-token fallback; enforce
  `MAX_TOOL_CALLS = 128` and `MAX_TOOL_ARG_BYTES = 1 MB` to bound
  accumulated tool-call memory during streaming.
- **Anthropic adapter**: `finalMessage()` guarded by try-catch so
  aborted streams exit cleanly instead of leaking generator errors.

#### Performance

- **OpenTelemetry**: Span-cache eviction switched from `O(n log n)`
  sort-based to `O(1)` LRU `Map` pattern; purge is now threshold-guarded
  with early break (was `O(n)` full scan every call).
- **CostTracker**: `traceTotals` secondary index enables `O(1)`
  `getCostByTrace()` (previously scanned the record buffer).
- **Orchestrator**: BFS queue uses index-based traversal instead of
  `Array.shift()` for `O(1)` dequeue.

#### Resource management

- **CostTracker**: `modelTotals` / `traceTotals` bounded by new
  `maxModels` (default 1000) and `maxTraces` (default 10,000) config,
  with FIFO eviction — closes unbounded memory growth.
- **Full harness**: `sessions.dispose()` now runs in both `drain()` and
  `shutdown()` paths.
- **ContextBoundary**: New `clearAgent(agentId)` method prevents
  view-cache leaks when agents are recycled in long-running processes.
- **OpenTelemetry**: Flush uses snapshot-then-clear for concurrent
  safety.
- **Langfuse**: `maxRecords >= 1` validated at construction.

#### Error handling

- **Full harness**: All `conversations.append()` calls wrapped in
  try-catch with `logger.warn`; `exporter.shutdown()` promise now has
  `.catch()` so exporter faults cannot surface as unhandled rejections.
- **TraceManager**: `console.warn` fallback when no `onExportError`
  callback is registered — export failures are never swallowed silently.
- **DatasetExporter**: Runtime shape validation before type casts.
- **Langfuse**: Empty `catch(() => {})` blocks replaced with
  `console.warn` logging; unpriced models emit a one-time warning.
- **OutputParser**: `regenerateTimeoutMs` option (default 30s) wraps the
  regenerate callback in `Promise.race` so a hung regenerator cannot
  stall the loop.
- **Full / env**: `isFinite()` + `> 0` checks on every numeric env var.
- **CacheMonitor**: `bucketMs <= 0` defaults to 60s instead of producing
  `NaN` buckets.

#### Robustness

- **SessionManager**: Throws `SESSION_LIMIT` when all sessions are
  locked at capacity (previously blocked forever).
- **FailureTaxonomy**: Detector thresholds (`toolLoopMinRun`,
  `earlyStopMaxSpans`, `budgetExceededConfidence`) are now configurable
  via `FailureTaxonomyConfig.thresholds`.
- **Redis**: Non-atomic update limitation documented in JSDoc; partial
  query results emit `console.warn`.

### Documentation

- `docs/history/AUDIT-2026-04-12.md` — full audit report (47 issues with fixes).
- `docs/forge-fix/audit-47-fixes-20260412/summary.md` — fix summary by
  group with test counts.
- `docs/architecture/06-observe.md` — CostTracker `maxModels` /
  `maxTraces` / secondary-index behavior, FailureTaxonomy `thresholds`.
- `docs/architecture/12-orchestration-multi-agent.md` —
  `ContextBoundary.clearAgent()`.
- `examples/` — self-healing, cache-monitor, failure-taxonomy,
  multi-agent, checkpoint-manager, fallback-adapter examples.

---

## [0.1.1] — 2026-04-11

### Fixed

#### Core (`harness-one`)

- **AgentLoop**: Input validation added to constructor — `maxIterations`,
  `maxTotalTokens`, `maxStreamBytes`, `maxToolArgBytes`, and `toolTimeoutMs`
  now reject non-positive or non-finite values at construction time.
- **AgentLoop**: Stream byte counter no longer resets on stream error — the
  cumulative counter is preserved across failed stream attempts, closing a DoS
  vector where repeated short failures could reset the `maxStreamBytes` budget.
- **Handoff**: Input validation added for `from`/`to` agent IDs; `as unknown as`
  type casts replaced with runtime type guards.
- **Spawn**: `as unknown as` type casts replaced with runtime type guards.

#### Guardrails

- **Rate limiter**: Distributed mode no longer crashes at runtime when a
  distributed back-end is unavailable — it now degrades to a no-op guardrail
  instead of throwing.
- **Self-healing**: Input validation added to `maxRetries` — non-positive values
  are rejected at construction time.
- **Schema validator**: `compress()` budget parameter validated on call.

#### Prompt

- **Registry**: `console.warn` removed — duplicate registration is now silently
  ignored instead of emitting a console warning.

#### Context

- **Context boundary**: `MAX_VIOLATIONS` limit is now configurable via
  `ContextBoundaryConfig`.

#### Memory

- **Relay**: `console.warn` removed from corruption handler — damaged relay data
  returns `null` silently.

#### Session

- **SessionManager**: Input validation added for `maxSessions` and `ttlMs` —
  non-positive values are rejected at construction time.

#### Observe

- **TraceManager**: Input validation added for `maxTraces`; the limit is now
  enforced at construction time.
- **CostTracker**: `maxRecords` is now configurable via `CostTrackerConfig`
  (previously hardcoded at 10,000).

#### Orchestration

- **MessageQueue**: `dequeue()`, `peek()`, and `size()` methods added.
- **MessageQueue**: `maxQueueSize` validated — values less than 1 are rejected
  at construction time.
- **Handoff**: `MAX_RECEIPTS` and `MAX_INBOX_PER_AGENT` limits are now
  configurable via `HandoffConfig`.

#### OpenAI adapter

- **`chat()` / `stream()`**: `responseFormat` passthrough added for
  `json_object` and `json_schema` response formats.
- **`stream()`**: `max_tokens` is now forwarded to the SDK call (was previously
  omitted).
- **`stream()`**: `stream_options: { include_usage: true }` added so streaming
  responses carry token usage data.
- **Tool call ID fallback**: Empty tool call IDs now fall back to
  `tool_${tc.index}` instead of `''`.
- **Provider registry**: Providers are now extensible via `registerProvider()`.

#### Anthropic adapter

- **Errors**: `HarnessError` is now thrown instead of generic `Error`.
- **Config**: Unused `maxRetries` field removed from `AnthropicAdapterConfig`.

#### Redis

- **`query()`**: Session ID filtering is now applied server-side.
- **Writes**: `multi()`/`exec()` used for atomic write operations.
- **Config**: Input validation added for `client` and `TTL` parameters.
- **Corruption handler**: `console.warn` removed — corrupted entries are
  discarded silently.

#### Langfuse

- **`flush()`**: No longer clears trace maps — only `shutdown()` clears them.
- **Trace map**: `MAX_TRACE_MAP_SIZE` is now configurable via `maxTraceMapSize`
  in `LangfuseConfig`.
- **CostTracker**: `maxRecords` is now configurable via `LangfuseConfig`.
- **Errors**: `HarnessError` is now thrown instead of generic `Error`.

#### AJV

- **Format loader**: Retries on transient failures during async format plugin
  loading.

#### OpenTelemetry

- **Span limit**: Maximum number of tracked spans is now configurable via
  `maxSpans` in the exporter config (previously hardcoded).

---

## [0.1.0] — 2026-04-10

### Fixed

#### Core (`harness-one`)

- **AgentLoop**: Timer leak in tool timeout `Promise.race` — timeout handle is
  now cleared in the `finally` branch regardless of resolve/reject path.
- **AgentLoop**: Conversation trimming edge case — the trimmer now preserves
  every system message instead of keeping only the first one.
- **AgentLoop**: Fallback adapter race condition — a mutex guards concurrent
  fallback selections so two concurrent failures cannot both promote the same
  secondary adapter.
- **AgentLoop**: Cumulative stream-byte counter is reset on stream error so
  `maxStreamBytes` enforcement is not skewed by a failed prior attempt.

#### Guardrails

- **Pipeline**: Timer leak in pipeline timeout `Promise.race` — timeout handle
  is cleared in `finally`.
- **Injection detector**: Base64-bypass at medium sensitivity closed — detector
  now decodes and re-scans base64-encoded fragments before scoring.
- **Injection detector**: Mathematical alphanumeric homoglyph support added —
  Unicode math-bold, math-italic, and script codepoints are normalised before
  pattern matching.
- **Content guardrail**: Truncation replaced with a sliding window for payloads
  larger than 100 KB, preventing silent data loss.
- **Schema validator**: ReDoS protection extended to user-supplied `pattern`
  values — `isSafePattern()` is called before compiling any regex provided via
  config.
- **Self-healing**: Double token estimation removed — usage was being counted
  once during planning and again during execution.

#### Prompt

- **Template builder**: Variable injection vulnerability patched — template
  variable values are sanitized before interpolation.
- **Registry**: Semver validation added on `register()` — malformed version
  strings are rejected with a descriptive error.

#### Context

- **Truncation**: Oversized single message is always preserved rather than
  silently dropped when it alone exceeds the context budget.
- **Memory**: Sliding window optimization reduces working data structures from 4
  to 2, cutting peak memory during large context operations.

#### Memory

- **FS store**: `update()` TOCTOU race condition eliminated — read-modify-write
  is now serialized per key.
- **Vector store**: Dimension validation added — mismatched embedding dimensions
  raise an error at write time instead of silently corrupting similarity scores.

#### Session

- **LRU eviction**: Locked sessions are skipped during eviction candidates
  selection, preventing eviction of sessions with active locks.
- **Auth context**: Shallow `Object.freeze` replaced with a recursive deep
  freeze so nested objects on the auth context are also immutable.

#### Observe

- **Trace eviction**: `isEvicting` guard wrapped in `try-finally` — the flag is
  always cleared even if the eviction callback throws.
- **CostTracker**: `updateUsage()` was not called for streaming chunks; the
  running total is now updated incrementally on every streaming delta.

#### OpenAI adapter

- **`stream()`**: `temperature`, `topP`, and `stopSequences` parameters were
  silently dropped; they are now forwarded to the SDK call.

#### AJV

- **Format loading**: Race condition on async `validate()` fixed — format
  plugins are awaited before the first schema compilation.

#### Langfuse

- **Generation detection**: Heuristic was too broad; explicit `span.kind` is
  now checked first before falling back to name-based inference.
- **CostTracker**: `updateUsage()` was missing from the Langfuse cost tracker
  implementation; added to match the core interface.

#### OpenTelemetry

- **Parent span eviction**: Evicting a parent span no longer orphans its
  children — an `evictedParents` map provides a fallback root context so child
  spans remain correctly rooted.

#### Full (`harness-one-full`)

- **Exporter shutdown**: `shutdown()` previously hung indefinitely; a 5-second
  timeout now forces resolution.
- **Tool call arguments**: Arguments from tool calls were not passed through
  guardrail validation; they are now screened before the tool handler is invoked.

#### Eval

- **Flywheel hash collision**: Length-prefix encoding added to the hash
  input — concatenated fields can no longer produce the same hash via
  value-boundary collisions.

#### Evolve

- **Drift detector**: Magic-number zero-baseline thresholds replaced with
  `zeroBaselineThresholds` config, allowing callers to tune sensitivity.
- **Architecture checker**: Fragile substring path matching replaced with exact
  segment matching, eliminating false positives from partial directory names.
- **Retirement condition**: Missing `AND` clause support added — conditions can
  now require multiple criteria to be satisfied simultaneously.

#### Infrastructure

- **Vitest configs**: 8 coverage configurations were excluding source files from
  coverage reporting; all are now included.
- **ESLint**: `no-console` rule added project-wide with exemptions for CLI
  entry-points and test files.
- **package.json**: Legacy `main`, `module`, and `types` fields added to the 8
  packages that were missing them, restoring compatibility with non-ESM tooling.

---

### Added

- `maxStreamBytes` and `maxToolArgBytes` config options in `AgentLoop` to cap
  per-call data volumes.
- `maxResults` config option in the guardrail pipeline for limiting the number
  of findings returned per run.
- `sanitize` option in the prompt builder and registry to control variable
  sanitization behavior.
- `onTransition` observability hook in `SkillEngine` for tracking state
  transitions.
- `updateUsage()` method in `CostTracker` for incremental streaming token
  accounting.
- `pii` guardrails config in `createHarness()` for enabling PII detection at
  harness construction time.
- `zeroBaselineThresholds` config in the drift detector for configurable
  zero-baseline sensitivity.
- `warnings` field in `ValidationResult` JSON Schema — non-fatal issues are now
  surfaced without causing validation failure.
- `AND` clause support in component retirement conditions.
- `evictedParents` map in the OpenTelemetry exporter to maintain span parentage
  after parent eviction.
- `no-console` ESLint rule with CLI and test file exemptions.
- Legacy `main` / `module` / `types` fields in 8 `package.json` files.

---

## [Unreleased]

### Changed — harness-one-full

- `Harness` interface now includes `eventBus`, `logger`, `conversations`, and
  `middleware` fields, auto-configured by `createHarness()`.

### Added — Multi-Agent Orchestration (`harness-one/orchestration`)

- New `orchestration` module for managing multiple agents with lifecycle tracking,
  inter-agent messaging, shared context propagation, and task delegation.
- `createOrchestrator()` factory with `hierarchical` and `peer` modes.
- Built-in delegation strategies: `createRoundRobinStrategy()`,
  `createRandomStrategy()`, `createFirstAvailableStrategy()`.
- Agent lifecycle events via `onEvent()` subscription.
- Shared context with `get`/`set`/`entries` for cross-agent data sharing.

### Added — RAG Pipeline (`harness-one/rag`)

- New `rag` module providing a complete document retrieval pipeline:
  load → chunk → embed → index → retrieve.
- Document loaders: `createTextLoader()`, `createDocumentArrayLoader()`.
- Chunking strategies: `createFixedSizeChunking()` (with overlap),
  `createParagraphChunking()` (with maxChunkSize), `createSlidingWindowChunking()`.
- `createInMemoryRetriever()` using cosine similarity for vector search.
- `createRAGPipeline()` orchestrates the full ingest/query workflow.

### Fixed — Adapters (`@harness-one/anthropic`, `@harness-one/openai`)

- **AbortSignal propagation**: `ChatParams.signal` is now forwarded to the
  underlying Anthropic and OpenAI SDK calls (`client.messages.create`,
  `client.chat.completions.create`). In-flight HTTP requests are cancelled
  when the `AgentLoop` is aborted or an external signal fires.

- **`maxRetries` config option**: Both `AnthropicAdapterConfig` and
  `OpenAIAdapterConfig` now accept a `maxRetries` field. The value is passed to
  the SDK client at construction time so transient 429 / 5xx errors are retried
  without caller involvement. The Anthropic SDK default is 2; the OpenAI SDK
  default is 2.

- **Anthropic streaming — no duplicate `done` events**: The streaming
  implementation previously yielded a `done` chunk from the `message_delta`
  event and then a second one from `stream.finalMessage()`. Only the final
  `finalMessage()` done is now emitted, which carries complete and accurate
  usage data.

- **Anthropic — safe cache token property access**: Cache token fields
  (`cache_read_input_tokens`, `cache_creation_input_tokens`) are now accessed
  via `'field' in usage` presence checks instead of direct type casts, removing
  a potential `undefined` read.

- **Anthropic — `JSON.parse` in tool arguments wrapped in try/catch**: Tool
  argument strings that are not valid JSON no longer throw an unhandled
  exception; the raw string is used as a fallback instead.

### Fixed — Build & Config

- **`package.json` exports — `types` condition moved to first position**: All
  9 packages now list the `types` export condition before `import` and
  `require`. TypeScript resolves conditions in order; placing `types` last
  caused it to be silently ignored by some bundler configurations.

- **`LLMConfig` index signature replaced with `extra` field**: The previous
  `[key: string]: unknown` index signature on `LLMConfig` prevented TypeScript
  from enforcing the known fields. It has been replaced with
  `extra?: Readonly<Record<string, unknown>>` — a named escape hatch that keeps
  type safety on the standard fields while still allowing provider-specific
  pass-through.

  Migration: rename any usages from `config['someKey']` to
  `config.extra?.['someKey']`, and from `{ ...config, someKey: val }` to
  `{ ...config, extra: { someKey: val } }`.

- **`@harness-one/ajv` — build fixed**: The Ajv integration package now
  compiles cleanly.

### Fixed — `harness-one-full`

- **`HarnessConfig` is now a discriminated union**: `HarnessConfig` is defined
  as `AnthropicHarnessConfig | OpenAIHarnessConfig`, each carrying
  `provider: 'anthropic' | 'openai'` as the discriminant. TypeScript narrows
  the required `client` field automatically based on which provider is chosen,
  eliminating the previous `unknown`-typed `client`.

  ```typescript
  // Before (both provider and client were untyped)
  const harness = createHarness({ provider: 'anthropic', client: myClient });

  // After (TypeScript enforces that `client` must be an Anthropic instance
  // when provider is 'anthropic', and an OpenAI instance for 'openai')
  const harness = createHarness({
    provider: 'anthropic',
    client: new Anthropic({ apiKey: '...' }),
  });
  ```

- **`langfuse`, `redis`, `client` fields are properly typed**: These fields
  previously resolved to `unknown`. They are now typed as the concrete client
  interfaces from their respective packages (`Langfuse`, `Redis`, `Anthropic` /
  `OpenAI`).

- **No more `as unknown as` casts in internal helpers**: Internal factory
  functions (`createAdapter`, `createExporters`, `createMemory`) relied on
  `as unknown as X` casts to satisfy the discriminated union. These casts are
  replaced with explicit discriminant checks.

### Fixed — `harness-one` core

- **`GuardrailPipeline` — WeakSet validation**: Pipeline validity is now
  checked via a module-level `WeakSet` that is populated only by
  `createPipeline()`. The previous branded type cast (`as BrandedPipeline`)
  could be trivially bypassed; the WeakSet check cannot.

- **Memory stores — `idCounter` moved into closures**: `createInMemoryStore()`
  and `createFileSystemStore()` previously used a module-level `idCounter`
  variable, meaning all store instances shared the same counter. The counter is
  now a closure variable inside each factory call, so instances are independent.

- **FS store — atomic entry writes via write-then-rename**: Entry JSON files
  are now written to a `.tmp` sibling and then renamed to the final path. This
  prevents a partially-written file from being read as a corrupted entry if the
  process is interrupted mid-write.

- **FS store — parallel I/O in `allEntries()`**: `readdir` results are now
  processed with `Promise.all` instead of a sequential `for` loop, reducing
  latency when the directory contains many entries.

- **`AgentLoop` — stack traces stripped from tool error results**: When a tool
  handler throws, only `err.message` is included in the tool result message
  sent back to the LLM. Stack traces, file paths, and other internal
  implementation details are no longer present in the conversation context.

- **Injection detector — high-sensitivity patterns require context**: The high
  sensitivity tier patterns are now word-boundary anchored (e.g.
  `\bignore\b.*?\binstructions\b`) so that ordinary words like "override" in
  unrelated sentences do not trigger false positives.

- **JSON schema validator — ReDoS protection via `isSafePattern()`**: Before
  compiling a `pattern` keyword into a `RegExp`, the validator checks for
  nested quantifiers (`(a+)+` style) using `isSafePattern()`. Patterns that
  fail the check produce a validation error rather than blocking the event loop.

- **Rate limiter — incremental LRU index maintenance**: The LRU key eviction
  structure previously rebuilt its position index with `O(N)` `indexOf` on
  every request. The index is now maintained incrementally using a companion
  `Map<string, number>`, reducing worst-case cost from O(N) to O(N) per eviction
  sweep but eliminating the per-request O(N) scan.

- **In-memory store — `searchByVector()` implemented with cosine similarity**:
  `MemoryStore.searchByVector()` was previously unimplemented and returned an
  empty result. It now computes cosine similarity against embeddings stored in
  `entry.metadata.embedding` and returns results sorted by descending score.

- **`CostTracker` — running total + ring buffer (max 10 000 records)**:
  `getTotalCost()` previously re-summed all records on every call (O(N)).
  A `runningTotal` variable is now maintained incrementally. Records are held
  in a ring buffer capped at 10 000 entries; the oldest record's cost is
  subtracted from the running total when it is evicted.

### Fixed — Integration packages

- **`@harness-one/redis` — `compact()` uses batched `mget`**: Compaction
  previously issued one `GET` per entry (N+1 Redis round trips). Entries are
  now fetched in batches of 100 using `mget`, matching the `query()` pattern.

- **`@harness-one/langfuse` — `traceMap` LRU eviction (max 1 000 entries)**:
  The `traceMap` that holds live Langfuse trace references grew without bound.
  It now evicts the oldest entry (insertion order) when it exceeds 1 000 keys,
  preventing unbounded memory growth in long-running processes.

- **`@harness-one/langfuse` prompt backend — `list()` tracks known prompts**:
  `list()` previously returned an empty array because there is no Langfuse API
  to enumerate all prompts. It now returns templates for every prompt
  successfully fetched via `fetch()` since the backend was instantiated.

- **`@harness-one/langfuse` prompt backend — `push()` throws a descriptive
  error**: `push()` previously threw a generic error or silently no-oped.
  It now throws a `HarnessError` with the code `UNSUPPORTED_OPERATION` and a
  message directing users to the Langfuse UI or REST API.

- **`@harness-one/langfuse` cost tracker — O(1) running total**: `getTotalCost()`
  now returns a maintained `runningTotal` rather than re-summing on every call,
  matching the fix applied to the core `CostTracker`.

- **`@harness-one/opentelemetry` — proper parent-child span context via OTel
  Context API**: Child spans are now started with
  `tracer.startActiveSpan(name, {}, parentContext, callback)` where
  `parentContext` is obtained via `otelTrace.setSpan(otelContext.active(),
  parentOTelSpan)`. Previously, parent-child relationships were tracked in
  metadata attributes only and were not visible to OTel-aware tooling.
