# harness-one Integration Examples

These examples fall into two buckets:

1. **External-dep integrations** — plug in a popular SDK through a harness-one
   interface. External deps never leak past the integration file.
2. **Subsystem quickstarts** — show how to use a harness-one primitive on its
   own, no third-party SDK required.

All files typecheck via `pnpm -C examples typecheck` (see `TYPECHECK.md`).

## Pattern

Every integration follows the same shape:

1. Import the **harness-one interface** (e.g., `AgentAdapter`, `TraceExporter`).
2. Import the **external SDK** (e.g., `@anthropic-ai/sdk`, `ioredis`).
3. Write a function returning an object satisfying the interface.
4. Pass it to the relevant harness-one factory.

## External-dep integrations

| File | Interface | External Package |
|------|-----------|-----------------|
| [`adapters/anthropic-adapter.ts`](adapters/anthropic-adapter.ts) | `AgentAdapter` | `@anthropic-ai/sdk` |
| [`adapters/openai-adapter.ts`](adapters/openai-adapter.ts) | `AgentAdapter` | `openai` |
| [`observe/langfuse-exporter.ts`](observe/langfuse-exporter.ts) | `TraceExporter` | `langfuse` |
| [`observe/opentelemetry-exporter.ts`](observe/opentelemetry-exporter.ts) | `TraceExporter` | `@opentelemetry/api` |
| [`context/tiktoken-tokenizer.ts`](context/tiktoken-tokenizer.ts) | `Tokenizer` | `tiktoken` |
| [`memory/redis-store.ts`](memory/redis-store.ts) | `MemoryStore` | `ioredis` |
| [`memory/vector-store.ts`](memory/vector-store.ts) | `MemoryStore` + `searchByVector` | `@pinecone-database/pinecone` |
| [`eval/llm-judge-scorer.ts`](eval/llm-judge-scorer.ts) | `Scorer` | `@anthropic-ai/sdk` |
| [`guardrails/llm-injection-detector.ts`](guardrails/llm-injection-detector.ts) | `Guardrail` | `@anthropic-ai/sdk` |
| [`tools/ajv-validator.ts`](tools/ajv-validator.ts) | `SchemaValidator` | `ajv` |
| [`prompt/langfuse-prompt-backend.ts`](prompt/langfuse-prompt-backend.ts) | `PromptBackend` | `langfuse` |
| [`full-stack-demo.ts`](full-stack-demo.ts) | All of the above + AgentLoop | `@anthropic-ai/sdk` + `langfuse` + `tiktoken` |

## Subsystem quickstarts

Each file stands alone — no external SDK needed.

| File | Covers |
|------|--------|
| [`preset/secure-preset.ts`](preset/secure-preset.ts) | `createSecurePreset` — production entry with fail-closed defaults |
| [`session/session-manager.ts`](session/session-manager.ts) | `createSessionManager` + `ConversationStore` + lock/TTL/GC |
| [`rag/custom-pipeline.ts`](rag/custom-pipeline.ts) | `createRAGPipeline` — loader → chunking → embedding → retrieve |
| [`evolve-check/architecture-rules.ts`](evolve-check/architecture-rules.ts) | `createArchitectureChecker` + cycle + layer + custom rule |
| [`prompt/builder-skills-disclosure.ts`](prompt/builder-skills-disclosure.ts) | `PromptBuilder` + `PromptRegistry` + `SkillEngine` + `DisclosureManager` |
| [`context/budget-pack-compress.ts`](context/budget-pack-compress.ts) | `createBudget` + `packContext` + `compress` + `compactIfNeeded` |
| [`redact/redactor.ts`](redact/redactor.ts) | `createRedactor` + `redactValue` + `sanitizeAttributes` |
| [`advanced/middleware-chain.ts`](advanced/middleware-chain.ts) | `createMiddlewareChain` — onion retry / timing / logging |
| [`advanced/sse-stream.ts`](advanced/sse-stream.ts) | `toSSEStream` / `formatSSE` — HTTP SSE transport |
| [`advanced/resilient-loop.ts`](advanced/resilient-loop.ts) | `createResilientLoop` — outer retry + summarize-on-fail |
| [`resilience/fallback-adapter.ts`](resilience/fallback-adapter.ts) | `createFallbackAdapter` — cross-provider circuit breaker |
| [`resilience/checkpoint-manager.ts`](resilience/checkpoint-manager.ts) | `createCheckpointManager` — snapshot / restore conversation state |
| [`guardrails/pii-detector.ts`](guardrails/pii-detector.ts) | `createPIIDetector` (5th built-in, Wave-25) |
| [`guardrails/self-healing.ts`](guardrails/self-healing.ts) | `withSelfHealing` — block → retry-with-feedback |
| [`observe/cache-monitor.ts`](observe/cache-monitor.ts) | `createCacheMonitor` — KV-cache hit rate tracking |
| [`observe/cache-monitor-integration.ts`](observe/cache-monitor-integration.ts) | Cache monitor wired around a RAG query cache |
| [`observe/failure-taxonomy.ts`](observe/failure-taxonomy.ts) | `createFailureTaxonomy` — classify failures from Trace |
| [`observe/error-handling.ts`](observe/error-handling.ts) | Tool / guardrail / fallback failure reporting |
| [`orchestration/multi-agent.ts`](orchestration/multi-agent.ts) | `createAgentPool` + `createHandoff` + `createContextBoundary` |
| [`evolve/component-registry-drift-taste.ts`](evolve/component-registry-drift-taste.ts) | `ComponentRegistry` + `DriftDetector` + `TasteCodingRegistry` (devkit) |
| [`eval/generator-evaluator-flywheel.ts`](eval/generator-evaluator-flywheel.ts) | `runGeneratorEvaluator` + batch `EvalRunner` + `extractNewCases` (devkit) |
| [`infra/admission-control.ts`](infra/admission-control.ts) | `createAdmissionController` + `unrefTimeout` / `unrefInterval` — per-tenant backpressure + non-blocking timers |

## Quick Start

```bash
# Typecheck all examples
pnpm -C examples typecheck

# Install the external packages you need (not declared in examples/package.json)
pnpm add @anthropic-ai/sdk

# Run a single example
npx tsx examples/preset/secure-preset.ts
```

## Interface Summary

| harness-one Interface | Module | Injection Point |
|----------------------|--------|-----------------|
| `AgentAdapter` | `harness-one/core` | `createAgentLoop({ adapter })` |
| `TraceExporter` | `harness-one/observe` | `createTraceManager({ exporters: [...] })` |
| `Tokenizer` | `harness-one/context` | `registerTokenizer(model, tokenizer)` |
| `MemoryStore` | `harness-one/memory` | `createRelay({ store })`, direct usage |
| `Scorer` | `@harness-one/devkit` | `createEvalRunner({ scorers: [...] })` |
| `Guardrail` | `harness-one/guardrails` | `createPipeline({ input: [...] })` |
| `SchemaValidator` | `harness-one/tools` | `createRegistry({ validator })` |
| `PromptBackend` | `harness-one/prompt` | `createAsyncPromptRegistry(backend)` |
| `EmbeddingModel` / `Retriever` | `harness-one/rag` | `createRAGPipeline({ embedding, retriever })` |
| `MessageTransport` | `harness-one/orchestration` | `createHandoff(transport)` |
| `ArchitectureRule` | `harness-one/evolve-check` | `createArchitectureChecker().addRule(rule)` |

## Notes

- These are **examples** — not compiled into the published packages.
- No runtime dependencies added to any published `package.json`.
- All imports use harness-one subpath exports (`harness-one/core`,
  `harness-one/advanced`, `@harness-one/preset`, …).
- Each file is self-contained and can be copied into your project.
