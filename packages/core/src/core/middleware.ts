/**
 * Middleware chain for intercepting adapter calls and tool execution.
 *
 * Follows the onion model: each middleware wraps the next, with the
 * innermost handler being the actual operation.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from './errors.js';

/** Context passed through the middleware chain. */
export type MiddlewareContext<TExtra extends Record<string, unknown> = Record<string, unknown>> = {
  type: 'chat' | 'tool_call' | 'tool_result';
} & TExtra;

/** A single middleware function. Calls `next()` to proceed to the next middleware or handler. */
export type MiddlewareFn<TExtra extends Record<string, unknown> = Record<string, unknown>> =
  (ctx: MiddlewareContext<TExtra>, next: () => Promise<unknown>) => Promise<unknown>;

/** A composable middleware chain. */
export interface MiddlewareChain<TExtra extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Register a middleware function. Middlewares execute in registration order.
   *
   * NOTE: `use()` is intended for startup/configuration — register middlewares
   * before the chain is put under load. Registering while execute() is in
   * flight is supported but the new middleware only participates in subsequent
   * executions, not the currently-running one.
   *
   * PERF-026: The chain storage is a `Set<MiddlewareFn>`. JS `Set` preserves
   * insertion order, so execution order is unchanged from the historical
   * array-backed implementation. Unsubscribe is O(1) (Set.delete) instead of
   * O(n) indexOf+splice. **Behavior change**: registering the same function
   * twice is now deduplicated — a reference can only participate once. Wrap
   * the function in a fresh closure to register it twice.
   *
   * @returns CQ-016: An `unsubscribe()` function that removes this specific
   *   middleware from the chain. Calling it more than once is a no-op.
   */
  use(fn: MiddlewareFn<TExtra>): () => void;
  /**
   * CQ-016: Remove every registered middleware. Intended for teardown or for
   * swapping an entire middleware set in tests.
   */
  clear(): void;
  /** Execute the chain with the given context and terminal handler. */
  execute(ctx: MiddlewareContext<TExtra>, handler: () => Promise<unknown>): Promise<unknown>;
}

/**
 * Creates a new middleware chain.
 *
 * @example
 * ```ts
 * const chain = createMiddlewareChain();
 * chain.use(async (ctx, next) => {
 *   console.log('before', ctx.type);
 *   const result = await next();
 *   console.log('after', ctx.type);
 *   return result;
 * });
 * const result = await chain.execute({ type: 'chat' }, () => adapter.chat(params));
 * ```
 */
export function createMiddlewareChain<TExtra extends Record<string, unknown> = Record<string, unknown>>(options?: {
  /** Optional error handler called when a middleware throws. */
  onError?: (error: Error, ctx: MiddlewareContext<TExtra>) => void;
}): MiddlewareChain<TExtra> {
  // PERF-026: Set-backed storage — JS Sets preserve insertion order, so
  // execution order is identical to the previous array-backed version.
  // Unsubscribe is O(1) instead of O(n) indexOf+splice. Tradeoff: registering
  // the same function twice is now deduplicated (see MiddlewareChain.use docs).
  const middlewares = new Set<MiddlewareFn<TExtra>>();
  const onError = options?.onError;

  return {
    use(fn: MiddlewareFn<TExtra>): () => void {
      middlewares.add(fn);
      // CQ-016: Return an idempotent unsubscribe. `Set.delete` is O(1) and
      // naturally idempotent (returns false on second call), but we still
      // guard with `unsubscribed` so callers observing the flag don't trigger
      // a no-op mutation on the set.
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        middlewares.delete(fn);
      };
    },

    clear(): void {
      middlewares.clear();
    },

    async execute(ctx: MiddlewareContext<TExtra>, handler: () => Promise<unknown>): Promise<unknown> {
      // Snapshot to an array at execute() start so mid-flight use()/
      // unsubscribe() calls behave the same way as the historical array
      // version (new middlewares only participate in subsequent executions).
      // Using Array.from instead of Set.values() prevents iterator
      // invalidation if the Set is mutated during async execution.
      const snapshot = Array.from(middlewares);
      let idx = 0;
      const next = async (): Promise<unknown> => {
        if (idx < snapshot.length) {
          const mw = snapshot[idx++];
          try {
            return await mw(ctx, next);
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            if (onError) {
              onError(error, ctx);
            }
            if (err instanceof HarnessError) {
              throw err;
            }
            throw new HarnessError(
              error.message,
              HarnessErrorCode.CORE_MIDDLEWARE_ERROR,
              'Check the middleware implementation',
              error,
            );
          }
        }
        return handler();
      };
      return next();
    },
  };
}
