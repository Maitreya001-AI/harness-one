# harness-one

Framework-agnostic primitives for AI agent harness engineering. Zero-runtime-dep core with submodule exports (`agent-loop`, `tools`, `guardrails`, `memory`, `observe`, `context`, `prompt`, `eval`, `rag`, `orchestration`).

## Install

```bash
pnpm add harness-one
```

No runtime dependencies. Node 18+.

## Peer Dependencies

None required by core. Integration packages (`@harness-one/anthropic`, `@harness-one/openai`, `@harness-one/ajv`, ...) bring their own peers.

## Quick Start

```ts
import { createAgentLoop, defineTool, createRegistry, toolSuccess } from 'harness-one';
import type { AgentAdapter } from 'harness-one/core';

const add = defineTool<{ a: number; b: number }>({
  name: 'add',
  description: 'Add two numbers',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  execute: async ({ a, b }) => toolSuccess(a + b),
});

const registry = createRegistry();
registry.register(add);

declare const adapter: AgentAdapter; // Implement or use @harness-one/anthropic / @harness-one/openai
const loop = createAgentLoop({ adapter, onToolCall: registry.handler() });

for await (const ev of loop.run([
  { role: 'system', content: 'You are a calculator.' },
  { role: 'user', content: 'What is 2 + 3?' },
])) {
  if (ev.type === 'message') console.log(ev.message.content);
  if (ev.type === 'done') break;
}
```

## Submodule Imports

Every public API is also exported from a submodule path for better tree-shaking:

```ts
import { AgentLoop } from 'harness-one/core';
import { defineTool, createRegistry } from 'harness-one/tools';
import { createPipeline, createInjectionDetector } from 'harness-one/guardrails';
import { createTraceManager, createCostTracker } from 'harness-one/observe';
```

Available submodules: `core`, `prompt`, `context`, `tools`, `guardrails`, `observe`, `session`, `memory`, `eval`, `evolve`, `rag`, `orchestration`.

See the main [repository README](../../README.md) and [architecture docs](../../docs/architecture/) for the full API surface.
