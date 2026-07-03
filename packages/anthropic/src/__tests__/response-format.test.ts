/**
 * Anthropic adapter `ChatParams.responseFormat` support (C2).
 *
 * Anthropic has no native JSON mode, so per docs/provider-spec.md §"responseFormat
 * handling" the adapter implements structured output by appending a system-level
 * instruction:
 *   - `text` (or omitted)  → no-op.
 *   - `json_object`        → append "Respond with a single JSON object."
 *   - `json_schema`        → the same hint plus the serialized JSON schema.
 *
 * The instruction composes with an existing system message (from extractSystem)
 * and applies identically on the streaming path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAnthropicAdapter } from '../index.js';
import type { AnthropicAdapterConfig } from '../index.js';
import type { JsonSchema } from 'harness-one/core';

function createMockAnthropicClient() {
  const createFn = vi.fn();
  const streamFn = vi.fn();
  return {
    client: {
      messages: { create: createFn, stream: streamFn },
    } as unknown as AnthropicAdapterConfig['client'],
    mocks: { create: createFn, stream: streamFn },
  };
}

function createMockStream(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    finalMessage: vi.fn().mockResolvedValue({ usage: { input_tokens: 1, output_tokens: 1 } }),
  };
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
};

describe('Anthropic adapter: responseFormat', () => {
  let mock: ReturnType<typeof createMockAnthropicClient>;

  beforeEach(() => {
    mock = createMockAnthropicClient();
    mock.mocks.create.mockResolvedValue({
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  function bodyOf(): Record<string, unknown> {
    return mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
  }

  it('text is a no-op (no system field injected when none exists)', async () => {
    const adapter = createAnthropicAdapter({ client: mock.client });
    await adapter.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      responseFormat: { type: 'text' },
    });
    expect(bodyOf().system).toBeUndefined();
  });

  it('text leaves an existing system message untouched', async () => {
    const adapter = createAnthropicAdapter({ client: mock.client });
    await adapter.chat({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ],
      responseFormat: { type: 'text' },
    });
    expect(bodyOf().system).toBe('You are helpful');
  });

  it('json_object appends the JSON instruction when there is no system message', async () => {
    const adapter = createAnthropicAdapter({ client: mock.client });
    await adapter.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      responseFormat: { type: 'json_object' },
    });
    expect(bodyOf().system).toBe('Respond with a single JSON object.');
  });

  it('json_object composes with an existing system message', async () => {
    const adapter = createAnthropicAdapter({ client: mock.client });
    await adapter.chat({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ],
      responseFormat: { type: 'json_object' },
    });
    expect(bodyOf().system).toBe('You are helpful\n\nRespond with a single JSON object.');
  });

  it('json_schema appends the JSON instruction plus the serialized schema', async () => {
    const adapter = createAnthropicAdapter({ client: mock.client });
    await adapter.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      responseFormat: { type: 'json_schema', schema: SCHEMA },
    });
    const system = bodyOf().system as string;
    expect(system).toContain('Respond with a single JSON object.');
    expect(system).toContain(JSON.stringify(SCHEMA));
  });

  it('json_schema composes with an existing system message', async () => {
    const adapter = createAnthropicAdapter({ client: mock.client });
    await adapter.chat({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ],
      responseFormat: { type: 'json_schema', schema: SCHEMA },
    });
    const system = bodyOf().system as string;
    expect(system.startsWith('You are helpful\n\n')).toBe(true);
    expect(system).toContain(JSON.stringify(SCHEMA));
  });

  it('omitting responseFormat entirely leaves the request unchanged', async () => {
    const adapter = createAnthropicAdapter({ client: mock.client });
    await adapter.chat({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ],
    });
    expect(bodyOf().system).toBe('You are helpful');
  });

  it('applies the same treatment on the streaming path', async () => {
    mock.mocks.stream.mockReturnValue(
      createMockStream([
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } },
      ]),
    );

    const adapter = createAnthropicAdapter({ client: mock.client });
    for await (const _c of adapter.stream!({
      messages: [
        { role: 'system', content: 'Be terse' },
        { role: 'user', content: 'Hi' },
      ],
      responseFormat: { type: 'json_object' },
    })) {
      /* consume */
    }

    const body = mock.mocks.stream.mock.calls[0][0] as Record<string, unknown>;
    expect(body.system).toBe('Be terse\n\nRespond with a single JSON object.');
  });
});
