import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAdmissionController } from '../admission-controller.js';

describe('createAdmissionController (Wave-5D ARCH-8)', () => {
  it('grants permits up to maxInflight immediately', async () => {
    const ac = createAdmissionController({ maxInflight: 2 });
    const p1 = await ac.acquire('tenant-a');
    const p2 = await ac.acquire('tenant-a');
    expect(ac.inflight('tenant-a')).toBe(2);
    p1.release();
    p2.release();
    expect(ac.inflight('tenant-a')).toBe(0);
  });

  it('queues beyond capacity and releases the oldest waiter first', async () => {
    const ac = createAdmissionController({ maxInflight: 1, defaultTimeoutMs: 0 });
    const p1 = await ac.acquire('t');
    // Use long timeoutMs so the waiter doesn't self-reject
    const pendingA = ac.acquire('t', { timeoutMs: 1000 });
    const pendingB = ac.acquire('t', { timeoutMs: 1000 });
    expect(ac.waiting('t')).toBe(2);
    p1.release();
    const a = await pendingA;
    expect(ac.waiting('t')).toBe(1);
    a.release();
    const b = await pendingB;
    b.release();
    expect(ac.inflight('t')).toBe(0);
    expect(ac.waiting('t')).toBe(0);
  });

  it('rejects with POOL_TIMEOUT on acquire timeout', async () => {
    const ac = createAdmissionController({ maxInflight: 1 });
    await ac.acquire('t');
    await expect(ac.acquire('t', { timeoutMs: 20 })).rejects.toThrow(/timed out after 20ms/);
  });

  it('respects AbortSignal during wait', async () => {
    const ac = createAdmissionController({ maxInflight: 1 });
    await ac.acquire('t');
    const controller = new AbortController();
    const pending = ac.acquire('t', { signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(ac.waiting('t')).toBe(0);
  });

  it('withPermit releases even when fn throws', async () => {
    const ac = createAdmissionController({ maxInflight: 1 });
    await expect(
      ac.withPermit('t', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(ac.inflight('t')).toBe(0);
  });

  describe('H6: timeoutMs=0 means immediate rejection', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects immediately when timeoutMs=0 and no permit is available', async () => {
      const ac = createAdmissionController({ maxInflight: 1 });
      // Saturate the single permit slot
      const held = await ac.acquire('t');

      const pending = ac.acquire('t', { timeoutMs: 0 });

      // Advance timers by 0ms — the setTimeout(fn, 0) callback should fire
      vi.advanceTimersByTime(0);

      await expect(pending).rejects.toThrow(/timed out after 0ms/);
      expect(ac.waiting('t')).toBe(0);
      held.release();
    });

    it('does not reject when a permit is available even with timeoutMs=0', async () => {
      const ac = createAdmissionController({ maxInflight: 1 });

      // No contention — acquire should succeed immediately regardless of timeoutMs
      const permit = await ac.acquire('t', { timeoutMs: 0 });
      expect(ac.inflight('t')).toBe(1);
      permit.release();
      expect(ac.inflight('t')).toBe(0);
    });

    it('timeoutMs=0 fires before a longer-timeout waiter in the same queue', async () => {
      const ac = createAdmissionController({ maxInflight: 1 });
      const held = await ac.acquire('t');

      const fastPending = ac.acquire('t', { timeoutMs: 0 });
      const slowPending = ac.acquire('t', { timeoutMs: 5000 });

      // Only advance to 0ms — fast waiter should reject, slow should remain queued
      vi.advanceTimersByTime(0);

      await expect(fastPending).rejects.toThrow(/timed out after 0ms/);
      expect(ac.waiting('t')).toBe(1); // slow waiter still waiting

      // Release the held permit so the slow waiter can be granted
      held.release();
      const slowPermit = await slowPending;
      expect(ac.inflight('t')).toBe(1);
      slowPermit.release();
    });

    it('timeoutMs=0 rejects with POOL_TIMEOUT error code', async () => {
      const ac = createAdmissionController({ maxInflight: 1 });
      await ac.acquire('t');

      const pending = ac.acquire('t', { timeoutMs: 0 });
      vi.advanceTimersByTime(0);

      try {
        await pending;
        expect.unreachable('should have rejected');
      } catch (err: unknown) {
        expect((err as { code?: string }).code).toBe('POOL_TIMEOUT');
      }
    });
  });

  it('isolates per-tenant budgets', async () => {
    const ac = createAdmissionController({ maxInflight: 1 });
    const aPermit = await ac.acquire('a');
    // tenant b is unaffected by tenant a saturation
    const bPermit = await ac.acquire('b', { timeoutMs: 10 });
    expect(ac.inflight('a')).toBe(1);
    expect(ac.inflight('b')).toBe(1);
    aPermit.release();
    bPermit.release();
  });
});
