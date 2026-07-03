/**
 * Tests for OpenAI adapter error normalization (C1b).
 *
 * Verifies that SDK errors surfaced by `chat()` and `stream()` are translated
 * into typed `HarnessError`s per the Error-mapping table in
 * `docs/provider-spec.md`, that the original error is preserved as `cause`, and
 * that abort semantics mirror the anthropic adapter (a caller abort surfaces as
 * a clean terminal zero-usage `done` on the stream path, and propagates
 * unchanged on the non-stream path).
 *
 * The `openai` module is mocked to a bare constructor, so `OpenAI.APIError` /
 * `APIUserAbortError` / `APIConnectionError` are absent here — that exercises
 * the adapter's *structural* fallback (status / code / message probing). The
 * `instanceof`-based path is covered against the real SDK by the compat matrix.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockOpenAIConstructor } = vi.hoisted(() => {
  const mockCreateFn = vi.fn();
  const mockOpenAIConstructor = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreateFn } },
    _mockCreate: mockCreateFn,
  }));
  return { mockOpenAIConstructor };
});

vi.mock('openai', () => ({ default: mockOpenAIConstructor }));

import { createOpenAIAdapter } from '../index.js';
import type { StreamChunk } from 'harness-one/core';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import { createMockOpenAIClient } from './openai-test-fixtures.js';

/** An Error carrying a structural `status`, like the SDK's APIError shape. */
function apiError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}

/** An async-iterable stream that yields the given chunks, then throws. */
function throwingStream(chunks: unknown[], error: unknown): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
      throw error;
    },
  };
}

async function drainStream(
  iter: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const c of iter) chunks.push(c);
  return chunks;
}

describe('OpenAI adapter error normalization', () => {
  let mock: ReturnType<typeof createMockOpenAIClient>;

  beforeEach(() => {
    mock = createMockOpenAIClient();
  });

  // -------------------------------------------------------------------------
  // chat() — status → code mapping + cause preservation
  // -------------------------------------------------------------------------
  describe('chat()', () => {
    const cases: Array<[string, Error, HarnessErrorCode]> = [
      ['401 → ADAPTER_AUTH', apiError(401, 'Unauthorized'), HarnessErrorCode.ADAPTER_AUTH],
      ['429 → ADAPTER_RATE_LIMIT', apiError(429, 'Too Many Requests'), HarnessErrorCode.ADAPTER_RATE_LIMIT],
      ['500 → ADAPTER_UNAVAILABLE', apiError(500, 'Internal Server Error'), HarnessErrorCode.ADAPTER_UNAVAILABLE],
      ['503 → ADAPTER_UNAVAILABLE', apiError(503, 'Service Unavailable'), HarnessErrorCode.ADAPTER_UNAVAILABLE],
    ];

    for (const [name, sdkErr, expectedCode] of cases) {
      it(`maps ${name} and preserves cause`, async () => {
        mock.mocks.create.mockRejectedValue(sdkErr);
        const adapter = createOpenAIAdapter({ client: mock.client });

        await expect(
          adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
        ).rejects.toBeInstanceOf(HarnessError);

        try {
          await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });
          throw new Error('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(HarnessError);
          expect((err as HarnessError).code).toBe(expectedCode);
          expect((err as HarnessError).cause).toBe(sdkErr);
        }
      });
    }

    it('maps a network/timeout error (no HTTP status) to ADAPTER_NETWORK', async () => {
      const netErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      mock.mocks.create.mockRejectedValue(netErr);
      const adapter = createOpenAIAdapter({ client: mock.client });

      try {
        await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        expect((err as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_NETWORK);
        expect((err as HarnessError).cause).toBe(netErr);
      }
    });

    it('maps an unclassified error (no status, no network markers) to ADAPTER_ERROR', async () => {
      const weird = new Error('Something unexpected happened');
      mock.mocks.create.mockRejectedValue(weird);
      const adapter = createOpenAIAdapter({ client: mock.client });

      try {
        await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        expect((err as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_ERROR);
        expect((err as HarnessError).cause).toBe(weird);
      }
    });

    it('propagates a caller abort unchanged (does NOT wrap it in a HarnessError)', async () => {
      const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      mock.mocks.create.mockRejectedValue(abortErr);
      const adapter = createOpenAIAdapter({ client: mock.client });

      try {
        await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });
        throw new Error('should have thrown');
      } catch (err) {
        // Abort surfaces raw so the loop's CORE_ABORTED machinery recognises it.
        expect(err).toBe(abortErr);
        expect(err).not.toBeInstanceOf(HarnessError);
      }
    });

    it('propagates a caller abort (detected via aborted signal) unchanged', async () => {
      const genericErr = new Error('request cancelled');
      mock.mocks.create.mockRejectedValue(genericErr);
      const controller = new AbortController();
      controller.abort();
      const adapter = createOpenAIAdapter({ client: mock.client });

      await expect(
        adapter.chat({
          messages: [{ role: 'user', content: 'Hi' }],
          signal: controller.signal,
        }),
      ).rejects.toBe(genericErr);
    });
  });

  // -------------------------------------------------------------------------
  // stream() — create-time + mid-flight mapping, abort → terminal done
  // -------------------------------------------------------------------------
  describe('stream()', () => {
    it('maps a create()-time rejection (401) to a HarnessError before the first chunk', async () => {
      const sdkErr = apiError(401, 'Unauthorized');
      mock.mocks.create.mockRejectedValue(sdkErr);
      const adapter = createOpenAIAdapter({ client: mock.client });

      try {
        await drainStream(adapter.stream!({ messages: [{ role: 'user', content: 'Hi' }] }));
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        expect((err as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_AUTH);
        expect((err as HarnessError).cause).toBe(sdkErr);
      }
    });

    it('maps a mid-flight stream failure (500) to ADAPTER_UNAVAILABLE with cause', async () => {
      const sdkErr = apiError(500, 'Internal Server Error');
      mock.mocks.create.mockResolvedValue(
        throwingStream([{ choices: [{ delta: { content: 'Hel' } }] }], sdkErr),
      );
      const adapter = createOpenAIAdapter({ client: mock.client });

      const collected: StreamChunk[] = [];
      try {
        for await (const c of adapter.stream!({ messages: [{ role: 'user', content: 'Hi' }] })) {
          collected.push(c);
        }
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        expect((err as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_UNAVAILABLE);
        expect((err as HarnessError).cause).toBe(sdkErr);
      }
      // The pre-error text delta was still surfaced.
      expect(collected.filter((c) => c.type === 'text_delta')).toHaveLength(1);
    });

    it('maps a mid-flight rate-limit (429) to ADAPTER_RATE_LIMIT', async () => {
      mock.mocks.create.mockResolvedValue(
        throwingStream([{ choices: [{ delta: { content: 'x' } }] }], apiError(429)),
      );
      const adapter = createOpenAIAdapter({ client: mock.client });

      await expect(
        drainStream(adapter.stream!({ messages: [{ role: 'user', content: 'Hi' }] })),
      ).rejects.toMatchObject({ code: HarnessErrorCode.ADAPTER_RATE_LIMIT });
    });

    it('surfaces a mid-flight abort (AbortError) as a terminal zero-usage done, no throw', async () => {
      const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
      mock.mocks.create.mockResolvedValue(
        throwingStream([{ choices: [{ delta: { content: 'partial' } }] }], abortErr),
      );
      const adapter = createOpenAIAdapter({ client: mock.client });

      const chunks = await drainStream(
        adapter.stream!({ messages: [{ role: 'user', content: 'Hi' }] }),
      );

      const done = chunks.filter((c) => c.type === 'done');
      expect(done).toHaveLength(1);
      expect(done[0].usage).toEqual({ inputTokens: 0, outputTokens: 0 });
      // The partial text delta is still delivered before the terminal done.
      expect(chunks.filter((c) => c.type === 'text_delta')).toHaveLength(1);
    });

    it('surfaces an abort detected via aborted signal as a terminal done (signal wins)', async () => {
      // Non-abort error shape, but the caller aborted — signal state wins, so
      // the stream ends cleanly (mirrors the anthropic adapter contract).
      const controller = new AbortController();
      controller.abort();
      mock.mocks.create.mockResolvedValue(
        throwingStream([{ choices: [{ delta: { content: 'partial' } }] }], new Error('boom')),
      );
      const adapter = createOpenAIAdapter({ client: mock.client });

      const chunks = await drainStream(
        adapter.stream!({
          messages: [{ role: 'user', content: 'Hi' }],
          signal: controller.signal,
        }),
      );

      const done = chunks.filter((c) => c.type === 'done');
      expect(done).toHaveLength(1);
      expect(done[0].usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('still releases the stream controller when a mid-flight error is mapped', async () => {
      const abortFn = vi.fn();
      const failing: AsyncIterable<unknown> & { controller: { abort: () => void } } = {
        controller: { abort: abortFn },
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'x' } }] };
          throw apiError(500);
        },
      };
      mock.mocks.create.mockResolvedValue(failing);
      const adapter = createOpenAIAdapter({ client: mock.client });

      await expect(
        drainStream(adapter.stream!({ messages: [{ role: 'user', content: 'Hi' }] })),
      ).rejects.toBeInstanceOf(HarnessError);
      // finally must run even on the error path.
      expect(abortFn).toHaveBeenCalled();
    });
  });
});
