# harness-one

Framework-agnostic primitives for AI agent harness engineering. Zero-runtime-dep core with subpath exports (`core`, `advanced`, `prompt`, `context`, `tools`, `guardrails`, `observe`, `session`, `memory`, `evolve-check`, `rag`, `orchestration`, `redact`, `infra`, `testing`). `eval` and `evolve` ship from `@harness-one/devkit`.

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

Available submodules: `core`, `advanced`, `prompt`, `context`, `tools`, `guardrails`, `observe`, `session`, `memory`, `evolve-check`, `rag`, `orchestration`, `redact`, `infra`, `testing`.

> **`harness-one/testing` subpath** — mock `AgentAdapter` factories (`createMockAdapter`, `createFailingAdapter`, `createStreamingMockAdapter`, `createErrorStreamingMockAdapter`) ship from this path so the `/advanced` surface carries only production extension primitives. See [`docs/architecture/17-testing.md`](../../docs/architecture/17-testing.md).

> **eval + evolve live in `@harness-one/devkit`** — the [`@harness-one/devkit`](../devkit) package owns eval + evolve dev-tooling; the runtime architecture-rule engine stays in core under `harness-one/evolve-check`. The CLI ships as [`@harness-one/cli`](../cli).
>
> The root barrel is curated to **18 value symbols** (core user-journey set). `createSecurePreset` is not in the root barrel — import it from `@harness-one/preset` to avoid a `harness-one` ↔ `@harness-one/preset` dependency cycle. Other factories like `toSSEStream`, `categorizeAdapterError` etc. live on subpaths only.

> **Subpath-only extensions**:
> - `harness-one/observe` — `MetricsPort` + `createNoopMetricsPort` (vendor-neutral metric instruments), `HarnessLifecycle` + `createHarnessLifecycle` (init→ready→draining→shutdown state machine + aggregated `health()`)
> - `harness-one/infra` — `createAdmissionController` (per-tenant in-process token bucket with abort/timeout fail-closed)
> - `harness-one/core` — `createTrustedSystemMessage`, `isTrustedSystemMessage`, `sanitizeRestoredMessage` for the system-message brand pattern
> - `harness-one/guardrails` — `runRagContext` for per-chunk input scanning of retrieved context

> **`HarnessErrorCode` is closed and module-prefixed.** Switch on `HarnessError.code` exhaustively. Always **value-import** (`import { HarnessErrorCode }`) — type-only import drops the runtime `Object.values()` record (lint rule `harness-one/no-type-only-harness-error-code` enforces). See root [`MIGRATION.md`](../../MIGRATION.md) and the git log for change history (`CHANGELOG.md` is intentionally empty pre-release).

See the main [repository README](../../README.md) and [architecture docs](../../docs/architecture/) for the full API surface.
