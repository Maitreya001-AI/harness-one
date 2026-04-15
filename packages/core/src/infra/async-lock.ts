/**
 * Minimal single-owner async mutex.
 *
 * JS is single-threaded but `await` is a preemption point: any "read map →
 * await → mutate map" sequence is a TOCTOU vulnerability when two async
 * functions can interleave on the same shared state. `createAsyncLock()`
 * serialises those critical sections with a FIFO queue so at most one
 * holder is inside the guarded region at a time.
 *
 * The lock is **single-owner**: there is no reentrancy check. A holder that
 * calls `acquire()` again from within its own critical section will
 * deadlock. This is intentional — reentrant mutexes are almost always a
 * symptom of mixed concerns; prefer splitting the critical section.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from '../core/errors.js';

/** Options accepted by {@link AsyncLock.acquire}. */
export interface AcquireOptions {
  /**
   * Optional abort signal. When the signal fires before the lock becomes
   * available, `acquire()` rejects with a `HarnessError(HarnessErrorCode.LOCK_ABORTED)`
   * and the waiter is removed from the queue.
   */
  readonly signal?: AbortSignal;
}

/** A single-owner async mutex. */
export interface AsyncLock {
  /**
   * Acquire the lock. Resolves with a `release` function the holder MUST
   * call (even on error) — the typical pattern is `try { ... } finally
   * { release(); }`. Prefer {@link withLock} which handles release for you.
   */
  acquire(options?: AcquireOptions): Promise<() => void>;
  /**
   * Run `fn` under the lock. The lock is released even if `fn` throws.
   * Returns the value `fn` resolves to, or re-throws its rejection.
   */
  withLock<T>(fn: () => Promise<T>, options?: AcquireOptions): Promise<T>;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: unknown) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

/**
 * Create a new async lock. Each call produces an independent mutex — lock
 * state is closure-local and not shared across returned instances.
 *
 * @example
 * ```ts
 * const lock = createAsyncLock();
 * await lock.withLock(async () => {
 *   const value = state.get(key);
 *   const next = await compute(value);
 *   state.set(key, next);
 * });
 * ```
 */
export function createAsyncLock(): AsyncLock {
  let held = false;
  const queue: Waiter[] = [];

  function handoff(): void {
    // Called by `release()`. Hand the lock to the next waiter, or mark it free.
    while (queue.length > 0) {
      const next = queue.shift() as Waiter;
      // Detach abort listener — no longer needed once we're handing off.
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      held = true;
      // Build a fresh release that can only fire once.
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        held = false;
        handoff();
      });
      return;
    }
    held = false;
  }

  async function acquire(options?: AcquireOptions): Promise<() => void> {
    const signal = options?.signal;
    if (signal?.aborted) {
      throw new HarnessError(
        'Lock acquire aborted',
        HarnessErrorCode.LOCK_ABORTED,
        'The AbortSignal was already aborted when acquire() was called',
      );
    }
    if (!held) {
      held = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held = false;
        handoff();
      };
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (signal) {
        const onAbort = (): void => {
          const idx = queue.indexOf(waiter);
          if (idx >= 0) queue.splice(idx, 1);
          signal.removeEventListener('abort', onAbort);
          reject(
            new HarnessError(
              'Lock acquire aborted',
              HarnessErrorCode.LOCK_ABORTED,
              'The AbortSignal fired while waiting for the lock',
            ),
          );
        };
        waiter.signal = signal;
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      queue.push(waiter);
    });
  }

  async function withLock<T>(fn: () => Promise<T>, options?: AcquireOptions): Promise<T> {
    const release = await acquire(options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { acquire, withLock };
}
