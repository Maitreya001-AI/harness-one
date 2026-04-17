/**
 * Streaming-path integration tests for {@link AgentLoop}.
 *
 * Wave-16 M1 extraction from `agent-loop.test.ts`. Covers the full
 * streaming surface — `text_delta` / `tool_call_delta` forwarding,
 * fallback to `chat()` when `stream()` is absent, stream-error handling,
 * tool dispatch through the stream path, and tool-schema propagation.
 *
 * The monolith kept these scenarios inline alongside ~2800 other lines.
 * Splitting them out lets contributors modify the streaming state
 * machine without reading 3k LOC of unrelated coverage; the shared
 * fixtures live in `agent-loop-test-fixtures.ts` so setup is not
 * duplicated.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../agent-loop.js';
import type {
  AgentAdapter,
  StreamChunk,
  ToolSchema,
} from '../types.js';
import type { AgentEvent } from '../events.js';
import { collectEvents, USAGE } from './agent-loop-test-fixtures.js';

describe('AgentLoop streaming', () => {
  it('uses adapter.stream() and yields text_delta events when streaming is enabled', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
    ];

    const adapter: AgentAdapter = {
      async chat() {
        return { message: { role: 'assistant', content: 'Hello world' }, usage: USAGE };
      },
      async *stream() {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };

    const loop = new AgentLoop({ adapter, streaming: true });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas).toHaveLength(2);
    expect((deltas[0] as Extract<AgentEvent, { type: 'text_delta' }>).text).toBe('Hello');
    expect((deltas[1] as Extract<AgentEvent, { type: 'text_delta' }>).text).toBe(' world');

    const msgEvent = events.find((e) => e.type === 'message');
    expect(msgEvent).toBeDefined();
    expect((msgEvent as Extract<AgentEvent, { type: 'message' }>).message.content).toBe('Hello world');

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
  });

  it('handles streaming with tool calls', async () => {
    const toolCallChunks: StreamChunk[] = [
      { type: 'tool_call_delta', toolCall: { id: 'call_1', name: 'search' } },
      { type: 'tool_call_delta', toolCall: { arguments: '{"q":"test"}' } },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
    ];
    const textChunks: StreamChunk[] = [
      { type: 'text_delta', text: 'Found it!' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
    ];
    let callCount = 0;

    const adapter: AgentAdapter = {
      async chat() {
        throw new Error('Should not be called in streaming mode');
      },
      async *stream() {
        callCount++;
        if (callCount === 1) {
          for (const chunk of toolCallChunks) yield chunk;
        } else {
          for (const chunk of textChunks) yield chunk;
        }
      },
    };
    const onToolCall = vi.fn().mockResolvedValue('search result');

    const loop = new AgentLoop({ adapter, onToolCall, streaming: true });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'search' }]));

    expect(events.find((e) => e.type === 'tool_call')).toBeDefined();
    expect(events.find((e) => e.type === 'tool_result')).toBeDefined();
    expect(events.filter((e) => e.type === 'text_delta').length).toBeGreaterThan(0);
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });

  it('falls back to chat() when streaming is enabled but adapter has no stream()', async () => {
    const adapter: AgentAdapter = {
      async chat() {
        return { message: { role: 'assistant', content: 'Hello' }, usage: USAGE };
      },
    };

    const loop = new AgentLoop({ adapter, streaming: true });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

    expect(events.find((e) => e.type === 'message')).toBeDefined();
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });

  it('accumulates full response text in conversation history for subsequent iterations', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text_delta', text: 'Accumulated' },
      { type: 'text_delta', text: ' response' },
      { type: 'text_delta', text: ' text' },
      { type: 'done', usage: { inputTokens: 20, outputTokens: 10 } },
    ];

    const adapter: AgentAdapter = {
      async chat() {
        throw new Error('Should not be called when stream() is available');
      },
      async *stream() {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };

    const loop = new AgentLoop({ adapter, streaming: true });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(3);

    const msgEvent = events.find((e) => e.type === 'message') as Extract<AgentEvent, { type: 'message' }>;
    expect(msgEvent).toBeDefined();
    expect(msgEvent.message.content).toBe('Accumulated response text');
    expect(msgEvent.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it('yields tool_call_delta events during streaming', async () => {
    const chunks: StreamChunk[] = [
      { type: 'tool_call_delta', toolCall: { id: 'tc1', name: 'readFile' } },
      { type: 'tool_call_delta', toolCall: { arguments: '{"path":' } },
      { type: 'tool_call_delta', toolCall: { arguments: '"test.ts"}' } },
      { type: 'done', usage: USAGE },
    ];

    let callCount = 0;
    const adapter: AgentAdapter = {
      async chat() {
        throw new Error('Should not be called');
      },
      async *stream() {
        callCount++;
        if (callCount === 1) {
          for (const chunk of chunks) yield chunk;
        } else {
          yield { type: 'text_delta' as const, text: 'Done!' };
          yield { type: 'done' as const, usage: USAGE };
        }
      },
    };
    const onToolCall = vi.fn().mockResolvedValue('file contents');

    const loop = new AgentLoop({ adapter, onToolCall, streaming: true });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'read file' }]));

    expect(events.filter((e) => e.type === 'tool_call_delta').length).toBeGreaterThanOrEqual(3);

    const toolCallEvent = events.find((e) => e.type === 'tool_call') as Extract<AgentEvent, { type: 'tool_call' }>;
    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent.toolCall.name).toBe('readFile');
    expect(toolCallEvent.toolCall.arguments).toBe('{"path":"test.ts"}');
  });

  it('does not call chat() when streaming is enabled and adapter has stream()', async () => {
    const chatSpy = vi.fn();
    const adapter: AgentAdapter = {
      async chat() {
        chatSpy();
        return { message: { role: 'assistant', content: 'fallback' }, usage: USAGE };
      },
      async *stream() {
        yield { type: 'text_delta' as const, text: 'streamed' };
        yield { type: 'done' as const, usage: USAGE };
      },
    };

    const loop = new AgentLoop({ adapter, streaming: true });
    await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

    expect(chatSpy).not.toHaveBeenCalled();
  });

  it('fallback to chat() produces no text_delta events', async () => {
    const adapter: AgentAdapter = {
      async chat() {
        return { message: { role: 'assistant', content: 'Via chat' }, usage: USAGE };
      },
    };

    const loop = new AgentLoop({ adapter, streaming: true });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(0);

    const msg = events.find((e) => e.type === 'message') as Extract<AgentEvent, { type: 'message' }>;
    expect(msg.message.content).toBe('Via chat');
  });

  it('handles stream() throwing an error gracefully', async () => {
    const adapter: AgentAdapter = {
      async chat() {
        return { message: { role: 'assistant', content: 'fallback' }, usage: USAGE };
      },
      async *stream() {
        yield { type: 'text_delta' as const, text: 'partial' };
        throw new Error('Stream connection lost');
      },
    };

    const loop = new AgentLoop({ adapter, streaming: true });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

    expect(events.find((e) => e.type === 'error')).toBeDefined();

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect((done as Extract<AgentEvent, { type: 'done' }>).reason).toBe('error');
  });

  it('passes tools to adapter.stream() when configured', async () => {
    let receivedTools: readonly ToolSchema[] | undefined;
    const adapter: AgentAdapter = {
      async chat() {
        throw new Error('Should not be called');
      },
      async *stream(params) {
        receivedTools = params.tools;
        yield { type: 'text_delta' as const, text: 'hi' };
        yield { type: 'done' as const, usage: USAGE };
      },
    };

    const tools: ToolSchema[] = [
      { name: 'search', description: 'Search', parameters: { type: 'object' } },
    ];

    const loop = new AgentLoop({ adapter, streaming: true, tools });
    await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

    expect(receivedTools).toEqual(tools);
  });
});
