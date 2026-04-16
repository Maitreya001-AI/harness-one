---
'@harness-one/core': patch
'@harness-one/anthropic': patch
'@harness-one/openai': patch
'@harness-one/langfuse': patch
'@harness-one/opentelemetry': patch
'@harness-one/preset': patch
'@harness-one/tiktoken': patch
---

Wave-12 — 62 production-grade architecture fixes driven by a six-angle deep
research pass (concurrency, error handling, API design, performance,
observability, tests).

Highlights: `agent-pool.pendingQueue` bounded + `POOL_QUEUE_FULL`,
circuit-breaker half-open probe mutex, streaming `string[]` buffers (no more
quadratic concat), in-place conversation prune, guarded stream-controller
narrow (no unsafe double-casts), 5xx `ADAPTER_UNAVAILABLE` classification,
`adapterTimeoutMs` on non-streaming chat, Langfuse `pendingFlushes` +
`dispose(timeoutMs)`, OTel TTL-free parent retention, `flushTimeoutMs`,
tail-sampling hook, logger `getContext()` + path-sanitized stack traces,
preset `onSessionId` callback, deeply-`readonly` guardrails config, OpenAI
`{allowOverride}` + `WeakMap` schema memo, Anthropic `onMalformedToolUse`
option, sse-stream serialization guard, cost-tracker alert dedupe window,
property tests for backoff/LRU/tokenizer invariants.

Non-breaking. See CHANGELOG.md and `docs/forge-fix/wave-12/research-report.md`
for the full list.
