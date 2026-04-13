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

Closes 123 findings from the 2026-04-13 production-readiness audit across
six dimensions (security, performance, code quality, spec compliance,
observability, docs, tests).

Security hardening:
- Logger and TraceManager gained a `redact` config backed by shared
  `createRedactor()` in `_internal/redact.ts`; default deny pattern scrubs
  `apiKey`, `authorization`, `token`, `password`, etc. from logs, span
  attributes, and exporter payloads (OTel + Langfuse).
- Session / trace / memory identifiers now use `randomBytes(16)` /
  `randomUUID()` via `_internal/ids.ts` — replaces `Math.random()` and
  `Date.now()`-based IDs that were enumerable and hijackable.
- `MemoryStore.fs-io` validates entry IDs against `^[A-Za-z0-9_-]{1,128}$`
  and asserts post-join path containment — closes path-traversal via
  user-supplied entry ids.
- `_internal/json-schema` validator uses `hasOwnProperty` and rejects
  `__proto__` / `constructor` / `prototype` property names; prevents
  prototype pollution via crafted schemas.
- `guardrails/schema-validator` enforces a configurable `maxJsonBytes`
  (default 1 MiB) before `JSON.parse` to block DoS via oversized content.
- `guardrails/self-healing` clears the regeneration timeout on success;
  prevents event-loop retention under burst load.
- `guardrails/content-filter` broadens ReDoS detection to cover
  overlapping-prefix alternation like `(a|a?)+` and `(a|b|ab)*`.
- `guardrails/rate-limiter` emits `onEviction` when an active bucket is
  dropped (flood-signal), plus optional `bucketMs` time-bucketed counting.
- `guardrails/injection-detector` validates `extraPatterns` via the same
  ReDoS check and bounds the base64 pattern to `{8,1024}`.
- `openai.registerProvider()` requires `https://` (except localhost) and
  refuses to overwrite built-ins without `{ force: true }`.
- `redis.getEntry` no longer auto-deletes corrupt entries (was a victim-
  triggered DoS); `repair()` method added for explicit cleanup.
- RAG retriever cache is scoped by `tenantId` to prevent cross-tenant
  cache poisoning / timing side-channels.
- Orchestrator shared context rejects prototype-polluting keys and
  normalizes Unicode case before `startsWith` policy matching.
- Cost tracker overflows into a synthetic `__overflow__` bucket rather
  than evicting legitimate per-model totals via attacker-controlled keys.
- Trace metadata split into `systemMetadata` / `userMetadata` so
  untrusted callers can't control sampling decisions.

Resource / performance:
- Session `dispose()` always `clearInterval` under try/finally; `evictLRU`
  amortized to run only when over `max + 5% threshold`.
- Agent-loop tool-timeout guarded by a `settled` flag so a racing timer
  can't double-resolve the promise.
- Agent-loop external signal listener removal wrapped in try/catch;
  `JSON.stringify(toolResult)` depth- and size-bounded.
- TraceManager `pendingExports.delete` now in a final `.catch().finally()`
  chain so rejected exports don't leak Set entries.
- TraceManager `endTrace` O(1) removal via secondary index Map.
- Memory store `compact()` uses indexed iteration over a pre-sorted slice
  (was O(n²) shift loop); lazy iteration over `.values()` in the default
  query path (was `Array.from` copy).
- Orchestration `handoff` priority queue uses binary-search insertion
  within priority tiers.
- Orchestration orchestrator event handlers backed by `Set` (O(1)
  unsubscribe) instead of array splice.
- Output-parser caches `JSON.stringify(schema)` via `WeakMap`.
- Ajv package caches compiled validators via bounded LRU (default 256).
- Tiktoken adds `disposeTiktoken()` that calls `.free()` on native
  encoders and clears the cache.

Code quality:
- Fallback-adapter replaces recursive retry with a bounded `for` loop.
- Relay `checkpoint()` / `addArtifact()` route through the same
  optimistic-concurrency guard as `save()`; `lastKnownVersion` is
  advanced on every successful write.
- Fs-store `write()` unlinks the prior entry file when overwriting an
  existing key (was leaking disk space).
- Memory tag-query semantics unified to **OR** across in-memory /
  fs-store / redis backends; new `testkit.ts` conformance suite.
- Langfuse cost-tracker now shares the `KahanSum` helper plus per-model
  / per-trace Maps with core, and exposes an `exceeded` budget branch.
- Agent-loop tool-registry timeout path wraps the race in try/catch so
  counter accounting matches the non-timeout path.
- Middleware `use()` returns an `unsubscribe` function; adds `clear()`.
- Resilient loop `dispose()`s inner AgentLoop between retries.
- CostTracker API documents `getTotalCost()` (recent-window) vs
  `getCostByModel()` (cumulative since start).
- Conversation store gains `maxSessions` / `maxMessagesPerSession` caps.
- Agent pool `acquireAsync` accepts an `AbortSignal` to cancel pending
  acquisitions cleanly.
- JSON-schema regex cache with bounded LRU.

Spec / contract:
- OpenAI adapter extracts `prompt_tokens_details.cached_tokens` into
  `TokenUsage.cacheReadTokens`; non-stream path emits a one-time
  `console.warn` on zero-token responses (matching the stream path).
- Both adapters now merge `params.config.extra` into the provider
  request body (previously silently dropped — a MUST violation of
  `docs/provider-spec.md`).
- Anthropic adapter rethrows stream errors as `HarnessError(PROVIDER_ERROR)`
  when the external signal is not aborted; previously swallowed.
- CLI `ALL_MODULES` / templates include `orchestration` and `rag`.
- Preset `Harness.tokenizer` now exposes custom function/object
  tokenizers (was silently stored but unreachable).
- OTel exporter passes real `harness.startTime` / `harness.endTime` into
  OTel spans (was clocking zero duration); spans fall back to the
  per-trace OTel root context when their direct parent is unavailable,
  so the hierarchy stays connected.
- Docs: PRD / provider-spec / architecture docs corrected for
  `createContextManager`, factory names, `StreamChunk` shape,
  `HarnessError` constructor order, `compress()` return type,
  `DoneReason` variants, Node version, dependency graph.

Observability:
- Logger accepts `correlationId` + `redact`; auto-inherits in child
  loggers.
- TraceManager span events support `severity`.
- Langfuse emits a `budget_exceeded` event when the hard budget is
  crossed; flush errors route through `onExportError` / `logger.error`
  instead of console warn; counters exposed via `getStats()`.
- OTel exporter reports dropped-attribute counter + semconv mapping
  (`cache.hit_ratio`, `cache.miss_ratio`, `cache.latency_ms`).
- RAG pipeline emits per-chunk spans with error status + reason.
- Orchestration message-queue drops emit structured logger warnings.

Docs:
- Per-package `README.md` for every workspace package.
- `LICENSE` (MIT), `CONTRIBUTING.md`, `NOTICE` at repo root.
- `docs/guides/fallback.md` for adapter-failover troubleshooting.
- `docs/architecture/06-observe.md` documents `harness.*` OTel
  attribute conventions and the cache-monitor → semconv mapping.
- `docs/architecture/12-orchestration-multi-agent.md` documents
  delegation cycle detection.
- New examples `examples/observe/cache-monitor-integration.ts` and
  `examples/observe/error-handling.ts`.

Tests:
- +353 tests (3,190 → 3,543). New coverage for redact, secure ID
  generation, guardrail ReDoS expansion, OTel TTL/eviction, Langfuse
  KahanSum + budget-exceeded path, memory conformance, agent-loop
  timeout/signal cleanup, fallback bounded loop, relay concurrency.
- Self-healing exponential-backoff test now uses fake timers (was
  3 s of real wall clock).
- Langfuse PROVIDER_ERROR non-string prompt path covered.
