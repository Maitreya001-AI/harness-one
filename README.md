# harness-one

> Universal primitives for AI agent harness engineering. The hard 30% of harness infrastructure, done once and done right.

## What is Harness Engineering?

An AI agent is **Model + Harness**. The model provides intelligence; the harness provides everything else: context management, tool routing, safety guardrails, observability, memory, evaluation, and session orchestration.

Harness engineering is the discipline of building robust, production-grade infrastructure around LLMs. It is framework-agnostic, model-agnostic, and designed to outlast any single model generation.

## Why harness-one?

- **Framework-agnostic** -- works with any LLM provider (OpenAI, Anthropic, local models) through a simple adapter interface
- **Composable primitives** -- use one module or all twelve; no all-or-nothing framework lock-in
- **Zero runtime dependencies** -- pure TypeScript, nothing to audit or worry about in production
- **Complete coverage** -- addresses all 9 layers of the harness reference architecture in a single, cohesive package, plus RAG, multi-agent orchestration, and more

## Quick Start

```bash
npm install harness-one
```

```typescript
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

// Set up guardrails
const pipeline = createPipeline({
  input: [createInjectionDetector({ sensitivity: 'medium' })],
  failClosed: true,
});

// Create agent loop
const loop = new AgentLoop({
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

## Modules

### harness-one/core -- Agent Loop

The execution engine. Calls your LLM adapter in a loop, dispatches tool calls, and enforces safety valves (max iterations, token budgets, abort signals).

Adapters receive `ChatParams.signal` (an `AbortSignal`) and should forward it to their underlying SDK to cancel in-flight requests when the loop is aborted. `LLMConfig.extra` accepts a `Record<string, unknown>` for provider-specific options that fall outside the standard fields.

`maxConversationMessages` defaults to **200** — the loop automatically trims conversation history once it exceeds this length. Pass `maxConversationMessages: Infinity` to disable.

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
  maxConversationMessages: 200,  // default; trims history automatically
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

```typescript
import { createPromptBuilder, createPromptRegistry } from 'harness-one/prompt';

const builder = createPromptBuilder({ separator: '\n\n' });

// Cacheable layers go first (stable KV-cache prefix)
builder.addLayer({
  name: 'system',
  content: 'You are an expert assistant.',
  priority: 0,
  cacheable: true,
});

// Dynamic layers added after
builder.addLayer({
  name: 'context',
  content: 'User project: {{project}}',
  priority: 10,
  cacheable: false,
});

builder.setVariable('project', 'my-app');
const result = builder.build();
// result.systemPrompt, result.stablePrefixHash, result.metadata
```

### harness-one/context -- Context Engineering

Token budget management with named segments, HEAD/MID/TAIL context packing with automatic trimming, and cache stability analysis across iterations.

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

```typescript
import {
  createPipeline,
  createInjectionDetector,
  createContentFilter,
  createRateLimiter,
  runInput,
  withSelfHealing,
} from 'harness-one/guardrails';

const pipeline = createPipeline({
  input: [
    createInjectionDetector({ sensitivity: 'medium' }),
    createContentFilter({ blocked: ['password'] }),
    createRateLimiter({ max: 10, windowMs: 60_000 }),
  ],
  failClosed: true,
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

When using `harness-one-full`, guardrails are automatically applied inside `harness.run()` — no manual `runInput`/`runOutput` calls required:

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
  },
});

// Guardrails fire automatically — blocked input/output yields an 'error' event
for await (const event of harness.run(messages)) {
  if (event.type === 'error') console.error('Blocked:', event.error.message);
  if (event.type === 'message') console.log(event.message.content);
}
```

### harness-one/observe -- Observability

Structured tracing with spans and exporters, plus token cost tracking with budget alerts.

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
costTracker.recordUsage({ traceId, model: 'claude-3', inputTokens: 1000, outputTokens: 500 });
```

### harness-one/session -- Session Management

Session lifecycle with TTL-based expiry, LRU eviction, exclusive locking, and automatic garbage collection.

```typescript
import { createSessionManager } from 'harness-one/session';

const sm = createSessionManager({
  maxSessions: 100,
  ttlMs: 30 * 60 * 1000,
});

const session = sm.create({ userId: 'alice' });
const accessed = sm.access(session.id);

// Exclusive locking for concurrent safety
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

**File-system store**: `createFileSystemStore` serializes each entry as an individual JSON file. An index file maps keys to IDs. All writes (including `update()`) run inside an in-process index lock that prevents concurrent read-modify-write corruption. Raw I/O is delegated to `fs-io.ts`, keeping the business logic layer testable in isolation.

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
  retirementCondition: 'When models support unlimited context',
  createdAt: '2025-01-01',
});

// Detect metric drift
const detector = createDriftDetector();
detector.setBaseline('ctx-packer', { latencyP50: 12, cacheHitRate: 0.85 });
const drift = detector.check('ctx-packer', { latencyP50: 18, cacheHitRate: 0.72 });

// Enforce architecture rules
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

## harness-one-full — Batteries Included

`harness-one-full` wires all modules and integrations together in a single `createHarness()` call. Install it when you want a fully-configured harness without writing boilerplate.

```bash
npm install harness-one-full @anthropic-ai/sdk
```

**Preferred pattern — inject a pre-built adapter** (`AdapterHarnessConfig`):

```typescript
import { createAnthropicAdapter } from '@harness-one/anthropic';
import { createHarness } from 'harness-one-full';

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
  },
  budget: 5.0,
});
```

**Provider-based shorthand** (still supported):

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { createHarness } from 'harness-one-full';

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

**harness.run() auto-wiring**: guardrails fire on every user message (input) and every assistant message + tool result (output). The `AgentLoop` is created internally with `maxConversationMessages: 200` by default.

```typescript
harness.tools.register(myTool);
for await (const event of harness.run(messages)) {
  if (event.type === 'message') console.log(event.message.content);
  if (event.type === 'error') console.error('Blocked:', event.error.message);
  if (event.type === 'done') break;
}

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
| `langfuse` | `Langfuse` instance | Enables Langfuse trace export and cost tracking |
| `redis` | `Redis` instance | Enables Redis-backed persistent memory |
| `tokenizer` | `'tiktoken'` \| `(text) => number` \| `{ encode }` | Token counting — string enables tiktoken globally; function/object avoids global side-effects |

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

**Event bus deprecation**: `harness.eventBus` is deprecated. Each module exposes its own `onEvent()` subscription (sessions, orchestrator, traces). Use per-module subscriptions for new code.

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
               +------------+
               |  _internal |  (JSON Schema, token estimator, LRU cache)
               +-----+------+
                     |
               +-----+------+
               |    core    |  (types, errors, AgentLoop + traceManager opt.)
               +-----+------+
                     |
     +---------------+---------------+---------------+
     |          |         |          |               |
+----+----+ +---+---+ +---+---+ +----+----+    +-----+------+
| context | | tools | |prompt | |guardrails|   | orchestration|
+---------+ +-------+ +-------+ +-----------+  +----- -------+
                                     |           (AgentPool,
+----------+  +--------+  +-------+  |            Handoff,
|  observe |  | session|  | memory|  |            ContextBoundary,
+----------+  +--------+  +-------+  |            MessageQueue)
                               |
                           +---+---+
                           | fs-io |  (extracted I/O layer)
                           +-------+
+------+    +-------+    +-----+
|  rag |    |  eval |    |evolve|
+------+    +-------+    +------+
```

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
| 9. Evaluation | `eval` | Scorers, quality gates, generator-evaluator, flywheel |
| 10. Evolution | `evolve` | Component registry, drift detection, architecture rules |
| 11. Multi-Agent Orchestration | `orchestration` | AgentPool, Handoff, MessageTransport, ContextBoundary, MessageQueue |
| 12. RAG Pipeline | `rag` | Document loading, chunking, embedding, retrieval, token estimates |

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
