/**
 * Anthropic adapter error normalization (C1a).
 *
 * Validates that raw SDK / network errors thrown from `client.messages.create`
 * (chat) and `client.messages.stream` / `finalMessage()` (stream) are mapped
 * to typed `HarnessError`s per docs/provider-spec.md's "Error mapping" table:
 *
 *   - HTTP 401 / 403 / invalid key → ADAPTER_AUTH
 *   - HTTP 429                     → ADAPTER_RATE_LIMIT
 *   - HTTP 5xx / unavailable       → ADAPTER_UNAVAILABLE
 *   - timeout / ECONNRESET / net   → ADAPTER_NETWORK
 *   - other 4xx                    → ADAPTER_ERROR
 *   - fully-unknown throwable      → ADAPTER_UNKNOWN
 *
 * In every case the original throwable is preserved as `cause`. Abort
 * semantics are unchanged: chat() rethrows the raw abort error, stream()
 * yields a terminal zero-usage done chunk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAnthropicAdapter } from '../index.js';
import type { AnthropicAdapterConfig } from '../index.js';
import type { StreamChunk } from 'harness-one/core';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

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

/** Build an Error carrying an SDK-style numeric `.status`. */
function apiError(status: number, message: string): Error {
  const err = new Error(message);
  (err as Error & { status: number }).status = status;
  return err;
}

/** An async-iterable stream stub whose finalMessage() rejects. */
function rejectingStream(rejection: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'content_block_start', content_block: { type: 'text' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } };
    },
    finalMessage: vi.fn().mockRejectedValue(rejection),
  };
}

async function drainStream(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iter) chunks.push(chunk);
  return chunks;
}

const USER = [{ role: 'user' as const, content: 'Hi' }];

// Table of (label, thrown error, expected code) for the message-classified
// and status-classified cases shared across chat() and stream().
const CASES: ReadonlyArray<{ label: string; err: unknown; code: HarnessErrorCode }> = [
  { label: 'HTTP 401', err: apiError(401, 'Unauthorized'), code: HarnessErrorCode.ADAPTER_AUTH },
  { label: 'HTTP 403', err: apiError(403, 'Forbidden'), code: HarnessErrorCode.ADAPTER_AUTH },
  { label: 'HTTP 429', err: apiError(429, 'Too Many Requests'), code: HarnessErrorCode.ADAPTER_RATE_LIMIT },
  { label: 'HTTP 500', err: apiError(500, 'Internal Server Error'), code: HarnessErrorCode.ADAPTER_UNAVAILABLE },
  { label: 'HTTP 503', err: apiError(503, 'Service Unavailable'), code: HarnessErrorCode.ADAPTER_UNAVAILABLE },
  { label: 'HTTP 408', err: apiError(408, 'Request Timeout'), code: HarnessErrorCode.ADAPTER_NETWORK },
  { label: 'HTTP 400 (other 4xx)', err: apiError(400, 'Bad Request'), code: HarnessErrorCode.ADAPTER_ERROR },
];

describe('Anthropic adapter: error normalization', () => {
  let mock: ReturnType<typeof createMockAnthropicClient>;

  beforeEach(() => {
    mock = createMockAnthropicClient();
  });

  describe('chat()', () => {
    for (const { label, err, code } of CASES) {
      it(`maps ${label} → ${code} with cause preserved`, async () => {
        mock.mocks.create.mockRejectedValue(err);
        const adapter = createAnthropicAdapter({ client: mock.client });

        try {
          await adapter.chat({ messages: USER });
          throw new Error('expected chat() to throw');
        } catch (caught) {
          expect(caught).toBeInstanceOf(HarnessError);
          expect((caught as HarnessError).code).toBe(code);
          expect((caught as HarnessError).cause).toBe(err);
        }
      });
    }

    it('maps a connection error (ECONNRESET, no status) → ADAPTER_NETWORK', async () => {
      const err = new Error('read ECONNRESET');
      (err as Error & { code: string }).code = 'ECONNRESET';
      mock.mocks.create.mockRejectedValue(err);
      const adapter = createAnthropicAdapter({ client: mock.client });

      await expect(adapter.chat({ messages: USER })).rejects.toMatchObject({
        code: HarnessErrorCode.ADAPTER_NETWORK,
        cause: err,
      });
    });

    it('maps a JSON parse failure (no status) → ADAPTER_PARSE', async () => {
      const err = new Error('Unexpected token < in JSON at position 0');
      mock.mocks.create.mockRejectedValue(err);
      const adapter = createAnthropicAdapter({ client: mock.client });

      try {
        await adapter.chat({ messages: USER });
        throw new Error('expected chat() to throw');
      } catch (caught) {
        expect(caught).toBeInstanceOf(HarnessError);
        expect((caught as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_PARSE);
        expect((caught as HarnessError).suggestion).toMatch(/unparseable/);
      }
    });

    it('maps a fully-unknown (non-Error) throwable → ADAPTER_UNKNOWN', async () => {
      mock.mocks.create.mockRejectedValue('kaboom');
      const adapter = createAnthropicAdapter({ client: mock.client });

      try {
        await adapter.chat({ messages: USER });
        throw new Error('expected chat() to throw');
      } catch (caught) {
        expect(caught).toBeInstanceOf(HarnessError);
        expect((caught as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_UNKNOWN);
        // Non-Error throwables carry no `cause`.
        expect((caught as HarnessError).cause).toBeUndefined();
      }
    });

    it('rethrows a raw AbortError unchanged (does not normalize aborts)', async () => {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      mock.mocks.create.mockRejectedValue(abortErr);
      const adapter = createAnthropicAdapter({ client: mock.client });

      await expect(adapter.chat({ messages: USER })).rejects.toBe(abortErr);
    });

    it('rethrows the raw error unchanged when the signal is aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const raw = new Error('socket closed');
      mock.mocks.create.mockRejectedValue(raw);
      const adapter = createAnthropicAdapter({ client: mock.client });

      // signal.aborted === true takes precedence — the raw error propagates.
      await expect(
        adapter.chat({ messages: USER, signal: controller.signal }),
      ).rejects.toBe(raw);
    });

    it('produces an actionable message and suggestion', async () => {
      mock.mocks.create.mockRejectedValue(apiError(401, 'bad key'));
      const adapter = createAnthropicAdapter({ client: mock.client });

      try {
        await adapter.chat({ messages: USER });
      } catch (caught) {
        const e = caught as HarnessError;
        expect(e.message).toContain('chat()');
        expect(e.message).toContain('ADAPTER_AUTH');
        expect(e.suggestion).toMatch(/ANTHROPIC_API_KEY/);
      }
    });
  });

  describe('stream()', () => {
    for (const { label, err, code } of CASES) {
      it(`maps ${label} → ${code} on finalMessage() with cause preserved`, async () => {
        mock.mocks.stream.mockReturnValue(rejectingStream(err));
        const adapter = createAnthropicAdapter({ client: mock.client });

        try {
          await drainStream(adapter.stream!({ messages: USER }));
          throw new Error('expected stream() to throw');
        } catch (caught) {
          expect(caught).toBeInstanceOf(HarnessError);
          expect((caught as HarnessError).code).toBe(code);
          expect((caught as HarnessError).cause).toBe(err);
        }
      });
    }

    it('normalizes an error thrown synchronously during stream setup', async () => {
      const err = apiError(429, 'rate limited at setup');
      mock.mocks.stream.mockImplementation(() => {
        throw err;
      });
      const adapter = createAnthropicAdapter({ client: mock.client });

      try {
        await drainStream(adapter.stream!({ messages: USER }));
        throw new Error('expected stream() to throw');
      } catch (caught) {
        expect(caught).toBeInstanceOf(HarnessError);
        expect((caught as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_RATE_LIMIT);
        expect((caught as HarnessError).cause).toBe(err);
      }
    });

    it('normalizes an error thrown mid-iteration', async () => {
      const err = apiError(500, 'stream blew up');
      const badStream = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'content_block_start', content_block: { type: 'text' } };
          throw err;
        },
        finalMessage: vi.fn(),
      };
      mock.mocks.stream.mockReturnValue(badStream);
      const adapter = createAnthropicAdapter({ client: mock.client });

      try {
        await drainStream(adapter.stream!({ messages: USER }));
        throw new Error('expected stream() to throw');
      } catch (caught) {
        expect(caught).toBeInstanceOf(HarnessError);
        expect((caught as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_UNAVAILABLE);
        expect((caught as HarnessError).cause).toBe(err);
      }
    });

    it('maps a fully-unknown (non-Error) throwable → ADAPTER_UNKNOWN', async () => {
      mock.mocks.stream.mockReturnValue(rejectingStream({ weird: true }));
      const adapter = createAnthropicAdapter({ client: mock.client });

      try {
        await drainStream(adapter.stream!({ messages: USER }));
        throw new Error('expected stream() to throw');
      } catch (caught) {
        expect(caught).toBeInstanceOf(HarnessError);
        expect((caught as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_UNKNOWN);
      }
    });

    it('yields a terminal zero-usage done chunk on abort instead of throwing', async () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      mock.mocks.stream.mockReturnValue(rejectingStream(abortErr));
      const adapter = createAnthropicAdapter({ client: mock.client });

      const chunks = await drainStream(adapter.stream!({ messages: USER }));
      const done = chunks.filter((c) => c.type === 'done');
      expect(done).toHaveLength(1);
      expect(done[0].usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });
  });
});
