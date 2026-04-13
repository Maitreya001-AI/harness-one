---
"harness-one": minor
"@harness-one/preset": minor
"@harness-one/anthropic": minor
"@harness-one/openai": minor
"@harness-one/ajv": minor
"@harness-one/redis": minor
"@harness-one/langfuse": minor
"@harness-one/opentelemetry": minor
"@harness-one/tiktoken": minor
---

Closes 47 findings from the 2026-04-13 **new-perspective deep-research
audit** (wave 4). Five parallel research agents ran against angles the
prior 147/50/123 audits had not entered: concurrency correctness,
architectural elegance, hot-path latency, type safety, and lifecycle /
multi-tenant safety. See `docs/RESEARCH-2026-04-13-wave4.md` for the
full source report.

**3,543 → 3,678 tests** (+135); typecheck + lint clean across 9 packages.

Wave 4a — Foundational primitives + shutdown DAG (9 fixes)
- New `_internal/disposable.ts` — `Disposable` interface + `disposeAll()`
  with `DisposeAggregateError`.
- New `_internal/async-lock.ts` — FIFO single-owner mutex with
  `AbortSignal` support (`acquire()` / `withLock()`).
- New `_internal/lazy-async.ts` — `createLazyAsync<T>()` that stores the
  in-flight promise synchronously so concurrent first-callers share the
  same init; retries on rejection.
- **LM-001 / LM-013** Preset `shutdown()` / `drain()` rewritten as a
  sequential DAG behind a `shutdownPromise` latch; concurrent callers
  now await one pass instead of racing past the flag.
- **LM-014** `agent-pool.dispose()` is now async, idempotent, and awaits
  every `loop.dispose?.()` call; pending acquires are rejected cleanly.
- **LM-015** `langfuse` exporter awaits `client.flushAsync()` inside a
  5 s `Promise.race` before clearing `traceMap` / `traceTimestamps`.
- **LM-003 / A1-3** TraceManager per-exporter `ensureInitialized` uses
  `createLazyAsync` — concurrent first-exports share one init call and
  failed init is re-tried on the next export.
- **LM-016** `startTrace` returns a dead handle (no admission to the
  `traces` map) when every exporter reports `isHealthy() === false`.

Wave 4b — TOCTOU races + abort listener leaks (7 fixes)
- **A1-1** `orchestrator.delegate()` cycle check + `strategy.select` +
  chain mutation wrapped in a per-source `AsyncLock`; concurrent
  delegations can no longer bypass `DELEGATION_CYCLE` detection.
- **A1-4** Handoff `send()` is synchronous and therefore atomic under
  the single-threaded runtime — documented with a forward-compat
  reference to the lock primitive and pinned by a 200-concurrent-send
  test at `maxInboxPerAgent=50`.
- **A1-8** RAG retriever LRU "touch" now uses a per-cache-key
  `createLazyAsync` map — 10 parallel identical retrieves call the
  embedder exactly once; the lazy slot clears on rejection so a later
  call retries.
- **A1-19** Guardrail self-healing uses a new `sleepWithAbort` helper
  that clears the timer and removes the abort listener on both paths;
  backoff abort throws `HarnessError('SELF_HEALING_ABORTED')`.
- **A1-20** Agent-loop's external-signal listener body is gated on
  `_status === 'disposed'` so a late-firing signal is a no-op.
- **CQ-037** `fallback-adapter.pendingSwitch` (a racy `Promise | null`)
  replaced with `createAsyncLock` + a stale-adapter guard — 10
  concurrent failures advance the adapter index exactly once.
- **LM-011** TraceManager captures `samplingRateSnapshot` at
  `startTrace`; `exportTraceTo` reads the snapshot, so a mid-flight
  `setSamplingRate(0)` no longer drops in-flight traces.
- **CQ-036** `pendingExports` cleanup `.catch()` now routes through the
  injected logger; silent fallback only when no logger is configured.

Wave 4c — Streaming hot-path allocations + snapshot correctness (12 fixes)
- **PERF-024 / 025 / 028 / 032 / 034** Agent-loop streaming loop no
  longer allocates per chunk: `Object.frozen` strategy-options bag is
  hoisted to the constructor; `accumulatedToolCalls` Map is paired with
  a `toolCallList` array so delta handling mutates in place and the
  message-assembly path reuses the array; `Promise.allSettled` consumes
  the `pendingExports` Set directly; yield-then-execute is a single
  pass.
- **PERF-026 / LM-012** Middleware chain and session event handlers
  switched from array to `Set<fn>` — insertion-order iteration is
  preserved, duplicate registration is deduped, unsubscribe is O(1).
- **PERF-031** `MessageQueue.iterateMessages()` — zero-copy generator
  with the same `type` / `since` filter semantics; `getMessages()`
  documented as allocating.
- **PERF-021 / 023 / 033 / 035** TraceManager builds **one** frozen
  readonly snapshot (with a frozen `events` array) per span and reuses
  it across every exporter — no more per-exporter deep clone.
- **PERF-029 / LM-007** LRU order replaced with a per-trace
  doubly-linked list (`lruPrev` / `lruNext` / `inLru`); append /
  remove / shift are all O(1). `startTrace` now actively evicts when
  `maxTraces` is reached, so memory is capped even when exporters are
  unhealthy and traces never end.
- **PERF-030** Logger gates all work behind the level check; replacer
  is constructed only when actually stringifying; text-mode calls with
  no metadata skip `JSON.stringify` entirely.

Wave 4d — Type safety + error contract (9 fixes)
- **CQ-033** Opaque branded types `TraceId` / `SpanId` / `SessionId`
  via `Brand<string, …>` plus `asTraceId` / `asSpanId` / `asSessionId`
  helpers in `_internal/ids.ts`; TraceManager / SessionManager return
  branded values so cross-assignment (sessionId → spanId) fails the
  typecheck.
- **CQ-041** `ToolResult` gains a `kind: 'success' | 'error'`
  discriminator alongside the legacy `success: boolean` — consumers
  can now write exhaustive `switch` blocks.
- **CQ-031** `guardrails/pipeline` replaces an `as unknown as
  Partial<…>` double-cast with a module-scoped
  `WeakMap<GuardrailPipeline, PipelineInternalData>`; pipeline tokens
  are frozen opaque objects.
- **CQ-045** Memory `_schemas` gained `isMemoryEntry` / `isRelayState`
  runtime type-guards; shape mismatches now throw
  `HarnessError('MEMORY_CORRUPT')` instead of silently casting.
- **CQ-032 / 034 / 040 / 044** Ad-hoc `throw new Error(...)` sites in
  `LRUCache`, `output-parser`, `cli/parser`, and `tiktoken` routed
  through `HarnessError` (`INVALID_CONFIG`, `INTERNAL_ERROR`,
  `CLI_PARSE_ERROR`, `MEMORY_CORRUPT`); tiktoken emits a one-time warn
  via swappable `setTiktokenFallbackWarner` instead of throwing.
- **CQ-038** Preset emits a `logger.warn` when a custom function /
  object tokenizer is supplied without `config.model` — previously a
  silent no-op.
- **CQ-039** Preset config validation now requires
  `Number.isInteger && > 0` for `maxIterations` / `maxTotalTokens` /
  `guardrails.rateLimit.max` / `guardrails.rateLimit.windowMs`;
  `budget` requires `Number.isFinite && > 0` (rejects `NaN`, negative,
  and `-Infinity`).
- **CQ-035** Removed redundant `| undefined` on `AgentLoopConfig`
  readonly optional fields.

Wave 4e — Module surface polish + extension points (10 fixes)
- **ARCH-001** `StreamAggregator` extracted from the god-module
  `agent-loop.ts` into `core/stream-aggregator.ts` — behaviour-preserving
  refactor; `handleStream` is now a thin wrapper.
- **ARCH-002** `AgentLoopTraceManager` hoisted to
  `core/trace-interface.ts` with a cleaner JSDoc rationale.
- **ARCH-012** New `InstrumentationPort` in
  `observe/instrumentation-port.ts`; RAG accepts the port instead of
  the concrete `TraceManager` (structural compat, no consumer break).
- **ARCH-008** Pluggable `EvictionStrategy` (`overflow-bucket` +
  `lru`) in `observe/cost-tracker-eviction.ts`. Core default stays
  `overflow-bucket` (preserves SEC-009); Langfuse explicitly wires
  `lruStrategy`; a conformance suite runs against both.
- **ARCH-006** `AgentLoopHook` interface
  (`onIterationStart` / `onToolCall` / `onCost` / `onIterationEnd`)
  for iteration-level instrumentation; hook errors route through the
  logger and never break the loop.
- **ARCH-003** New `harness-one/essentials` entry point exports the 12
  most-used symbols (AgentLoop, HarnessError, defineTool, …); wired
  through `package.json` + `tsup`.
- **ARCH-010** Preset `Harness.eventBus` is now a `Proxy` dead stub —
  warns once on property read, throws
  `HarnessError('DEPRECATED_EVENT_BUS')` on any method call. Scheduled
  for removal in 0.5.0.
- **ARCH-009** `setSpanAttributes()` emits one-warn-per-key when the
  attribute prefix is outside `{system., error., cost., user.}`;
  silent when no logger is configured.
- **ARCH-011** `AgentLoop` class export carries `@deprecated` —
  `createAgentLoop()` factory is preferred; the class still works.
- **ARCH-007** `Harness.initialize?()` — optional warmup (exporter
  initialise + tokenizer warm) with an idempotent latch; calling
  `run()` before `initialize()` still works with a documented
  cold-start penalty.
