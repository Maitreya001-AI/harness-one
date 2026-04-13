# @harness-one/anthropic

Anthropic Messages API adapter for the harness-one `AgentAdapter` interface. Supports chat, streaming, and tool_use.

## Install

```bash
pnpm add @harness-one/anthropic @anthropic-ai/sdk
```

## Peer Dependencies

- `@anthropic-ai/sdk` >= 0.30.0
- `harness-one` (workspace)

## Quick Start

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicAdapter } from '@harness-one/anthropic';
import { createAgentLoop } from 'harness-one';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const adapter = createAnthropicAdapter({
  client,
  model: 'claude-sonnet-4-20250514',
});

const loop = createAgentLoop({ adapter });

for await (const ev of loop.run([
  { role: 'user', content: 'Write a haiku about TypeScript.' },
])) {
  if (ev.type === 'text_delta') process.stdout.write(ev.text);
  if (ev.type === 'done') break;
}
```

The adapter:

- Maps harness-one `Message` to Anthropic content blocks (text + `tool_use` + `tool_result`).
- Forwards `ChatParams.signal` so the loop's `AbortSignal` cancels in-flight requests.
- Surfaces `cache_read_input_tokens` / `cache_creation_input_tokens` as `TokenUsage.cacheReadTokens` / `cacheWriteTokens`.
- Accepts an optional `logger` (`Pick<Logger, 'warn' | 'error'>`) for non-fatal warnings.

See the main [repository README](../../README.md).
