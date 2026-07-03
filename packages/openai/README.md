# @harness-one/openai

OpenAI Chat Completions API adapter for the harness-one `AgentAdapter` interface. Works with OpenAI and OpenAI-compatible providers (Groq, DeepSeek, Together, etc.).

## Install

```bash
pnpm add @harness-one/openai openai
```

## Peer Dependencies

- `openai` >= 4.67.0 — the first release shipping both `stream_options`
  (added in 4.42.0) and `CompletionUsage.prompt_tokens_details` (added in
  4.67.0), which the adapter uses for streaming usage and cache-read token
  reporting. On older SDKs streaming usage silently reports zeros.
- `harness-one` (workspace)

## Quick Start

```ts
import OpenAI from 'openai';
import { createOpenAIAdapter } from '@harness-one/openai';
import { createAgentLoop } from 'harness-one';

const adapter = createOpenAIAdapter({
  client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  model: 'gpt-4o',
});

const loop = createAgentLoop({ adapter });

for await (const ev of loop.run([
  { role: 'user', content: 'Summarize harness engineering in one sentence.' },
])) {
  if (ev.type === 'message') console.log(ev.message.content);
  if (ev.type === 'done') break;
}
```

## OpenAI-Compatible Providers

```ts
import { createOpenAIAdapter, registerProvider } from '@harness-one/openai';

registerProvider('groq', { baseURL: 'https://api.groq.com/openai/v1' });

const adapter = createOpenAIAdapter({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
  model: 'llama-3.1-70b-versatile',
});
```

The adapter surfaces `usage.prompt_tokens_details.cached_tokens` as `TokenUsage.cacheReadTokens`, forwards `AbortSignal`, and accepts an injected `logger`.

## Content blocks (RFC-0001)

`Message.blocks` is honoured where OpenAI can represent it and degraded
gracefully where it cannot:

- **User image blocks** → OpenAI `image_url` content parts. Base64 sources
  become `data:` URLs; `url` sources pass through directly. A user message with
  no image block keeps the plain-string `content` path (perf + prompt-cache
  stability), so non-multimodal turns are unchanged.

  ```ts
  {
    role: 'user',
    content: 'what is in this screenshot?',
    blocks: [
      { type: 'text', text: 'what is in this screenshot?' },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data } },
    ],
  }
  ```

- **Assistant thinking / redacted_thinking blocks** → dropped on send (OpenAI's
  Chat Completions API cannot transport reasoning blocks produced by another
  provider). `content` already carries the text projection, so no text is lost.
  Warns once per adapter instance — keep conversations provider-consistent
  rather than replaying another provider's extended-thinking turns through
  OpenAI.

- **Tool-result image blocks** → replaced with the text marker
  `[image omitted: not representable in OpenAI tool results]` appended to the
  text content (OpenAI tool-role messages are text-only). Warns once per
  adapter instance.

See the main [repository README](../../README.md).
