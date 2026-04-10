import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../agent-loop.js';
import type { AgentAdapter } from '../types.js';
import type { AgentEvent } from '../events.js';

/** Helper: collect all events from an async generator. */
async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

const mockAdapter: AgentAdapter = {
  async chat() {
    return {
      message: { role: 'assistant' as const, content: 'Hello' },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  },
};

describe('AgentLoop status', () => {
  it('starts as idle', () => {
    const loop = new AgentLoop({ adapter: mockAdapter });
    expect(loop.status).toBe('idle');
  });

  it('becomes running during run()', async () => {
    let statusDuringRun: string | undefined;

    const capturingAdapter: AgentAdapter = {
      async chat() {
        // Capture status while the loop is actively running
        statusDuringRun = loopRef.status;
        return {
          message: { role: 'assistant' as const, content: 'Hello' },
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };

    const loopRef = new AgentLoop({ adapter: capturingAdapter });
    await collectEvents(loopRef.run([{ role: 'user', content: 'Hi' }]));

    expect(statusDuringRun).toBe('running');
  });

  it('becomes completed after run() finishes with end_turn', async () => {
    const loop = new AgentLoop({ adapter: mockAdapter });
    await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

    expect(loop.status).toBe('completed');
  });

  it('becomes disposed after dispose()', async () => {
    const loop = new AgentLoop({ adapter: mockAdapter });
    await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

    loop.dispose();
    expect(loop.status).toBe('disposed');
  });

  it('becomes disposed if dispose() is called while idle (never ran)', () => {
    const loop = new AgentLoop({ adapter: mockAdapter });
    expect(loop.status).toBe('idle');

    loop.dispose();
    expect(loop.status).toBe('disposed');
  });
});
