/**
 * Lazy, concurrency-safe async value.
 *
 * Wraps an async `factory()` so callers that race to `get()` all observe the
 * SAME in-flight promise rather than each kicking off a duplicate factory
 * invocation. The in-flight promise is stored **synchronously, before
 * awaiting the factory**, which is the property that makes this safe under
 * concurrent access: by the time a second caller enters `get()`, the cached
 * promise already exists, so they join it instead of starting a new factory.
 *
 * On rejection the cached promise is cleared, so the next `get()` call
 * retries — avoiding the trap where a transient startup failure permanently
 * poisons the handle.
 *
 * @module
 */

/** A lazily-initialised async value. */
export interface LazyAsync<T> {
  /**
   * Return the factory's resolved value. Concurrent callers share the same
   * promise; on rejection the cache is cleared and the next call retries.
   */
  get(): Promise<T>;
  /**
   * Forget the cached promise. The next `get()` will re-invoke the factory.
   * Useful after manual reconnection logic that knows the underlying value
   * is no longer valid.
   */
  reset(): void;
}

/**
 * Create a lazy async handle.
 *
 * @param factory - Producer for the underlying value. Invoked at most once
 *   per successful resolution cycle. If the factory synchronously throws,
 *   the thrown error is converted into a rejected promise so concurrent
 *   callers all see it consistently.
 *
 * @example
 * ```ts
 * const lazy = createLazyAsync(() => initExporter());
 * // Concurrent callers share one init.
 * await Promise.all([lazy.get(), lazy.get(), lazy.get()]);
 * ```
 */
export function createLazyAsync<T>(factory: () => Promise<T>): LazyAsync<T> {
  let pending: Promise<T> | null = null;

  function get(): Promise<T> {
    if (pending) return pending;
    // Store the promise synchronously before awaiting — this is the whole
    // point. A second caller that enters `get()` during the same microtask
    // sees the same pending promise and joins it.
    let inner: Promise<T>;
    try {
      inner = factory();
    } catch (err) {
      // Factory threw synchronously. Wrap and fall through to the rejection
      // cleanup branch below.
      inner = Promise.reject(err);
    }
    const p = inner.then(
      (value) => value,
      (err) => {
        // Clear the cache on failure so the next caller retries. Guard against
        // the case where the caller has already called reset() between the
        // rejection scheduling and its resolution.
        if (pending === p) pending = null;
        throw err;
      },
    );
    pending = p;
    return p;
  }

  function reset(): void {
    pending = null;
  }

  return { get, reset };
}
