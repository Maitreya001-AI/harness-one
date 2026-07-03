/**
 * One-time "no cost ceiling" warning.
 *
 * `maxTotalTokens` defaults to Infinity; combined with no `maxDurationMs`
 * only `maxIterations` bounds a run. The loop now surfaces that once per
 * instance (mirror of the no-pipeline security warning) instead of
 * leaving the missing budget silent.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAgentLoop } from '../agent-loop.js';
import type { AgentEvent } from '../events.js';
import { createMockAdapter, USAGE } from './agent-loop-test-fixtures.js';

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const RESPONSE = { message: { role: 'assistant' as const, content: 'ok' }, usage: USAGE };

function budgetWarns(warn: ReturnType<typeof vi.fn>): unknown[][] {
  return warn.mock.calls.filter(
    (c) => typeof c[0] === 'string' && /no token or duration budget/i.test(c[0] as string),
  );
}

describe('AgentLoop no-budget warning', () => {
  it('warns once when neither maxTotalTokens nor maxDurationMs is set', async () => {
    const warn = vi.fn();
    const loop = createAgentLoop({
      adapter: createMockAdapter([RESPONSE, RESPONSE]),
      logger: { warn },
      guardrailsManagedExternally: true, // isolate from the no-pipeline warning
    });

    await drain(loop.run([{ role: 'user', content: 'hi' }]));
    await drain(loop.run([{ role: 'user', content: 'again' }]));

    expect(budgetWarns(warn)).toHaveLength(1);
    const meta = budgetWarns(warn)[0][1] as { hint?: string };
    expect(meta.hint).toMatch(/maxTotalTokens/);
  });

  it('does not warn when maxTotalTokens is finite', async () => {
    const warn = vi.fn();
    const loop = createAgentLoop({
      adapter: createMockAdapter([RESPONSE]),
      logger: { warn },
      guardrailsManagedExternally: true,
      maxTotalTokens: 10_000,
    });

    await drain(loop.run([{ role: 'user', content: 'hi' }]));

    expect(budgetWarns(warn)).toHaveLength(0);
  });

  it('does not warn when maxDurationMs is set', async () => {
    const warn = vi.fn();
    const loop = createAgentLoop({
      adapter: createMockAdapter([RESPONSE]),
      logger: { warn },
      guardrailsManagedExternally: true,
      maxDurationMs: 60_000,
    });

    await drain(loop.run([{ role: 'user', content: 'hi' }]));

    expect(budgetWarns(warn)).toHaveLength(0);
  });
});
