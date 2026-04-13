# Harness-One Architecture Research — Wave 4

**Date:** 2026-04-13
**Scope:** New-angle deep-research follow-on to waves 1-3 (147 + 50 + 123 issues, all closed in commits `083bafb`, `9686831`, `8b298f9`).
**Baseline excluded:** FINDINGS-2026-04-13.md (PERF-001..020, CQ-001..030, SEC-001..016, SPEC-001..018, TEST-001..015, DOC-001..009, OBS-001..015).
**Method:** 5 parallel `Explore` sub-agents, each scoped to one new angle the prior audits did not enter.

---

## Executive Summary

The prior three waves closed the obvious surface of the codebase — timer leaks, unbounded caches, predictable IDs, spec drift. This wave targeted structural issues that only surface under realistic production load: concurrent `dispose()` during in-flight I/O, shutdown sequencing across sub-systems, hot-path allocation in the streaming loop, type escape hatches that defeat branded types, and a rapidly-widening public API surface.

**Headline verdict:** the codebase is close to production-grade but not yet there. The two largest remaining gaps are **(1) the shutdown/drain DAG in `preset/src/index.ts`**, which races sub-system disposal and can abandon in-flight traces, and **(2) the streaming path in `core/agent-loop.ts`**, which allocates per-chunk in a tight loop and will cause measurable GC pressure at higher QPS.

| Dimension | Raw findings | After dedup | P0 | P1 | P2 |
|-----------|-------------:|------------:|---:|---:|---:|
| Concurrency correctness | 20 | 13 | 4 | 7 | 2 |
| Module elegance & extension | 14 | 14 | 0 | 6 | 8 |
| Hot-path latency & allocation | 15 | 15 | 3 | 7 | 5 |
| Type safety & error contract | 15 | 14 | 3 | 8 | 3 |
| Lifecycle & multi-tenant safety | 16 | 12 | 4 | 5 | 3 |
| **Unique total** | **80** | **68** | **14** | **33** | **21** |

Verified spot-checks: `agent-loop.ts` is **986 LOC**, `preset/src/index.ts` is **705 LOC**, `trace-manager.ts` is **705 LOC**, `langfuse/src/index.ts` is **675 LOC**, `cost-tracker.ts` is **566 LOC** — the god-module claims in cluster 4 are real.

---

## 1. Cluster: Shutdown & Drain DAG (P0)

The shutdown path in `preset/src/index.ts` is the single highest-risk area. Sub-system disposal is not ordered as a DAG; flush and shutdown race.

| ID | File:line | Problem |
|----|-----------|---------|
| LM-001 | `preset/src/index.ts:544-561` | `shutdown()` calls `traces.flush()` then races exporters' `shutdown()` against a 5s timeout — `pendingExports` may still be in-flight when exporters close. |
| LM-002 | `preset/src/index.ts:563-581` | `drain()` aborts the loop and disposes sessions but does not drain `agent-pool` or await middleware cleanup before `traces.dispose()`; pool timers can fire after traces close. |
| LM-013 | `preset/src/index.ts:376-392` | `isShutdown` flag is a check, not a latch — concurrent shutdown calls race past the check before the first completes. |
| LM-014 | `orchestration/agent-pool.ts:385-396` | `dispose()` is synchronous; does not await pending `loop.dispose()` (which may close file handles). |
| LM-015 | `langfuse/src/index.ts:149-157` | `shutdown()` does not await `client.flushAsync()` before clearing `traceMap`; in-flight flush can reference cleared trace objects. |

**Recommendation:** Define a `Disposable` interface with an async, idempotent `dispose()` and a disposal order (AgentLoop → AgentPool → Orchestrator → Middleware → Sessions → Memory → TraceManager → Exporters → Logger). Serialize concurrent `shutdown()` calls behind a single promise cached on the harness. Add an integration test that runs 100 concurrent `run()` + random `shutdown()` timings.

---

## 2. Cluster: TOCTOU on Async Boundaries (P0–P1)

Single-threaded JS makes us lazy about locks, but `await` is a preemption point. Several critical state-mutations check-then-act across awaits.

| ID | File:line | Race |
|----|-----------|------|
| A1-1 | `orchestration/orchestrator.ts:376-421` | Delegation chain is checked then written **around** `await strategy.select()`; concurrent delegations bypass cycle detection. |
| A1-3 / LM-003 | `observe/trace-manager.ts:152-168` | Lazy-init `initPromises` map: between `Map.get` and `Map.set`, a second caller can see `undefined` and kick a duplicate init. |
| A1-4 | `orchestration/handoff.ts:136-149` | `while (queue.length > maxInboxPerAgent)` eviction after `push`; concurrent senders can invalidate the bound. |
| A1-8 | `rag/retriever.ts:110-129` | LRU "touch" does `delete` then `set` across an await — concurrent `retrieve()` sees cache miss and duplicates the embedding call. |
| LM-011 | `observe/trace-manager.ts:579-609` | Runtime `setSamplingRate()` mutates config observed by concurrent `exportTraceTo()` decisions. |
| LM-016 | `observe/trace-manager.ts:235-244` | No transaction boundary: `startTrace` admits the trace before the exporter's lazy init resolves; init failure leaves zombie traces that never export. |

**Recommendation:** Introduce a small `AsyncLock` / `Mutex` primitive in `core/_internal/` and wrap every "read map → await → mutate map" sequence. For lazy-init promises, store the promise **synchronously before awaiting** so second callers see the in-flight promise.

---

## 3. Cluster: AbortSignal & Listener Leaks (P0–P1)

AbortSignal plumbing is partial. Several promises register listeners that survive successful resolution because cleanup happens on the cleanup path, not the happy path.

| ID | File:line | Leak |
|----|-----------|------|
| A1-2 | `orchestration/agent-pool.ts:251-296` | `setTimeout` and `signal.addEventListener` both register teardown; winner settles, loser's listener stays until GC. |
| A1-5 | `orchestration/agent-pool.ts:318-324` | `pendingQueue.length > 0` check then shift across await — `release()` may double-resolve. |
| A1-19 | `guardrails/self-healing.ts:85-88` | Backoff `setTimeout` not cleared when abort fires during backoff. |
| A1-20 | `core/agent-loop.ts:310-318` | External signal listener fires after `dispose()` has nulled its reference — handler still invoked on dereferenced state. |
| LM-010 | `core/agent-loop.ts` | Tool-execution retries scheduled before `abort()` continue to fire post-shutdown; retry scheduler has no abort gate. |

**Recommendation:** Adopt the `AbortSignal.any()` + `{ once: true }` pattern uniformly. Every `Promise.race([op, timeoutPromise])` site should have a settled-flag guard; every signal-based cleanup should be idempotent.

---

## 4. Cluster: Hot-Path Allocation in Streaming (P0–P1)

`core/agent-loop.ts` is the hottest path in the library. Per-chunk allocations multiply with token count.

| ID | File:line | Cost |
|----|-----------|------|
| PERF-024 | `core/agent-loop.ts:866` | `[...accumulatedToolCalls.values()]` on every tool-call delta — O(N) alloc per streamed chunk. |
| PERF-025 | `core/agent-loop.ts:662-667` | `Object.assign({signal, getToolMeta?})` constructed per tool-batch; template is static. |
| PERF-028 | `core/agent-loop.ts:591,593,621,632` | Multiple `Array.from(pendingExports)` + `exporters.map()` during flush/dispose. |
| PERF-032 | `core/agent-loop.ts:898` | Final `[...accumulatedToolCalls.values()]` materialises map only to hand off. |
| PERF-021 / 023 / 033 / 035 | `observe/trace-manager.ts:358-385, 535-539` | Per-export deep-clone of span + events; with N exporters, cost is ×N per trace. |
| PERF-026 / LM-012 | `core/middleware.ts:76`, `session/manager.ts:367` | Linear `indexOf` unsubscribe on arrays; O(n) at scale. |
| PERF-029 / LM-007 | `observe/trace-manager.ts:287-290, 235-249` | LRU eviction rebuilds `traceOrderIndex` O(n); map grows unbounded if all exporters become unhealthy. |
| PERF-031 | `orchestration/message-queue.ts:149-159` | `getMessages()` filter+copy per call; no zero-copy iterator. |

**Recommendation:** Mark span/event snapshots as `Readonly` and hand them by reference. Replace ordered-array LRU with a doubly-linked hash map. Switch middleware storage to a `Set` keyed by function reference. Pre-allocate loop-invariant objects outside the streaming loop.

---

## 5. Cluster: Module Elegance & Extension Points (P1–P2)

| ID | Finding |
|----|---------|
| ARCH-001 | `agent-loop.ts` is **986 LOC** mixing 5 concerns (loop, stream, errors, tool safety, middleware dispatch). Extract `StreamAggregator`, `ToolResultSafetyGate`, `RetryStateManager`. |
| ARCH-002 | `AgentLoopTraceManager` interface on `agent-loop.ts:24-35` leaks its "structural-compat to avoid circular import" rationale into the public docs. Hoist to `core/trace-interface.ts`. |
| ARCH-003 | `packages/core/src/index.ts` barrel exports ~90 named symbols from 18 submodule groups. Add `harness-one/essentials` entry point for the 12 most-used APIs; let tree-shaking handle the rest. |
| ARCH-005 | No typed `Disposable` interface — `dispose()` is convention-only. Codify `{ dispose(): Promise<void>, readonly disposed: boolean }`. |
| ARCH-006 | Custom instrumentation must extend `TraceExporter`; no `AgentLoopHook` for iteration-level events (onIterationStart, onToolCall, onCost). |
| ARCH-007 | `createHarness()` wires components with implicit ordering; using `.memory.query()` before `.sessions.create()` is undefined. Add `initialize()` gate. |
| ARCH-008 | Core `CostTracker` uses overflow-bucket; Langfuse uses LRU. Extract `BaseCostTracker` + pluggable `EvictionStrategy`. |
| ARCH-009 | `SpanAttributes = Record<string, SpanAttributeValue>` has no reserved-prefix discipline. Adding `system.*` keys in a patch is a breaking change for consumers' custom exporters. |
| ARCH-010 | `Harness.eventBus` is documented `@deprecated` but still constructed. Schedule removal in next major. |
| ARCH-011 | Mixed factory/class exports: `createAgentLoop` + `new AgentLoop()` both public. Pick factory-only. |
| ARCH-012 | `rag/types.ts:7` imports concrete `TraceManager`; plugins can't substitute. Extract `InstrumentationPort`. |
| ARCH-014 | Observability factories share redaction via `_internal/redact.ts` but no `ObservabilityContext` binds them — misconfiguration of one leaves others unvalidated. |

---

## 6. Cluster: Type Safety Escape Hatches (P0–P1)

| ID | File:line | Issue |
|----|-----------|-------|
| CQ-031 | `guardrails/pipeline.ts:38,101` | Branded-type `getInternal()` uses `as unknown as` double-cast — defeats the brand. |
| CQ-033 | `core/types.ts:26` | `TraceId`, `SpanId`, `SessionId` are bare `string` — cross-assignment is legal. Add branded types. |
| CQ-041 | `tools/types.ts:18-20` | `ToolResult` discriminated only by `.success: boolean`; no `kind` tag for exhaustive `switch`. Compare `GuardrailVerdict.action` (done correctly). |
| CQ-045 | `memory/_schemas.ts:61,94,100` | `as unknown` cast on parse result without Zod/Ajv validation — silent trust boundary. |
| CQ-032 / CQ-034 / CQ-040 / CQ-044 | Multiple | Ad-hoc `throw new Error(...)` outside `HarnessError` taxonomy (LRUCache ctor, output-parser unreachable, CLI parser, tiktoken fallback). Wrappers can't catch by `.code`. |
| CQ-036 | `observe/trace-manager.ts:188` | `.catch(() => {})` silently swallows rejection in `pendingExports` cleanup. |
| CQ-037 | `core/fallback-adapter.ts:45` | `pendingSwitch: Promise<void> | null` null-check-then-assign is racy under concurrent failure. |
| CQ-038 | `preset/index.ts:275-291` | Tokenizer config accepts 3 forms but silently no-ops 2 of them. |
| CQ-039 | `preset/index.ts:220-256` | `!Number.isFinite(maxIterations)` admits `-Infinity` edge case; add `> 0` guard. |

---

## 7. Cluster: Cross-Cutting Observations

- **Disposal contract is the spine that's missing.** Eight findings across clusters 1, 3, and 5 collapse into one need: a typed `Disposable` protocol with enforced composition order. This is the single most leveraged fix.
- **Lazy-init is duplicated across `TraceManager`, `ResilientLoop`, `Preset`, `Langfuse`, `Redis`.** Extract a `createLazyAsync<T>()` helper that stores the in-flight promise synchronously and retries on rejection.
- **Snapshot semantics are undefined.** Exporters receive deep-cloned spans defensively; consumers freeze nothing. Define `ReadonlyDeep<Span>` and hand references — cost drops by Nx where N is exporter count.
- **The streaming loop is where the library lives.** It deserves its own performance budget (allocations per chunk, per tool-call, per iteration) and a microbenchmark suite in CI that fails on regression.
- **Public API is wide and still growing.** 90 named exports + full type catalogue at the root entry will harden before a 1.0 is feasible. Consider `harness-one/essentials` + explicit submodule imports for everything else.

---

## 8. Recommended Next Waves

1. **Wave 4a — Disposal & shutdown DAG (P0):** Codify `Disposable`, rewrite `preset` shutdown/drain as an ordered async DAG, add 48-hour soak + concurrent-shutdown integration tests. *Blast radius: preset, all factories.*
2. **Wave 4b — TOCTOU & listener safety (P0):** Introduce `AsyncLock` / `createLazyAsync`, audit every `await` between map read and write. Standardise abort-race teardown pattern. *Blast radius: trace-manager, agent-pool, orchestrator, rag.*
3. **Wave 4c — Streaming hot-path budget (P0–P1):** Benchmark `agent-loop.handleStream`; extract `StreamAggregator`; switch middleware to `Set`; freeze span snapshots. *Blast radius: core/agent-loop, middleware, trace-manager.*
4. **Wave 4d — Type taxonomy (P1):** Branded IDs, `ToolResult` discriminator, HarnessError taxonomy audit, remove `as unknown as` casts. *Blast radius: core/types, tools, guardrails/pipeline, memory.*
5. **Wave 4e — Public surface discipline (P1–P2):** `Disposable` contract exported, `AgentLoopHook`/`InstrumentationPort` extension points, `essentials` entry point, remove `eventBus` dead export. *Blast radius: package barrel files, preset, rag.*

---

## 9. Limitations & Caveats

- Agent 5 reported 5 findings (LM-005, LM-008, LM-009) in the vicinity of shared singleton cost-tracker state; I did not fully verify these beyond the spot-checks in §1. They should be re-run with targeted reads before any fix.
- Agent 1 self-resolved 4 findings as "verified safe" (single-threaded JS guarantees held). Those were excluded from the dedup'd count.
- No findings here were dynamically tested. Severity estimates are structural — a `P0` TOCTOU may be vanishingly rare if the precondition requires contested multi-tenant writes the codebase never creates.
- The `686 LOC`-style god-module findings are real but cosmetic until someone needs to extend the class. Defer behind wave 4a/4b which already touch those files.

## 10. Source Transcripts

Per-angle agent transcripts (with file:line citations) archived at:

- Concurrency (Agent 1): task `a74ad32ca0549f793`
- Module boundaries (Agent 2): task `a3212d57427891d70`
- Hot paths (Agent 3): task `ab8f39048ac78c4dc`
- Type safety (Agent 4): task `a77429174074f20c4`
- Lifecycle (Agent 5): task `a260540e08b6e7f1c`

All agents read `FINDINGS-2026-04-13.md` first and were instructed to exclude its contents.
