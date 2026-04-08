# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

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
