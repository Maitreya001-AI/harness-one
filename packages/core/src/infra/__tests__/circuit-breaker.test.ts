import { describe, it, expect, vi } from 'vitest';
import { createCircuitBreaker, CircuitOpenError } from '../circuit-breaker.js';

describe('createCircuitBreaker', () => {
  it('starts in closed state', () => {
    const cb = createCircuitBreaker();
    expect(cb.state()).toBe('closed');
  });

  it('stays closed when calls succeed', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });
    await cb.execute(async () => 'ok');
    await cb.execute(async () => 'ok');
    expect(cb.state()).toBe('closed');
  });

  it('trips to open after failureThreshold consecutive failures', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
    }
    expect(cb.state()).toBe('open');
  });

  it('fast-fails with CircuitOpenError when open', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 1 });
    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
    expect(cb.state()).toBe('open');
    await expect(cb.execute(async () => 'never')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('transitions to half_open after resetTimeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const cb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 });
      await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      expect(cb.state()).toBe('open');

      vi.advanceTimersByTime(5000);
      expect(cb.state()).toBe('half_open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on success in half_open state', async () => {
    vi.useFakeTimers();
    try {
      const cb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
      await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      vi.advanceTimersByTime(1000);

      const result = await cb.execute(async () => 'recovered');
      expect(result).toBe('recovered');
      expect(cb.state()).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopens on failure in half_open state', async () => {
    vi.useFakeTimers();
    try {
      const cb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
      await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      vi.advanceTimersByTime(1000);

      await expect(cb.execute(async () => { throw new Error('still failing'); })).rejects.toThrow();
      expect(cb.state()).toBe('open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects concurrent probes in half_open state', async () => {
    vi.useFakeTimers();
    try {
      const cb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
      await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      vi.advanceTimersByTime(1000);

      // Start a slow probe
      const slowProbe = cb.execute(() => new Promise((r) => setTimeout(() => r('slow'), 5000)));
      // Second concurrent call should be rejected
      await expect(cb.execute(async () => 'concurrent')).rejects.toBeInstanceOf(CircuitOpenError);

      vi.advanceTimersByTime(5000);
      expect(await slowProbe).toBe('slow');
      expect(cb.state()).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset() forces back to closed', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 1 });
    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(cb.state()).toBe('open');

    cb.reset();
    expect(cb.state()).toBe('closed');
  });

  it('recordSuccess/recordFailure work from outside execute()', () => {
    const cb = createCircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure();
    expect(cb.state()).toBe('closed');
    cb.recordFailure();
    expect(cb.state()).toBe('open');
    cb.recordSuccess();
    expect(cb.state()).toBe('closed');
  });

  it('resets failure counter on success', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });
    // Two failures, then a success resets the counter
    await expect(cb.execute(async () => { throw new Error('f1'); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error('f2'); })).rejects.toThrow();
    await cb.execute(async () => 'ok');
    // Two more failures — still under threshold
    await expect(cb.execute(async () => { throw new Error('f3'); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error('f4'); })).rejects.toThrow();
    expect(cb.state()).toBe('closed');
  });

  it('invokes onStateChange callback on transitions', async () => {
    const transitions: Array<{ from: string; to: string }> = [];
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
      onStateChange: (from, to) => transitions.push({ from, to }),
    });

    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(transitions).toEqual([{ from: 'closed', to: 'open' }]);

    cb.reset();
    expect(transitions).toEqual([
      { from: 'closed', to: 'open' },
      { from: 'open', to: 'closed' },
    ]);
  });

  it('swallows onStateChange callback exceptions without breaking state transition', async () => {
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      onStateChange: () => { throw new Error('callback exploded'); },
    });
    // The callback throws, but the state should still transition to open.
    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
    expect(cb.state()).toBe('open');

    // reset() also triggers transition — callback throws again but state changes.
    cb.reset();
    expect(cb.state()).toBe('closed');
  });

  it('handles failureThreshold=1 edge case', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 1 });
    await expect(cb.execute(async () => { throw new Error('once'); })).rejects.toThrow();
    expect(cb.state()).toBe('open');
  });

  it('uses default config values', () => {
    const cb = createCircuitBreaker();
    // Default failureThreshold is 5
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.state()).toBe('closed');
    cb.recordFailure();
    expect(cb.state()).toBe('open');
  });

  // P0-5 (Wave-12): Half-open probe mutex is atomic.
  describe('P0-5 (Wave-12): half-open probe atomicity', () => {
    it('serializes the probe slot so concurrent probes do not both win', async () => {
      vi.useFakeTimers();
      try {
        const cb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
        await expect(cb.execute(async () => { throw new Error('trip'); })).rejects.toThrow();
        vi.advanceTimersByTime(1000);
        expect(cb.state()).toBe('half_open');

        // Kick off two probes in the same microtask tick — only one may
        // acquire the slot; the other must fast-fail.
        let resolveFirst!: (v: string) => void;
        const firstProbe = cb.execute(() => new Promise<string>((r) => { resolveFirst = r; }));
        const secondProbe = cb.execute(async () => 'second');

        await expect(secondProbe).rejects.toBeInstanceOf(CircuitOpenError);

        // First probe completes successfully → breaker closes.
        resolveFirst('first');
        expect(await firstProbe).toBe('first');
        expect(cb.state()).toBe('closed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('releases the probe slot on failure so a subsequent half_open cycle can probe', async () => {
      vi.useFakeTimers();
      try {
        const cb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
        await expect(cb.execute(async () => { throw new Error('trip'); })).rejects.toThrow();

        // First half-open probe fails → breaker reopens.
        vi.advanceTimersByTime(1000);
        await expect(cb.execute(async () => { throw new Error('probe-fail'); })).rejects.toThrow('probe-fail');
        expect(cb.state()).toBe('open');

        // After another reset window, breaker must transition to half_open
        // again AND accept a new probe — i.e. the slot was released on the
        // prior failure (no wedged state).
        vi.advanceTimersByTime(1000);
        const result = await cb.execute(async () => 'recovered');
        expect(result).toBe('recovered');
        expect(cb.state()).toBe('closed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not corrupt consecutiveFailures when races are prevented', async () => {
      vi.useFakeTimers();
      try {
        const cb = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
        // Trip to open with two failures.
        await expect(cb.execute(async () => { throw new Error('f1'); })).rejects.toThrow();
        await expect(cb.execute(async () => { throw new Error('f2'); })).rejects.toThrow();
        expect(cb.state()).toBe('open');

        vi.advanceTimersByTime(1000);
        // Fire three concurrent probes. Only one may claim the slot; the
        // other two fast-fail. The winning probe's failure must be counted
        // and reopen the breaker.
        let reject!: (err: Error) => void;
        const p1 = cb.execute(() => new Promise<string>((_, r) => { reject = r; }));
        const p2 = cb.execute(async () => 'b');
        const p3 = cb.execute(async () => 'c');

        await expect(p2).rejects.toBeInstanceOf(CircuitOpenError);
        await expect(p3).rejects.toBeInstanceOf(CircuitOpenError);

        reject(new Error('probe-fail'));
        await expect(p1).rejects.toThrow('probe-fail');

        // After the single probe's failure, breaker must be open (not closed).
        expect(cb.state()).toBe('open');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
