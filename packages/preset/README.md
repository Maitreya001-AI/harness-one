# @harness-one/preset

Batteries-included preset that wires `harness-one` core + provider adapters
+ AJV validator + observability + memory + lifecycle into a single
`createHarness()` / `createSecurePreset()` call.

`createSecurePreset()` is an opinionated reference preset, not a mandatory
top-level entry point. Use it when its fail-closed defaults match your
deployment posture; otherwise call `createHarness()` or wire subsystems
directly.

## Install

```bash
pnpm add @harness-one/preset @anthropic-ai/sdk
# Or for OpenAI:
pnpm add @harness-one/preset openai
```

## Peer / Required Dependencies

Bundled (direct deps): `harness-one`, `@harness-one/anthropic`,
`@harness-one/openai`, `@harness-one/ajv`.

Optional: `@harness-one/redis`, `@harness-one/langfuse`,
`@harness-one/opentelemetry`, `@harness-one/tiktoken`.

You must install exactly one provider SDK:

- `@anthropic-ai/sdk` (when `provider: 'anthropic'` or injecting an Anthropic client)
- `openai` (when `provider: 'openai'`)

## Quick Start (secure preset, recommended for production)

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createSecurePreset } from '@harness-one/preset';

const harness = createSecurePreset({
  provider: 'anthropic',
  client: new Anthropic({ apiKey: process.env.ANTHROPIC_KEY }),
  model: 'claude-sonnet-4-20250514',
  // guardrailLevel defaults to 'standard' (injection + contentFilter + PII)
});

for await (const ev of harness.run([
  { role: 'user', content: 'Hello!' },
])) {
  if (ev.type === 'message') console.log(ev.message.content);
  if (ev.type === 'done') break;
}

await harness.shutdown();
```

The returned `Harness` exposes `loop`, `tools`, `guardrails`, `traces`,
`costs`, `sessions`, `memory`, `prompts`, `eval`, `logger`,
`conversations`, and `middleware`. `SecureHarness` adds `lifecycle` and
`metrics`. Wire any of these directly when you need lower-level control.

## Configuration

### Preferred pattern — inject a pre-built adapter (`AdapterHarnessConfig`)

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

### Provider-based shorthand (still supported)

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

### `harness.run()` auto-wiring

Guardrails fire on every user message (input) and every assistant
message + tool result (output). Tool call arguments are also validated
against input guardrails before execution. The `AgentLoop` is created
internally with `maxConversationMessages: 200` by default, and the
shared `traceManager` is passed through so every iteration / tool call /
guardrail check shows up as a span in your configured exporter.

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

### Provider variants

```typescript
// OpenAI
import OpenAI from 'openai';
import { createHarness } from '@harness-one/preset';

const harness = createHarness({
  provider: 'openai',
  client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  model: 'gpt-4o',
});
```

### Optional integrations (pass pre-configured clients to enable)

| Field | Type | Effect |
|-------|------|--------|
| `langfuse` | `Langfuse` instance | Enables Langfuse trace export and cost tracking; generation detection prioritizes explicit `harness.span.kind` attribute |
| `redis` | `Redis` instance | Enables Redis-backed persistent memory |
| `tokenizer` | `'tiktoken'` \| `(text) => number` \| `{ encode }` | Token counting — string enables tiktoken globally; function/object avoids global side-effects |

### Integration package notes

- **OpenAI adapter** (`@harness-one/openai`): `stream()` forwards `temperature`, `topP`, and `stopSequences` from `LLMConfig` to the underlying API call.
- **AJV validator** (`@harness-one/ajv`): async `validate()` awaits format plugin loading before validating, preventing a race condition where format keywords were silently ignored on the first call.
- **Langfuse** (`@harness-one/langfuse`): span kind detection checks the explicit `harness.span.kind` attribute first before falling back to heuristics.
- **OpenTelemetry** (`@harness-one/opentelemetry`): when a parent span is evicted from the active-spans map before a child span finishes, the parent's context is preserved for correct child linking.

### Observability auto-wiring

Pass a `traceManager` to `AgentLoop` directly if you need per-iteration
and per-tool spans without managing traces manually:

```typescript
import { createTraceManager, createConsoleExporter } from 'harness-one/observe';
import { AgentLoop } from 'harness-one/core';

const tm = createTraceManager({ exporters: [createConsoleExporter()] });
const loop = new AgentLoop({
  adapter,
  traceManager: tm, // creates trace on run(), span per iteration, child span per tool call
});
```

## Conventions and footguns

- **No central event bus**: `harness.eventBus` does not exist — each
  module exposes its own `onEvent()` subscription (sessions, orchestrator,
  traces); use those for new code.
- **AgentLoop class + factory coexist**: both `new AgentLoop(...)` and
  `createAgentLoop()` are first-class — pick whichever you prefer. The
  factory form is the style used across the rest of the `createX()`
  surface.
- **`Harness.initialize()`** — optional warmup that pre-initialises
  exporters and tokenizers behind an idempotent latch. `harness.run()`
  still works without it but may pay a cold-start latency on the first
  call.
- **No `/essentials` subpath**: there is no `harness-one/essentials`.
  Import the symbols you need directly from `harness-one` (root barrel)
  or the relevant submodule (`harness-one/core`, `harness-one/observe`, …).
- **`harness-one/testing` subpath**: mock `AgentAdapter` factories
  (`createMockAdapter`, `createFailingAdapter`, `createStreamingMockAdapter`,
  `createErrorStreamingMockAdapter`) live here. `harness-one/advanced`
  carries only composable production primitives. See
  [`docs/architecture/17-testing.md`](../../docs/architecture/17-testing.md)
  for the rationale.
- **Root barrel is 18 symbols**: the unscoped `harness-one` root
  re-exports only 18 curated user-journey value symbols.
  `createSecurePreset` intentionally lives on `@harness-one/preset` (not
  the root barrel) to avoid a `harness-one` ↔ `@harness-one/preset`
  dependency cycle. Other factories (`toSSEStream`,
  `categorizeAdapterError`, …) live on subpaths only. See
  [`MIGRATION.md`](../../MIGRATION.md) + `git log` for the authoritative
  changelog (`CHANGELOG.md` is intentionally empty pre-release).
- **`HarnessErrorCode` is closed and module-prefixed**: `HarnessError.code`
  is not widened with `(string & {})`; every member is prefixed by module
  (`CORE_UNKNOWN`, `CORE_MAX_ITERATIONS`, `GUARD_VIOLATION`, etc.).
  Adapter-specific codes use `HarnessErrorCode.ADAPTER_CUSTOM` +
  `details.adapterCode`. Always **value-import**
  (`import { HarnessErrorCode }`) — `import type` silently breaks
  `Object.values()`; the lint rule
  `harness-one/no-type-only-harness-error-code` catches this.
- **CLI + devkit live in sibling packages**: the CLI ships as
  [`@harness-one/cli`](../cli) (use `pnpm dlx @harness-one/cli init`
  or install locally); eval + evolve dev-tooling ships as
  [`@harness-one/devkit`](../devkit). The runtime architecture-rule
  engine remains in core under `harness-one/evolve-check`.
- **Trust-boundary typing + multi-tenant Redis**: `SystemMessage`
  carries an optional `_trust` brand minted by
  `createTrustedSystemMessage()` from `harness-one/core`; restored
  messages without the brand are downgraded to `user` so a session-store
  write cannot elevate authority. `RedisStoreConfig.tenantId` is required
  for multi-tenant deployments (one-shot warn if defaulted) — keys flip
  to `prefix:{tenantId}:id`. Memory entries enforce a 1 MiB content /
  16 KiB metadata cap and reserve `_version`/`_trust` keys.
  `createContextBoundary` rejects policy prefixes without a trailing
  `.`/`/`. `HandoffManager.createSendHandle(from)` mints sealed sender
  handles; payloads cap at 64 KiB / depth 16. Tool schemas declaring
  `additionalProperties: false` are enforced at runtime. Per-chunk RAG
  context scanning ships as `runRagContext` from `harness-one/guardrails`.
- **Adapter logger + crypto IDs + unref timers**: `@harness-one/anthropic`
  / `@harness-one/openai` / `@harness-one/ajv` / `@harness-one/redis`
  route their default logger through core's redaction-enabled
  `createDefaultLogger()` (never bare `console.warn`).
  `@harness-one/langfuse` inline warnings flow through `safeWarn`.
  `harness-one/context` checkpoint IDs use `prefixedSecureId('cp')`
  (`crypto.randomBytes`); trace sampling uses `crypto.randomInt`. The
  `harness-one/infra` `unrefTimeout` / `unrefInterval` helpers replace
  the ad-hoc `.unref?.()` pattern. `@harness-one/preset` pricing
  validation rejects `NaN`/`Infinity` alongside negatives.

### MetricsPort + lifecycle state machine + AdmissionController

Three vendor-neutral primitives shipping on subpaths.

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

### `AgentLoopHook`

Pass an array of hooks in `AgentLoopConfig.hooks` to receive
`onIterationStart` / `onToolCall` / `onTokenUsage` / `onIterationEnd`
callbacks without subscribing to `AgentEvent`. Hook errors are swallowed
through the injected logger and never break the loop.

All auto-configured components can be replaced by passing the explicit
override field (`adapter`, `exporters`, `memoryStore`, `schemaValidator`).

### Graceful shutdown

Wire SIGTERM/SIGINT handlers in one call:

<!-- noverify -->
```ts
import { createSecurePreset, createShutdownHandler } from '@harness-one/preset';

const harness = createSecurePreset({ ... });
createShutdownHandler(harness, { timeoutMs: 15_000 });
// Now SIGTERM/SIGINT will drain in-flight work and exit cleanly.
```

### Lifecycle & health checks

Query harness readiness (useful for k8s probes):

```ts
const health = await harness.lifecycle.health();
// { state: 'ready', ready: true, components: { traceManager: { status: 'up' }, ... } }
```

## Naming history

> Previously scaffolded as `harness-one-full`. Renamed to
> `@harness-one/preset` to match the rest of the `@harness-one/*`
> integration scope. See `.changeset/rename-preset.md` for the
> rename trail — runtime behavior is unchanged.

## Related

- Repository [`README.md`](../../README.md) — top-level overview and
  quick start.
- [`docs/modules.md`](../../docs/modules.md) — per-subpath public API
  reference.
- [`docs/guides/import-paths.md`](../../docs/guides/import-paths.md) —
  which subpath owns which symbol.
- [`docs/architecture/`](../../docs/architecture/) — internal design
  docs (Chinese).
