import { describe, it, expect } from 'vitest';
import { createMockAdapter } from '../test-utils.js';

describe('createMockAdapter', () => {
  it('returns an adapter with a chat method', () => {
    const adapter = createMockAdapter({ responses: [{ content: 'Hello' }] });
    expect(typeof adapter.chat).toBe('function');
  });

  it('records calls in the calls array', async () => {
    const adapter = createMockAdapter({ responses: [{ content: 'Hi' }] });
    const params = { messages: [{ role: 'user' as const, content: 'Hello' }] };
    await adapter.chat(params);

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toBe(params);
  });

  it('returns responses in order', async () => {
    const adapter = createMockAdapter({
      responses: [
        { content: 'First' },
        { content: 'Second' },
        { content: 'Third' },
      ],
    });

    const r1 = await adapter.chat({ messages: [] });
    const r2 = await adapter.chat({ messages: [] });
    const r3 = await adapter.chat({ messages: [] });

    expect(r1.message.content).toBe('First');
    expect(r2.message.content).toBe('Second');
    expect(r3.message.content).toBe('Third');
  });

  it('repeats the last response when exhausted', async () => {
    const adapter = createMockAdapter({
      responses: [{ content: 'Only' }],
    });

    const r1 = await adapter.chat({ messages: [] });
    const r2 = await adapter.chat({ messages: [] });
    const r3 = await adapter.chat({ messages: [] });

    expect(r1.message.content).toBe('Only');
    expect(r2.message.content).toBe('Only');
    expect(r3.message.content).toBe('Only');
  });

  it('returns assistant role messages', async () => {
    const adapter = createMockAdapter({ responses: [{ content: 'test' }] });
    const response = await adapter.chat({ messages: [] });
    expect(response.message.role).toBe('assistant');
  });

  it('includes token usage in responses', async () => {
    const adapter = createMockAdapter({ responses: [{ content: 'test' }] });
    const response = await adapter.chat({ messages: [] });
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('includes tool calls when specified', async () => {
    const toolCalls = [{ id: 'tc-1', name: 'search', arguments: '{"q":"test"}' }] as const;
    const adapter = createMockAdapter({
      responses: [{ content: '', toolCalls }],
    });

    const response = await adapter.chat({ messages: [] });
    expect(response.message.role).toBe('assistant');
    if (response.message.role === 'assistant') {
      expect(response.message.toolCalls).toEqual(toolCalls);
    }
  });

  it('omits toolCalls field when not specified', async () => {
    const adapter = createMockAdapter({ responses: [{ content: 'Hello' }] });
    const response = await adapter.chat({ messages: [] });
    expect(response.message).not.toHaveProperty('toolCalls');
  });

  it('starts with empty calls array', () => {
    const adapter = createMockAdapter({ responses: [{ content: 'test' }] });
    expect(adapter.calls).toHaveLength(0);
  });

  it('records multiple calls with different params', async () => {
    const adapter = createMockAdapter({
      responses: [{ content: 'r1' }, { content: 'r2' }],
    });

    const p1 = { messages: [{ role: 'user' as const, content: 'Hello' }] };
    const p2 = { messages: [{ role: 'user' as const, content: 'World' }] };

    await adapter.chat(p1);
    await adapter.chat(p2);

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0]).toBe(p1);
    expect(adapter.calls[1]).toBe(p2);
  });
});
