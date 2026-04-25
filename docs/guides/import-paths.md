# Import-path cheatsheet

Not sure which subpath owns a symbol? This table covers the 95% cases.

The **root barrel** (`'harness-one'`) re-exports 18 curated value symbols;
everything else is on a submodule path only. Types are re-exported
liberally from the root (zero runtime cost).

| Subpath | Key exports (factories in bold) |
|---|---|
| `'harness-one'` (root) | **`createAgentLoop`**, **`AgentLoop`**, **`createResilientLoop`**, **`createMiddlewareChain`**, **`createPipeline`**, **`createTraceManager`**, **`createCostTracker`**, **`createLogger`**, **`createSessionManager`**, **`defineTool`**, **`createRegistry`**, **`disposeAll`**, `HarnessError`, `HarnessErrorCode`, `MaxIterationsError`, `AbortedError`, `ToolValidationError`, `TokenBudgetExceededError` |
| `harness-one/core` | `AgentLoop`, `AgentAdapter`, `Message`, `ChatParams`, `ChatResponse`, `AgentEvent`, `createTrustedSystemMessage` |
| `harness-one/advanced` | **`createMiddlewareChain`**, **`createResilientLoop`**, **`createFallbackAdapter`**, **`toSSEStream`**, **`categorizeAdapterError`**, **`StreamAggregator`**, `createJsonOutputParser`, `createSequentialStrategy`, `createParallelStrategy`, `pruneConversation`, `computeBackoffMs` |
| `harness-one/tools` | **`defineTool`**, **`createRegistry`**, **`toolSuccess`**, **`toolError`**, `ToolMiddleware` |
| `harness-one/guardrails` | **`createPipeline`**, **`createInjectionDetector`**, **`createContentFilter`**, **`createRateLimiter`**, **`createSchemaValidator`**, **`createPIIDetector`**, **`withGuardrailRetry`**, **`runRagContext`**, `runInput`, `runOutput` |
| `harness-one/observe` | **`createTraceManager`**, **`createCostTracker`**, **`createLogger`**, **`createFailureTaxonomy`**, **`createCacheMonitor`**, **`createHarnessLifecycle`**, **`createNoopMetricsPort`**, `MetricsPort`, `InstrumentationPort`, `TraceExporter` |
| `harness-one/session` | **`createSessionManager`**, **`createInMemoryConversationStore`**, `AuthContext` |
| `harness-one/memory` | **`createInMemoryStore`**, **`createFsMemoryStore`**, **`createRelay`**, **`runMemoryStoreConformance`** |
| `harness-one/context` | **`createBudget`**, **`packContext`**, **`compress`**, **`compactIfNeeded`**, **`registerTokenizer`**, **`countTokens`** |
| `harness-one/prompt` | **`createPromptBuilder`**, **`createPromptRegistry`**, **`createSkillRegistry`**, **`createAsyncSkillRegistry`**, **`createDisclosureManager`** |
| `harness-one/orchestration` | **`createOrchestrator`**, **`createAgentPool`**, **`createHandoff`**, **`createContextBoundary`**, **`createMessageQueue`** |
| `harness-one/rag` | **`createRAGPipeline`**, **`createInMemoryRetriever`**, **`runRetrieverConformance`**, **`runEmbeddingModelConformance`**, **`runChunkingStrategyConformance`** |
| `harness-one/redact` | **`createRedactor`**, **`redactValue`**, **`sanitizeAttributes`**, `REDACTED_VALUE`, `DEFAULT_SECRET_PATTERN` |
| `harness-one/infra` | **`createAdmissionController`**, **`unrefTimeout`**, **`unrefInterval`** |
| `harness-one/evolve-check` | **`createArchitectureChecker`**, `noCircularDepsRule`, `layerDependencyRule` |
| `harness-one/testing` | Mock adapters: **`createMockAdapter`**, **`createFailingAdapter`**, **`createStreamingMockAdapter`**, **`createErrorStreamingMockAdapter`**. Chaos injection: **`createChaosAdapter`**, **`createSeededRng`**. Cassette record/replay: **`recordCassette`**, **`createCassetteAdapter`**, **`loadCassette`**, **`computeKey`**, **`fingerprint`**. Adapter contract suite: **`createAdapterContractSuite`**, **`CONTRACT_FIXTURES`**, **`cassetteFileName`**, **`contractFixturesHandle`**. **Test-only**, never import from production code |
| `@harness-one/preset` | **`createSecurePreset`**, **`createHarness`**, **`createShutdownHandler`** |
| `@harness-one/devkit` | **`createEvalRunner`**, **`createBasicRelevanceScorer`**, **`createComponentRegistry`**, **`createDriftDetector`** |
| `@harness-one/cli` | **`parseInitArgs`**, **`renderTemplates`** (library form of the `harness-one` binary) |
| `@harness-one/anthropic` / `@harness-one/openai` | Provider `AgentAdapter` factories |
| `@harness-one/ajv` / `@harness-one/tiktoken` | `SchemaValidator` / `Tokenizer` providers |
| `@harness-one/redis` / `@harness-one/langfuse` / `@harness-one/opentelemetry` | `MemoryStore` / `TraceExporter` providers |

When in doubt, import from the root — types and the 18 curated factories
resolve cleanly. Drop to a subpath only for tree-shaking or when the root
doesn't carry the value (e.g. `toSSEStream` lives on `/advanced`).

## Worked example — root + subpath mix

<!-- noverify -->
```typescript
import { createAgentLoop } from 'harness-one';
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
