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

import { HarnessError, HarnessErrorCode } from './errors-base.js';

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
  /** Reject all queued waiters and prevent future acquisitions. */
  dispose(): void;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: unknown) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
  /**
   * Wave-13 A-4: Set to `true` by whichever of `dispose()` or the abort
   * handler runs first. The second runner sees the flag and skips its own
   * `reject()`, preventing a double-reject race where both paths observe
   * the waiter in-flight and both try to settle the same promise.
   *
   * Promises are idempotent under double-settle (subsequent calls are
   * no-ops), but the flag lets us also skip the unnecessary listener /
   * queue work and makes intent explicit.
   */
  aborted: boolean;
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
  let disposed = false;
  const queue: Waiter[] = [];

  function handoff(): void {
    // Race-safe: both handoff (via queue.shift) and the abort handler (via
    // queue.splice) are synchronous. If abort wins, the waiter is already
    // removed from the queue by the time handoff runs. If handoff wins, it
    // detaches the abort listener before resolving, so the listener never fires.
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
    if (disposed) {
      throw new HarnessError(
        'Lock has been disposed',
        HarnessErrorCode.LOCK_ABORTED,
        'The lock was disposed — create a new lock if needed',
      );
    }
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
      const waiter: Waiter = { resolve, reject, aborted: false };
      if (signal) {
        const onAbort = (): void => {
          // Wave-13 A-4: Race protection against dispose().
          // If dispose() already claimed this waiter, its `aborted` flag is
          // set; skip the reject to avoid a double-settle and do not touch
          // the queue (dispose() already drained it).
          if (waiter.aborted) {
            // Still drop the listener — dispose() may not have, e.g. if we
            // lost a microtask race. Defensive, cheap, idempotent.
            signal.removeEventListener('abort', onAbort);
            return;
          }
          waiter.aborted = true;
          const idx = queue.indexOf(waiter);
          if (idx >= 0) queue.splice(idx, 1);
          // Wave-13 A-4: Unconditionally detach the listener to avoid
          // unbounded accumulation on long-lived AbortSignals. The
          // `{ once: true }` option handles the common case, but an
          // explicit removeEventListener is robust against runtime
          // implementations that drop the option.
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

  function dispose(): void {
    disposed = true;
    while (queue.length > 0) {
      const waiter = queue.shift() as Waiter;
      // Wave-13 A-4: Race protection against concurrent abort-handler.
      // If the abort handler already claimed this waiter, skip — it
      // already rejected and removed its listener. Without this check,
      // both paths would call `reject()` on the same promise; while
      // Promise semantics make the second call a no-op, relying on that
      // is fragile and obscures intent.
      if (waiter.aborted) {
        continue;
      }
      waiter.aborted = true;
      // Detach abort listener first — we are settling the promise
      // synchronously here, so the listener would otherwise fire later
      // and do redundant work (or leak if the signal outlives the lock).
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(
        new HarnessError(
          'Lock has been disposed',
          HarnessErrorCode.LOCK_ABORTED,
          'The lock was disposed while waiting — create a new lock if needed',
        ),
      );
    }
  }

  return { acquire, withLock, dispose };
}
