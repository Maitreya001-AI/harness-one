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

- Maps harness-one `Message` to Anthropic content blocks (text + `tool_use` + `tool_result` + `thinking` + `image`).
- Forwards `ChatParams.signal` so the loop's `AbortSignal` cancels in-flight requests.
- Normalizes provider errors (401/429/5xx/network/…) into typed `HarnessError`s with the correct `HarnessErrorCode` and the original error preserved as `cause`.
- Implements `ChatParams.responseFormat` (`json_object` / `json_schema`) by appending a system-level instruction — Anthropic has no native JSON mode.
- Round-trips extended-thinking (`thinking` / `redacted_thinking`) and image content blocks (RFC-0001) — see below.
- Surfaces `cache_read_input_tokens` / `cache_creation_input_tokens` as `TokenUsage.cacheReadTokens` / `cacheWriteTokens`.
- Accepts an optional `logger` (`Pick<Logger, 'warn' | 'error'>`) for non-fatal warnings.

## Prompt caching (opt-in)

Anthropic only populates `cacheReadTokens` / `cacheWriteTokens` when the
request carries `cache_control` breakpoints. Enable them via `promptCaching`
(default: off — the request shape is unchanged unless you opt in):

```ts
const adapter = createAnthropicAdapter({
  client,
  promptCaching: {
    system: true,      // cache the system prompt
    lastMessage: true, // cache the whole conversation prefix (great for loops)
  },
});
```

At most two breakpoints are emitted, well under Anthropic's cap of four.

When `promptCaching.lastMessage` is combined with extended thinking, the
breakpoint is placed on the last **non-thinking** block (Anthropic rejects
`cache_control` on `thinking` / `redacted_thinking` blocks); if the final
message is entirely thinking blocks, no breakpoint is emitted.

## Extended thinking (opt-in, RFC-0001)

Enable Anthropic extended thinking with the `thinking` option. The adapter
sends `thinking: { type: 'enabled', budget_tokens }` on every request, and
parses the returned `thinking` / `redacted_thinking` blocks into
`Message.blocks` (with their integrity `signature`s). Those blocks are
replayed **verbatim** on the next request — required for multi-turn tool
loops — and reasoning fragments stream as `thinking_delta` events.

```ts
const adapter = createAnthropicAdapter({
  client,
  thinking: { budgetTokens: 4000 },
});
```

Anthropic constraints:

- **`maxTokens` must exceed `budgetTokens`.** When `config.maxTokens` is set
  and not greater than `budgetTokens`, the adapter throws
  `HarnessError(CORE_INVALID_CONFIG)` **before** the network call. When
  `maxTokens` is unset, the adapter default (`4096`) applies — keep
  `budgetTokens` below it or set `maxTokens` explicitly.
- **Temperature must stay at its default.** The adapter forwards
  `config.temperature` as-is; setting it while thinking is enabled makes
  Anthropic reject the request. Leave `temperature` unset.

`Message.content` remains the plain-text projection (thinking text is not
included), so text-only consumers (guardrails, token estimator, pruning) are
unaffected.

## Images (RFC-0001)

User messages and tool results carry images via `Message.blocks`:

```ts
await loop.run([
  {
    role: 'user',
    content: 'What is in this screenshot?',
    blocks: [
      { type: 'text', text: 'What is in this screenshot?' },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: pngBase64 } },
      // or: { type: 'image', source: { kind: 'url', url: 'https://…/shot.png' } }
    ],
  },
]);
```

Image blocks in a **tool result** (e.g. a screenshot tool) map to a mixed
`tool_result` content array (text + image). Tool results without images keep
the plain string content.

See the main [repository README](../../README.md).
