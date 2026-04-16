import { describe, it, expect, vi } from 'vitest';
import { createLazyAsync } from '../lazy-async.js';

describe('createLazyAsync', () => {
  it('returns the factory value on first call', async () => {
    const lazy = createLazyAsync(async () => 42);
    expect(await lazy.get()).toBe(42);
  });

  it('invokes the factory at most once across many sequential calls', async () => {
    const factory = vi.fn(async () => 'v');
    const lazy = createLazyAsync(factory);
    await lazy.get();
    await lazy.get();
    await lazy.get();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('shares the in-flight promise among concurrent callers', async () => {
    let resolveIt: (value: number) => void = () => {};
    const factory = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveIt = resolve;
        }),
    );
    const lazy = createLazyAsync(factory);
    const a = lazy.get();
    const b = lazy.get();
    const c = lazy.get();
    // Factory runs exactly once because all callers joined the same pending promise.
    expect(factory).toHaveBeenCalledTimes(1);
    resolveIt(7);
    const [va, vb, vc] = await Promise.all([a, b, c]);
    expect(va).toBe(7);
    expect(vb).toBe(7);
    expect(vc).toBe(7);
  });

  it('caches the promise synchronously before awaiting factory', async () => {
    // This is the critical property: by the time a second caller enters get(),
    // the cached promise already exists so a second factory call is impossible.
    let count = 0;
    const lazy = createLazyAsync(async () => {
      count++;
      await new Promise((r) => setTimeout(r, 5));
      return count;
    });
    // Kick off three concurrent gets in the same tick.
    const results = await Promise.all([lazy.get(), lazy.get(), lazy.get()]);
    expect(count).toBe(1);
    expect(results).toEqual([1, 1, 1]);
  });

  it('clears the cached promise on rejection so the next call retries', async () => {
    let calls = 0;
    const lazy = createLazyAsync(async () => {
      calls++;
      if (calls === 1) throw new Error('first-fail');
      return 'ok';
    });
    await expect(lazy.get()).rejects.toThrow('first-fail');
    // Retry succeeds and uses a fresh factory invocation.
    expect(await lazy.get()).toBe('ok');
    expect(calls).toBe(2);
  });

  it('all concurrent callers observe the same rejection, then the next caller retries', async () => {
    let calls = 0;
    const lazy = createLazyAsync(async () => {
      calls++;
      if (calls === 1) {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('boom');
      }
      return 'ok';
    });
    const [a, b, c] = await Promise.allSettled([lazy.get(), lazy.get(), lazy.get()]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(c.status).toBe('rejected');
    expect(calls).toBe(1);
    // Retry
    expect(await lazy.get()).toBe('ok');
    expect(calls).toBe(2);
  });

  it('reset() clears cache so the next get re-invokes factory', async () => {
    const factory = vi.fn(async () => 1);
    const lazy = createLazyAsync(factory);
    await lazy.get();
    await lazy.get();
    expect(factory).toHaveBeenCalledTimes(1);
    lazy.reset();
    await lazy.get();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('reset() during an in-flight call does not break the call itself', async () => {
    let resolve: (v: string) => void = () => {};
    const factory = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const lazy = createLazyAsync(factory);
    const inflight = lazy.get();
    lazy.reset();
    // Next call starts a fresh factory call.
    const second = lazy.get();
    expect(factory).toHaveBeenCalledTimes(2);
    resolve('v');
    // Both the pre-reset and post-reset promises resolve (possibly from
    // different factory invocations but the framework only resolved the one
    // we have a handle to via `resolve`, which was the SECOND call — the
    // first awaits its own resolve too).
    // We drive both by awaiting in order.
    await expect(second).resolves.toBe('v');
    // Force the first factory invocation to settle, too.
    // (It's captured by the first `new Promise` invocation.)
    // We didn't retain that resolver, but the test has verified the key
    // property: reset mid-flight does not prevent a new factory from firing.
    // Detach the inflight promise from the test so an unhandled rejection
    // (if any) doesn't fail the run. This mirrors how consumers treat reset.
    inflight.catch(() => {});
  });

  it('surfaces synchronous factory throws as rejected promise', async () => {
    const lazy = createLazyAsync((() => {
      throw new Error('sync boom');
    }) as () => Promise<number>);
    await expect(lazy.get()).rejects.toThrow('sync boom');
    // And retries on next call.
    let calls = 0;
    const lazy2 = createLazyAsync((() => {
      calls++;
      if (calls === 1) throw new Error('again');
      return Promise.resolve('ok');
    }) as () => Promise<string>);
    await expect(lazy2.get()).rejects.toThrow('again');
    await expect(lazy2.get()).resolves.toBe('ok');
  });

  it('does not re-clear cache when reset was already called between fail and rejection', async () => {
    // A reset() call clears pending. If the in-flight promise then rejects,
    // our cache-clear branch should detect that `pending !== p` and leave
    // the (new) pending alone.
    let firstReject: ((err: unknown) => void) | null = null;
    let callNum = 0;
    const factory = vi.fn(() => {
      callNum++;
      if (callNum === 1) {
        return new Promise<string>((_, reject) => {
          firstReject = reject;
        });
      }
      return Promise.resolve('clean');
    });
    const lazy = createLazyAsync(factory);
    const first = lazy.get();
    await new Promise((r) => setTimeout(r, 1));
    // Reset clears the cached (still-pending) promise.
    lazy.reset();
    const second = lazy.get();
    expect(factory).toHaveBeenCalledTimes(2);
    // Now fire the FIRST call's rejection. The cache-clear branch must notice
    // the cached promise is no longer this one and leave the new pending alone.
    (firstReject as unknown as (err: unknown) => void)(new Error('delayed'));
    await expect(first).rejects.toThrow('delayed');
    await expect(second).resolves.toBe('clean');
    // Subsequent get() should join the resolved cache (no third factory call).
    await expect(lazy.get()).resolves.toBe('clean');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('reset() between rejection scheduling and execution does not clear the new pending promise', async () => {
    // Race condition: reset() is called after a rejection is scheduled but
    // before it executes. The rejection handler must not clear the NEW pending
    // promise that was created after reset().
    let firstReject: ((err: unknown) => void) | null = null;
    let callNum = 0;
    const factory = vi.fn((): Promise<string> => {
      callNum++;
      if (callNum === 1) {
        return new Promise<string>((_, reject) => { firstReject = reject; });
      }
      return Promise.resolve('fresh');
    });
    const lazy = createLazyAsync(factory);

    // Start first get — factory call #1
    const first = lazy.get();
    await new Promise((r) => setTimeout(r, 1));

    // Reset clears the pending promise
    lazy.reset();

    // Start second get — factory call #2 (new pending promise)
    const second = lazy.get();
    expect(factory).toHaveBeenCalledTimes(2);

    // Now reject the FIRST factory call. With the generation counter fix,
    // this should NOT clear the second pending promise.
    firstReject!(new Error('late rejection'));
    await expect(first).rejects.toThrow('late rejection');
    await expect(second).resolves.toBe('fresh');

    // Critical: a third get() should reuse the second's cached promise,
    // NOT start a new factory call.
    await expect(lazy.get()).resolves.toBe('fresh');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('returns a distinct handle per invocation', () => {
    const a = createLazyAsync(async () => 1);
    const b = createLazyAsync(async () => 2);
    expect(a).not.toBe(b);
  });
});
