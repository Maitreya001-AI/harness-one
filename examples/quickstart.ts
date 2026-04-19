/**
 * Quickstart — the shortest path from install to first streaming reply.
 *
 *   pnpm add harness-one @harness-one/preset @harness-one/anthropic @anthropic-ai/sdk
 *   ANTHROPIC_API_KEY=sk-... pnpm tsx examples/quickstart.ts
 *
 * Read this before anything else in examples/. See `full-stack-demo.ts`
 * once you need multi-subsystem wiring.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createSecurePreset } from '@harness-one/preset';

const harness = createSecurePreset({
  provider: 'anthropic',
  client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  model: 'claude-sonnet-4-20250514',
});

for await (const event of harness.run([
  { role: 'user', content: 'Say hi in one sentence.' },
])) {
  if (event.type === 'text_delta') process.stdout.write(event.text);
  if (event.type === 'done') {
    console.log(`\n[done: ${event.reason}, cost: $${harness.costs.getTotalCost().toFixed(4)}]`);
    break;
  }
}

await harness.shutdown();
