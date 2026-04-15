import { describe, it, expect } from 'vitest';
import { createAsyncLock } from '../async-lock.js';
import { HarnessError, HarnessErrorCode} from '../../core/errors.js';

describe('createAsyncLock', () => {
  it('runs single-owner critical sections exclusively', async () => {
    const lock = createAsyncLock();
    let active = 0;
    let maxActive = 0;
    const work = async (): Promise<void> => {
      await lock.withLock(async () => {
        active++;
        if (active > maxActive) maxActive = active;
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    };
    await Promise.all([work(), work(), work(), work()]);
    expect(maxActive).toBe(1);
  });

  it('returns fn result from withLock', async () => {
    const lock = createAsyncLock();
    const value = await lock.withLock(async () => 42);
    expect(value).toBe(42);
  });

  it('releases the lock when fn throws', async () => {
    const lock = createAsyncLock();
    await expect(
      lock.withLock(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Lock must be available again
    const value = await lock.withLock(async () => 'ok');
    expect(value).toBe('ok');
  });

  it('serialises waiters in FIFO order', async () => {
    const lock = createAsyncLock();
    const order: number[] = [];

    const first = lock.acquire();
    const firstRelease = await first;
    // Enqueue three waiters in order.
    const p1 = lock.withLock(async () => { order.push(1); });
    const p2 = lock.withLock(async () => { order.push(2); });
    const p3 = lock.withLock(async () => { order.push(3); });
    firstRelease();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('acquire returns a release that is idempotent', async () => {
    const lock = createAsyncLock();
    const release = await lock.acquire();
    release();
    release(); // must not throw or destabilise internal state
    // And the lock is still acquirable.
    const r2 = await lock.acquire();
    r2();
  });

  it('rejects immediately when signal is already aborted', async () => {
    const lock = createAsyncLock();
    const ac = new AbortController();
    ac.abort();
    await expect(lock.acquire({ signal: ac.signal })).rejects.toMatchObject({
      code: HarnessErrorCode.LOCK_ABORTED,
    });
  });

  it('rejects a queued waiter when its signal aborts during wait', async () => {
    const lock = createAsyncLock();
    const release = await lock.acquire();
    const ac = new AbortController();
    const p = lock.acquire({ signal: ac.signal });
    // Abort before release.
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(HarnessError);
    await expect(p).rejects.toMatchObject({ code: HarnessErrorCode.LOCK_ABORTED });
    // Lock owner can still release cleanly.
    release();
    // And the lock remains functional.
    const r2 = await lock.acquire();
    r2();
  });

  it('aborting one waiter does not affect others in the queue', async () => {
    const lock = createAsyncLock();
    const release = await lock.acquire();
    const ac = new AbortController();
    const aborted = lock.acquire({ signal: ac.signal });
    const results: string[] = [];
    const ok = lock.withLock(async () => { results.push('ok'); });
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ code: HarnessErrorCode.LOCK_ABORTED });
    release();
    await ok;
    expect(results).toEqual(['ok']);
  });

  it('acquires lock synchronously when uncontended', async () => {
    const lock = createAsyncLock();
    const start = Date.now();
    await lock.withLock(async () => {});
    expect(Date.now() - start).toBeLessThan(20);
  });

  it('does not leak abort listener after successful acquire', async () => {
    const lock = createAsyncLock();
    const release = await lock.acquire();
    const ac = new AbortController();
    const waitPromise = lock.acquire({ signal: ac.signal });
    release();
    const r2 = await waitPromise;
    // After resolution, firing abort should NOT cause unhandled rejection
    // (listener must be detached during handoff).
    ac.abort();
    r2();
    // Lock remains functional.
    const r3 = await lock.acquire();
    r3();
  });

  it('withLock propagates acquire rejection unchanged', async () => {
    const lock = createAsyncLock();
    const ac = new AbortController();
    ac.abort();
    await expect(
      lock.withLock(async () => 'never', { signal: ac.signal }),
    ).rejects.toMatchObject({ code: HarnessErrorCode.LOCK_ABORTED });
  });

  it('errors include operator-friendly hint text', async () => {
    const lock = createAsyncLock();
    const ac = new AbortController();
    ac.abort();
    try {
      await lock.acquire({ signal: ac.signal });
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      const he = err as HarnessError;
      expect(he.code).toBe(HarnessErrorCode.LOCK_ABORTED);
      expect(typeof he.suggestion).toBe('string');
    }
  });
});
