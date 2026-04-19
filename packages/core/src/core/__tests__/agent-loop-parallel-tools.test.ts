/**
 * Parallel tool execution tests for {@link AgentLoop}.
 *
 * Covers default sequential behaviour, `parallel: true` fan-out,
 * `isSequentialTool` hybrid scheduling, event-ordering invariants (all
 * tool_call events precede tool_result events), conversation-ordering of
 * results, custom ExecutionStrategy plumbing, and the single-call edge
 * case.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../agent-loop.js';
import type {
  ExecutionStrategy,
  ToolCallRequest,
  ToolExecutionResult,
} from '../types.js';
import type { AgentEvent } from '../events.js';
import { collectEvents, createMockAdapter, USAGE } from './agent-loop-test-fixtures.js';

describe('AgentLoop parallel tool execution', () => {
  it('defaults to sequential execution when parallel is not set', async () => {
    const calls: string[] = [];
    const toolCall1: ToolCallRequest = { id: 'tc1', name: 'tool_a', arguments: '{}' };
    const toolCall2: ToolCallRequest = { id: 'tc2', name: 'tool_b', arguments: '{}' };

    const adapter = createMockAdapter([
      { message: { role: 'assistant', content: '', toolCalls: [toolCall1, toolCall2] }, usage: USAGE },
      { message: { role: 'assistant', content: 'done' }, usage: USAGE },
    ]);
    const onToolCall = vi.fn().mockImplementation(async (call: ToolCallRequest) => {
      calls.push(`start:${call.name}`);
      await new Promise((r) => setTimeout(r, 10));
      calls.push(`end:${call.name}`);
      return `result_${call.name}`;
    });

    const loop = new AgentLoop({ adapter, onToolCall });
    await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

    expect(calls).toEqual(['start:tool_a', 'end:tool_a', 'start:tool_b', 'end:tool_b']);
  });

  it('executes tools in parallel when parallel: true', async () => {
    const calls: string[] = [];
    const toolCall1: ToolCallRequest = { id: 'tc1', name: 'tool_a', arguments: '{}' };
    const toolCall2: ToolCallRequest = { id: 'tc2', name: 'tool_b', arguments: '{}' };
    const toolCall3: ToolCallRequest = { id: 'tc3', name: 'tool_c', arguments: '{}' };

    const adapter = createMockAdapter([
      { message: { role: 'assistant', content: '', toolCalls: [toolCall1, toolCall2, toolCall3] }, usage: USAGE },
      { message: { role: 'assistant', content: 'done' }, usage: USAGE },
    ]);
    const onToolCall = vi.fn().mockImplementation(async (call: ToolCallRequest) => {
      calls.push(`start:${call.name}`);
      await new Promise((r) => setTimeout(r, 50));
      calls.push(`end:${call.name}`);
      return `result_${call.name}`;
    });

    const start = Date.now();
    const loop = new AgentLoop({ adapter, onToolCall, parallel: true });
    await collectEvents(loop.run([{ role: 'user', content: 'go' }]));
    const elapsed = Date.now() - start;

    const startCount = calls.filter((c) => c.startsWith('start:')).length;
    expect(startCount).toBe(3);
    // Parallel: total time should be much less than 150ms (3 * 50ms sequential)
    expect(elapsed).toBeLessThan(130);
  });

  it('respects isSequentialTool — sequential tools run after parallel batch', async () => {
    const order: string[] = [];
    const toolCall1: ToolCallRequest = { id: 'tc1', name: 'parallel_tool', arguments: '{}' };
    const toolCall2: ToolCallRequest = { id: 'tc2', name: 'seq_tool', arguments: '{}' };
    const toolCall3: ToolCallRequest = { id: 'tc3', name: 'another_parallel', arguments: '{}' };

    const adapter = createMockAdapter([
      { message: { role: 'assistant', content: '', toolCalls: [toolCall1, toolCall2, toolCall3] }, usage: USAGE },
      { message: { role: 'assistant', content: 'done' }, usage: USAGE },
    ]);
    const onToolCall = vi.fn().mockImplementation(async (call: ToolCallRequest) => {
      order.push(call.name);
      await new Promise((r) => setTimeout(r, 10));
      return `result_${call.name}`;
    });

    const loop = new AgentLoop({
      adapter,
      onToolCall,
      parallel: true,
      isSequentialTool: (name) => name === 'seq_tool',
    });
    await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

    const seqIdx = order.indexOf('seq_tool');
    const par1Idx = order.indexOf('parallel_tool');
    const par2Idx = order.indexOf('another_parallel');
    expect(seqIdx).toBeGreaterThan(par1Idx);
    expect(seqIdx).toBeGreaterThan(par2Idx);
  });

  it('emits all tool_call events before all tool_result events in parallel mode', async () => {
    const toolCall1: ToolCallRequest = { id: 'tc1', name: 'tool_a', arguments: '{}' };
    const toolCall2: ToolCallRequest = { id: 'tc2', name: 'tool_b', arguments: '{}' };

    const adapter = createMockAdapter([
      { message: { role: 'assistant', content: '', toolCalls: [toolCall1, toolCall2] }, usage: USAGE },
      { message: { role: 'assistant', content: 'done' }, usage: USAGE },
    ]);
    const onToolCall = vi.fn().mockResolvedValue('ok');

    const loop = new AgentLoop({ adapter, onToolCall, parallel: true });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

    const relevantTypes = events
      .filter((e) => e.type === 'tool_call' || e.type === 'tool_result')
      .map((e) => e.type);

    expect(relevantTypes).toEqual(['tool_call', 'tool_call', 'tool_result', 'tool_result']);
  });

  it('preserves conversation order for tool result messages in parallel mode', async () => {
    const toolCall1: ToolCallRequest = { id: 'tc1', name: 'slow_tool', arguments: '{}' };
    const toolCall2: ToolCallRequest = { id: 'tc2', name: 'fast_tool', arguments: '{}' };

    const adapter = createMockAdapter([
      { message: { role: 'assistant', content: '', toolCalls: [toolCall1, toolCall2] }, usage: USAGE },
      { message: { role: 'assistant', content: 'done' }, usage: USAGE },
    ]);
    const onToolCall = vi.fn().mockImplementation(async (call: ToolCallRequest) => {
      const delay = call.name === 'slow_tool' ? 40 : 5;
      await new Promise((r) => setTimeout(r, delay));
      return `result_${call.name}`;
    });

    const loop = new AgentLoop({ adapter, onToolCall, parallel: true });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

    const resultEvents = events.filter((e) => e.type === 'tool_result') as Array<
      Extract<AgentEvent, { type: 'tool_result' }>
    >;

    expect(resultEvents[0].toolCallId).toBe('tc1');
    expect(resultEvents[1].toolCallId).toBe('tc2');
  });

  it('uses a custom ExecutionStrategy when provided', async () => {
    const toolCall1: ToolCallRequest = { id: 'tc1', name: 'tool_a', arguments: '{}' };

    const customStrategy: ExecutionStrategy = {
      async execute(calls, handler) {
        const results: ToolExecutionResult[] = [];
        for (const call of calls) {
          const result = await handler(call);
          results.push({ toolCallId: call.id, result: `custom:${result}` });
        }
        return results;
      },
    };

    const adapter = createMockAdapter([
      { message: { role: 'assistant', content: '', toolCalls: [toolCall1] }, usage: USAGE },
      { message: { role: 'assistant', content: 'done' }, usage: USAGE },
    ]);
    const onToolCall = vi.fn().mockResolvedValue('raw');

    const loop = new AgentLoop({ adapter, onToolCall, executionStrategy: customStrategy });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

    const resultEvent = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(resultEvent.result).toBe('custom:raw');
  });

  it('handles single tool call correctly in parallel mode', async () => {
    const toolCall1: ToolCallRequest = { id: 'tc1', name: 'only_tool', arguments: '{}' };

    const adapter = createMockAdapter([
      { message: { role: 'assistant', content: '', toolCalls: [toolCall1] }, usage: USAGE },
      { message: { role: 'assistant', content: 'done' }, usage: USAGE },
    ]);
    const onToolCall = vi.fn().mockResolvedValue('result');

    const loop = new AgentLoop({ adapter, onToolCall, parallel: true });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('done');

    const resultEvent = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(resultEvent.result).toBe('result');
    expect(resultEvent.toolCallId).toBe('tc1');
  });
});
