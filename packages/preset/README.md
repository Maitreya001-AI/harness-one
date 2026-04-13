# @harness-one/preset

Batteries-included preset wiring core + anthropic + openai + ajv defaults into a single `createHarness()`.

## Install

```bash
pnpm add @harness-one/preset @anthropic-ai/sdk
# Or for OpenAI:
pnpm add @harness-one/preset openai
```

## Peer / Required Dependencies

Bundled (direct deps): `harness-one`, `@harness-one/anthropic`, `@harness-one/openai`, `@harness-one/ajv`.

Optional: `@harness-one/redis`, `@harness-one/langfuse`, `@harness-one/opentelemetry`, `@harness-one/tiktoken`.

You must install exactly one provider SDK:

- `@anthropic-ai/sdk` (when `provider: 'anthropic'` or injecting an Anthropic client)
- `openai` (when `provider: 'openai'`)

## Quick Start

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createHarness } from '@harness-one/preset';

const harness = createHarness({
  provider: 'anthropic',
  client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  model: 'claude-sonnet-4-20250514',
});

for await (const ev of harness.run([
  { role: 'user', content: 'Hello!' },
])) {
  if (ev.type === 'message') console.log(ev.message.content);
  if (ev.type === 'done') break;
}

await harness.shutdown();
```

The returned `Harness` exposes `loop`, `tools`, `guardrails`, `traces`, `costs`, `sessions`, `memory`, `prompts`, `eval`, and `logger`. Wire them directly when you need lower-level control.

See the main [repository README](../../README.md) for configuration options and the [preset architecture doc](../../docs/architecture/00-overview.md).
