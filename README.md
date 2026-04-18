# harness-one

> Universal primitives for AI agent harness engineering. The hard 30% of harness infrastructure, done once and done right.

**Languages**: **English** (this file) · [中文版 → `README.zh-CN.md`](./README.zh-CN.md)

## What is Harness Engineering?

An AI agent is **Model + Harness**. The model provides intelligence; the harness provides everything else: context management, tool routing, safety guardrails, observability, memory, evaluation, and session orchestration.

Harness engineering is the discipline of building robust, production-grade infrastructure around LLMs. It is framework-agnostic, model-agnostic, and designed to outlast any single model generation.

## Why harness-one?

- **Framework-agnostic** -- works with any LLM provider (OpenAI, Anthropic, local models) through a simple adapter interface
- **Composable primitives** -- use one module or all twelve; no all-or-nothing framework lock-in
- **Zero runtime dependencies** -- pure TypeScript, nothing to audit or worry about in production
- **Complete coverage** -- addresses all 9 layers of the harness reference architecture in a single, cohesive package, plus RAG, multi-agent orchestration, and more

## Quick Start

> **Production users**: prefer `createSecurePreset` over `createHarness`. It
> fail-closed defaults redaction, guardrail pipeline, tool capability limits,
> and `sealProviders()`. See the **Secure preset** section below. All packages
> are pre-release (`0.1.0`, not yet on npm); pin by SHA if you need stability.

Two install paths:

```bash
# À la carte — the core package (tree-shakeable submodules).
npm install harness-one

# Batteries-included preset — core + all integrations wired.
npm install @harness-one/preset @anthropic-ai/sdk
```

### Secure preset (recommended for production)

```ts
import { createSecurePreset } from '@harness-one/preset';
import Anthropic from '@anthropic-ai/sdk';

const harness = createSecurePreset({
  provider: 'anthropic',
  client: new Anthropic({ apiKey: process.env.ANTHROPIC_KEY }),
  model: 'claude-sonnet-4-20250514',
  // guardrailLevel defaults to 'standard' (injection + contentFilter + PII)
});
```

Under the hood:
- `logger` / `traceManager` redact secrets by default
- `langfuseExporter` sanitizes span attributes
- Tool registry defaults to `allowedCapabilities: ['readonly']` (fail-closed);
  tools declaring `network`/`shell` must be widened via
  `createRegistry({ allowedCapabilities: [...] })` or `createPermissiveRegistry()`
- AgentLoop guardrail pipeline is pre-wired (input + output + tool-output hooks)
- OpenAI provider registry is sealed after construction
- `HarnessLifecycle` state machine auto-created with health checks for core components
- `MetricsPort` wired (no-op by default; swap in OTel adapter for real metrics)
- Unified config validation catches typos and invalid values at construction time

**Graceful shutdown** — wire SIGTERM/SIGINT handlers in one call:

```ts
import { createSecurePreset, createShutdownHandler } from '@harness-one/preset';

const harness = createSecurePreset({ ... });
createShutdownHandler(harness, { timeoutMs: 15_000 });
// Now SIGTERM/SIGINT will drain in-flight work and exit cleanly.
```

**Lifecycle & health checks** — query harness readiness (useful for k8s probes):

```ts
const health = await harness.lifecycle.health();
// { state: 'ready', ready: true, components: { traceManager: { status: 'up' }, ... } }
```


### Using `harness-one` directly

Every public API is re-exported from the root entry **and** from its submodule
path. Use whichever fits your tree-shaker:

```typescript
// Root entry — good for prototyping and examples
import {
  AgentLoop,
  createAgentLoop,
  defineTool,
  createRegistry,
  toolSuccess,
  createPipeline,
  createInjectionDetector,
  runInput,
} from 'harness-one';

// Or submodule imports — good for production, better tree-shaking
import { AgentLoop } from 'harness-one/core';
import { defineTool, createRegistry, toolSuccess } from 'harness-one/tools';
import { createPipeline, createInjectionDetector, runInput } from 'harness-one/guardrails';

// Define a tool
const calculator = defineTool<{ a: number; b: number }>({
  name: 'add',
  description: 'Add two numbers',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'number' },
      b: { type: 'number' },
    },
    required: ['a', 'b'],
  },
  execute: async ({ a, b }) => toolSuccess(a + b),
});

// Create tool registry
const registry = createRegistry();
registry.register(calculator);

// Set up guardrails — pipeline entries are {name, guard} objects.
// Built-in factories (createInjectionDetector / createContentFilter / ...) already
// return that shape, so you can pass the factory call directly.
const pipeline = createPipeline({
  input: [createInjectionDetector({ sensitivity: 'medium' })],
  failClosed: true,
});

// Create agent loop — class form or factory form, your choice
const loop = createAgentLoop({
  adapter: yourLLMAdapter, // Implement AgentAdapter interface
  maxIterations: 10,
  onToolCall: registry.handler(),
});

// Run with guardrails
const userInput = 'What is 2 + 3?';
const check = await runInput(pipeline, { content: userInput });

if (check.passed) {
  for await (const event of loop.run([
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: userInput },
  ])) {
    if (event.type === 'message') console.log(event.message.content);
    if (event.type === 'done') break;
  }
}
```

`AgentLoop.run()` is **not re-entrant**: calling it again while a previous call is
still running throws `HarnessError('INVALID_STATE')`. Create one `AgentLoop`
instance per concurrent run, or await the previous run before starting a new one.

## Modules

### harness-one/core -- Agent Loop

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

### harness-one/prompt -- Prompt Engineering

Multi-layer prompt assembly optimized for KV-cache stability, template registry with versioning, multi-stage skill workflows, and progressive disclosure.

Template variable substitution sanitizes values by default (`sanitize: true`) to prevent injection through variable content. The prompt registry validates semver on `register()` and rejects malformed version strings. `SkillEngine` exposes an `onTransition` hook for observing state machine transitions.

```typescript
import { createPromptBuilder, createPromptRegistry, createSkillEngine } from 'harness-one/prompt';

const builder = createPromptBuilder({ separator: '\n\n' });

// Cacheable layers go first (stable KV-cache prefix)
builder.addLayer({
  name: 'system',
  content: 'You are an expert assistant.',
  priority: 0,
  cacheable: true,
});

// Dynamic layers added after; variables are sanitized by default
builder.addLayer({
  name: 'context',
  content: 'User project: {{project}}',
  priority: 10,
  cacheable: false,
  sanitize: true,  // default; strips injection characters from variable values
});

builder.setVariable('project', 'my-app');
const result = builder.build();
// result.systemPrompt, result.stablePrefixHash, result.metadata

// SkillEngine: observe state transitions for debugging / tracing
const engine = createSkillEngine({
  onTransition: ({ from, to, skill, context }) => {
    console.log(`skill ${skill}: ${from} → ${to}`);
  },
});
```

### harness-one/context -- Context Engineering

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

### harness-one/tools -- Tool System

Define tools with JSON Schema validation, register them in a rate-limited registry, and wire directly to the agent loop.

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

### harness-one/guardrails -- Safety & Guardrails

Pipeline of input/output guardrails with fail-closed semantics, built-in detectors for injection and content filtering, rate limiting, and self-healing retry loops.

The injection detector at `sensitivity: 'medium'` includes base64 payload detection. The Unicode homoglyph scanner covers mathematical alphanumeric lookalikes (U+1D400–U+1D467) in addition to standard confusables. Content analysis on payloads larger than 100 KB uses sliding window analysis rather than truncation so no content is silently skipped. User-supplied regex patterns in `createContentFilter` are validated against ReDoS at construction time. `createPipeline` accepts a `maxResults` option (default **1000**) to cap the number of events retained for bounded memory use. `withSelfHealing` uses optimized token estimation internally.

```typescript
import {
  createPipeline,
  createInjectionDetector,
  createContentFilter,
  createRateLimiter,
  runInput,
  withSelfHealing,
} from 'harness-one/guardrails';

// Pipeline entries are {name, guard, timeoutMs?} objects. Built-in factories
// already return {name, guard}, so they can be passed directly. For a custom
// Guardrail function, wrap it with an explicit name:
const customGuard = async (ctx) => ({ action: 'allow' });

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

// Self-healing: retry with LLM when guardrails block
const healed = await withSelfHealing({
  guardrails: [createContentFilter({ blocked: ['secret'] })],
  buildRetryPrompt: (content, failures) => `Rewrite: ${failures[0].reason}`,
  regenerate: async (prompt) => callLLM(prompt),
}, initialContent);
```

#### Auto-wiring in createHarness()

When using `@harness-one/preset`, guardrails are automatically applied inside `harness.run()` — no manual `runInput`/`runOutput` calls required. Each guardrail check also emits a child span on the `harness.run` trace (`guardrail:input`, `guardrail:output`, `guardrail:tool-args`, `guardrail:tool-result`) so blocked requests are auditable post-hoc.

- **Input guardrails** run on every `user` role message before the agent loop starts.
- **Output guardrails** run on every `assistant` message and every `tool_result` yielded by the loop.

Configure them in `createHarness()`:

```typescript
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

### harness-one/observe -- Observability

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

### harness-one/session -- Session Management

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

### harness-one/memory -- Memory & Persistence

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

### harness-one/eval -- Evaluation & Validation

Evaluation runner with built-in scorers (relevance, faithfulness, length), custom scorers, quality gates, generator-evaluator loops, and data flywheel extraction.

```typescript
import {
  createEvalRunner,
  createRelevanceScorer,
  createLengthScorer,
  runGeneratorEvaluator,
} from 'harness-one/eval';

const runner = createEvalRunner({
  scorers: [createRelevanceScorer(), createLengthScorer({ minTokens: 10, maxTokens: 200 })],
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
```

### harness-one/evolve -- Continuous Evolution

Component registry with model assumptions and retirement conditions, drift detection for tracking metric changes, architecture rule enforcement, and taste-coding registries for institutional knowledge.

The drift detector supports configurable zero-baseline thresholds so metrics that start at zero do not produce false positives. The architecture checker uses exact path-segment matching (not substring matching) to avoid false positive rule violations. `ValidationResult` includes an `unsupportedKeywords` array when a JSON Schema contains keywords the validator does not implement. The data flywheel uses length-prefix encoding in its hashing scheme to prevent hash collisions across different input shapes. Component retirement conditions support AND clauses for multi-condition gates.

```typescript
import {
  createComponentRegistry,
  createDriftDetector,
  createArchitectureChecker,
  noCircularDepsRule,
  layerDependencyRule,
} from 'harness-one/evolve';

// Track components and their model assumptions
const registry = createComponentRegistry();
registry.register({
  id: 'ctx-packer',
  name: 'Context Packer',
  description: 'Packs messages into context window',
  modelAssumption: 'Models have limited context windows',
  // AND clause: all conditions must be true before retirement is suggested
  retirementCondition: { all: ['Models support unlimited context', 'Cost is negligible'] },
  createdAt: '2025-01-01',
});

// Detect metric drift — zeroThreshold avoids false positives for metrics starting at 0
const detector = createDriftDetector({ zeroThreshold: 0.01 });
detector.setBaseline('ctx-packer', { latencyP50: 12, cacheHitRate: 0.85 });
const drift = detector.check('ctx-packer', { latencyP50: 18, cacheHitRate: 0.72 });

// Enforce architecture rules (exact path-segment matching)
const checker = createArchitectureChecker();
checker.addRule(noCircularDepsRule(['core', 'context', 'tools']));
checker.addRule(layerDependencyRule({
  core: [],
  context: ['core'],
  tools: ['core'],
}));
```

### harness-one/orchestration -- Multi-Agent Orchestration

Manage multiple agents with hierarchical or peer-to-peer communication, shared context, delegation strategies, and lifecycle events. Includes AgentPool, Handoff protocol, ContextBoundary, and MessageQueue.

```typescript
import {
  createOrchestrator,
  createRoundRobinStrategy,
  createAgentPool,
  createHandoff,
  createContextBoundary,
} from 'harness-one/orchestration';
import { AgentLoop } from 'harness-one/core';

// Orchestrator — agent registration, routing, delegation
const orch = createOrchestrator({
  mode: 'hierarchical',
  strategy: createRoundRobinStrategy(),
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
import type { MessageTransport } from 'harness-one/orchestration';

const transport: MessageTransport = {
  send(msg) { myEventBus.publish(msg); },
};
const handoff = createHandoff(transport);
```

### harness-one/rag -- RAG Pipeline

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
  createFixedSizeChunking,
  createParagraphChunking,
  createSlidingWindowChunking,
} from 'harness-one/rag';

// Fixed character size with optional overlap
const fixedChunking = createFixedSizeChunking({ chunkSize: 512, overlap: 64 });

// Split on double newlines; sub-split oversized paragraphs
const paraChunking = createParagraphChunking({ maxChunkSize: 500 });

// Overlapping sliding windows
const slidingChunking = createSlidingWindowChunking({ windowSize: 300, stepSize: 150 });
```

**Full pipeline** — wire all stages together:

```typescript
import {
  createTextLoader,
  createParagraphChunking,
  createInMemoryRetriever,
  createRAGPipeline,
} from 'harness-one/rag';

const pipeline = createRAGPipeline({
  loader: createTextLoader([
    'TypeScript is a typed superset of JavaScript.',
    'Harness engineering builds infrastructure around LLMs.',
  ]),
  chunking: createParagraphChunking({ maxChunkSize: 500 }),
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
const retriever = createInMemoryRetriever({ embedding: myModel });
await retriever.indexScoped(tenantAChunks, 'tenant-a');
await retriever.indexScoped(tenantBChunks, 'tenant-b');

// Tenant A only sees their own chunks:
const results = await retriever.retrieve('query', { tenantId: 'tenant-a', limit: 5 });
```

## Feature Maturity

Not all features are at the same maturity level. This table clarifies what's production-ready vs. what requires additional work.

| Feature | Maturity | Notes |
|---------|----------|-------|
| Agent Loop (core) | Production | Token budget, abort, streaming, tool timeout |
| Adapters (anthropic, openai) | Production | Full chat + streaming support |
| Tool System | Production | Schema validation, rate limiting, namespacing |
| Guardrails Pipeline | Production | Fail-closed, PII detection, injection detection |
| Self-Healing Guardrails | Production | Retry with exponential backoff |
| Observability (tracing, spans) | Production | Langfuse, OpenTelemetry exporters |
| Cost Tracking | Production | Model pricing, budget alerts, auto-stop |
| Memory System | Production | In-memory, file-system, Redis backends |
| Session Management | Production | TTL, LRU eviction, locking |
| Evaluation Framework | Production | Scorers, quality gates, generator-evaluator |
| RAG Pipeline | Production | Loaders, chunking, in-memory retriever |
| Prompt Engineering | Production | Builder, registry, skill engine |
| Context Engineering | Production | Budget, packing, compression, checkpoints |
| Multi-Agent Orchestration | Production | Agent pool, handoff, context boundaries |
| Fallback Adapter | Production | Circuit-breaker with mutual exclusion |
| Circuit Breaker | Production | Prevents cascade failures when LLM provider is down |
| Graceful Shutdown | Production | SIGTERM/SIGINT → drain → dispose handler |
| Failure Taxonomy | Monitoring | Classifies failures; requires manual action |
| Drift Detection | Advisory | Detects metric drift; no auto-remediation |
| Component Registry | Tracking | Tracks retirement conditions; no CI enforcement |
| Progressive Disclosure | Manual | Requires explicit `advance()` calls |
| Context Boundaries | Advisory | Access control is advisory, not enforced |
| Data Flywheel (eval) | Passive | Extracts low-score cases; manual re-eval |
| Resilient Loop | New | Outer retry with fresh context (REQ-015) |
| Dataset Export | New | Trace-to-JSONL for fine-tuning (REQ-018) |

## @harness-one/preset — Batteries Included

> Previously scaffolded as `harness-one-full`. Renamed to
> `@harness-one/preset` to match the rest of the `@harness-one/*`
> integration scope. See `.changeset/rename-preset.md` for the
> rename trail — runtime behavior is unchanged.

`@harness-one/preset` wires all modules and integrations together in a single
`createHarness()` call. Install it when you want a fully-configured harness
without writing boilerplate.

```bash
npm install @harness-one/preset @anthropic-ai/sdk
```

**Preferred pattern — inject a pre-built adapter** (`AdapterHarnessConfig`):

```typescript
import { createAnthropicAdapter } from '@harness-one/anthropic';
import { createHarness } from '@harness-one/preset';

const adapter = createAnthropicAdapter({
  client: anthropicClient,
  model: 'claude-sonnet-4-20250514',
});

const harness = createHarness({
  adapter,  // no provider/client fields needed
  maxIterations: 20,
  guardrails: {
    injection: { sensitivity: 'medium' },
    rateLimit: { max: 10, windowMs: 60_000 },
    pii: true,  // auto-wires PII detector via guardrails.pii config
  },
  budget: 5.0,         // REQUIRED for production — see warning below
  pricing: [{ model: 'claude-sonnet-4-20250514', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 }],
});
```

> **Heads-up**: when `budget` is omitted, `createHarness()` logs a one-time
> warning — token usage is otherwise unbounded. Always set `budget` in
> production. Similarly, `harness.run(messages)` without `{ sessionId }`
> logs a one-time warning: the default `"default"` session is unsafe when
> multiple concurrent `run()` calls share a harness instance.

**Provider-based shorthand** (still supported):

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { createHarness } from '@harness-one/preset';

// HarnessConfig is a discriminated union keyed by `provider`.
// TypeScript narrows the required `client` field by provider.
const harness = createHarness({
  provider: 'anthropic',
  client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  model: 'claude-sonnet-4-20250514',
  maxIterations: 20,
  guardrails: {
    injection: { sensitivity: 'medium' },
    rateLimit: { max: 10, windowMs: 60_000 },
  },
  budget: 5.0,
});
```

**harness.run() auto-wiring**: guardrails fire on every user message (input) and every assistant message + tool result (output). Tool call arguments are also validated against input guardrails before execution. The `AgentLoop` is created internally with `maxConversationMessages: 200` by default, and the shared `traceManager` is passed through so every iteration / tool call / guardrail check shows up as a span in your configured exporter.

```typescript
harness.tools.register(myTool);

// Always pass a per-request sessionId in multi-tenant servers.
// Concurrent run() calls to the same session will interleave messages;
// pass distinct sessionIds to isolate conversation histories.
for await (const event of harness.run(messages, { sessionId: userId })) {
  if (event.type === 'message') console.log(event.message.content);
  if (event.type === 'error') console.error('Blocked:', event.error.message);
  if (event.type === 'done') break;
}

// shutdown() allows up to 5 seconds per exporter for graceful flush.
// flush() / dispose() wait for pending span/trace exports.
await harness.shutdown();
```

**Provider variants**:

```typescript
// OpenAI
import OpenAI from 'openai';
const harness = createHarness({
  provider: 'openai',
  client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  model: 'gpt-4o',
});
```

**Optional integrations** (pass pre-configured clients to enable):

| Field | Type | Effect |
|-------|------|--------|
| `langfuse` | `Langfuse` instance | Enables Langfuse trace export and cost tracking; generation detection prioritizes explicit `harness.span.kind` attribute |
| `redis` | `Redis` instance | Enables Redis-backed persistent memory |
| `tokenizer` | `'tiktoken'` \| `(text) => number` \| `{ encode }` | Token counting — string enables tiktoken globally; function/object avoids global side-effects |

**Integration package notes**:

- **OpenAI adapter** (`@harness-one/openai`): `stream()` forwards `temperature`, `topP`, and `stopSequences` from `LLMConfig` to the underlying API call.
- **AJV validator** (`@harness-one/ajv`): async `validate()` awaits format plugin loading before validating, preventing a race condition where format keywords were silently ignored on the first call.
- **Langfuse** (`@harness-one/langfuse`): span kind detection checks the explicit `harness.span.kind` attribute first before falling back to heuristics.
- **OpenTelemetry** (`@harness-one/opentelemetry`): when a parent span is evicted from the active-spans map before a child span finishes, the parent's context is preserved for correct child linking.

**Observability auto-wiring**: pass a `traceManager` to `AgentLoop` directly if you need per-iteration and per-tool spans without managing traces manually:

```typescript
import { createTraceManager, createConsoleExporter } from 'harness-one/observe';
import { AgentLoop } from 'harness-one/core';

const tm = createTraceManager({ exporters: [createConsoleExporter()] });
const loop = new AgentLoop({
  adapter,
  traceManager: tm, // creates trace on run(), span per iteration, child span per tool call
});
```

**Event bus removal** (Wave-5C): `harness.eventBus` was a dead stub and has been **removed** entirely. Each module exposes its own `onEvent()` subscription (sessions, orchestrator, traces); use those for new code.

**AgentLoop class + factory coexist**: both `new AgentLoop(...)` and `createAgentLoop()` are first-class — pick whichever you prefer. The factory form is the style used across the rest of the `createX()` surface.

**Harness.initialize()** — optional warmup that pre-initialises exporters and tokenizers behind an idempotent latch. `harness.run()` still works without it but may pay a cold-start latency on the first call.

**harness-one/essentials removed** (Wave-5C): the curated `harness-one/essentials` subpath has been removed as redundant with the trimmed root barrel. Import the symbols you need directly from `harness-one` or the relevant submodule (`harness-one/core`, `harness-one/observe`, …).

**Root barrel trimmed to 19 symbols** (Wave-5C): the unscoped `harness-one` root now re-exports only the 19 curated user-journey value symbols. Other factories (`createEventBus`, `toSSEStream`, `categorizeAdapterError`, …) live on subpaths only. **`createSecurePreset` is no longer re-exported from the root** — import it directly from `@harness-one/preset`. See [`CHANGELOG.md`](./CHANGELOG.md) for the full inventory.

**`HarnessErrorCode` is closed and module-prefixed** (Wave-5C): `HarnessError.code` is no longer widened with `(string & {})` and members renamed (`UNKNOWN` → `CORE_UNKNOWN`, `MAX_ITERATIONS` → `CORE_MAX_ITERATIONS`, `GUARDRAIL_VIOLATION` → `GUARD_VIOLATION`, etc.). Adapter-specific codes use `HarnessErrorCode.ADAPTER_CUSTOM` + `details.adapterCode`. Always **value-import** (`import { HarnessErrorCode }`) — `import type` silently breaks `Object.values()`; the lint rule `harness-one/no-type-only-harness-error-code` catches this. Full rename mapping in [`CHANGELOG.md`](./CHANGELOG.md).

**`@harness-one/cli` and `@harness-one/devkit` extracted** (Wave-5C): the `harness-one/cli` subpath moved to [`@harness-one/cli`](./packages/cli) (use `pnpm dlx @harness-one/cli init` or install locally). `harness-one/eval` and `harness-one/evolve` moved to [`@harness-one/devkit`](./packages/devkit); the runtime architecture-rule engine remains in core under `harness-one/evolve-check`.

**Trust-boundary typing + multi-tenant Redis** (Wave-5E): `SystemMessage` carries an optional `_trust` brand minted by `createTrustedSystemMessage()` from `harness-one/core`; restored messages without the brand are downgraded to `user` so a session-store write cannot elevate authority. `RedisStoreConfig.tenantId` is required for multi-tenant deployments (one-shot warn if defaulted) — keys flip to `prefix:{tenantId}:id`. Memory entries enforce a 1 MiB content / 16 KiB metadata cap and reserve `_version`/`_trust` keys. `createContextBoundary` rejects policy prefixes without a trailing `.`/`/`. `HandoffManager.createSendHandle(from)` mints sealed sender handles; payloads cap at 64 KiB / depth 16. Tool schemas declaring `additionalProperties: false` are now actually enforced. Per-chunk RAG context scanning ships as `runRagContext` from `harness-one/guardrails`.

**Adapter logger + crypto IDs + unref timers** (Wave-5F): `@harness-one/anthropic` / `@harness-one/openai` / `@harness-one/ajv` / `@harness-one/redis` now route their default logger through core's redaction-enabled `createDefaultLogger()` (no more bare `console.warn`). `@harness-one/langfuse` inline warnings flow through `safeWarn`. `harness-one/context` checkpoint IDs use `prefixedSecureId('cp')` (crypto.randomBytes); trace sampling uses `crypto.randomInt`. The new `harness-one/infra` `unrefTimeout` / `unrefInterval` helpers replace the ad-hoc `.unref?.()` pattern. `@harness-one/preset` pricing validation rejects NaN/Infinity alongside negatives.

**MetricsPort + lifecycle state machine + AdmissionController** (Wave-5D first pass): three vendor-neutral primitives shipping on subpaths.

```ts
import {
  createNoopMetricsPort,         // counter / gauge / histogram facade — wire an OTel bridge in your host
  createHarnessLifecycle,        // init → ready → draining → shutdown + aggregated `health()`
} from 'harness-one/observe';

import { createAdmissionController } from 'harness-one/infra';

const metrics = createNoopMetricsPort();
const lifecycle = createHarnessLifecycle();
lifecycle.registerHealthCheck('adapter', () => ({ status: 'up' }));
lifecycle.markReady();

const admission = createAdmissionController({ maxInflight: 64, defaultTimeoutMs: 5000 });
await admission.withPermit('tenant-123', async () => {
  // adapter call — automatically respects per-tenant inflight cap, fails closed on timeout
  return harness.run(messages);
});
```

The four bigger 5D items — `CostTracker` consolidation, conversation-store reconciler, Redis-backed cross-process token bucket, and demoting `@harness-one/langfuse` to a secondary `TraceExporter` — are deferred to **5D.1** pending PRD + ADR competition.

**AgentLoopHook** — pass an array of hooks in `AgentLoopConfig.hooks` to receive `onIterationStart` / `onToolCall` / `onTokenUsage` / `onIterationEnd` callbacks without subscribing to `AgentEvent`. Hook errors are swallowed through the injected logger and never break the loop.

All auto-configured components can be replaced by passing the explicit override field (`adapter`, `exporters`, `memoryStore`, `schemaValidator`).

## CLI Tool

Scaffold harness-one boilerplate into your project with a single command:

```bash
npx harness-one init          # Interactive -- choose which modules to scaffold
npx harness-one init --all    # Generate boilerplate for all available modules
npx harness-one init --modules core,tools,guardrails
npx harness-one audit         # Scan project for harness-one usage and coverage gaps
```

The `init` command creates working starter files in a `harness/` directory. The `audit` command scans your codebase for `harness-one/*` imports and reports a maturity assessment.

## Architecture

### Module Dependency Graph

```
                    +-----------+
                    |   infra   |  <- JSON Schema, IDs, LRU, async-lock, timers, safe-log,
                    +-----+-----+      AdmissionController (Wave-5D)
                          |
                    +-----+-----+
                    |   core    |  <- shared types + AgentLoop + HarnessError(Code)
                    +-----+-----+      + TrustedSystemMessage helpers (Wave-5E)
                          |
  +--------+--------+-----+-----+--------+--------+--------+--------+----------------+---------------+
  |        |        |     |     |        |        |        |        |                |               |
  v        v        v     v     v        v        v        v        v                v               v
context  prompt   tools   guardrails  observe  session  memory    rag    evolve-check       orchestration
                                       |                  |
                                       v                  v
                              MetricsPort +            fs-io
                              HarnessLifecycle
                              (Wave-5D)
```

Sibling packages (extracted from core in Wave-5C):

```
@harness-one/cli      <- harness-one CLI binary (was `harness-one/cli`)
@harness-one/devkit   <- eval + evolve dev-tools (was `harness-one/eval` + `/evolve`)
@harness-one/preset   <- batteries-included `createSecurePreset` / `createHarness`
```

Dependency rules (enforced by `harness-one/evolve-check`):

1. `infra/` -> no dependencies (leaf module)
2. `core/` -> only `infra/`
3. Every feature module -> only `core/` + `infra/` (mostly type-only imports)
4. Feature modules never import each other (`context`, `tools`, `guardrails`, `prompt`, etc. are siblings)
5. Sibling packages depend on `harness-one` as a regular or peer dep; never the reverse

### Key Design Decisions

- **Function-first API** -- factory functions (`createRegistry()`, `createBudget()`) over classes for composability
- **JSON Schema validation** -- tool parameters validated against JSON Schema at runtime
- **Fail-closed guardrails** -- errors in guardrails block by default (opt into fail-open)
- **Errors as feedback** -- tool errors are serialized back to the LLM for self-correction; stack traces are stripped so internal implementation details are never leaked to the model
- **Immutable data** -- `Object.freeze()` on all returned structures to prevent accidental mutation
- **Zero dependencies** -- pure TypeScript with only `node:fs`, `node:path`, and `node:readline` for the CLI

## 12+ Layer Reference Architecture

| Layer | Module | Purpose |
|-------|--------|---------|
| 1. Agent Loop | `core` | LLM calling, tool dispatch, safety valves, optional traceManager |
| 2. Prompt Engineering | `prompt` | Multi-layer assembly, KV-cache optimization, skills |
| 3. Context Engineering | `context` | Token budgets, packing, cache stability |
| 4. Tool System | `tools` | Definition, validation, registry, rate limiting |
| 5. Safety & Guardrails | `guardrails` | Input/output filtering, injection detection, auto-wired in createHarness() |
| 6. Observability | `observe` | Tracing, spans, cost tracking, budget alerts |
| 7. Session Management | `session` | TTL, LRU eviction, locking, garbage collection |
| 8. Memory & Persistence | `memory` | Graded storage, sessionId filter, atomic fs writes, cross-context relay |
| 9. Evaluation | `@harness-one/devkit` (since Wave-5C) | Scorers, quality gates, generator-evaluator, flywheel |
| 10. Evolution | `@harness-one/devkit` + `harness-one/evolve-check` (split in Wave-5C) | Component registry, drift detection (devkit) + architecture rules (core) |
| 11. Multi-Agent Orchestration | `orchestration` | AgentPool, Handoff (sealed `SendHandle` + 64 KiB cap, Wave-5E), MessageTransport, ContextBoundary (segment-aware, Wave-5E), MessageQueue |
| 12. RAG Pipeline | `rag` + `runRagContext` (Wave-5E) | Document loading, chunking, embedding, retrieval, token estimates, per-chunk guardrail scanning |

## Troubleshooting

- **Fallback adapter never recovers to primary** — by design. The breaker advances one-way. See [`docs/guides/fallback.md`](./docs/guides/fallback.md) for periodic-reset and active-health-check patterns.
- **Fallback switched but I have no logs** — there is no `adapter_switched` event on `AgentLoop`. Wrap each inner adapter to log via `categorizeAdapterError()`; see `examples/observe/error-handling.ts`.
- **All adapter errors classified as `ADAPTER_ERROR`** — `categorizeAdapterError()` inspects `err.message`, not `.code`. Ensure your provider SDK surfaces readable messages, or classify upstream.
- **Guardrails don't block in tests** — `createPipeline({ failClosed: true })` blocks *on error*; explicit `block` verdicts still require the guard to match. Use `sensitivity: 'high'` on `createInjectionDetector` to widen coverage.
- **Costs reported as 0** — the model has no registered pricing. Enable `warnUnpricedModels: true` (default) on `createCostTracker` and watch for the one-time warning.
- **Cache-hit metrics always 0** — the adapter isn't forwarding `cacheReadTokens` / `cacheWriteTokens`. Check the adapter's `toTokenUsage()` mapping.

More runbooks in [`docs/guides/`](./docs/guides/).

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Write tests first (TDD): `npm run test:watch`
4. Ensure all checks pass: `npm run typecheck && npm test && npm run lint`
5. Submit a pull request

### Development

```bash
npm install          # Install dev dependencies
npm test             # Run all tests
npm run test:watch   # Watch mode
npm run typecheck    # Type checking
npm run build        # Build with tsup
npm run lint         # ESLint
```

## License

MIT
