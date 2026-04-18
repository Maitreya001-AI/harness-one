/**
 * Tests for `retry-policy.ts` — round-3 extraction from adapter-caller.
 */
import { describe, it, expect } from 'vitest';
import { createRetryPolicy } from '../retry-policy.js';
import { HarnessErrorCode, AbortedError } from '../errors.js';
import type { CircuitBreaker } from '../../infra/circuit-breaker.js';

function makeBreaker(initialState: 'closed' | 'open' | 'half-open'): {
  breaker: CircuitBreaker;
  state: { current: typeof initialState; success: number; failure: number };
} {
  const state = { current: initialState, success: 0, failure: 0 };
  const breaker = {
    execute: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    state: () => state.current,
    recordSuccess: () => {
      state.success++;
    },
    recordFailure: () => {
      state.failure++;
    },
    reset: () => {
      state.current = 'closed';
    },
  } as unknown as CircuitBreaker;
  return { breaker, state };
}

describe('createRetryPolicy', () => {
  it('classifies retryable error categories via Set membership', () => {
    const signal = new AbortController().signal;
    const policy = createRetryPolicy({
      maxAdapterRetries: 2,
      baseRetryDelayMs: 10,
      retryableErrors: [HarnessErrorCode.ADAPTER_RATE_LIMIT, HarnessErrorCode.ADAPTER_UNAVAILABLE],
      signal,
    });
    expect(policy.isRetryableCategory(HarnessErrorCode.ADAPTER_RATE_LIMIT)).toBe(true);
    expect(policy.isRetryableCategory(HarnessErrorCode.ADAPTER_UNAVAILABLE)).toBe(true);
    expect(policy.isRetryableCategory(HarnessErrorCode.ADAPTER_AUTH)).toBe(false);
  });

  it('exposes maxRetries as a stable readonly', () => {
    const signal = new AbortController().signal;
    const policy = createRetryPolicy({
      maxAdapterRetries: 5,
      baseRetryDelayMs: 10,
      retryableErrors: [],
      signal,
    });
    expect(policy.maxRetries).toBe(5);
  });

  it('scheduleBackoff resolves after the timer fires', async () => {
    const ac = new AbortController();
    const policy = createRetryPolicy({
      maxAdapterRetries: 3,
      baseRetryDelayMs: 5,
      retryableErrors: [],
      signal: ac.signal,
    });
    const { delay, promise } = policy.scheduleBackoff(0);
    expect(delay).toBeGreaterThan(0);
    await promise; // should not throw
  });

  it('scheduleBackoff rejects with AbortedError when signal fires mid-sleep', async () => {
    const ac = new AbortController();
    const policy = createRetryPolicy({
      maxAdapterRetries: 3,
      baseRetryDelayMs: 500,
      retryableErrors: [],
      signal: ac.signal,
    });
    const { promise } = policy.scheduleBackoff(3);
    ac.abort();
    await expect(promise).rejects.toBeInstanceOf(AbortedError);
  });

  it('scheduleBackoff rejects immediately when already-aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const policy = createRetryPolicy({
      maxAdapterRetries: 3,
      baseRetryDelayMs: 10,
      retryableErrors: [],
      signal: ac.signal,
    });
    const { promise } = policy.scheduleBackoff(0);
    await expect(promise).rejects.toBeInstanceOf(AbortedError);
  });

  it('checkCircuitOpen returns payload when breaker is OPEN', () => {
    const { breaker } = makeBreaker('open');
    const signal = new AbortController().signal;
    const policy = createRetryPolicy({
      maxAdapterRetries: 0,
      baseRetryDelayMs: 10,
      retryableErrors: [],
      signal,
      circuitBreaker: breaker,
    });
    const payload = policy.checkCircuitOpen();
    expect(payload).toBeDefined();
    expect(payload!.errorCategory).toBe(HarnessErrorCode.ADAPTER_CIRCUIT_OPEN);
  });

  it('checkCircuitOpen returns undefined when closed / half-open', () => {
    for (const s of ['closed', 'half-open'] as const) {
      const { breaker } = makeBreaker(s);
      const policy = createRetryPolicy({
        maxAdapterRetries: 0,
        baseRetryDelayMs: 10,
        retryableErrors: [],
        signal: new AbortController().signal,
        circuitBreaker: breaker,
      });
      expect(policy.checkCircuitOpen()).toBeUndefined();
    }
  });

  it('checkCircuitOpen returns undefined when no breaker configured', () => {
    const policy = createRetryPolicy({
      maxAdapterRetries: 0,
      baseRetryDelayMs: 10,
      retryableErrors: [],
      signal: new AbortController().signal,
    });
    expect(policy.checkCircuitOpen()).toBeUndefined();
  });

  it('recordSuccess / recordFailure forward to the breaker', () => {
    const { breaker, state } = makeBreaker('closed');
    const policy = createRetryPolicy({
      maxAdapterRetries: 0,
      baseRetryDelayMs: 10,
      retryableErrors: [],
      signal: new AbortController().signal,
      circuitBreaker: breaker,
    });
    policy.recordSuccess();
    policy.recordSuccess();
    policy.recordFailure();
    expect(state.success).toBe(2);
    expect(state.failure).toBe(1);
  });
});

// Integration coverage — retry policy composed with the REAL circuit breaker
// (no hand-rolled stub). Exercises the retry-decision + breaker-transition
// seam that the Evidence Synthesizer audit flagged as hand-rolled-only.
describe('createRetryPolicy + real CircuitBreaker integration', () => {
  it('failed retries transition breaker closed → open at the threshold', async () => {
    const { createCircuitBreaker } = await import('../../infra/circuit-breaker.js');
    const breaker = createCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 30_000,
    });
    const policy = createRetryPolicy({
      maxAdapterRetries: 0,
      baseRetryDelayMs: 1,
      retryableErrors: [],
      signal: new AbortController().signal,
      circuitBreaker: breaker,
    });

    expect(breaker.state()).toBe('closed');
    expect(policy.checkCircuitOpen()).toBeUndefined();

    policy.recordFailure();
    policy.recordFailure();
    policy.recordFailure();

    expect(breaker.state()).toBe('open');
    const open = policy.checkCircuitOpen();
    expect(open).toBeDefined();
    expect(open?.error).toBeDefined();
    expect(open?.errorCategory).toBe(HarnessErrorCode.ADAPTER_CIRCUIT_OPEN);
  });

  it('success after threshold resets the breaker back to closed', async () => {
    const { createCircuitBreaker } = await import('../../infra/circuit-breaker.js');
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 30_000,
    });
    const policy = createRetryPolicy({
      maxAdapterRetries: 0,
      baseRetryDelayMs: 1,
      retryableErrors: [],
      signal: new AbortController().signal,
      circuitBreaker: breaker,
    });

    policy.recordFailure();
    policy.recordSuccess(); // interleaved success resets the failure count
    policy.recordFailure();
    expect(breaker.state()).toBe('closed');
    expect(policy.checkCircuitOpen()).toBeUndefined();
  });

  it('probe failure during HALF_OPEN re-opens the breaker', async () => {
    const { createCircuitBreaker } = await import('../../infra/circuit-breaker.js');
    // Use a generous reset timeout (100ms) so the post-probe `state()` read
    // does not race the lazy "OPEN past reset window → HALF_OPEN" transition
    // back to half_open. With resetTimeoutMs=1 the assertion below was racy
    // on slow CI runners; 100ms gives the test deterministic headroom while
    // still keeping it fast.
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
    });
    const policy = createRetryPolicy({
      maxAdapterRetries: 0,
      baseRetryDelayMs: 1,
      retryableErrors: [],
      signal: new AbortController().signal,
      circuitBreaker: breaker,
    });

    policy.recordFailure();
    expect(breaker.state()).toBe('open');

    // Wait past the reset timeout so the next execute() transitions to half-open.
    await new Promise((r) => setTimeout(r, 150));

    // Execute a failing probe through the breaker. After a half-open
    // failure, the breaker must return to OPEN.
    await expect(
      breaker.execute(async () => {
        throw new Error('probe failed');
      }),
    ).rejects.toThrow('probe failed');

    // Read state immediately — the freshly-recorded failure resets
    // `lastFailureTime`, so the next reset window only opens after another
    // 100ms; no race with the lazy half-open transition.
    expect(breaker.state()).toBe('open');
    expect(policy.checkCircuitOpen()).toBeDefined();
  });
});
