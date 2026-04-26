# `harness-one-coding`

Autonomous coding agent built on `harness-one`. Long-horizon dogfood + reusable vertical package.

See [`docs/coding-agent-DESIGN.md`](../../docs/coding-agent-DESIGN.md) for the design spec, and [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for staged build progress.

## Status

Pre-MVP. Implementation underway in stages — see `IMPLEMENTATION_PLAN.md`.

## Quick start (post-MVP)

```bash
harness-coding "Fix the failing test in src/utils/parse.ts"
harness-coding --resume <taskId>
harness-coding --plan-only "Refactor the auth module"
```

## Public API (post-MVP)

```ts
import { createCodingAgent } from 'harness-one-coding';
import { createAnthropicAdapter } from '@harness-one/anthropic';

const agent = createCodingAgent({
  adapter: createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }),
  workspace: process.cwd(),
});

const result = await agent.runTask({
  prompt: 'Fix the failing test in src/utils/parse.ts',
});
console.log(result.summary);
```
