/**
 * Tests for OpenAI adapter `LLMConfig.extra` allow-list filtering (T06).
 *
 * Contract (symmetric to T05 anthropic):
 *  - Keys within the OpenAI allow-list transparently flow through.
 *  - Keys outside the allow-list are filtered out by default, with a single
 *    warn-level log entry enumerating the rejected keys.
 *  - With `strictExtraAllowList: true`, an unknown key raises
 *    `HarnessError { code: HarnessErrorCode.ADAPTER_INVALID_EXTRA }`.
 *  - `extra: undefined` / missing produces no warning and no extra keys.
 *  - Mixed payloads forward allowed keys and warn about the rejected subset.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockOpenAIConstructor } = vi.hoisted(() => {
  const mockCreateFn = vi.fn();
  const mockOpenAIConstructor = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreateFn,
      },
    },
    _mockCreate: mockCreateFn,
  }));
  return { mockOpenAIConstructor };
});

vi.mock('openai', () => ({
  default: mockOpenAIConstructor,
}));

import { createOpenAIAdapter } from '../index.js';
import type { OpenAIAdapterConfig } from '../index.js';
import { HarnessError, HarnessErrorCode} from 'harness-one/core';

function createMockOpenAIClient() {
  const createFn = vi.fn();
  return {
    client: {
      chat: {
        completions: {
          create: createFn,
        },
      },
    } as unknown as NonNullable<OpenAIAdapterConfig['client']>,
    mocks: { create: createFn },
  };
}

function createWarnCapturingLogger(): {
  logger: NonNullable<OpenAIAdapterConfig['logger']>;
  warnCalls: Array<{ msg: string; meta?: Record<string, unknown> }>;
  errorCalls: Array<{ msg: string; meta?: Record<string, unknown> }>;
} {
  const warnCalls: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const errorCalls: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  return {
    warnCalls,
    errorCalls,
    logger: {
      warn: (msg: string, meta?: Record<string, unknown>): void => {
        warnCalls.push({ msg, ...(meta !== undefined && { meta }) });
      },
      error: (msg: string, meta?: Record<string, unknown>): void => {
        errorCalls.push({ msg, ...(meta !== undefined && { meta }) });
      },
    },
  };
}

/** Minimum-valid chat completion response fixture. */
function okResponse(): unknown {
  return {
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

describe('OpenAI adapter — LLMConfig.extra allow-list (T06)', () => {
  let mock: ReturnType<typeof createMockOpenAIClient>;

  beforeEach(() => {
    mock = createMockOpenAIClient();
    mock.mocks.create.mockResolvedValue(okResponse());
  });

  it('forwards allow-list keys unchanged to the provider', async () => {
    const { logger, warnCalls } = createWarnCapturingLogger();
    const adapter = createOpenAIAdapter({ client: mock.client, logger });

    await adapter.chat({
      messages: [{ role: 'user', content: 'hi' }],
      config: { extra: { temperature: 0.2, seed: 42 } },
    });

    const sentArgs = mock.mocks.create.mock.calls[0][0];
    expect(sentArgs.temperature).toBe(0.2);
    expect(sentArgs.seed).toBe(42);
    expect(warnCalls).toHaveLength(0);
  });

  it('filters unknown keys by default and emits a single warn listing rejects', async () => {
    const { logger, warnCalls } = createWarnCapturingLogger();
    const adapter = createOpenAIAdapter({ client: mock.client, logger });

    await adapter.chat({
      messages: [{ role: 'user', content: 'hi' }],
      config: { extra: { not_a_real_param: 1, also_bad: 'x' } },
    });

    const sentArgs = mock.mocks.create.mock.calls[0][0];
    expect(sentArgs.not_a_real_param).toBeUndefined();
    expect(sentArgs.also_bad).toBeUndefined();

    // Exactly one warn call describing the filtered keys.
    expect(warnCalls).toHaveLength(1);
    const warn = warnCalls[0]!;
    expect(warn.msg).toMatch(/extra/i);
    // Rejected keys are surfaced (either in the message or in structured meta).
    const rejectedRepr = JSON.stringify(warn);
    expect(rejectedRepr).toContain('not_a_real_param');
    expect(rejectedRepr).toContain('also_bad');
  });

  it('throws ADAPTER_INVALID_EXTRA when strictExtraAllowList is true and an unknown key is present', async () => {
    const { logger } = createWarnCapturingLogger();
    const adapter = createOpenAIAdapter({
      client: mock.client,
      logger,
      strictExtraAllowList: true,
    });

    await expect(
      adapter.chat({
        messages: [{ role: 'user', content: 'hi' }],
        config: { extra: { not_a_real_param: 1 } },
      }),
    ).rejects.toMatchObject({
      name: 'HarnessError',
      code: HarnessErrorCode.ADAPTER_INVALID_EXTRA,
    });

    // The provider MUST NOT be called when strict mode rejects the payload.
    expect(mock.mocks.create).not.toHaveBeenCalled();
  });

  it('throws a HarnessError instance (not a bare Error) in strict mode', async () => {
    const adapter = createOpenAIAdapter({
      client: mock.client,
      strictExtraAllowList: true,
    });

    const err = await adapter
      .chat({
        messages: [{ role: 'user', content: 'hi' }],
        config: { extra: { nope: true } },
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_INVALID_EXTRA);
  });

  it('is a no-op when extra is undefined — no warn and no injected keys', async () => {
    const { logger, warnCalls } = createWarnCapturingLogger();
    const adapter = createOpenAIAdapter({ client: mock.client, logger });

    await adapter.chat({
      messages: [{ role: 'user', content: 'hi' }],
      // Intentionally no config.extra.
    });

    expect(warnCalls).toHaveLength(0);
    const sentArgs = mock.mocks.create.mock.calls[0][0];
    // Spot-check: no spurious keys spilled in.
    expect(sentArgs).not.toHaveProperty('not_a_real_param');
  });

  it('forwards every allow-list key without warnings when all are valid', async () => {
    const { logger, warnCalls } = createWarnCapturingLogger();
    const adapter = createOpenAIAdapter({ client: mock.client, logger });

    const fullAllowList = {
      temperature: 0.7,
      top_p: 0.95,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      stop: ['END'],
      seed: 7,
      response_format: { type: 'json_object' as const },
      user: 'u-1',
      service_tier: 'auto',
      parallel_tool_calls: false,
    };

    await adapter.chat({
      messages: [{ role: 'user', content: 'hi' }],
      config: { extra: fullAllowList },
    });

    const sentArgs = mock.mocks.create.mock.calls[0][0];
    for (const [k, v] of Object.entries(fullAllowList)) {
      expect(sentArgs[k]).toEqual(v);
    }
    expect(warnCalls).toHaveLength(0);
  });

  it('mixed allow + deny payload: forwards allowed keys and warns about rejected ones', async () => {
    const { logger, warnCalls } = createWarnCapturingLogger();
    const adapter = createOpenAIAdapter({ client: mock.client, logger });

    await adapter.chat({
      messages: [{ role: 'user', content: 'hi' }],
      config: {
        extra: {
          temperature: 0.3,
          seed: 9,
          bogus_one: 1,
          bogus_two: 2,
        },
      },
    });

    const sentArgs = mock.mocks.create.mock.calls[0][0];
    // Allowed forwarded.
    expect(sentArgs.temperature).toBe(0.3);
    expect(sentArgs.seed).toBe(9);
    // Rejected filtered.
    expect(sentArgs.bogus_one).toBeUndefined();
    expect(sentArgs.bogus_two).toBeUndefined();

    // One warn listing BOTH rejected keys.
    expect(warnCalls).toHaveLength(1);
    const rejectedRepr = JSON.stringify(warnCalls[0]);
    expect(rejectedRepr).toContain('bogus_one');
    expect(rejectedRepr).toContain('bogus_two');
  });

  it('applies the same filtering on stream() path', async () => {
    const { logger, warnCalls } = createWarnCapturingLogger();
    const adapter = createOpenAIAdapter({ client: mock.client, logger });

    // stream() consumes an async iterable — return an empty one that ends cleanly.
    mock.mocks.create.mockResolvedValue({
      [Symbol.asyncIterator]: async function* (): AsyncIterator<unknown> {
        // no chunks — exercises the "no usage" code path but shouldn't affect this test
      },
    });

    const iter = adapter.stream({
      messages: [{ role: 'user', content: 'hi' }],
      config: { extra: { temperature: 0.5, nope: true } },
    });
    for await (const _chunk of iter) {
      // drain
    }

    const sentArgs = mock.mocks.create.mock.calls[0][0];
    expect(sentArgs.temperature).toBe(0.5);
    expect(sentArgs.nope).toBeUndefined();

    // At least one warn about the rejected key (the stream path may log an
    // additional "stream ended without usage" warn — allow, but require our
    // extra-filter warn to be present).
    const joined = warnCalls.map((c) => JSON.stringify(c)).join('\n');
    expect(joined).toContain('nope');
  });
});
