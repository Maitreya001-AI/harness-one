# @harness-one/langfuse

Langfuse exporter, prompt backend, and cost tracker for harness-one observability. Maps harness-one traces/spans to Langfuse traces and generations.

## Install

```bash
pnpm add @harness-one/langfuse langfuse
```

## Peer Dependencies

- `langfuse` >= 3.0.0
- `harness-one` (workspace)

## Quick Start

```ts
import { Langfuse } from 'langfuse';
import { createLangfuseExporter, createLangfuseCostTracker } from '@harness-one/langfuse';
import { createTraceManager } from 'harness-one/observe';

const client = new Langfuse({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
  secretKey: process.env.LANGFUSE_SECRET_KEY!,
  baseUrl: 'https://cloud.langfuse.com',
});

const exporter = createLangfuseExporter({ client });
const traces = createTraceManager({ exporters: [exporter] });

const traceId = traces.startTrace('user-request', { userId: 'u123' });
const spanId = traces.startSpan(traceId, 'llm-call');
traces.setSpanAttributes(spanId, {
  model: 'claude-sonnet-4-20250514',
  inputTokens: 150,
  outputTokens: 80,
});
traces.endSpan(spanId);
traces.endTrace(traceId);

await traces.flush(); // Ensure events reach Langfuse before exit
```

The package also exports `createLangfusePromptBackend(config)` (prompt versioning via Langfuse) and `createLangfuseCostTracker(config)` (cost aggregation that forwards totals as Langfuse scores).

Spans containing `model` or `inputTokens` attributes are mapped to Langfuse **generations**; other spans map to generic Langfuse **spans**.

See the main [repository README](../../README.md).
