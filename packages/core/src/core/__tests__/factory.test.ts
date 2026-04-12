/**
 * Verifies createAgentLoop() returns an AgentLoop instance with identical
 * runtime behavior to `new AgentLoop(config)`. Having both forms keeps
 * harness-one's API-style consistent while preserving class access for
 * users who need it.
 */
import { describe, it, expect } from 'vitest';
import { AgentLoop, createAgentLoop } from '../agent-loop.js';
import type { AgentAdapter } from '../types.js';

function makeAdapter(): AgentAdapter {
  return {
    name: 'test',
    async chat() {
      return {
        message: { role: 'assistant', content: 'ok' },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

describe('createAgentLoop factory', () => {
  it('returns an AgentLoop instance', () => {
    const loop = createAgentLoop({ adapter: makeAdapter() });
    expect(loop).toBeInstanceOf(AgentLoop);
  });

  it('behaves identically to `new AgentLoop(config)`', async () => {
    const loop = createAgentLoop({ adapter: makeAdapter() });
    const events: string[] = [];
    for await (const e of loop.run([{ role: 'user', content: 'hi' }])) {
      events.push(e.type);
    }
    expect(events[events.length - 1]).toBe('done');
  });
});
