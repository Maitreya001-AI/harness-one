# Wave-12 Deep Architecture Research Report

**Date:** 2026-04-17
**Scope:** `harness-one` 1.0-rc, 9 packages, 173 source + 132 test files
**Method:** 6 parallel Explore agents, 6 orthogonal angles
**Total findings:** 77 raw → 62 unique (after dedupe) across P0/P1/P2

Angles covered:
1. Concurrency / async correctness / resource lifecycle
2. Error handling / failure modes / resilience
3. API design / public surface ergonomics / type safety
4. Performance / hot path / memory
5. Observability correctness (trace, metrics, logs)
6. Test quality / coverage gaps

---

## P0 — Data Loss / Crash (must-fix for 1.0)

### P0-1 Unbounded `pendingQueue` in agent-pool
**File:** `packages/core/src/orchestration/agent-pool.ts:86`
Pending-queue array grows without bound under sustained acquire bursts → OOM / DoS.
**Fix:** cap queue size (config, default 1000), reject excess with `POOL_QUEUE_FULL`.

### P0-2 Unsafe double-cast on OpenAI stream controller
**File:** `packages/openai/src/index.ts:634-635`
`stream as unknown as Record<string, unknown>` then `as unknown as { controller }` to reach private field. Breaks silently on SDK drift.
**Fix:** guarded property access with runtime shape check, no raw casts.

### P0-3 String concatenation in streaming hot loop (O(n²))
**File:** `packages/core/src/core/stream-aggregator.ts:133, 155, 199`
`this.accumulatedText += chunk.text` and `existing.arguments += partial.arguments` per-chunk.
**Fix:** buffer as `string[]`, `.join('')` in `getMessage()`.

### P0-4 Conversation splice with full spread in agent-loop
**File:** `packages/core/src/core/agent-loop.ts:771`
`ctx.conversation.splice(0, len, ...pruneResult.pruned)` → O(n) spread + O(n) splice, stack depth risk.
**Fix:** in-place overwrite loop + `length = len`.

### P0-5 Half-open circuit-breaker probe race
**File:** `packages/core/src/infra/circuit-breaker.ts:137-142`
Two probes can interleave check/set on `halfOpenProbeInFlight`; one success can reset `consecutiveFailures` to 0 before the other's failure is recorded.
**Fix:** atomic guard via Promise-based mutex acquired before the check.

---

## P1 — Meaningful Degradation / Footguns

### P1-1 5xx status codes not classified as retryable
**File:** `packages/core/src/core/error-classifier.ts:28-42`
503/502/504 fall through to generic `ADAPTER_ERROR` — no retry despite being the canonical "overload, back off" signal.
**Fix:** add `ADAPTER_UNAVAILABLE` + regex match `50[234]|gateway|unavailable`.

### P1-2 JSON parse error on tool arguments loses cause
**File:** `packages/core/src/tools/registry.ts:232-241`
Throws `'Invalid JSON in tool call arguments'` with no `cause`, no position.
**Fix:** preserve `SyntaxError` as `cause`, include message hint.

### P1-3 Anthropic tool_use malformed-input silent `{}`
**File:** `packages/anthropic/src/index.ts:150-167`
Malformed JSON in tool_use → emit warn, substitute `{}`. Hides the real error; downstream tool fails with confusing "missing field".
**Fix:** throw `HarnessError(ADAPTER_PARSE)` with raw string preserved in context bag.

### P1-4 Adapter `.chat()` has no timeout (non-streaming)
**File:** `packages/core/src/core/adapter-caller.ts:208-221`
If provider hangs, adapter promise hangs forever unless caller passed `AbortSignal`.
**Fix:** add `adapterTimeoutMs` config, wrap in `Promise.race` with abortable timeout.

### P1-5 `batchUnlink` partial-failure silently dropped
**File:** `packages/core/src/memory/fs-store.ts:217` uses `packages/core/src/memory/fs-io.ts:212-232`
Failed deletes returned but caller never reports → stale entries, silent corruption.
**Fix:** log + emit metric on `result.failed.length > 0`, surface to logger warn.

### P1-6 Head-based-only trace sampling
**File:** `packages/core/src/observe/trace-manager.ts:566-569`
Decision frozen at trace start; can't implement "sample all errors" tail strategy.
**Fix:** optional `shouldSampleTrace(trace)` hook evaluated at `endTrace()`.

### P1-7 Logger has no span/trace context auto-injection
**File:** `packages/core/src/observe/logger.ts:143-160`
Only static `correlationId` — every call site must pass trace id manually. Breaks log↔trace correlation.
**Fix:** optional `getContextFn()` in LoggerConfig evaluated per log.

### P1-8 Langfuse `client.flushAsync()` fire-and-forget
**File:** `packages/langfuse/src/index.ts:638-640`
Not awaited, not tracked in `pendingExports`; exception in catch handler swallowed silently.
**Fix:** track in Set, await on dispose, wrap catch defensively.

### P1-9 OTel parent-span eviction loses hierarchy
**File:** `packages/opentelemetry/src/index.ts:314-317`
TTL-based `evictedParents` cleanup races child arrival → child appears as root.
**Fix:** remove TTL, rely only on size-based LRU eviction; document retention.

### P1-10 Session event queue silent drops after cap
**File:** `packages/core/src/session/manager.ts:132-147`
Past `MAX_PENDING_EVENTS`, drops silently (only one warn). Destroy events can be lost → leaks.
**Fix:** prioritize (keep destroy/error, drop access), emit metric per drop.

### P1-11 `_zeroUsageWarnedModels` module-scoped leak
**File:** `packages/openai/src/index.ts:444`
Never cleared, unbounded across long-running servers with many distinct models.
**Fix:** LRU-bound (max 1000) or instance-scoped.

### P1-12 Unbounded tool-call accumulation in stream-aggregator
**File:** `packages/core/src/core/stream-aggregator.ts:169-189`
`MAX_TOOL_CALLS=128` checked after allocation; rogue stream can allocate thousands first.
**Fix:** size check before allocation (line 168).

### P1-13 Mutable provider registry in OpenAI adapter
**File:** `packages/openai/src/index.ts:27-36, 234`
`_providers` mutable; re-register silently overwrites (security: attacker could repoint `groq`).
**Fix:** require `sealProviders()` after init; throw on late mutation.

### P1-14 Readonly leaking on guardrail options
**File:** `packages/preset/src/index.ts:96-101`
Nested fields (`rateLimit.max`, `contentFilter.blocked[]`) mutable despite top-level readonly.
**Fix:** deep `readonly` types; `readonly string[]` for arrays.

### P1-15 Cost tracker exposes mutable setters
**File:** `packages/core/src/observe/cost-tracker.ts`
`setPricing()` / `setBudget()` mutate state post-construction → non-deterministic under concurrency.
**Fix:** require all config at factory time; deprecate mutators with warning.

### P1-16 Session metadata shallow copy
**File:** `packages/core/src/session/manager.ts:229`
`toReadonly()` shallow-clones metadata; nested mutation bypasses readonly contract.
**Fix:** deep-freeze metadata on entry or clone on return.

### P1-17 `retryableErrors.includes()` linear scan per retry
**File:** `packages/core/src/core/adapter-caller.ts:326, 399`
O(n) lookup on hot path.
**Fix:** `Set<string>` at construction.

### P1-18 Tool-call timeout doesn't force-close underlying work
**File:** `packages/core/src/tools/registry.ts:304-340`
Abort fires in finally; tool impl may not honor signal → socket leak.
**Fix:** document signal contract; add `forceKill` option.

### P1-19 Flush has no global timeout
**File:** `packages/core/src/observe/trace-manager.ts:821-833, 858-873`
`Promise.allSettled` loop with no deadline → shutdown hangs on stuck exporter.
**Fix:** global `flushTimeoutMs`, log warn + abandon on timeout.

### P1-20 Default session ID never returned to caller
**File:** `packages/preset/src/index.ts:502-514`
Auto-generated, warn once, caller has no way to learn it → conversations can't resume.
**Fix:** emit `session.started` event with id; add `onSessionId` callback.

### P1-21 OpenAI schema transform not memoized
**File:** `packages/openai/src/index.ts:363-382`
Called per-message × per-tool × per-adapter-invocation.
**Fix:** `WeakMap<JsonSchema, OpenAIParameters>` memo.

### P1-22 Untyped `ToolCall.arguments`
**File:** `packages/core/src/tools/types.ts:140-145`
`Record<string, unknown>` with no discriminator; consumers assume parsed but may get unparsed.
**Fix:** brand as `ParsedToolArguments`, offer `{kind:'success'|'parse_error'}` result.

### P1-23 Langfuse `traceMap` entry not cleaned on export failure
**File:** `packages/langfuse/src/index.ts:163-185`
Throws after `traceMap.set(...)` → poisoned entry until LRU eviction.
**Fix:** try/catch, delete on throw.

### P1-24 SSE `JSON.stringify` not guarded
**File:** `packages/core/src/core/sse-stream.ts:28-34`
Circular refs or throwing getters crash the stream abruptly.
**Fix:** try/catch, yield `{event:'error'}` fallback.

### P1-25 Span status captured before export
**File:** `packages/core/src/observe/trace-manager.ts:endSpan`
If caller sets status after `endSpan`, exporter sees stale `completed` status.
**Fix:** document invariant; optionally snapshot status later.

### P1-26 Langfuse event metadata unsanitized
**File:** `packages/langfuse/src/index.ts:88-100`
`attributes` sanitized but `events[].attributes` shipped raw.
**Fix:** recursive sanitize.

---

## P2 — Smells / Polish / Test Coverage

### P2-1 Abort listener registered after timer start in adapter-caller backoff
`packages/core/src/core/adapter-caller.ts:165-203` — micro-race window, fix ordering.

### P2-2 `spanMap` / `spans` Map unbounded parallel index
`packages/core/src/observe/trace-manager.ts:355-356` — audit eviction cascade.

### P2-3 Session-manager GC `setInterval` not `clearInterval`ed
`packages/core/src/session/manager.ts:235-244` — store handle, clear in dispose.

### P2-4 `computeJitterMs` result uncapped
`packages/core/src/orchestration/agent-pool.ts:163-175` — clamp via `Math.min`.

### P2-5 Generator `.return()` not forwarded to StreamHandler
`packages/core/src/core/adapter-caller.ts:296-375` — explicit `streamGen.return()` in finally.

### P2-6 SSE per-chunk `{event,data}` allocation
`packages/core/src/core/sse-stream.ts:30-33` — hot-path GC pressure.

### P2-7 Tool-call arg concat in Anthropic streaming
`packages/anthropic/src/index.ts:397` — buffer instead of re-yield prefix.

### P2-8 `serializeToolResult` replacer has no depth limit
`packages/core/src/core/iteration-runner.ts:189-195` — stack overflow on circular/deep input.

### P2-9 Logger metadata allocated regardless of level
`packages/openai/src/index.ts:505-507`, `packages/anthropic/src/index.ts:156-167` — add `isWarnEnabled()` gate.

### P2-10 Message-queue backpressure doesn't emit `onEvent`
Behavior gap + test gap in `message-queue.ts:103-137`.

### P2-11 `_providersSealed` boolean without atomic semantics
`packages/openai/src/index.ts:50, 263-265` — worker-thread race; document or lock.

### P2-12 OTel non-primitive attributes dropped to console.debug only
`packages/opentelemetry/src/index.ts:200-212` — optional JSON-stringify fallback.

### P2-13 Budget check fires per update on streaming → alert flood
`packages/core/src/observe/cost-tracker.ts:505-511, 584-589` — dedupe window.

### P2-14 Stack trace absolute paths not redacted
`packages/core/src/observe/logger.ts:86-87` — path sanitizer.

### P2-15 Sampling rate change not atomic + not documented
`packages/core/src/observe/trace-manager.ts:839-848` — doc note only.

### P2-16 `filterExtra()` allow-list rechecked per call
`packages/openai/src/index.ts:107-113`, `packages/anthropic/src/index.ts:97-103` — prebuilt Set.

### P2-17 `AdapterHarnessConfig` leaks `AgentAdapter` in preset barrel
`packages/preset/src/index.ts:13-15, 44, 143-148` — mark `@internal` or split export path.

### P2-18 Logger `warn(meta: Record<string, unknown>)` not readonly
`packages/core/src/observe/logger.ts:22-28` — signature tightening.

### P2-19 Schema transformers silently drop unknown keys
`packages/anthropic/src/index.ts:191-210`, `packages/openai/src/index.ts:363-382` — mark `@internal`, warn on drop.

### P2-20 `Harness.initialize()` missing TSDoc
`packages/preset/src/index.ts:217-218` — polish.

### P2-21 Code-block parser edge: CRLF + whitespace
`packages/core/src/core/output-parser.ts:120-132` — test + normalize.

### P2-22 MessageQueue `since` boundary semantics undocumented
`packages/core/src/orchestration/message-queue.ts:167` — test `timestamp === since` excluded.

### P2-23 Missing property tests (backoff monotonicity, LRU invariants, token-count monotonic)
`infra/backoff.ts`, `infra/lru-cache.ts`, `tiktoken/src/index.ts` — add fast-check.

### P2-24 Tool execute returning non-ToolResult type not tested
`packages/core/src/tools/registry.ts` — runtime shape assert.

### P2-25 `onRetry` callback throw path not tested
`packages/core/src/core/resilience.ts` — wrap defensively or document propagation.

### P2-26 Budget negative-remaining edge not tested
`packages/core/src/context/budget.ts` — clamp at 0 vs allow negative.

---

## Fix Wave Organization (for implementation)

To minimize file-ownership conflicts during parallel fix execution:

**Track A — core infra** (agent-pool, async-lock, circuit-breaker, backoff, output-parser, abortable-timeout, lru-cache)
P0-1, P0-5, P1-17, P2-1, P2-4, P2-23

**Track B — core streaming** (stream-aggregator, sse-stream, adapter-caller, iteration-runner, agent-loop)
P0-3, P0-4, P1-4, P1-12, P1-24, P2-5, P2-6, P2-8

**Track C — core observe** (logger, trace-manager, cost-tracker)
P1-6, P1-7, P1-15, P1-19, P1-25, P2-13, P2-14, P2-15

**Track D — core session+tools+memory** (session/manager, tools/registry, tools/types, memory/fs-store)
P1-2, P1-5, P1-10, P1-16, P1-18, P1-22, P2-3

**Track E — core error classifier + context**
P1-1, P2-26

**Track F — adapters (anthropic + openai)**
P0-2, P1-3, P1-11, P1-13, P1-21, P2-7, P2-9, P2-11, P2-16, P2-19

**Track G — exporters (langfuse + opentelemetry)**
P1-8, P1-9, P1-23, P1-26, P2-12

**Track H — preset + public API**
P1-14, P1-20, P2-17, P2-18, P2-20

**Track I — tests**
P2-10, P2-21, P2-22, P2-24, P2-25

Each track owns a disjoint set of files so fix agents can run in parallel without conflict.
