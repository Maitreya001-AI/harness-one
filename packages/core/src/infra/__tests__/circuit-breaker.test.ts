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
});
