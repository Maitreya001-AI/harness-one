/**
 * Middleware chain for intercepting adapter calls and tool execution.
 *
 * Follows the onion model: each middleware wraps the next, with the
 * innermost handler being the actual operation.
 *
 * @module
 */

/** Context passed through the middleware chain. */
export type MiddlewareContext = {
  type: 'chat' | 'tool_call' | 'tool_result';
  [key: string]: unknown;
};

/** A single middleware function. Calls `next()` to proceed to the next middleware or handler. */
export type MiddlewareFn = (ctx: MiddlewareContext, next: () => Promise<unknown>) => Promise<unknown>;

/** A composable middleware chain. */
export interface MiddlewareChain {
  /** Register a middleware function. Middlewares execute in registration order. */
  use(fn: MiddlewareFn): void;
  /** Execute the chain with the given context and terminal handler. */
  execute(ctx: MiddlewareContext, handler: () => Promise<unknown>): Promise<unknown>;
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
export function createMiddlewareChain(): MiddlewareChain {
  const middlewares: MiddlewareFn[] = [];

  return {
    use(fn: MiddlewareFn): void {
      middlewares.push(fn);
    },

    async execute(ctx: MiddlewareContext, handler: () => Promise<unknown>): Promise<unknown> {
      let index = 0;
      const next = async (): Promise<unknown> => {
        if (index < middlewares.length) {
          const mw = middlewares[index++];
          return mw(ctx, next);
        }
        return handler();
      };
      return next();
    },
  };
}
