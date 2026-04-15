/**
 * Unref-by-default timer helpers.
 *
 * Node's `setTimeout` / `setInterval` return a `Timeout` object that keeps
 * the event loop alive until cleared. Long-lived library timers (cache
 * sweepers, health checks, background flushers, ...) should NEVER hold the
 * loop open — the host process decides when to exit, not the library.
 *
 * Callers that need the timer to block process exit must re-`.ref()` the
 * returned handle explicitly.
 *
 * Wave-5F m-2 consolidates the 22-site `setTimeout()/setInterval()` + ad-hoc
 * `.unref?.()` pattern into two entry points.
 *
 * @module
 */

/** An `unref()`-applied timer handle. Compatible with `clearTimeout`/`clearInterval`. */
export type UnrefTimer = ReturnType<typeof setTimeout>;

/**
 * `setTimeout` that immediately `.unref()`s the resulting timer so it does
 * not keep the Node event loop alive.
 */
export function unrefTimeout(fn: () => void, ms: number): UnrefTimer {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}

/**
 * `setInterval` that immediately `.unref()`s the resulting timer so it does
 * not keep the Node event loop alive.
 */
export function unrefInterval(fn: () => void, ms: number): UnrefTimer {
  const t = setInterval(fn, ms);
  t.unref?.();
  return t;
}
