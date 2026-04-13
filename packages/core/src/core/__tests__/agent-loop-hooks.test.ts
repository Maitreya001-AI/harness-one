/**
 * Tests for ARCH-006: AgentLoopHook iteration-level instrumentation.
 *
 * Pin the hook contract so subsequent refactors keep the four lifecycle
 * callbacks paired and ordered against the public AgentEvent stream.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAgentLoop } from '../agent-loop.js';
import type { AgentLoopHook } from '../agent-loop.js';
import type { AgentAdapter, ChatResponse, TokenUsage, ToolCallRequest } from '../types.js';
import type { AgentEvent } from '../events.js';

const USAGE: TokenUsage = { inputTokens: 7, outputTokens: 3 };

function adapterFromResponses(responses: ChatResponse[]): AgentAdapter {
  let i = 0;
  return {
    async chat() {
      const r = responses[i];
      if (!r) throw new Error('out of responses');
      i++;
      return r;
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('AgentLoopHook (ARCH-006)', () => {
  it('fires onIterationStart, onCost, onIterationEnd for a no-tool iteration', async () => {
    const hook: AgentLoopHook = {
      onIterationStart: vi.fn(),
      onToolCall: vi.fn(),
      onCost: vi.fn(),
      onIterationEnd: vi.fn(),
    };
    const adapter = adapterFromResponses([
      { message: { role: 'assistant', content: 'hi' }, usage: USAGE },
    ]);
    const loop = createAgentLoop({ adapter, hooks: [hook] });
    await drain(loop.run([{ role: 'user', content: 'hello' }]));

    expect(hook.onIterationStart).toHaveBeenCalledWith({ iteration: 1 });
    expect(hook.onToolCall).not.toHaveBeenCalled();
    expect(hook.onCost).toHaveBeenCalledWith({ iteration: 1, usage: USAGE });
    expect(hook.onIterationEnd).toHaveBeenCalledWith({ iteration: 1, done: true });
  });

  it('fires onToolCall and pairs iteration_start/end across multiple iterations', async () => {
    const tc: ToolCallRequest = { id: 't1', name: 'echo', arguments: '{}' };
    const adapter = adapterFromResponses([
      { message: { role: 'assistant', content: '', toolCalls: [tc] }, usage: USAGE },
      { message: { role: 'assistant', content: 'done' }, usage: USAGE },
    ]);
    const events: string[] = [];
    const hook: AgentLoopHook = {
      onIterationStart: ({ iteration }) => events.push(`start:${iteration}`),
      onToolCall: ({ iteration, toolCall }) => events.push(`tool:${iteration}:${toolCall.name}`),
      onCost: ({ iteration }) => events.push(`cost:${iteration}`),
      onIterationEnd: ({ iteration, done }) => events.push(`end:${iteration}:${done}`),
    };
    const loop = createAgentLoop({
      adapter,
      hooks: [hook],
      onToolCall: async () => 'ok',
    });
    await drain(loop.run([{ role: 'user', content: 'go' }]));

    // Expected: iteration 1 starts → cost → tool → end (loop continues),
    // iteration 2 starts → cost → end (terminal).
    expect(events).toEqual([
      'start:1',
      'cost:1',
      'tool:1:echo',
      'end:1:false',
      'start:2',
      'cost:2',
      'end:2:true',
    ]);
  });

  it('swallows hook errors and routes them to the configured logger', async () => {
    const adapter = adapterFromResponses([
      { message: { role: 'assistant', content: 'hi' }, usage: USAGE },
    ]);
    const warn = vi.fn();
    const logger = { warn };
    const throwingHook: AgentLoopHook = {
      onIterationStart: () => { throw new Error('boom'); },
      onCost: () => { throw new Error('boom-cost'); },
      onIterationEnd: () => { throw new Error('boom-end'); },
    };
    const loop = createAgentLoop({ adapter, hooks: [throwingHook], logger });
    const events = await drain(loop.run([{ role: 'user', content: 'hi' }]));

    // The loop completed normally even though every hook threw.
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(warn).toHaveBeenCalled();
    const messages = warn.mock.calls.map((c) => c[0]);
    for (const m of messages) {
      expect(m).toContain('hook threw');
    }
  });

  it('multiple hooks all receive every event in registration order', async () => {
    const adapter = adapterFromResponses([
      { message: { role: 'assistant', content: 'hi' }, usage: USAGE },
    ]);
    const order: string[] = [];
    const hooks: AgentLoopHook[] = [
      { onIterationStart: () => order.push('a:start') },
      { onIterationStart: () => order.push('b:start') },
    ];
    const loop = createAgentLoop({ adapter, hooks });
    await drain(loop.run([{ role: 'user', content: 'hi' }]));
    expect(order).toEqual(['a:start', 'b:start']);
  });

  it('hooks are not required — undefined hooks config behaves identically', async () => {
    const adapter = adapterFromResponses([
      { message: { role: 'assistant', content: 'hi' }, usage: USAGE },
    ]);
    const loop = createAgentLoop({ adapter });
    const events = await drain(loop.run([{ role: 'user', content: 'hi' }]));
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});
