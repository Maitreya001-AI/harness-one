/**
 * Template generation for CLI scaffolding.
 *
 * @module
 */

import type { ModuleName } from './parser.js';

export function getTemplate(mod: ModuleName): string {
  return TEMPLATES[mod];
}

const TEMPLATES: Record<ModuleName, string> = {
  core: `import { AgentLoop } from 'harness-one/core';
import type { AgentAdapter, Message } from 'harness-one/core';

// 1. Create an adapter for your LLM provider
const adapter: AgentAdapter = {
  async chat({ messages }) {
    // Replace with your actual LLM call (OpenAI, Anthropic, etc.)
    const lastMessage = messages[messages.length - 1];
    return {
      message: { role: 'assistant', content: \`Echo: \${lastMessage.content}\` },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  },
};

// 2. Create the agent loop with safety valves
const loop = new AgentLoop({
  adapter,
  maxIterations: 10,
  maxTotalTokens: 100_000,
  onToolCall: async (call) => {
    // Route tool calls to your tool registry
    return { result: \`Executed \${call.name}\` };
  },
});

// 3. Run the loop
const messages: Message[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello!' },
];

for await (const event of loop.run(messages)) {
  if (event.type === 'message') console.log('Assistant:', event.message.content);
  if (event.type === 'tool_call') console.log('Tool call:', event.toolCall.name);
  if (event.type === 'done') console.log('Done:', event.reason);
}
`,

  prompt: `import { createPromptBuilder, createPromptRegistry } from 'harness-one/prompt';

// 1. Build multi-layer prompts with KV-cache optimization
const builder = createPromptBuilder({ separator: '\\n\\n' });

builder.addLayer({
  name: 'system',
  content: 'You are an expert coding assistant.',
  priority: 0,
  cacheable: true, // Stable prefix for KV-cache hits
});

builder.addLayer({
  name: 'tools',
  content: 'Available tools: readFile, writeFile, search',
  priority: 1,
  cacheable: true,
});

builder.addLayer({
  name: 'user-context',
  content: 'The user is working on project: {{project}}',
  priority: 10,
  cacheable: false, // Dynamic content
});

builder.setVariable('project', 'harness-one');

const result = builder.build();
console.log('System prompt:', result.systemPrompt);
console.log('Cache hash:', result.stablePrefixHash);

// 2. Template registry with versioning
const registry = createPromptRegistry();

registry.register({
  id: 'greeting',
  version: '1.0',
  content: 'Hello {{name}}, welcome to {{project}}!',
  variables: ['name', 'project'],
});

const greeting = registry.resolve('greeting', { name: 'Alice', project: 'harness-one' });
console.log(greeting);
`,

  context: `import { createBudget, packContext, analyzeCacheStability } from 'harness-one/context';
import type { Message } from 'harness-one/core';

// 1. Set up token budget with named segments
const budget = createBudget({
  totalTokens: 4096,
  responseReserve: 1000,
  segments: [
    { name: 'system', maxTokens: 500, reserved: true },
    { name: 'history', maxTokens: 2000, trimPriority: 1 },
    { name: 'recent', maxTokens: 596, trimPriority: 0 },
  ],
});

console.log('System remaining:', budget.remaining('system'));
console.log('Needs trimming:', budget.needsTrimming());

// 2. Pack context with HEAD/MID/TAIL layout
const systemMsg: Message = { role: 'system', content: 'You are helpful.' };
const history: Message[] = [
  { role: 'user', content: 'What is TypeScript?' },
  { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript.' },
];
const latest: Message = { role: 'user', content: 'Tell me more.' };

const packed = packContext({
  head: [systemMsg],
  mid: history,
  tail: [latest],
  budget,
});

console.log('Packed messages:', packed.messages.length);
console.log('Truncated:', packed.truncated);

// 3. Analyze cache stability between iterations
const v1: Message[] = [systemMsg, ...history];
const v2: Message[] = [systemMsg, { role: 'user', content: 'Different question' }];
const report = analyzeCacheStability(v1, v2);
console.log('Cache prefix match:', report.prefixMatchRatio);
console.log('Recommendations:', report.recommendations);
`,

  tools: `import { defineTool, createRegistry, toolSuccess, toolError } from 'harness-one/tools';

// 1. Define tools with JSON Schema validation
const calculator = defineTool<{ a: number; b: number; op: string }>({
  name: 'calculator',
  description: 'Perform basic arithmetic',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'number', description: 'First operand' },
      b: { type: 'number', description: 'Second operand' },
      op: { type: 'string', enum: ['add', 'sub', 'mul', 'div'], description: 'Operation' },
    },
    required: ['a', 'b', 'op'],
  },
  execute: async ({ a, b, op }) => {
    switch (op) {
      case 'add': return toolSuccess(a + b);
      case 'sub': return toolSuccess(a - b);
      case 'mul': return toolSuccess(a * b);
      case 'div': return b !== 0 ? toolSuccess(a / b) : toolError('Division by zero', 'validation');
      default: return toolError(\`Unknown op: \${op}\`, 'validation');
    }
  },
});

// 2. Create a registry with rate limiting
const registry = createRegistry({ maxCallsPerTurn: 5 });
registry.register(calculator);

// 3. Execute tool calls (validates input automatically)
const result = await registry.execute({
  id: 'call-1',
  name: 'calculator',
  arguments: JSON.stringify({ a: 10, b: 3, op: 'add' }),
});
console.log('Result:', result);

// 4. Wire to AgentLoop via handler()
const handler = registry.handler();
// Pass \`handler\` as onToolCall to AgentLoop
`,

  guardrails: `import {
  createPipeline,
  createInjectionDetector,
  createContentFilter,
  createRateLimiter,
  runInput,
  runOutput,
  withSelfHealing,
} from 'harness-one/guardrails';

// 1. Create guardrails
const injection = createInjectionDetector({ sensitivity: 'medium' });
const filter = createContentFilter({ blocked: ['password', 'secret'] });
const limiter = createRateLimiter({ max: 10, windowMs: 60_000 });

// 2. Assemble pipeline (fail-closed by default)
const pipeline = createPipeline({
  input: [injection, filter, limiter],
  output: [filter],
  failClosed: true,
  onEvent: (event) => {
    console.log(\`[\${event.direction}] \${event.guardrail}: \${event.verdict.action} (\${event.latencyMs.toFixed(1)}ms)\`);
  },
});

// 3. Run guardrails on user input
const inputResult = await runInput(pipeline, { content: 'Hello, can you help me?' });
console.log('Input passed:', inputResult.passed);

// 4. Run guardrails on model output
const outputResult = await runOutput(pipeline, { content: 'Sure, here is your answer.' });
console.log('Output passed:', outputResult.passed);

// 5. Self-healing: auto-retry when guardrails block
const healed = await withSelfHealing({
  maxRetries: 3,
  guardrails: [filter],
  buildRetryPrompt: (content, failures) =>
    \`Rewrite without blocked content. Issues: \${failures.map(f => f.reason).join('; ')}\\nOriginal: \${content}\`,
  regenerate: async (prompt) => {
    // Replace with your LLM call
    return 'Here is a safe response.';
  },
}, 'Response containing password');
console.log('Healed:', healed.passed, 'Attempts:', healed.attempts);
`,

  observe: `import {
  createTraceManager,
  createConsoleExporter,
  createCostTracker,
} from 'harness-one/observe';

// 1. Set up tracing with console exporter
const exporter = createConsoleExporter({ verbose: false });
const tm = createTraceManager({ exporters: [exporter] });

// 2. Trace an agent request
const traceId = tm.startTrace('user-request', { userId: 'alice' });

const llmSpan = tm.startSpan(traceId, 'llm-call');
tm.setSpanAttributes(llmSpan, { model: 'claude-3', tokens: 1500 });
// ... your LLM call here ...
tm.endSpan(llmSpan);

const toolSpan = tm.startSpan(traceId, 'tool-execution');
tm.addSpanEvent(toolSpan, { name: 'tool-start', attributes: { tool: 'calculator' } });
// ... tool execution ...
tm.endSpan(toolSpan);

tm.endTrace(traceId);

// 3. Track costs with budget alerts
const costTracker = createCostTracker({
  pricing: [
    { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    { model: 'gpt-4', inputPer1kTokens: 0.03, outputPer1kTokens: 0.06 },
  ],
  budget: 10.0,
});

costTracker.onAlert((alert) => {
  console.warn(\`Cost alert [\${alert.type}]: \${alert.message}\`);
});

costTracker.recordUsage({
  traceId,
  model: 'claude-3',
  inputTokens: 1000,
  outputTokens: 500,
});

console.log('Total cost:', costTracker.getTotalCost().toFixed(4));
console.log('Cost by model:', costTracker.getCostByModel());
`,

  session: `import { createSessionManager } from 'harness-one/session';

// 1. Create a session manager with TTL and LRU eviction
const sm = createSessionManager({
  maxSessions: 100,
  ttlMs: 30 * 60 * 1000, // 30 minutes
  gcIntervalMs: 60_000,
});

// 2. Listen for session events
sm.onEvent((event) => {
  console.log(\`Session \${event.type}: \${event.sessionId}\`);
});

// 3. Create and access sessions
const session = sm.create({ userId: 'alice', plan: 'pro' });
console.log('Created:', session.id, session.metadata);

const accessed = sm.access(session.id);
console.log('Accessed:', accessed.lastAccessedAt);

// 4. Lock a session for exclusive use (e.g., during writes)
const { unlock } = sm.lock(session.id);
try {
  // Critical section -- session is locked
  console.log('Session locked for exclusive access');
} finally {
  unlock();
}

// 5. List active sessions and run garbage collection
console.log('Active sessions:', sm.activeSessions);
const removed = sm.gc();
console.log('GC removed:', removed, 'expired sessions');

// 6. Clean up when done
sm.dispose();
`,

  memory: `import { createInMemoryStore, createRelay } from 'harness-one/memory';

// 1. Create a memory store
const store = createInMemoryStore();

// 2. Write memories with grades
const critical = await store.write({
  key: 'user-preference',
  content: 'User prefers TypeScript over JavaScript',
  grade: 'critical', // Never auto-compacted
  tags: ['preference', 'language'],
});

await store.write({
  key: 'chat-summary',
  content: 'Discussed project architecture',
  grade: 'useful',
  tags: ['summary'],
});

await store.write({
  key: 'temp-note',
  content: 'User said hello',
  grade: 'ephemeral', // First to be compacted
});

// 3. Query memories
const preferences = await store.query({ tags: ['preference'], limit: 5 });
console.log('Preferences:', preferences.length);

const allUseful = await store.query({ grade: 'useful' });
console.log('Useful memories:', allUseful.length);

// 4. Compact old memories
const compaction = await store.compact({ maxEntries: 10, maxAge: 86400000 });
console.log('Compaction removed:', compaction.removed);

// 5. Cross-context relay for session handoff
const relay = createRelay({ store });

await relay.save({
  progress: { step: 3, status: 'implementing' },
  artifacts: ['src/index.ts', 'src/utils.ts'],
  checkpoint: 'v1',
  timestamp: Date.now(),
});

const state = await relay.load();
console.log('Relay state:', state?.progress);
`,

  eval: `import {
  createEvalRunner,
  createRelevanceScorer,
  createLengthScorer,
  createCustomScorer,
  runGeneratorEvaluator,
} from 'harness-one/eval';

// 1. Set up scorers
const relevance = createRelevanceScorer();
const length = createLengthScorer({ minTokens: 5, maxTokens: 100 });
const politeness = createCustomScorer({
  name: 'politeness',
  description: 'Checks if output is polite',
  scoreFn: async (_input, output) => ({
    score: /please|thank|welcome/i.test(output) ? 1.0 : 0.5,
    explanation: 'Politeness keyword check',
  }),
});

// 2. Create eval runner with pass thresholds
const runner = createEvalRunner({
  scorers: [relevance, length, politeness],
  passThreshold: 0.6,
  overallPassRate: 0.8,
});

// 3. Define test cases
const cases = [
  { id: 'q1', input: 'What is TypeScript?', context: 'TypeScript is a typed language.' },
  { id: 'q2', input: 'Explain async await', context: 'Async/await handles asynchronous code.' },
];

// 4. Run evaluation
const report = await runner.run(cases, async (input) => {
  // Replace with your actual LLM call
  return \`Thank you for asking. \${input} is an important topic in programming.\`;
});

console.log('Pass rate:', (report.passRate * 100).toFixed(1) + '%');
console.log('Average scores:', report.averageScores);

// 5. Quality gate check
const gate = runner.checkGate(report);
console.log('Gate:', gate.passed ? 'PASS' : 'FAIL', gate.reason);

// 6. Generator-Evaluator loop
const result = await runGeneratorEvaluator({
  generate: async (input) => \`Answer about \${input}\`,
  evaluate: async (_input, output) => ({
    pass: output.length > 10,
    feedback: output.length <= 10 ? 'Response too short' : undefined,
  }),
  maxRetries: 3,
}, 'TypeScript generics');

console.log('Generator-Evaluator:', result.passed, 'attempts:', result.attempts);
`,

  orchestration: `import {
  createOrchestrator,
  createAgentPool,
  createHandoff,
  createContextBoundary,
  createRoundRobinStrategy,
  spawnSubAgent,
} from 'harness-one/orchestration';

// 1. Create an orchestrator with a round-robin delegation strategy
const orchestrator = createOrchestrator({
  strategy: createRoundRobinStrategy(),
  mode: 'cooperative',
});

// 2. Register agents
orchestrator.register('agent-a', 'Researcher', { metadata: { role: 'research' } });
orchestrator.register('agent-b', 'Writer', { metadata: { role: 'writing' } });

// 3. Delegate work: strategy picks one of the registered agents
const selected = await orchestrator.delegate({
  id: 'task-1',
  description: 'Summarize the latest findings',
  requiredCapabilities: ['research'],
});
console.log('Delegated to:', selected);

// 4. Pool short-lived sub-agents for bounded concurrency
const pool = createAgentPool({
  maxSize: 4,
  factory: async (id) => ({
    id,
    async run(input: string) {
      return \`Processed: \${input}\`;
    },
  }),
});

const agent = await pool.acquire();
try {
  const result = await agent.run('demo input');
  console.log(result);
} finally {
  await pool.release(agent);
}

// 5. Handoff payload between agents with verification receipts
const handoff = createHandoff();
const receipt = handoff.prepare({
  from: 'agent-a',
  to: 'agent-b',
  artifacts: [{ id: 'doc-1', type: 'document', content: 'Draft' }],
});
console.log('Handoff receipt:', receipt.id);

// 6. Enforce context boundary policies between agents
const boundary = createContextBoundary({
  policies: [
    { agentId: 'agent-b', allowRead: ['draft.'], allowWrite: ['final.'] },
  ],
});
const ctx = boundary.wrap('agent-b', {});
ctx.set('final.result', 'ok');

// 7. Spawn a short-lived subagent with its own boundary
const sub = await spawnSubAgent({
  id: 'sub-1',
  parentId: 'agent-a',
  async run() { return 'done'; },
});
console.log('Sub result:', sub.result);
`,

  rag: `import {
  createRAGPipeline,
  createTextLoader,
  createDocumentArrayLoader,
  createFixedSizeChunking,
  createParagraphChunking,
  createInMemoryRetriever,
} from 'harness-one/rag';
import type { EmbeddingModel } from 'harness-one/rag';

// 1. Bring your own embedding model (wrap any provider SDK)
const embedding: EmbeddingModel = {
  dimensions: 1536,
  async embed(texts) {
    // Replace with your real embedding call (OpenAI, Cohere, etc.)
    return texts.map(() => new Array(1536).fill(0).map(() => Math.random()));
  },
};

// 2. Assemble the pipeline: loader -> chunking -> embedding -> retriever
const pipeline = createRAGPipeline({
  loader: createTextLoader([
    'Retrieval-Augmented Generation combines retrieval with generation.',
    'It grounds LLM answers in your documents.',
  ]),
  chunking: createFixedSizeChunking({ chunkSize: 200, overlap: 20 }),
  embedding,
  retriever: createInMemoryRetriever({ embedding }),
  maxChunks: 10_000,
  validateEmbedding: true,
  onWarning: (w) => console.warn('[rag]', w.type, w.message),
});

// 3. Ingest documents (load -> chunk -> embed -> index)
const { documents, chunks } = await pipeline.ingest();
console.log(\`Ingested \${chunks} chunks from \${documents} documents\`);

// 4. Query and surface relevant chunks with scores
const results = await pipeline.query('what is RAG?', { limit: 3, minScore: 0.2 });
for (const r of results) {
  console.log(\`[score=\${r.score.toFixed(3)}] \${r.chunk.content.slice(0, 80)}...\`);
}

// 5. Observability: per-chunk ingestion metrics
const metrics = pipeline.getIngestMetrics();
console.log('Ingest metrics:', metrics);

// 6. Ingest pre-loaded documents bypassing the loader
await pipeline.ingestDocuments([
  { id: 'doc-custom', content: 'Additional knowledge.', metadata: { source: 'api' } },
]);

// 7. Alternate chunking + custom loader
const paragraphPipeline = createRAGPipeline({
  loader: createDocumentArrayLoader([
    { id: 'multi', content: 'Paragraph one.\\n\\nParagraph two.' },
  ]),
  chunking: createParagraphChunking(),
  embedding,
  retriever: createInMemoryRetriever({ embedding }),
});
await paragraphPipeline.ingest();
`,

  evolve: `import {
  createComponentRegistry,
  createDriftDetector,
  createArchitectureChecker,
  noCircularDepsRule,
  layerDependencyRule,
} from 'harness-one/evolve';

// 1. Register components with model assumptions and retirement conditions
const registry = createComponentRegistry();

registry.register({
  id: 'context-packer',
  name: 'Context Packer',
  description: 'Packs messages into LLM context window',
  modelAssumption: 'Models have limited context windows (128k-200k tokens)',
  retirementCondition: 'When models support unlimited context natively',
  createdAt: '2025-01-01',
  tags: ['context', 'core'],
});

registry.register({
  id: 'injection-detector',
  name: 'Injection Detector',
  description: 'Detects prompt injection attacks',
  modelAssumption: 'Models are vulnerable to prompt injection',
  retirementCondition: 'When models are immune to injection attacks',
  createdAt: '2025-01-01',
  tags: ['security', 'guardrails'],
});

// 2. Check for stale components that need re-validation
const stale = registry.getStale(90); // Not validated in 90 days
console.log('Stale components:', stale.map(c => c.id));

// 3. Drift detection -- track metric changes over time
const detector = createDriftDetector();
detector.setBaseline('context-packer', { latencyP50: 12, cacheHitRate: 0.85 });

const drift = detector.check('context-packer', { latencyP50: 18, cacheHitRate: 0.72 });
console.log('Drift detected:', drift.driftDetected);
console.log('Deviations:', drift.deviations);

// 4. Architecture rule enforcement
const checker = createArchitectureChecker();

checker.addRule(noCircularDepsRule(['core', 'context', 'tools', 'guardrails']));
checker.addRule(layerDependencyRule({
  core: [],
  context: ['core'],
  tools: ['core'],
  guardrails: ['core'],
  observe: ['core'],
}));

const archResult = checker.check({
  files: ['src/core/index.ts', 'src/context/pack.ts', 'src/tools/registry.ts'],
  imports: {
    'src/context/pack.ts': ['src/core/types.ts'],
    'src/tools/registry.ts': ['src/core/types.ts'],
  },
});
console.log('Architecture check passed:', archResult.passed);
if (!archResult.passed) {
  console.log('Violations:', archResult.violations);
}
`,
};

// ── File name mapping ─────────────────────────────────────────────────────────

export const FILE_NAMES: Record<ModuleName, string> = {
  core: 'agent.ts',
  prompt: 'prompt.ts',
  context: 'context.ts',
  tools: 'tools.ts',
  guardrails: 'guardrails.ts',
  observe: 'observe.ts',
  session: 'session.ts',
  memory: 'memory.ts',
  eval: 'eval.ts',
  evolve: 'evolve.ts',
  orchestration: 'orchestration.ts',
  rag: 'rag.ts',
};
