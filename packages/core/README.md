# harness-one

Framework-agnostic primitives for AI agent harness engineering. Zero-runtime-dep core with subpath exports (`core`, `advanced`, `prompt`, `context`, `tools`, `guardrails`, `observe`, `session`, `memory`, `evolve-check`, `rag`, `orchestration`, `redact`, `infra`). `eval` and `evolve` ship from `@harness-one/devkit`.

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

Available submodules: `core`, `advanced`, `prompt`, `context`, `tools`, `guardrails`, `observe`, `session`, `memory`, `evolve-check`, `rag`, `orchestration`, `redact`, `infra`.

> **Wave-5C** — `harness-one/eval` and `harness-one/evolve` were extracted to **[`@harness-one/devkit`](../devkit)**. The `harness-one/cli` subpath was extracted to **[`@harness-one/cli`](../cli)**. `harness-one/evolve-check` (architecture rules only) stays in core.
>
> The root barrel is now curated to **18 value symbols** (UJ-1..UJ-5 user-journey set; the original ADR slot 11 `createSecurePreset` was dropped per R-01 to break the `harness-one` ↔ `@harness-one/preset` cycle). Other factories like `toSSEStream`, `categorizeAdapterError` etc. live on subpaths only.

> **Wave-5D additions** (subpath-only): `harness-one/observe` exports `MetricsPort` + `createNoopMetricsPort` (vendor-neutral metric instruments), `HarnessLifecycle` + `createHarnessLifecycle` (init→ready→draining→shutdown state machine + aggregated `health()`); `harness-one/infra` exports `createAdmissionController` (per-tenant in-process token bucket with abort/timeout fail-closed).

> **Wave-5E additions** (subpath-only): `harness-one/core` exports `createTrustedSystemMessage`, `isTrustedSystemMessage`, `sanitizeRestoredMessage` for the system-message brand pattern (SEC-A07); `harness-one/guardrails` exports `runRagContext` for per-chunk input scanning of retrieved context (SEC-A16).

> **Wave-5C `HarnessErrorCode` is closed and prefixed.** Switch on `HarnessError.code` exhaustively. Always **value-import** (`import { HarnessErrorCode }`) — type-only import drops the runtime `Object.values()` record (lint rule `harness-one/no-type-only-harness-error-code` enforces). See root [`MIGRATION.md`](../../MIGRATION.md) and the git log for the full rename mapping (`CHANGELOG.md` is intentionally empty pre-release).

See the main [repository README](../../README.md) and [architecture docs](../../docs/architecture/) for the full API surface.
