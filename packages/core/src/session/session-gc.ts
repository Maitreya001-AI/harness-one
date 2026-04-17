/**
 * Session GC timer.
 *
 * Extracted from `session/manager.ts` in round-3 cleanup. The manager used
 * `setInterval(() => manager.gc(), ...)` inline — which closed over the
 * still-TDZ `manager` const and required an `.unref?.()` shim. The helper
 * below keeps the timer lifecycle in one place and makes the wiring
 * ordering-proof: the caller hands in the `runGc` callback at a point where
 * the manager is already constructed.
 *
 * @module
 */

export interface SessionGcHandle {
  /** Tear down the timer. Safe to call multiple times. */
  stop(): void;
}

/**
 * Start a `setInterval`-backed GC loop that invokes `runGc` at most once per
 * `intervalMs` milliseconds. When `intervalMs <= 0` no timer is scheduled and
 * the returned handle's `stop()` is a no-op (useful for tests that drive GC
 * manually).
 *
 * The timer is `unref()`-ed so an idle GC loop never blocks Node process exit.
 */
export function startSessionGc(
  runGc: () => void,
  intervalMs: number,
): SessionGcHandle {
  if (intervalMs <= 0) {
    return { stop: () => {} };
  }
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    try {
      runGc();
    } catch {
      // A throwing GC pass must not kill the timer — the next tick still
      // runs. Errors are the manager's job to surface via its logger.
    }
  }, intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }
  return {
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
