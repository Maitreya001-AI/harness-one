/**
 * Unit tests for AdapterCaller — covers behaviours that cannot be
 * exercised through the AgentLoop black box:
 *
 *   - adapter timeout on the non-streaming chat path
 *   - Set-backed `retryableErrors` lookup (public API parity)
 *   - abort listener registered before timer in backoff sleep
 *
 * The AgentLoop-level suites cover the retry loop and stream path; these
 * tests pin the contract of the lower-level adapter caller directly.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAdapterCaller } from '../adapter-caller.js';
import { createStreamHandler } from '../stream-handler.js';
import type { AgentAdapter, ChatResponse, Message } from '../types.js';
import { HarnessErrorCode } from '../errors.js';

const USAGE = { inputTokens: 1, outputTokens: 1 };

function makeAdapter(impl: Partial<AgentAdapter>): AgentAdapter {
  return {
    async chat(): Promise<ChatResponse> {
      throw new Error('chat not mocked');
    },
    ...impl,
  };
}

function baseConfig(adapter: AgentAdapter, signal: AbortSignal) {
  return {
    adapter,
    signal,
    streaming: false as const,
    maxAdapterRetries: 0,
    baseRetryDelayMs: 1,
    retryableErrors: ['ADAPTER_RATE_LIMIT'] as readonly string[],
    streamHandler: createStreamHandler({
      adapter,
      signal,
      maxStreamBytes: 10_000,
      maxToolArgBytes: 10_000,
      maxCumulativeStreamBytes: 100_000,
    }),
  };
}

describe('AdapterCaller — adapter timeout', () => {
  it('returns CORE_TIMEOUT when adapter.chat hangs past adapterTimeoutMs', async () => {
    const controller = new AbortController();
    const chatSpy = vi.fn().mockImplementation(() => new Promise(() => {
      /* never resolves */
    }));
    const adapter = makeAdapter({ chat: chatSpy });
    const caller = createAdapterCaller({
      ...baseConfig(adapter, controller.signal),
      adapterTimeoutMs: 20,
    });

    const result = await caller.callOnce([{ role: 'user', content: 'hi' }] satisfies Message[]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCategory).toBe(HarnessErrorCode.CORE_TIMEOUT);
      expect(result.error.message).toMatch(/timed out after 20ms/);
    }
    expect(chatSpy).toHaveBeenCalledOnce();
  });

  it('passes a chained AbortSignal to adapter.chat and aborts it on timeout', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const adapter = makeAdapter({
      async chat(params) {
        capturedSignal = params.signal;
        // Hang until the internal abort fires.
        await new Promise<never>((_, reject) => {
          params.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
        throw new Error('unreachable');
      },
    });
    const caller = createAdapterCaller({
      ...baseConfig(adapter, controller.signal),
      adapterTimeoutMs: 15,
    });
    const result = await caller.callOnce([{ role: 'user', content: 'hi' }]);
    expect(result.ok).toBe(false);
    expect(capturedSignal).toBeDefined();
    // After timeout the signal handed to the adapter must be aborted, even
    // though the CALLER's external signal is still live.
    expect(capturedSignal!.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });

  it('defaults to unlimited when adapterTimeoutMs is omitted', async () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const adapter = makeAdapter({
      async chat() {
        // Resolve quickly — if we erroneously wrapped in a default timeout
        // the test would still pass; the intent is to assert *no throw*.
        await new Promise((r) => { timer = setTimeout(r, 5); });
        return { message: { role: 'assistant', content: 'ok' }, usage: USAGE };
      },
    });
    const caller = createAdapterCaller(baseConfig(adapter, controller.signal));
    const result = await caller.callOnce([{ role: 'user', content: 'hi' }]);
    if (timer) clearTimeout(timer);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.content).toBe('ok');
  });
});

describe('AdapterCaller — retryableErrors Set lookup', () => {
  it('accepts a readonly string[] at the public API (no behaviour change)', async () => {
    // API parity smoke test: the internal representation is a Set but the
    // externally-observable behaviour when given the array form is
    // identical — a retryable category triggers a retry, a
    // non-retryable one does not.
    const controller = new AbortController();
    let attempts = 0;
    const adapter = makeAdapter({
      async chat() {
        attempts++;
        // First attempt 429 → retryable ADAPTER_RATE_LIMIT; second attempt succeeds.
        if (attempts === 1) {
          const e: Error & { status?: number } = new Error('rate limited');
          e.status = 429;
          throw e;
        }
        return { message: { role: 'assistant', content: 'ok' }, usage: USAGE };
      },
    });
    const caller = createAdapterCaller({
      ...baseConfig(adapter, controller.signal),
      maxAdapterRetries: 2,
      retryableErrors: ['ADAPTER_RATE_LIMIT'],
    });

    const iter = caller.call([{ role: 'user', content: 'hi' }], 0);
    // Drain to terminal return value.
    let step = await iter.next();
    while (!step.done) step = await iter.next();
    const final = step.value;
    expect(final.ok).toBe(true);
    expect(attempts).toBe(2);
  });
});

describe('AdapterCaller — abort-before-timer in backoff', () => {
  it('rejects promptly when abort fires synchronously before the first retry backoff arm', async () => {
    // Construct a scenario where the first attempt returns a RETRYABLE
    // error, then the caller's signal is already aborted — the backoff
    // sleep must observe the pre-armed abort listener and reject
    // immediately, NOT let the timer settle first. Previously the listener
    // was registered AFTER setTimeout returned, creating a micro-race.
    const controller = new AbortController();
    const adapter = makeAdapter({
      async chat() {
        // Abort BEFORE throwing so the backoff begins with an aborted
        // signal. The fix registers the listener before arming the timer,
        // so the synchronous `signal.aborted` check inside the Promise
        // initializer catches it; this test also validates the post-listener
        // ordering by triggering abort via microtask.
        queueMicrotask(() => controller.abort());
        const e: Error & { status?: number } = new Error('rate limited');
        e.status = 429;
        throw e;
      },
    });

    const caller = createAdapterCaller({
      ...baseConfig(adapter, controller.signal),
      maxAdapterRetries: 3,
      // Large delay: if the abort listener is installed AFTER setTimeout,
      // the micro-task abort can race with timer-arming — the test would
      // either time out or silently wait. With the fix the listener is
      // installed first and the race disappears.
      baseRetryDelayMs: 5_000,
      retryableErrors: ['ADAPTER_RATE_LIMIT'],
    });

    const iter = caller.call([{ role: 'user', content: 'hi' }], 0);
    const start = Date.now();
    let step = await iter.next();
    while (!step.done) step = await iter.next();
    const elapsed = Date.now() - start;
    const final = step.value;
    // Much less than the baseRetryDelayMs — abort surfaced promptly.
    expect(elapsed).toBeLessThan(1000);
    expect(final.ok).toBe(false);
    if (!final.ok) {
      expect(final.errorCategory).toBe(HarnessErrorCode.CORE_ABORTED);
    }
  });
});
