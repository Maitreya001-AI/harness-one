# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

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
`docs/RESEARCH-2026-04-13-wave4.md` for the full provenance.

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

- `docs/RESEARCH-2026-04-13-wave4.md` — the five-agent synthesis
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
(see `AUDIT-2026-04-12.md` and `docs/forge-fix/audit-47-fixes-20260412/`).
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

- `AUDIT-2026-04-12.md` — full audit report (47 issues with fixes).
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
