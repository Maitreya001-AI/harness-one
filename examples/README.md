# harness-one Integration Examples

These examples show how to inject external capabilities into harness-one while keeping zero runtime dependencies in the core framework. Each example implements a harness-one interface backed by a popular external library.

## Pattern

Every integration follows the same pattern:

1. Import the **harness-one interface** (e.g., `AgentAdapter`, `TraceExporter`, `MemoryStore`)
2. Import the **external library** (e.g., `@anthropic-ai/sdk`, `langfuse`, `ioredis`)
3. Write a function that returns an object satisfying the interface
4. Pass the object to the relevant harness-one factory function

The external dependency never leaks beyond the integration file.

## Examples

| File | Interface | External Package | Install |
|------|-----------|-----------------|---------|
| [`adapters/anthropic-adapter.ts`](adapters/anthropic-adapter.ts) | `AgentAdapter` | `@anthropic-ai/sdk` | `npm install @anthropic-ai/sdk` |
| [`adapters/openai-adapter.ts`](adapters/openai-adapter.ts) | `AgentAdapter` | `openai` | `npm install openai` |
| [`observe/langfuse-exporter.ts`](observe/langfuse-exporter.ts) | `TraceExporter` | `langfuse` | `npm install langfuse` |
| [`observe/opentelemetry-exporter.ts`](observe/opentelemetry-exporter.ts) | `TraceExporter` | `@opentelemetry/api` | `npm install @opentelemetry/api @opentelemetry/sdk-trace-base` |
| [`context/tiktoken-tokenizer.ts`](context/tiktoken-tokenizer.ts) | `Tokenizer` | `tiktoken` | `npm install tiktoken` |
| [`memory/redis-store.ts`](memory/redis-store.ts) | `MemoryStore` | `ioredis` | `npm install ioredis` |
| [`memory/vector-store.ts`](memory/vector-store.ts) | `MemoryStore` + `searchByVector` | `@pinecone-database/pinecone` | `npm install @pinecone-database/pinecone` |
| [`eval/llm-judge-scorer.ts`](eval/llm-judge-scorer.ts) | `Scorer` | `@anthropic-ai/sdk` | `npm install @anthropic-ai/sdk` |
| [`guardrails/llm-injection-detector.ts`](guardrails/llm-injection-detector.ts) | `Guardrail` | `@anthropic-ai/sdk` | `npm install @anthropic-ai/sdk` |
| [`tools/ajv-validator.ts`](tools/ajv-validator.ts) | `SchemaValidator` | `ajv` | `npm install ajv ajv-formats` |
| [`prompt/langfuse-prompt-backend.ts`](prompt/langfuse-prompt-backend.ts) | `PromptBackend` | `langfuse` | `npm install langfuse` |
| [`full-stack-demo.ts`](full-stack-demo.ts) | All of the above | Multiple | `npm install @anthropic-ai/sdk langfuse tiktoken` |

## Quick Start

```bash
# Install the external packages you need (examples only, not added to package.json)
npm install @anthropic-ai/sdk

# Set environment variables
export ANTHROPIC_API_KEY=sk-ant-...

# Run an example with tsx
npx tsx examples/adapters/anthropic-adapter.ts
```

## Interface Summary

| harness-one Interface | Module | Injection Point |
|----------------------|--------|-----------------|
| `AgentAdapter` | `harness-one/core` | Any function accepting an adapter |
| `TraceExporter` | `harness-one/observe` | `createTraceManager({ exporters: [...] })` |
| `Tokenizer` | `harness-one/context` | `registerTokenizer(model, tokenizer)` |
| `MemoryStore` | `harness-one/memory` | `createRelay({ store })`, direct usage |
| `Scorer` | `@harness-one/devkit` | `createEvalRunner({ scorers: [...] })` |
| `Guardrail` | `harness-one/guardrails` | `createPipeline({ input: [...] })` |
| `SchemaValidator` | `harness-one/tools` | `createRegistry({ validator })` |
| `PromptBackend` | `harness-one/prompt` | `createAsyncPromptRegistry(backend)` |

## Notes

- These are **examples only** -- they are not compiled or tested as part of the main build.
- No runtime dependencies are added to `package.json`.
- All imports use harness-one subpath exports (`harness-one/core`, `harness-one/observe`, etc.).
- Each file is self-contained and can be copied into your project as a starting point.
