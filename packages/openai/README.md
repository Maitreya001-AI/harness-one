# @harness-one/openai

OpenAI Chat Completions API adapter for the harness-one `AgentAdapter` interface. Works with OpenAI and OpenAI-compatible providers (Groq, DeepSeek, Together, etc.).

## Install

```bash
pnpm add @harness-one/openai openai
```

## Peer Dependencies

- `openai` >= 4.0.0
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

See the main [repository README](../../README.md).
