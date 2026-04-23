/**
 * Tests for AgentLoopHook iteration-level instrumentation.
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

describe('AgentLoopHook', () => {
  it('fires onIterationStart, onTokenUsage, onIterationEnd for a no-tool iteration', async () => {
    const hook: AgentLoopHook = {
      onIterationStart: vi.fn(),
      onToolCall: vi.fn(),
      onTokenUsage: vi.fn(),
      onIterationEnd: vi.fn(),
    };
    const adapter = adapterFromResponses([
      { message: { role: 'assistant', content: 'hi' }, usage: USAGE },
    ]);
    const loop = createAgentLoop({ adapter, hooks: [hook] });
    await drain(loop.run([{ role: 'user', content: 'hello' }]));

    expect(hook.onIterationStart).toHaveBeenCalledWith({ iteration: 1 });
    expect(hook.onToolCall).not.toHaveBeenCalled();
    expect(hook.onTokenUsage).toHaveBeenCalledWith({ iteration: 1, usage: USAGE });
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
      onTokenUsage: ({ iteration }) => events.push(`usage:${iteration}`),
      onIterationEnd: ({ iteration, done }) => events.push(`end:${iteration}:${done}`),
    };
    const loop = createAgentLoop({
      adapter,
      hooks: [hook],
      onToolCall: async () => 'ok',
    });
    await drain(loop.run([{ role: 'user', content: 'go' }]));

    // Expected: iteration 1 starts → token usage → tool → end (loop
    // continues), iteration 2 starts → token usage → end (terminal).
    expect(events).toEqual([
      'start:1',
      'usage:1',
      'tool:1:echo',
      'end:1:false',
      'start:2',
      'usage:2',
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
      onTokenUsage: () => { throw new Error('boom-usage'); },
      onIterationEnd: () => { throw new Error('boom-end'); },
    };
    const loop = createAgentLoop({ adapter, hooks: [throwingHook], logger });
    const events = await drain(loop.run([{ role: 'user', content: 'hi' }]));

    // The loop completed normally even though every hook threw.
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(warn).toHaveBeenCalled();
    // The logger may additionally receive a one-time
    // "no guardrail pipeline — security risk" warning. Filter that out so this
    // assertion stays focused on hook-failure routing (its original intent).
    const messages = warn.mock.calls
      .map((c) => c[0])
      .filter((m) => !(typeof m === 'string' && m.includes('guardrail pipeline')));
    expect(messages.length).toBeGreaterThan(0);
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

  describe('F5: strictHooks mode', () => {
    it('strictHooks: true re-throws hook errors instead of swallowing', async () => {
      const adapter = adapterFromResponses([
        { message: { role: 'assistant', content: 'hi' }, usage: USAGE },
      ]);
      const throwingHook: AgentLoopHook = {
        onIterationStart: () => { throw new Error('strict-boom'); },
      };
      const loop = createAgentLoop({
        adapter,
        hooks: [throwingHook],
        strictHooks: true,
      });
      await expect(
        drain(loop.run([{ role: 'user', content: 'hi' }])),
      ).rejects.toThrow('strict-boom');
    });

    it('strictHooks: false (default) swallows hook errors', async () => {
      const adapter = adapterFromResponses([
        { message: { role: 'assistant', content: 'hi' }, usage: USAGE },
      ]);
      const throwingHook: AgentLoopHook = {
        onIterationStart: () => { throw new Error('swallowed-boom'); },
      };
      const loop = createAgentLoop({
        adapter,
        hooks: [throwingHook],
      });
      // Should complete without error
      const events = await drain(loop.run([{ role: 'user', content: 'hi' }]));
      expect(events.some((e) => e.type === 'done')).toBe(true);
    });
  });

  describe('interceptable hooks', () => {
    it('onBeforeChat can rewrite the message array before the adapter call', async () => {
      const chatSpy = vi.fn(async ({ messages }: { messages: readonly { content: string }[] }) => ({
        message: { role: 'assistant' as const, content: messages[0]?.content ?? 'missing' },
        usage: USAGE,
      }));
      const adapter: AgentAdapter = { chat: chatSpy };
      const loop = createAgentLoop({
        adapter,
        hooks: [{
          onBeforeChat: ({ messages }) => [
            { role: 'system' as const, content: `policy:${messages.length}` },
            ...messages,
          ],
        }],
      });

      const events = await drain(loop.run([{ role: 'user', content: 'hello' }]));
      const message = events.find((event) => event.type === 'message');

      expect(chatSpy).toHaveBeenCalledTimes(1);
      expect(chatSpy.mock.calls[0]?.[0].messages[0]).toMatchObject({ content: 'policy:1' });
      expect(message).toMatchObject({ type: 'message', message: { content: 'policy:1' } });
    });

    it('onBeforeToolCall can rewrite tool arguments before execution', async () => {
      const tc: ToolCallRequest = { id: 't1', name: 'echo', arguments: '{"path":"./tmp"}' };
      const adapter = adapterFromResponses([
        { message: { role: 'assistant', content: '', toolCalls: [tc] }, usage: USAGE },
        { message: { role: 'assistant', content: 'done' }, usage: USAGE },
      ]);
      const onToolCall = vi.fn(async (call: ToolCallRequest) => call.arguments);
      const loop = createAgentLoop({
        adapter,
        onToolCall,
        hooks: [{
          onBeforeToolCall: ({ call }) => ({
            ...call,
            arguments: '{"path":"/abs/tmp"}',
          }),
        }],
      });

      await drain(loop.run([{ role: 'user', content: 'go' }]));
      expect(onToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ arguments: '{"path":"/abs/tmp"}' }),
      );
    });

    it('onBeforeToolCall can abort a tool call and feed the reason back as tool feedback', async () => {
      const tc: ToolCallRequest = { id: 't1', name: 'dangerous_tool', arguments: '{}' };
      const adapter = adapterFromResponses([
        { message: { role: 'assistant', content: '', toolCalls: [tc] }, usage: USAGE },
        { message: { role: 'assistant', content: 'done' }, usage: USAGE },
      ]);
      const onToolCall = vi.fn(async () => 'should-not-run');
      const loop = createAgentLoop({
        adapter,
        onToolCall,
        hooks: [{
          onBeforeToolCall: () => ({ abort: true, reason: 'Blocked by weekend policy' }),
        }],
      });

      const events = await drain(loop.run([{ role: 'user', content: 'go' }]));
      const toolResult = events.find((event) => event.type === 'tool_result') as Extract<
        AgentEvent,
        { type: 'tool_result' }
      >;

      expect(onToolCall).not.toHaveBeenCalled();
      expect(toolResult.result).toEqual({ error: 'Blocked by weekend policy' });
    });

    it('strictHooks applies to onBeforeChat and onBeforeToolCall as well', async () => {
      const adapter = adapterFromResponses([
        { message: { role: 'assistant', content: 'done' }, usage: USAGE },
      ]);
      const loop = createAgentLoop({
        adapter,
        strictHooks: true,
        hooks: [{
          onBeforeChat: () => {
            throw new Error('interceptor-boom');
          },
        }],
      });

      await expect(
        drain(loop.run([{ role: 'user', content: 'go' }])),
      ).rejects.toThrow('interceptor-boom');
    });
  });
});
