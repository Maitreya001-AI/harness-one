/**
 * Disposable protocol for harness-one subsystems.
 *
 * The {@link Disposable} contract codifies the convention previously scattered
 * across factories (TraceManager, AgentPool, SessionManager, etc.): every
 * long-lived resource exposes an idempotent, asynchronous `dispose()` and a
 * readonly `disposed` flag callers can inspect before re-use.
 *
 * Why async + idempotent:
 * - Sub-systems may own timers, sockets, and in-flight flush promises that
 *   must be awaited before it's safe to exit the process.
 * - `shutdown()` from multiple call sites (signal handlers, integration tests,
 *   user `await harness.shutdown()`) must be safe to invoke concurrently.
 *
 * @module
 */

/**
 * A resource whose lifecycle can be explicitly terminated.
 *
 * Implementations MUST:
 * 1. Make `dispose()` idempotent — subsequent calls return the same promise
 *    (or a resolved one) without re-running teardown.
 * 2. Flip `disposed` to `true` on successful (or failed) completion.
 * 3. Await any in-flight I/O owned by the resource before resolving.
 *
 * @example
 * ```ts
 * class ResourceLike implements Disposable {
 *   private _disposed = false;
 *   private _pending: Promise<void> | null = null;
 *   get disposed(): boolean { return this._disposed; }
 *   dispose(): Promise<void> {
 *     if (this._pending) return this._pending;
 *     this._pending = (async () => {
 *       try { await this.teardown(); } finally { this._disposed = true; }
 *     })();
 *     return this._pending;
 *   }
 *   private async teardown(): Promise<void> {
 *     // close handles
 *   }
 * }
 * ```
 */
export interface Disposable {
  /**
   * Release resources owned by this object. Idempotent. Always resolves —
   * internal errors are aggregated and surfaced by {@link disposeAll} when
   * used in a composite teardown, or handled individually otherwise.
   */
  dispose(): Promise<void>;
  /** `true` once `dispose()` has fully settled (success or failure). */
  readonly disposed: boolean;
}

/**
 * Aggregate error type thrown by {@link disposeAll} when one or more
 * disposables reject. Unlike the platform `AggregateError`, this class also
 * exposes the 0-based indices of the failing disposables so callers can
 * correlate failures back to the original array.
 */
export class DisposeAggregateError extends Error {
  /** The individual errors collected during sequential disposal. */
  readonly errors: readonly unknown[];
  /** Indices (into the original array) of the failing disposables. */
  readonly indices: readonly number[];

  constructor(errors: readonly unknown[], indices: readonly number[]) {
    const parts = errors.map((err, i) => {
      const message = err instanceof Error ? err.message : String(err);
      return `[${indices[i]}] ${message}`;
    });
    super(`disposeAll: ${errors.length} disposable(s) failed: ${parts.join('; ')}`);
    this.name = 'DisposeAggregateError';
    this.errors = errors;
    this.indices = indices;
  }
}

/**
 * Dispose every entry in `disposables` sequentially, awaiting each one before
 * starting the next. Errors are collected; if any disposable rejects the
 * aggregate is thrown **after** every disposable has had a chance to run.
 *
 * Sequential (rather than `Promise.all`) because disposal order matters: the
 * harness shutdown DAG requires that dependent sub-systems finish before
 * their dependencies (e.g. `AgentLoop` before `TraceManager`).
 *
 * @param disposables - Disposables to tear down, **in the order you want them
 *   torn down**.
 * @throws `DisposeAggregateError` when one or more disposables reject.
 *
 * @example
 * ```ts
 * await disposeAll([loop, pool, traces, exporter]);
 * ```
 */
export async function disposeAll(disposables: readonly Disposable[]): Promise<void> {
  const errors: unknown[] = [];
  const indices: number[] = [];
  for (let i = 0; i < disposables.length; i++) {
    const d = disposables[i];
    try {
      await d.dispose();
    } catch (err) {
      errors.push(err);
      indices.push(i);
    }
  }
  if (errors.length > 0) {
    throw new DisposeAggregateError(errors, indices);
  }
}
