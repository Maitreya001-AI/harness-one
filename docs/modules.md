# Modules — public API reference

> English module reference for `harness-one` and the `@harness-one/*`
> sibling packages. The Chinese counterparts in
> [`docs/architecture/`](./architecture/) cover internal architecture
> and design rationale; this file covers the **consumer-facing API**
> exposed by each subpath.

For the import-path cheatsheet (which subpath owns which symbol), see
[`docs/guides/import-paths.md`](./guides/import-paths.md).

## harness-one/core -- Agent Loop

The execution engine. Calls your LLM adapter in a loop, dispatches tool calls, and enforces safety valves (max iterations, token budgets, abort signals).

Adapters receive `ChatParams.signal` (an `AbortSignal`) and should forward it to their underlying SDK to cancel in-flight requests when the loop is aborted. `LLMConfig.extra` accepts a `Record<string, unknown>` for provider-specific options that fall outside the standard fields.

`maxConversationMessages` defaults to **200** — the loop automatically trims conversation history once it exceeds this length, always preserving all leading system messages. Pass `maxConversationMessages: Infinity` to disable.

`maxStreamBytes` (default **10 MB**) caps the total bytes consumed from a single streaming response. `maxToolArgBytes` (default **5 MB**) caps the byte length of any individual tool-call argument payload. Both prevent unbounded memory growth from runaway streams or malformed tool calls.

Pass an optional `traceManager` to get automatic observability: one trace per `run()`, one span per iteration, child spans per tool call.

```typescript
import { AgentLoop } from 'harness-one/core';
import type { AgentAdapter, Message } from 'harness-one/core';

const adapter: AgentAdapter = {
  async chat({ messages }) {
    // Your LLM call here
    return {
      message: { role: 'assistant', content: 'Hello!' },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  },
};

const loop = new AgentLoop({
  adapter,
  maxIterations: 10,
  maxTotalTokens: 100_000,
  maxConversationMessages: 200,  // default; trims history, preserving system messages
  maxStreamBytes: 10_485_760,    // default 10 MB; caps streaming response size
  maxToolArgBytes: 5_242_880,    // default 5 MB; caps tool argument payload size
  onToolCall: async (call) => ({ result: `Executed ${call.name}` }),
  traceManager: myTraceManager,  // optional; auto-creates spans
});

const messages: Message[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Hi' },
];

for await (const event of loop.run(messages)) {
  if (event.type === 'message') console.log(event.message.content);
  if (event.type === 'done') console.log('Reason:', event.reason);
}
```

## harness-one/prompt -- Prompt Engineering

Multi-layer prompt assembly optimized for KV-cache stability, template registry with versioning, stateless skill registries, and progressive disclosure.

Template variable substitution sanitizes values by default (`sanitize: true`) to prevent injection through variable content. The prompt registry validates semver on `register()` and rejects malformed version strings. `SkillRegistry` stores immutable skill definitions, renders cacheable skills first, and validates declared tool requirements before runtime.

```typescript
import { createPromptBuilder, createSkillRegistry } from 'harness-one/prompt';

// Builder-wide variable sanitization is default-on (sanitize: true);
// pass `sanitize: false` here to allow raw variable content.
const builder = createPromptBuilder({ separator: '\n\n' });

// Cacheable layers go first (stable KV-cache prefix)
builder.addLayer({
  name: 'system',
  content: 'You are an expert assistant.',
  priority: 0,
  cacheable: true,
});

// Dynamic layers added after; variables substituted at build time.
builder.addLayer({
  name: 'context',
  content: 'User project: {{project}}',
  priority: 10,
  cacheable: false,
});

builder.setVariable('project', 'my-app');
const result = builder.build();
// result.systemPrompt, result.stablePrefixHash, result.metadata

const skills = createSkillRegistry();
skills.register({
  id: 'planner',
  description: 'Planning instructions',
  content: 'Plan before acting. Use search before drafting.',
  requiredTools: ['search'],
});

const rendered = skills.render(['planner']);
const validation = skills.validate(['planner'], ['search']);
// rendered.content, rendered.stableHash, validation.valid
```

## harness-one/context -- Context Engineering

Token budget management with named segments, HEAD/MID/TAIL context packing with automatic trimming, and cache stability analysis across iterations.

The `truncate` compression strategy always retains at least the final message so the conversation is never left empty. The sliding window compressor uses an optimized 2-Set implementation for O(1) eviction.

```typescript
import { createBudget, packContext, analyzeCacheStability } from 'harness-one/context';
import type { Message } from 'harness-one/core';

const budget = createBudget({
  totalTokens: 4096,
  segments: [
    { name: 'system', maxTokens: 500, reserved: true },
    { name: 'history', maxTokens: 3000, trimPriority: 1 },
    { name: 'recent', maxTokens: 596, trimPriority: 0 },
  ],
});

const packed = packContext({
  head: [{ role: 'system', content: 'You are helpful.' }],
  mid: conversationHistory,
  tail: [{ role: 'user', content: 'Latest message' }],
  budget,
});
// packed.messages, packed.truncated, packed.usage
```

## harness-one/tools -- Tool System

Define tools with JSON Schema validation, register them in a rate-limited registry, and wire directly to the agent loop.

<!-- noverify -->
```typescript
import { defineTool, createRegistry, toolSuccess, toolError } from 'harness-one/tools';

const readFile = defineTool<{ path: string }>({
  name: 'readFile',
  description: 'Read a file from disk',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  execute: async ({ path }) => {
    // Your implementation
    return toolSuccess(`Contents of ${path}`);
  },
});

const registry = createRegistry({ maxCallsPerTurn: 10 });
registry.register(readFile);

// Wire to AgentLoop
const loop = new AgentLoop({
  adapter,
  onToolCall: registry.handler(),
});
```

## harness-one/guardrails -- Safety & Guardrails

Pipeline of input/output guardrails with fail-closed semantics, built-in detectors for injection and content filtering, rate limiting, and self-healing retry loops.

The injection detector at `sensitivity: 'medium'` includes base64 payload detection. The Unicode homoglyph scanner covers mathematical alphanumeric lookalikes (U+1D400–U+1D467) in addition to standard confusables. Content analysis on payloads larger than 100 KB uses sliding window analysis rather than truncation so no content is silently skipped. User-supplied regex patterns in `createContentFilter` are validated against ReDoS at construction time. `createPipeline` accepts a `maxResults` option (default **1000**) to cap the number of events retained for bounded memory use. `withGuardrailRetry` uses optimized token estimation internally.

```typescript
import {
  createPipeline,
  createInjectionDetector,
  createContentFilter,
  createRateLimiter,
  runInput,
  withGuardrailRetry,
} from 'harness-one/guardrails';
import type { Guardrail } from 'harness-one/guardrails';

// Pipeline entries are {name, guard, timeoutMs?} objects. Built-in factories
// already return {name, guard}, so they can be passed directly. For a custom
// Guardrail function, wrap it with an explicit name. Annotate the function as
// `Guardrail` so the verdict tagged union resolves (allow | block | modify).
const customGuard: Guardrail = async (ctx) => ({ action: 'allow' });

const pipeline = createPipeline({
  input: [
    createInjectionDetector({ sensitivity: 'medium' }), // includes base64 detection
    createContentFilter({ blocked: ['password'] }),      // regex validated against ReDoS
    createRateLimiter({ max: 10, windowMs: 60_000 }),
    { name: 'custom', guard: customGuard },              // custom guard: wrap in {name, guard}
  ],
  failClosed: true,
  maxResults: 1000,  // default; caps retained events
});

const result = await runInput(pipeline, { content: userMessage });
if (!result.passed) {
  console.log('Blocked:', result.verdict);
}

// Guardrail retry: regenerate when guardrails block
const healed = await withGuardrailRetry({
  guardrails: [createContentFilter({ blocked: ['secret'] })],
  buildRetryPrompt: (content, failures) => `Rewrite: ${failures[0].reason}`,
  regenerate: async (prompt) => callLLM(prompt),
}, initialContent);
```

### Auto-wiring in createHarness()

When using `@harness-one/preset`, guardrails are automatically applied inside `harness.run()` — no manual `runInput`/`runOutput` calls required. Each guardrail check also emits a child span on the `harness.run` trace (`guardrail:input`, `guardrail:output`, `guardrail:tool-args`, `guardrail:tool-result`) so blocked requests are auditable post-hoc.

- **Input guardrails** run on every `user` role message before the agent loop starts.
- **Output guardrails** run on every `assistant` message and every `tool_result` yielded by the loop.

Configure them in `createHarness()`:

```typescript
import { createHarness } from '@harness-one/preset';

const harness = createHarness({
  provider: 'anthropic',
  client: anthropicClient,
  model: 'claude-sonnet-4-20250514',
  guardrails: {
    injection: { sensitivity: 'medium' }, // or true for defaults
    rateLimit: { max: 10, windowMs: 60_000 },
    contentFilter: { blocked: ['confidential'] }, // applied to output
    pii: true,  // auto-wires PII detector; or { redact: true } for redaction mode
  },
});

// Guardrails fire automatically — blocked input/output yields an 'error' event
// Tool call arguments are also validated against input guardrails before execution
for await (const event of harness.run(messages)) {
  if (event.type === 'error') console.error('Blocked:', event.error.message);
  if (event.type === 'message') console.log(event.message.content);
}
```

## harness-one/observe -- Observability

Structured tracing with spans and exporters, plus token cost tracking with budget alerts. Trace eviction uses a try-finally guard so the `isEvicting` flag is always released even if an exporter throws.

`costTracker.updateUsage(traceId, partialUsage)` updates the most recent record for a given `traceId` with new token totals for streaming responses — call `recordUsage()` once at the start of the stream, then `updateUsage()` as larger token counts arrive; cost is recomputed from the merged totals.

```typescript
import {
  createTraceManager,
  createConsoleExporter,
  createCostTracker,
} from 'harness-one/observe';

const tm = createTraceManager({
  exporters: [createConsoleExporter({ verbose: false })],
});

const traceId = tm.startTrace('request', { userId: 'alice' });
const spanId = tm.startSpan(traceId, 'llm-call');
tm.setSpanAttributes(spanId, { model: 'claude-3' });
tm.endSpan(spanId);
tm.endTrace(traceId);

const costTracker = createCostTracker({
  pricing: [{ model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 }],
  budget: 10.0,
});

costTracker.onAlert((alert) => console.warn(alert.message));

// Streaming: record the initial usage for a traceId, then apply incremental
// updates as more tokens arrive. updateUsage(traceId, partialUsage) locates
// the most recent record for that traceId and merges new token counts in,
// recomputing cost from the merged totals (not a delta).
costTracker.recordUsage({ traceId, model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
costTracker.updateUsage(traceId, { outputTokens: 12 });  // per chunk / incremental
costTracker.updateUsage(traceId, { outputTokens: 500 }); // final total for the stream
```

## harness-one/session -- Session Management

Session lifecycle with TTL-based expiry, LRU eviction, exclusive locking, and automatic garbage collection. LRU eviction skips sessions that are currently locked (with a safety counter to prevent infinite loops). Auth context stored on a session is deep-frozen recursively, not just at the top level, preventing accidental mutation of nested objects.

```typescript
import { createSessionManager } from 'harness-one/session';

const sm = createSessionManager({
  maxSessions: 100,
  ttlMs: 30 * 60 * 1000,
});

const session = sm.create({ userId: 'alice' });
const accessed = sm.access(session.id);

// Exclusive locking for concurrent safety
// LRU eviction will skip this session until unlocked
const { unlock } = sm.lock(session.id);
try {
  // Critical section
} finally {
  unlock();
}

sm.dispose(); // Clean up GC timer
```

## harness-one/memory -- Memory & Persistence

Graded memory storage (critical/useful/ephemeral) with compaction, file-system persistence, and cross-context relay for session handoff between agent contexts.

```typescript
import { createInMemoryStore, createFileSystemStore, createRelay } from 'harness-one/memory';

const store = createInMemoryStore();
// Or for persistence: createFileSystemStore({ directory: './memory' })

await store.write({
  key: 'user-pref',
  content: 'Prefers TypeScript',
  grade: 'critical',
  tags: ['preference'],
  metadata: { sessionId: 'sess_abc123' }, // tag entries with session
});

// sessionId filter: retrieve only entries belonging to a specific session
const results = await store.query({ sessionId: 'sess_abc123', limit: 10 });
await store.compact({ maxEntries: 1000, maxAge: 86400000 });

// Cross-context relay for agent handoff
const relay = createRelay({ store });
await relay.save({
  progress: { step: 3 },
  artifacts: ['src/index.ts'],
  checkpoint: 'v1',
  timestamp: Date.now(),
});
```

**Vector stores**: `write()` validates that the dimension of any provided embedding vector matches the store's configured dimension; a `HarnessError` is thrown on mismatch rather than silently storing an incompatible vector.

**File-system store**: `createFileSystemStore` serializes each entry as an individual JSON file. An index file maps keys to IDs. `update()` performs a full read-modify-write cycle inside the index lock for atomicity — partial updates never leave the store in an inconsistent state. Raw I/O is delegated to `fs-io.ts`, keeping the business logic layer testable in isolation.

## @harness-one/devkit -- Evaluation & Validation

Evaluation runner with starter scorers (relevance, faithfulness, length),
custom scorers, quality gates, generator-evaluator loops, and data-flywheel
extraction.

```typescript
import {
  createEvalRunner,
  createBasicRelevanceScorer,
  createBasicFaithfulnessScorer,
  createBasicLengthScorer,
  runGeneratorEvaluator,
  extractNewCases,
} from '@harness-one/devkit';

const runner = createEvalRunner({
  scorers: [
    createBasicRelevanceScorer(),
    createBasicFaithfulnessScorer(),
    createBasicLengthScorer({ minTokens: 10, maxTokens: 200 }),
  ],
  passThreshold: 0.7,
  overallPassRate: 0.8,
});

const report = await runner.run(
  [{ id: 'q1', input: 'What is TypeScript?' }],
  async (input) => callLLM(input),
);

const gate = runner.checkGate(report);
if (!gate.passed) process.exit(1); // CI quality gate

// Generator-Evaluator pattern
const result = await runGeneratorEvaluator({
  generate: async (input) => callLLM(input),
  evaluate: async (input, output) => ({
    pass: output.length > 20,
    feedback: 'Too short',
  }),
}, 'Explain closures');

const newCases = extractNewCases(report, { scoreThreshold: 0.5, maxNewCases: 5 });
```

## @harness-one/devkit + harness-one/evolve-check -- Continuous Evolution

Component registry with model assumptions and retirement conditions, drift
detection for tracking metric changes, architecture rule enforcement, and
taste-coding registries for institutional knowledge.

The drift detector supports configurable zero-baseline thresholds so metrics
that start at zero do not produce false positives. The architecture checker
uses exact path-segment matching (not substring matching) to avoid false
positive rule violations. `ValidationResult` includes an
`unsupportedKeywords` array when a JSON Schema contains keywords the validator
does not implement. The data flywheel uses length-prefix encoding in its
hashing scheme to prevent hash collisions across different input shapes.
Component retirement conditions support AND clauses for multi-condition gates.

```typescript
import {
  createComponentRegistry,
  createDriftDetector,
  createTasteCodingRegistry,
} from '@harness-one/devkit';
import {
  createArchitectureChecker,
  noCircularDepsRule,
  layerDependencyRule,
} from 'harness-one/evolve-check';

// Track components and their model assumptions
const registry = createComponentRegistry();
registry.register({
  id: 'ctx-packer',
  name: 'Context Packer',
  description: 'Packs messages into context window',
  modelAssumption: 'Models have limited context windows',
  // DSL expression evaluated against `registry.validate(id, context)`
  retirementCondition: 'contextWindow > 1000000',
  createdAt: '2025-01-01',
});

// Detect metric drift — `zeroBaselineThresholds` keeps tiny deltas from
// flagging as drift when the baseline is 0 (ratio is undefined there).
const detector = createDriftDetector({ zeroBaselineThresholds: { low: 1, medium: 10 } });
detector.setBaseline('ctx-packer', { latencyP50: 12, cacheHitRate: 0.85 });
const drift = detector.check('ctx-packer', { latencyP50: 18, cacheHitRate: 0.72 });

// Encode postmortem rules as a reviewable rulebook
const taste = createTasteCodingRegistry();
taste.addRule({
  id: 'validate-json-boundaries',
  pattern: 'JSON.parse(',
  rule: 'Validate parsed JSON before narrowing it into domain types.',
  enforcement: 'lint',
  createdFrom: 'Corrupt persistence payload incident',
  createdAt: '2025-01-01',
});

// Enforce architecture rules (exact path-segment matching)
const checker = createArchitectureChecker();
checker.addRule(noCircularDepsRule(['core', 'context', 'tools']));
checker.addRule(layerDependencyRule({
  core: [],
  context: ['core'],
  tools: ['core'],
}));
```

## harness-one/orchestration -- Multi-Agent Orchestration

Manage multiple agents with hierarchical or peer-to-peer communication, shared context, delegation strategies, and lifecycle events. Includes AgentPool, Handoff protocol, ContextBoundary, and MessageQueue.

```typescript
import {
  createOrchestrator,
  createBasicRoundRobinStrategy,
  createAgentPool,
  createHandoff,
  createContextBoundary,
} from 'harness-one/orchestration';
import { AgentLoop } from 'harness-one/core';

// Orchestrator — agent registration, routing, delegation
const orch = createOrchestrator({
  mode: 'hierarchical',
  strategy: createBasicRoundRobinStrategy(),
  maxAgents: 10,
});

orch.register('coordinator', 'Coordinator');
orch.register('researcher', 'Researcher', { parentId: 'coordinator' });

orch.context.set('topic', 'AI safety');
orch.send({ from: 'coordinator', to: 'researcher', type: 'request', content: 'Find papers on RLHF' });

// AgentPool — lifecycle management for reusable AgentLoop instances
const pool = createAgentPool({
  factory: (role) => new AgentLoop({ adapter }),
  min: 2,    // keep 2 agents warm
  max: 10,   // hard cap
  idleTimeout: 60_000,
});

const agent = pool.acquire('researcher');
// ... use agent.loop
pool.release(agent);
console.log(pool.stats); // { idle, active, total, created, recycled }
await pool.drain();      // wait for all active agents to be released

// Handoff — structured inter-agent messaging
// Accepts any MessageTransport (AgentOrchestrator satisfies this interface)
const handoff = createHandoff(orch);
const receipt = handoff.send('coordinator', 'researcher', {
  summary: 'Research RLHF papers',
  artifacts: [{ type: 'url', content: 'https://...', label: 'survey' }],
  acceptanceCriteria: ['At least 5 papers', 'Include 2024 publications'],
});

const payload = handoff.receive('researcher'); // FIFO dequeue
const { passed, violations } = handoff.verify(receipt.id, output, myVerifier);

// ContextBoundary — advisory access control on SharedContext
const boundary = createContextBoundary(orch.context, [
  { agent: 'planner', allowWrite: ['plan.'], denyWrite: ['config.'] },
  { agent: 'worker',  allowRead: ['plan.', 'shared.'], denyWrite: ['plan.'] },
]);

const workerView = boundary.forAgent('worker');
workerView.get('plan.step');      // allowed
workerView.set('plan.step', 2);   // throws BOUNDARY_WRITE_DENIED
```

**MessageTransport interface**: `createHandoff` accepts any object with a `send(message)` method — the full orchestrator, a custom pub/sub channel, or a test double all work equally.

```typescript
import { createHandoff } from 'harness-one/orchestration';
import type { MessageTransport } from 'harness-one/orchestration';

const transport: MessageTransport = {
  send(msg) { myEventBus.publish(msg); },
};
const handoff = createHandoff(transport);
```

## harness-one/rag -- RAG Pipeline

Document loading, chunking, embedding, and retrieval pipeline with built-in strategies, in-memory vector search, deduplication, and token-count estimates on results.

**Loaders** — convert raw data into `Document` objects:

```typescript
import { createTextLoader, createDocumentArrayLoader } from 'harness-one/rag';

// From string array
const loader = createTextLoader(['Doc A', 'Doc B'], { source: 'my-corpus' });

// From pre-built Document objects
const loader2 = createDocumentArrayLoader([
  { id: 'custom-1', content: 'Pre-built doc', metadata: { version: 2 } },
]);
```

**Chunking strategies** — split documents into indexable pieces:

```typescript
import {
  createBasicFixedSizeChunking,
  createBasicParagraphChunking,
  createBasicSlidingWindowChunking,
} from 'harness-one/rag';

// Fixed character size with optional overlap
const fixedChunking = createBasicFixedSizeChunking({ chunkSize: 512, overlap: 64 });

// Split on double newlines; sub-split oversized paragraphs
const paraChunking = createBasicParagraphChunking({ maxChunkSize: 500 });

// Overlapping sliding windows
const slidingChunking = createBasicSlidingWindowChunking({ windowSize: 300, stepSize: 150 });
```

**Full pipeline** — wire all stages together:

```typescript
import {
  createTextLoader,
  createBasicParagraphChunking,
  createInMemoryRetriever,
  createRAGPipeline,
} from 'harness-one/rag';

const pipeline = createRAGPipeline({
  loader: createTextLoader([
    'TypeScript is a typed superset of JavaScript.',
    'Harness engineering builds infrastructure around LLMs.',
  ]),
  chunking: createBasicParagraphChunking({ maxChunkSize: 500 }),
  embedding: myEmbeddingModel,     // implement EmbeddingModel interface
  retriever: createInMemoryRetriever({ embedding: myEmbeddingModel }),
  maxChunks: 10_000,               // optional capacity cap
  onWarning: ({ type, message }) => console.warn(type, message),
});

// Ingest: load → chunk → deduplicate → embed → index
const { documents, chunks } = await pipeline.ingest();

// Or ingest pre-loaded documents directly (skips loader step)
await pipeline.ingestDocuments([{ id: 'd1', content: '...' }]);

// Query: embed query → cosine similarity → top-k
// Each result includes `tokens` (heuristic: content.length / 4)
const results = await pipeline.query('What is harness engineering?', { limit: 3 });
for (const { chunk, score, tokens } of results) {
  console.log(`[${score.toFixed(2)}] ~${tokens} tokens: ${chunk.content.slice(0, 80)}`);
}
```

`RetrievalResult.tokens` gives a token estimate so you can stay within your context budget when injecting retrieved chunks into a prompt.

**Multi-tenant isolation** (SEC-010): use `indexScoped()` and `tenantId` / `scope` options to prevent cross-tenant data leakage:

```typescript
import { createInMemoryRetriever } from 'harness-one/rag';

const retriever = createInMemoryRetriever({ embedding: myModel });
await retriever.indexScoped(tenantAChunks, 'tenant-a');
await retriever.indexScoped(tenantBChunks, 'tenant-b');

// Tenant A only sees their own chunks:
const results = await retriever.retrieve('query', { tenantId: 'tenant-a', limit: 5 });
```
