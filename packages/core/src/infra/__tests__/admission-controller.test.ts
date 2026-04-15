import { describe, it, expect } from 'vitest';
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
