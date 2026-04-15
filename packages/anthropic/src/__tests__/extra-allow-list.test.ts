/**
 * T05 (Wave-5A): Anthropic adapter `LLMConfig.extra` allow-list + warn + strict mode.
 *
 * Validates that:
 *   - Keys in the Anthropic allow-list are forwarded to the provider verbatim.
 *   - Keys outside the allow-list are filtered out (default, non-strict).
 *   - A single warn is emitted via the injected logger when keys are filtered,
 *     with meta.rejected listing the filtered keys.
 *   - When `strictExtraAllowList: true`, rejected keys cause a `HarnessError`
 *     with `code === HarnessErrorCode.ADAPTER_INVALID_EXTRA`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAnthropicAdapter } from '../index.js';
import type { AnthropicAdapterConfig } from '../index.js';
import { HarnessError, HarnessErrorCode} from 'harness-one/core';

function createMockAnthropicClient() {
  const createFn = vi.fn();
  const streamFn = vi.fn();
  return {
    client: {
      messages: {
        create: createFn,
        stream: streamFn,
      },
    } as unknown as AnthropicAdapterConfig['client'],
    mocks: { create: createFn, stream: streamFn },
  };
}

describe('Anthropic adapter: extra allow-list (T05)', () => {
  let mock: ReturnType<typeof createMockAnthropicClient>;

  beforeEach(() => {
    mock = createMockAnthropicClient();
    mock.mocks.create.mockResolvedValue({
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  it('forwards an allow-listed key (temperature) verbatim into the request body', async () => {
    const adapter = createAnthropicAdapter({ client: mock.client });
    await adapter.chat({
      messages: [{ role: 'user', content: 'hi' }],
      config: { extra: { temperature: 0.5 } },
    });

    const body = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
    expect(body.temperature).toBe(0.5);
  });

  it('filters out unknown keys (non-strict) and emits a single warn with meta.rejected', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const adapter = createAnthropicAdapter({ client: mock.client, logger });
    await adapter.chat({
      messages: [{ role: 'user', content: 'hi' }],
      config: { extra: { temperature: 0.5, evil_key: 1 } },
    });

    const body = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
    expect(body.temperature).toBe(0.5);
    expect(body).not.toHaveProperty('evil_key');

    // Filter warns should use the injected logger.warn exactly once with the rejected list in meta.
    const filterWarnCalls = logger.warn.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('extra keys filtered'),
    );
    expect(filterWarnCalls).toHaveLength(1);
    const meta = filterWarnCalls[0][1] as { rejected: string[] };
    expect(meta.rejected).toEqual(['evil_key']);
  });

  it('throws HarnessError(ADAPTER_INVALID_EXTRA) when strictExtraAllowList=true and unknown keys are present', async () => {
    const adapter = createAnthropicAdapter({
      client: mock.client,
      strictExtraAllowList: true,
    });

    await expect(
      adapter.chat({
        messages: [{ role: 'user', content: 'hi' }],
        config: { extra: { evil_key: 1 } },
      }),
    ).rejects.toMatchObject({
      name: 'HarnessError',
      code: HarnessErrorCode.ADAPTER_INVALID_EXTRA,
    });

    // Also sanity-check the message mentions the rejected key.
    try {
      await adapter.chat({
        messages: [{ role: 'user', content: 'hi' }],
        config: { extra: { evil_key: 1 } },
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).message).toContain('evil_key');
      expect((err as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_INVALID_EXTRA);
    }
  });

  it('does not warn or throw when extra is undefined', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const adapter = createAnthropicAdapter({
      client: mock.client,
      logger,
      strictExtraAllowList: true,
    });

    await expect(
      adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).resolves.toBeDefined();

    const filterWarnCalls = logger.warn.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('extra keys filtered'),
    );
    expect(filterWarnCalls).toHaveLength(0);
  });

  it('passes every allow-listed key through (full allow-list transit)', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const adapter = createAnthropicAdapter({ client: mock.client, logger });

    const fullExtra = {
      temperature: 0.3,
      top_k: 40,
      top_p: 0.9,
      stop_sequences: ['STOP'],
      thinking: { budget_tokens: 1024 },
      metadata: { user_id: 'u-1' },
      system: 'override system text',
    };
    await adapter.chat({
      messages: [{ role: 'user', content: 'hi' }],
      config: { extra: fullExtra },
    });

    const body = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
    for (const [k, v] of Object.entries(fullExtra)) {
      expect(body[k]).toEqual(v);
    }

    // No filter warn should fire.
    const filterWarnCalls = logger.warn.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('extra keys filtered'),
    );
    expect(filterWarnCalls).toHaveLength(0);
  });

  it('partial rejection: forwards allow-listed keys, filters unknown, warns once', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const adapter = createAnthropicAdapter({ client: mock.client, logger });

    await adapter.chat({
      messages: [{ role: 'user', content: 'hi' }],
      config: {
        extra: { temperature: 0.5, top_p: 0.9, unknown: 'x' },
      },
    });

    const body = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.9);
    expect(body).not.toHaveProperty('unknown');

    const filterWarnCalls = logger.warn.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('extra keys filtered'),
    );
    expect(filterWarnCalls).toHaveLength(1);
    const meta = filterWarnCalls[0][1] as { rejected: string[] };
    expect(meta.rejected).toEqual(['unknown']);
  });

  it('stream() also filters extra keys', async () => {
    function createMockStream(events: unknown[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
        finalMessage: vi.fn().mockResolvedValue({
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      };
    }
    mock.mocks.stream.mockReturnValue(createMockStream([]));

    const logger = { warn: vi.fn(), error: vi.fn() };
    const adapter = createAnthropicAdapter({ client: mock.client, logger });
    for await (const _c of adapter.stream!({
      messages: [{ role: 'user', content: 'hi' }],
      config: { extra: { temperature: 0.7, evil_key: 1 } },
    })) { /* consume */ }

    const body = mock.mocks.stream.mock.calls[0][0] as Record<string, unknown>;
    expect(body.temperature).toBe(0.7);
    expect(body).not.toHaveProperty('evil_key');

    const filterWarnCalls = logger.warn.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('extra keys filtered'),
    );
    expect(filterWarnCalls).toHaveLength(1);
  });

  it('stream() throws ADAPTER_INVALID_EXTRA under strict mode before touching the client', async () => {
    const adapter = createAnthropicAdapter({
      client: mock.client,
      strictExtraAllowList: true,
    });

    const iter = adapter.stream!({
      messages: [{ role: 'user', content: 'hi' }],
      config: { extra: { evil_key: 1 } },
    });

    await expect((async () => {
      for await (const _c of iter) { /* consume */ }
    })()).rejects.toMatchObject({
      name: 'HarnessError',
      code: HarnessErrorCode.ADAPTER_INVALID_EXTRA,
    });

    expect(mock.mocks.stream).not.toHaveBeenCalled();
  });
});
