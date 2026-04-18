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

  it('becomes errored after hitting maxIterations', async () => {
    // Adapter that always requests a tool so the loop never terminates
    // naturally — maxIterations=1 forces the max_iterations terminal.
    const loopingAdapter: AgentAdapter = {
      async chat() {
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            toolCalls: [{ id: 'c1', name: 'loop', arguments: '{}' }],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const loop = new AgentLoop({
      adapter: loopingAdapter,
      maxIterations: 1,
      onToolCall: async () => 'ok',
    });
    await collectEvents(loop.run([{ role: 'user', content: 'go' }]));
    expect(loop.status).toBe('errored');
  });

  it('becomes errored after external abort', async () => {
    const slowAdapter: AgentAdapter = {
      async chat({ signal }) {
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
        return {
          message: { role: 'assistant' as const, content: 'never' },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const controller = new AbortController();
    const loop = new AgentLoop({
      adapter: slowAdapter,
      signal: controller.signal,
    });
    const done = collectEvents(loop.run([{ role: 'user', content: 'go' }]));
    // Abort on the next microtask so run() can reach its first
    // `await adapter.chat()` before the signal fires.
    await Promise.resolve();
    controller.abort();
    await done;
    expect(loop.status).toBe('errored');
  });

  it('dispose() wins the race against a terminal status flip', async () => {
    // Arrange: adapter that resolves only after dispose() has been called so
    // the loop's run-to-terminal transition happens on an already-disposed
    // instance. Without the disposed-guard, the terminal emitter would
    // overwrite state.status back to 'completed'.
    let resolveAdapter: (value: unknown) => void;
    const latch = new Promise((resolve) => {
      resolveAdapter = resolve;
    });
    const gatedAdapter: AgentAdapter = {
      async chat() {
        await latch;
        return {
          message: { role: 'assistant' as const, content: 'ok' },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const loop = new AgentLoop({ adapter: gatedAdapter });
    const runPromise = collectEvents(loop.run([{ role: 'user', content: 'hi' }]));
    // Let the adapter suspend on the latch, then dispose.
    await Promise.resolve();
    loop.dispose();
    expect(loop.status).toBe('disposed');
    // Release the adapter — the terminal pass must NOT un-dispose.
    resolveAdapter!(undefined);
    await runPromise;
    expect(loop.status).toBe('disposed');
  });
});
