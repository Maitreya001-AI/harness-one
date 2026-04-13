/**
 * Middleware chain for intercepting adapter calls and tool execution.
 *
 * Follows the onion model: each middleware wraps the next, with the
 * innermost handler being the actual operation.
 *
 * @module
 */

import { HarnessError } from './errors.js';

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
  const middlewares: MiddlewareFn<TExtra>[] = [];
  const onError = options?.onError;

  return {
    use(fn: MiddlewareFn<TExtra>): () => void {
      middlewares.push(fn);
      // CQ-016: Return an idempotent unsubscribe. We look up by reference at
      // call time (instead of capturing an index) so re-registrations and
      // other remove-ops don't corrupt the unsubscribe handle.
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        const idx = middlewares.indexOf(fn);
        if (idx !== -1) {
          middlewares.splice(idx, 1);
        }
      };
    },

    clear(): void {
      middlewares.length = 0;
    },

    async execute(ctx: MiddlewareContext<TExtra>, handler: () => Promise<unknown>): Promise<unknown> {
      let index = 0;
      const next = async (): Promise<unknown> => {
        if (index < middlewares.length) {
          const mw = middlewares[index++];
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
              'MIDDLEWARE_ERROR',
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
