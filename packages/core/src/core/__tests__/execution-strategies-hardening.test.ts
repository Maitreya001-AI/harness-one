/**
 * Execution strategy + agent-loop dispose forwarding:
 *
 *   - `ExecutionStrategy` accepts an optional `dispose(): Promise<void>`
 *     method (declaration-merged in execution-strategies.ts).
 *     AgentLoop.dispose() forwards into it when present.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAgentLoop } from '../agent-loop.js';
import type { AgentAdapter, ExecutionStrategy } from '../types.js';

function makeAdapter(): AgentAdapter {
  return {
    name: 'noop',
    async chat() {
      return {
        message: { role: 'assistant', content: 'ok' },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

describe('ExecutionStrategy dispose forwarding', () => {
  it('AgentLoop.dispose() invokes strategy.dispose() when present', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const strategy: ExecutionStrategy = {
      async execute(calls) {
        return calls.map((c) => ({ toolCallId: c.id, result: null }));
      },
      dispose,
    };
    const loop = createAgentLoop({
      adapter: makeAdapter(),
      executionStrategy: strategy,
    });
    loop.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('AgentLoop.dispose() works with strategies that omit dispose (legacy)', async () => {
    const strategy: ExecutionStrategy = {
      async execute(calls) {
        return calls.map((c) => ({ toolCallId: c.id, result: null }));
      },
    };
    const loop = createAgentLoop({
      adapter: makeAdapter(),
      executionStrategy: strategy,
    });
    expect(() => loop.dispose()).not.toThrow();
  });

  it('AgentLoop.dispose() swallows synchronous throws from strategy.dispose', async () => {
    const strategy: ExecutionStrategy = {
      async execute(calls) {
        return calls.map((c) => ({ toolCallId: c.id, result: null }));
      },
      dispose: () => {
        throw new Error('dispose exploded');
      },
    };
    const loop = createAgentLoop({
      adapter: makeAdapter(),
      executionStrategy: strategy,
    });
    // Must not throw — teardown is best-effort.
    expect(() => loop.dispose()).not.toThrow();
  });

  it('AgentLoop.dispose() swallows async rejections from strategy.dispose', async () => {
    const dispose = vi.fn().mockRejectedValue(new Error('boom'));
    const strategy: ExecutionStrategy = {
      async execute(calls) {
        return calls.map((c) => ({ toolCallId: c.id, result: null }));
      },
      dispose,
    };
    const loop = createAgentLoop({
      adapter: makeAdapter(),
      executionStrategy: strategy,
    });
    expect(() => loop.dispose()).not.toThrow();
    // Flush microtasks — the .catch is attached but the rejection is async.
    await new Promise((r) => setTimeout(r, 10));
    expect(dispose).toHaveBeenCalledOnce();
  });
});
