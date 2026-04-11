# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
