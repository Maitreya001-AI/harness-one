/**
 * Adapter caller hardening tests:
 *
 *   - orphan-rejection after timeout is logged at debug-level with
 *     bounded metadata (not silent, not noisy).
 *   - AdapterRetryInfo carries `backoffMs` and `retryNumber` so
 *     iteration-runner can emit them as span-event attributes AND any
 *     metrics port can consume them as histogram labels.
 *   - timeout error path carries `timeoutMs` + `adapterName` on the
 *     failure result so the calling span can attribute without parsing
 *     error messages.
 *   - cumulative `totalBackoffMs` + `totalDurationMs` attached to both
 *     success and failure results.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAdapterCaller, type AdapterRetryInfo } from '../adapter-caller.js';
import { createStreamHandler } from '../stream-handler.js';
import type { AgentAdapter, ChatResponse, Message } from '../types.js';
import { HarnessErrorCode } from '../errors.js';

const USAGE = { inputTokens: 1, outputTokens: 1 };

function makeAdapter(impl: Partial<AgentAdapter>, name = 'test-adapter'): AgentAdapter {
  return {
    name,
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

describe('AdapterCaller — orphan rejection after timeout logged', () => {
  it('invokes logger.debug when the adapter rejects after the timeout', async () => {
    const controller = new AbortController();
    // Adapter whose chat() rejects AFTER we've already timed out —
    // simulates a misbehaving provider that doesn't honour abort promptly.
    const adapter = makeAdapter({
      async chat(_params) {
        // Wait a bit, then throw a post-timeout error regardless of abort.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 40);
          if (typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref();
        });
        // Reject — this rejection is "orphaned" (timeout has already won).
        throw new Error('late upstream failure');
      },
    }, 'my-adapter');

    const debug = vi.fn();
    const caller = createAdapterCaller({
      ...baseConfig(adapter, controller.signal),
      adapterTimeoutMs: 5,
      logger: { debug },
    });

    const result = await caller.callOnce([{ role: 'user', content: 'hi' }] satisfies Message[]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCategory).toBe(HarnessErrorCode.CORE_TIMEOUT);
    }

    // Wait for the orphaned rejection to settle — it's a `.catch` off the
    // now-discarded chatPromise; the debug call happens in a microtask.
    await new Promise((r) => setTimeout(r, 60));
    expect(debug).toHaveBeenCalled();
    const call = debug.mock.calls.find((c) => c[0] === 'adapter orphan after timeout');
    expect(call).toBeDefined();
    const meta = call![1] as { error: string; adapter: string; timeoutMs: number };
    expect(meta.adapter).toBe('my-adapter');
    expect(meta.timeoutMs).toBe(5);
    expect(meta.error.length).toBeLessThanOrEqual(200);
  });

  it('is silent when no logger is wired (legacy behaviour)', async () => {
    const controller = new AbortController();
    const adapter = makeAdapter({
      async chat() {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 20);
          if (typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref();
        });
        throw new Error('late');
      },
    });
    const caller = createAdapterCaller({
      ...baseConfig(adapter, controller.signal),
      adapterTimeoutMs: 5,
    });
    const result = await caller.callOnce([{ role: 'user', content: 'hi' }]);
    expect(result.ok).toBe(false);
    // Just wait for the orphan to flush — no assertion, no logger wired.
    await new Promise((r) => setTimeout(r, 40));
  });
});

describe('AdapterCaller — retry info carries backoffMs + retryNumber', () => {
  it('fireRetry on chat path receives backoffMs and retryNumber', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const adapter = makeAdapter({
      async chat() {
        attempts++;
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
      baseRetryDelayMs: 5,
    });

    const seen: AdapterRetryInfo[] = [];
    const iter = caller.call([{ role: 'user', content: 'hi' }], 0, (info) => {
      seen.push(info);
    });
    let step = await iter.next();
    while (!step.done) step = await iter.next();

    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe('chat');
    expect(seen[0].errorCategory).toBe(HarnessErrorCode.ADAPTER_RATE_LIMIT);
    expect(typeof seen[0].backoffMs).toBe('number');
    expect(seen[0].backoffMs).toBeGreaterThan(0);
    expect(seen[0].retryNumber).toBe(1);
  });
});

describe('AdapterCaller — timeout carries timeoutMs + adapterName', () => {
  it('callOnce failure on timeout carries timeoutMs + adapterName', async () => {
    const controller = new AbortController();
    const adapter = makeAdapter({
      async chat() {
        return await new Promise<never>(() => {
          /* never resolves — force timeout */
        });
      },
    }, 'openai');
    const caller = createAdapterCaller({
      ...baseConfig(adapter, controller.signal),
      adapterTimeoutMs: 10,
    });
    const result = await caller.callOnce([{ role: 'user', content: 'hi' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCategory).toBe(HarnessErrorCode.CORE_TIMEOUT);
      expect(result.timeoutMs).toBe(10);
      expect(result.adapterName).toBe('openai');
    }
  });

  it('call() chat-path failure on timeout carries timeoutMs + adapterName', async () => {
    const controller = new AbortController();
    const adapter = makeAdapter({
      async chat() {
        return await new Promise<never>(() => { /* never */ });
      },
    }, 'anthropic');
    const caller = createAdapterCaller({
      ...baseConfig(adapter, controller.signal),
      adapterTimeoutMs: 10,
    });
    const iter = caller.call([{ role: 'user', content: 'hi' }], 0);
    let step = await iter.next();
    while (!step.done) step = await iter.next();
    const final = step.value;
    expect(final.ok).toBe(false);
    if (!final.ok) {
      expect(final.errorCategory).toBe(HarnessErrorCode.CORE_TIMEOUT);
      expect(final.timeoutMs).toBe(10);
      expect(final.adapterName).toBe('anthropic');
    }
  });
});

describe('AdapterCaller — cumulative totalBackoffMs + totalDurationMs', () => {
  it('successful result after retries carries totalBackoffMs > 0 and totalDurationMs > 0', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const adapter = makeAdapter({
      async chat() {
        attempts++;
        if (attempts < 3) {
          throw new Error('rate limited');
        }
        return { message: { role: 'assistant', content: 'ok' }, usage: USAGE };
      },
    });
    const caller = createAdapterCaller({
      ...baseConfig(adapter, controller.signal),
      maxAdapterRetries: 3,
      baseRetryDelayMs: 5,
    });
    const iter = caller.call([{ role: 'user', content: 'hi' }], 0);
    let step = await iter.next();
    while (!step.done) step = await iter.next();
    const final = step.value;
    expect(final.ok).toBe(true);
    if (final.ok) {
      expect(final.attempts).toBe(2);
      expect(final.totalBackoffMs).toBeGreaterThan(0);
      expect(final.totalDurationMs).toBeGreaterThan(0);
      // Wall-clock should cover the summed backoff sleeps. Allow ~2ms slack:
      // Date.now() has 1ms resolution, so per-attempt integer rounding can
      // leave the recorded duration trailing the summed delays by a tick on
      // busy CI runners. A real accounting bug (e.g. totalDurationMs reset
      // to 0) still trips the assertion.
      expect(final.totalDurationMs!).toBeGreaterThanOrEqual(final.totalBackoffMs! - 2);
    }
  });

  it('retry-exhausted failure carries cumulative metrics', async () => {
    const controller = new AbortController();
    const adapter = makeAdapter({
      async chat() {
        throw new Error('rate limited always');
      },
    });
    const caller = createAdapterCaller({
      ...baseConfig(adapter, controller.signal),
      maxAdapterRetries: 2,
      baseRetryDelayMs: 3,
    });
    const iter = caller.call([{ role: 'user', content: 'hi' }], 0);
    let step = await iter.next();
    while (!step.done) step = await iter.next();
    const final = step.value;
    expect(final.ok).toBe(false);
    if (!final.ok) {
      expect(final.totalBackoffMs).toBeGreaterThan(0);
      // Same 2ms slack as above — Date.now()'s 1ms resolution can leave
      // the wall-clock duration a tick behind the summed delays.
      expect(final.totalDurationMs!).toBeGreaterThanOrEqual(final.totalBackoffMs! - 2);
    }
  });

  it('single-shot success (no retries) sets totalBackoffMs to 0', async () => {
    const controller = new AbortController();
    const adapter = makeAdapter({
      async chat() {
        return { message: { role: 'assistant', content: 'ok' }, usage: USAGE };
      },
    });
    const caller = createAdapterCaller({
      ...baseConfig(adapter, controller.signal),
      maxAdapterRetries: 2,
    });
    const iter = caller.call([{ role: 'user', content: 'hi' }], 0);
    let step = await iter.next();
    while (!step.done) step = await iter.next();
    const final = step.value;
    expect(final.ok).toBe(true);
    if (final.ok) {
      expect(final.totalBackoffMs).toBe(0);
      expect(final.totalDurationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
