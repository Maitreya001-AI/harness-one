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

  describe('dispose()', () => {
    it('rejects all queued waiters with LOCK_ABORTED', async () => {
      const lock = createAsyncLock();
      const release = await lock.acquire();
      const p1 = lock.acquire();
      const p2 = lock.acquire();
      lock.dispose();
      await expect(p1).rejects.toMatchObject({ code: HarnessErrorCode.LOCK_ABORTED });
      await expect(p2).rejects.toMatchObject({ code: HarnessErrorCode.LOCK_ABORTED });
      release();
    });

    it('acquire() after dispose() throws LOCK_ABORTED', async () => {
      const lock = createAsyncLock();
      lock.dispose();
      await expect(lock.acquire()).rejects.toMatchObject({ code: HarnessErrorCode.LOCK_ABORTED });
    });

    it('withLock() after dispose() throws LOCK_ABORTED', async () => {
      const lock = createAsyncLock();
      lock.dispose();
      await expect(lock.withLock(async () => 'never')).rejects.toMatchObject({ code: HarnessErrorCode.LOCK_ABORTED });
    });

    it('dispose() is idempotent', () => {
      const lock = createAsyncLock();
      lock.dispose();
      expect(() => lock.dispose()).not.toThrow();
    });
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

  // Prevent double-reject race between dispose() and a waiter's
  // own AbortSignal handler, and ensure abort listeners are detached so they
  // cannot accumulate on long-lived signals.
  describe('dispose + abort race', () => {
    it('concurrent dispose + signal abort does not double-settle', async () => {
      const lock = createAsyncLock();
      // Hold the lock so subsequent acquires queue up.
      const release = await lock.acquire();

      // Attach unhandled rejection tracker to catch any stray errors from
      // a second reject call (Node prints the first settle; extras surface
      // as unhandledrejection on some runtimes).
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      try {
        // Build 3 waiters, each with its own abort signal.
        const controllers = [
          new AbortController(),
          new AbortController(),
          new AbortController(),
        ];
        const promises = controllers.map((c) => lock.acquire({ signal: c.signal }));
        // Attach catch handlers so Node does not warn if we lose the race.
        const settlements = promises.map((p) =>
          p.then(
            () => ({ kind: 'resolved' as const }),
            (err: unknown) => ({ kind: 'rejected' as const, err }),
          ),
        );

        // Fire dispose() and aborts in the same microtask window.
        // Note: dispose is synchronous and will drain the queue before the
        // abort handlers see their signal as aborted (handlers are queued
        // as microtasks by `EventTarget`).
        lock.dispose();
        for (const c of controllers) c.abort();

        const results = await Promise.all(settlements);

        // All three must reject exactly once with LOCK_ABORTED.
        for (const r of results) {
          expect(r.kind).toBe('rejected');
          expect(r.kind === 'rejected' && r.err).toBeInstanceOf(HarnessError);
          expect(
            r.kind === 'rejected' && (r.err as HarnessError).code,
          ).toBe(HarnessErrorCode.LOCK_ABORTED);
        }

        // No stray unhandled rejections from a double-reject.
        // Wait a microtask tick so any queued unhandled rejection would surface.
        await new Promise((r) => setImmediate(r));
        expect(unhandled).toEqual([]);

        // Cleanly release the original holder.
        release();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('abort after dispose() is a no-op (no second reject, listener detached)', async () => {
      const lock = createAsyncLock();
      const release = await lock.acquire();
      const ac = new AbortController();
      const p = lock.acquire({ signal: ac.signal });
      // Attach a catch so Node does not log the rejection.
      const settlement = p.then(
        () => ({ kind: 'resolved' as const }),
        (err: unknown) => ({ kind: 'rejected' as const, err }),
      );

      lock.dispose();
      // Subsequent abort must be a no-op: promise is already settled, and
      // the handler should early-return because `waiter.aborted === true`.
      ac.abort();

      const result = await settlement;
      expect(result.kind).toBe('rejected');
      expect(result.kind === 'rejected' && (result.err as HarnessError).code).toBe(
        HarnessErrorCode.LOCK_ABORTED,
      );
      release();
    });

    it('dispose() after abort() is a no-op for already-aborted waiter', async () => {
      const lock = createAsyncLock();
      const release = await lock.acquire();
      const ac = new AbortController();
      const p = lock.acquire({ signal: ac.signal });
      const settlement = p.then(
        () => ({ kind: 'resolved' as const }),
        (err: unknown) => ({ kind: 'rejected' as const, err }),
      );

      // Abort first — this rejects the waiter and removes it from the queue.
      ac.abort();
      const aborted = await settlement;
      expect(aborted.kind).toBe('rejected');

      // Dispose afterwards must not try to reject the already-aborted waiter
      // (it is no longer in the queue anyway). It must be safe and idempotent.
      expect(() => lock.dispose()).not.toThrow();
      release();
    });

    it('abort listener is removed on both resolution paths (dispose + handoff)', async () => {
      // Track add/remove of abort listeners on a single controller across
      // its full lifecycle. If the lock leaks listeners, the count will
      // stay > 0 after resolution.
      const lock = createAsyncLock();
      const release = await lock.acquire();
      const ac = new AbortController();

      let addCount = 0;
      let removeCount = 0;
      const origAdd = ac.signal.addEventListener.bind(ac.signal);
      const origRemove = ac.signal.removeEventListener.bind(ac.signal);
      ac.signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
        if (args[0] === 'abort') addCount++;
        return origAdd(...args);
      }) as typeof origAdd;
      ac.signal.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
        if (args[0] === 'abort') removeCount++;
        return origRemove(...args);
      }) as typeof origRemove;

      // Waiter will be settled by dispose().
      const p = lock.acquire({ signal: ac.signal });
      const settlement = p.then(
        () => ({ kind: 'resolved' as const }),
        (err: unknown) => ({ kind: 'rejected' as const, err }),
      );
      lock.dispose();
      const result = await settlement;
      expect(result.kind).toBe('rejected');
      expect(addCount).toBeGreaterThan(0);
      expect(removeCount).toBeGreaterThanOrEqual(addCount);
      release();
    });

    it('mixed queue — some waiters aborted, some disposed', async () => {
      const lock = createAsyncLock();
      const release = await lock.acquire();

      const acA = new AbortController();
      const acB = new AbortController();
      // A will be aborted before dispose; B and plain will be handled by dispose.
      const pA = lock.acquire({ signal: acA.signal });
      const pB = lock.acquire({ signal: acB.signal });
      const pPlain = lock.acquire();

      const sA = pA.then(() => 'A-res' as const, (e: unknown) => ({ err: e }));
      const sB = pB.then(() => 'B-res' as const, (e: unknown) => ({ err: e }));
      const sPlain = pPlain.then(() => 'P-res' as const, (e: unknown) => ({ err: e }));

      acA.abort();
      // Give microtasks a chance so A settles first.
      await Promise.resolve();
      lock.dispose();
      // Fire acB after dispose to exercise the post-dispose abort guard on B.
      acB.abort();

      const [rA, rB, rP] = await Promise.all([sA, sB, sPlain]);
      // All three rejected with LOCK_ABORTED.
      for (const r of [rA, rB, rP]) {
        expect(typeof r).toBe('object');
        expect((r as { err: HarnessError }).err).toBeInstanceOf(HarnessError);
        expect((r as { err: HarnessError }).err.code).toBe(HarnessErrorCode.LOCK_ABORTED);
      }
      release();
    });
  });
});
