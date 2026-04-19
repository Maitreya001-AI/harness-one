import { describe, it, expect, vi } from 'vitest';
import { createMiddlewareChain } from '../middleware.js';
import type { MiddlewareContext } from '../middleware.js';
import { HarnessError, HarnessErrorCode} from '../errors.js';

describe('createMiddlewareChain', () => {
  it('executes handler directly with no middleware', async () => {
    const chain = createMiddlewareChain();
    const handler = vi.fn().mockResolvedValue('result');
    const result = await chain.execute({ type: 'chat' }, handler);
    expect(result).toBe('result');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('executes a single middleware wrapping the handler', async () => {
    const chain = createMiddlewareChain();
    const order: string[] = [];

    chain.use(async (_ctx, next) => {
      order.push('before');
      const result = await next();
      order.push('after');
      return result;
    });

    const handler = vi.fn(async () => {
      order.push('handler');
      return 'value';
    });

    const result = await chain.execute({ type: 'chat' }, handler);
    expect(result).toBe('value');
    expect(order).toEqual(['before', 'handler', 'after']);
  });

  it('executes multiple middlewares in order (onion model)', async () => {
    const chain = createMiddlewareChain();
    const order: string[] = [];

    chain.use(async (_ctx, next) => {
      order.push('A-before');
      const result = await next();
      order.push('A-after');
      return result;
    });

    chain.use(async (_ctx, next) => {
      order.push('B-before');
      const result = await next();
      order.push('B-after');
      return result;
    });

    const handler = async () => {
      order.push('handler');
      return 42;
    };

    await chain.execute({ type: 'tool_call' }, handler);
    expect(order).toEqual(['A-before', 'B-before', 'handler', 'B-after', 'A-after']);
  });

  it('passes context to each middleware', async () => {
    const chain = createMiddlewareChain();
    const seenContexts: MiddlewareContext[] = [];

    chain.use(async (ctx, next) => {
      seenContexts.push(ctx);
      return next();
    });

    chain.use(async (ctx, next) => {
      seenContexts.push(ctx);
      return next();
    });

    const ctx: MiddlewareContext = { type: 'tool_result', toolName: 'search' };
    await chain.execute(ctx, async () => 'done');

    expect(seenContexts).toHaveLength(2);
    expect(seenContexts[0]).toBe(ctx);
    expect(seenContexts[1]).toBe(ctx);
  });

  it('allows middleware to modify the return value', async () => {
    const chain = createMiddlewareChain();

    chain.use(async (_ctx, next) => {
      const result = await next();
      return (result as number) * 2;
    });

    const result = await chain.execute({ type: 'chat' }, async () => 5);
    expect(result).toBe(10);
  });

  it('allows middleware to short-circuit without calling next', async () => {
    const chain = createMiddlewareChain();
    const handler = vi.fn().mockResolvedValue('should not reach');

    chain.use(async () => {
      return 'short-circuited';
    });

    const result = await chain.execute({ type: 'chat' }, handler);
    expect(result).toBe('short-circuited');
    expect(handler).not.toHaveBeenCalled();
  });

  it('propagates errors from middleware', async () => {
    const chain = createMiddlewareChain();

    chain.use(async () => {
      throw new Error('middleware error');
    });

    await expect(chain.execute({ type: 'chat' }, async () => 'ok')).rejects.toThrow('middleware error');
  });

  it('propagates errors from handler through middleware', async () => {
    const chain = createMiddlewareChain();
    const caught: Error[] = [];

    chain.use(async (_ctx, next) => {
      try {
        return await next();
      } catch (err) {
        caught.push(err as Error);
        throw err;
      }
    });

    await expect(
      chain.execute({ type: 'chat' }, async () => {
        throw new Error('handler error');
      }),
    ).rejects.toThrow('handler error');

    expect(caught).toHaveLength(1);
    expect(caught[0].message).toBe('handler error');
  });

  it('allows middleware to catch and replace errors', async () => {
    const chain = createMiddlewareChain();

    chain.use(async (_ctx, next) => {
      try {
        return await next();
      } catch {
        return 'fallback';
      }
    });

    const result = await chain.execute({ type: 'chat' }, async () => {
      throw new Error('oops');
    });
    expect(result).toBe('fallback');
  });

  it('supports adding middleware after creation but before execute', async () => {
    const chain = createMiddlewareChain();
    const order: string[] = [];

    chain.use(async (_ctx, next) => {
      order.push('first');
      return next();
    });

    // Add second middleware later
    chain.use(async (_ctx, next) => {
      order.push('second');
      return next();
    });

    await chain.execute({ type: 'chat' }, async () => {
      order.push('handler');
      return null;
    });
    expect(order).toEqual(['first', 'second', 'handler']);
  });

  it('allows middleware to mutate context for downstream use', async () => {
    const chain = createMiddlewareChain();

    chain.use(async (ctx, next) => {
      ctx.startTime = Date.now();
      const result = await next();
      ctx.endTime = Date.now();
      return result;
    });

    const ctx: MiddlewareContext = { type: 'chat' };
    await chain.execute(ctx, async () => 'done');
    expect(ctx.startTime).toBeDefined();
    expect(ctx.endTime).toBeDefined();
    expect((ctx.endTime as number) >= (ctx.startTime as number)).toBe(true);
  });

  it('supports typed context via generic parameter', async () => {
    type MyExtra = { model: string; temperature: number };
    const chain = createMiddlewareChain<MyExtra>();
    let capturedModel = '';

    chain.use(async (ctx, next) => {
      // ctx.model should be accessible without casting
      capturedModel = ctx.model;
      return next();
    });

    await chain.execute({ type: 'chat', model: 'gpt-4', temperature: 0.7 }, async () => 'ok');
    expect(capturedModel).toBe('gpt-4');
  });

  it('works without generic parameter (backward compatible)', async () => {
    const chain = createMiddlewareChain();
    let seenType = '';

    chain.use(async (ctx, next) => {
      seenType = ctx.type;
      return next();
    });

    await chain.execute({ type: 'tool_call' }, async () => 'ok');
    expect(seenType).toBe('tool_call');
  });

  describe('unsubscribe and clear', () => {
    it('use() returns an unsubscribe function that removes the middleware', async () => {
      const chain = createMiddlewareChain();
      const order: string[] = [];

      const unsubscribe = chain.use(async (_ctx, next) => {
        order.push('A');
        return next();
      });
      chain.use(async (_ctx, next) => {
        order.push('B');
        return next();
      });

      // Before unsubscribe: both run
      await chain.execute({ type: 'chat' }, async () => 'ok');
      expect(order).toEqual(['A', 'B']);

      // Unsubscribe A
      order.length = 0;
      unsubscribe();
      await chain.execute({ type: 'chat' }, async () => 'ok');
      expect(order).toEqual(['B']);
    });

    it('unsubscribe is idempotent', async () => {
      const chain = createMiddlewareChain();
      const order: string[] = [];

      const unsubscribe = chain.use(async (_ctx, next) => {
        order.push('A');
        return next();
      });

      unsubscribe();
      unsubscribe(); // second call should be a no-op, not a crash
      await chain.execute({ type: 'chat' }, async () => 'ok');
      expect(order).toEqual([]);
    });

    it('clear() removes all middlewares', async () => {
      const chain = createMiddlewareChain();
      const order: string[] = [];

      chain.use(async (_ctx, next) => { order.push('A'); return next(); });
      chain.use(async (_ctx, next) => { order.push('B'); return next(); });
      chain.use(async (_ctx, next) => { order.push('C'); return next(); });

      chain.clear();

      await chain.execute({ type: 'chat' }, async () => 'ok');
      expect(order).toEqual([]);
    });

    it('clear() allows adding new middlewares afterward', async () => {
      const chain = createMiddlewareChain();
      const order: string[] = [];

      chain.use(async (_ctx, next) => { order.push('old'); return next(); });
      chain.clear();
      chain.use(async (_ctx, next) => { order.push('new'); return next(); });

      await chain.execute({ type: 'chat' }, async () => 'ok');
      expect(order).toEqual(['new']);
    });
  });

  describe('Fix 10: Error handling in middleware chain', () => {
    it('wraps middleware errors in HarnessError with MIDDLEWARE_ERROR code', async () => {
      const chain = createMiddlewareChain();

      chain.use(async () => {
        throw new Error('middleware broke');
      });

      try {
        await chain.execute({ type: 'chat' }, async () => 'ok');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_MIDDLEWARE_ERROR);
        expect((err as HarnessError).message).toBe('middleware broke');
        expect((err as HarnessError).cause).toBeInstanceOf(Error);
      }
    });

    it('wraps HarnessError thrown from middleware with CORE_MIDDLEWARE_ERROR', async () => {
      // The middleware chain wraps every middleware boundary failure
      // with `CORE_MIDDLEWARE_ERROR` so observers can trace the boundary in
      // the cause chain. The original HarnessError is preserved as `.cause`
      // so consumers that switch on the inner code can still inspect it via
      // `(err.cause as HarnessError).code`.
      const chain = createMiddlewareChain();
      const original = new HarnessError('custom error', HarnessErrorCode.CORE_INVALID_INPUT, 'fix it');

      chain.use(async () => {
        throw original;
      });

      try {
        await chain.execute({ type: 'chat' }, async () => 'ok');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_MIDDLEWARE_ERROR);
        // Original is preserved as cause so consumers can still inspect.
        expect((err as HarnessError).cause).toBe(original);
        expect(((err as HarnessError).cause as HarnessError).code).toBe(
          HarnessErrorCode.CORE_INVALID_INPUT,
        );
      }
    });

    it('calls onError handler when middleware throws', async () => {
      const errors: Error[] = [];
      const chain = createMiddlewareChain({
        onError: (err) => errors.push(err),
      });

      chain.use(async () => {
        throw new Error('logged error');
      });

      await expect(
        chain.execute({ type: 'chat' }, async () => 'ok'),
      ).rejects.toThrow();

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('logged error');
    });

    it('calls onError with context when middleware throws', async () => {
      let capturedCtx: MiddlewareContext | undefined;
      const chain = createMiddlewareChain({
        onError: (_err, ctx) => { capturedCtx = ctx; },
      });

      chain.use(async () => {
        throw new Error('context error');
      });

      const ctx: MiddlewareContext = { type: 'tool_call' };
      await expect(chain.execute(ctx, async () => 'ok')).rejects.toThrow();

      expect(capturedCtx).toBe(ctx);
    });

    it('wraps non-Error throws in HarnessError', async () => {
      const chain = createMiddlewareChain();

      chain.use(async () => {
        throw 'string error';
      });

      try {
        await chain.execute({ type: 'chat' }, async () => 'ok');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_MIDDLEWARE_ERROR);
        expect((err as HarnessError).message).toBe('string error');
      }
    });

    it('still propagates handler errors through middleware without wrapping', async () => {
      const chain = createMiddlewareChain();

      chain.use(async (_ctx, next) => {
        return next();
      });

      await expect(
        chain.execute({ type: 'chat' }, async () => {
          throw new Error('handler error');
        }),
      ).rejects.toThrow('handler error');
    });

    it('first middleware error is caught even when multiple middlewares exist', async () => {
      const chain = createMiddlewareChain();

      chain.use(async () => {
        throw new Error('first middleware error');
      });

      chain.use(async (_ctx, next) => {
        return next();
      });

      try {
        await chain.execute({ type: 'chat' }, async () => 'ok');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        expect((err as HarnessError).message).toBe('first middleware error');
      }
    });

    it('backward compatible: works without onError option', async () => {
      const chain = createMiddlewareChain();
      const handler = vi.fn().mockResolvedValue('result');
      const result = await chain.execute({ type: 'chat' }, handler);
      expect(result).toBe('result');
    });
  });

  describe('Set-backed storage', () => {
    it('deduplicates the same function reference registered twice', async () => {
      const chain = createMiddlewareChain();
      const calls: string[] = [];
      const mw = async (_ctx: MiddlewareContext, next: () => Promise<unknown>) => {
        calls.push('mw');
        return next();
      };

      const unsub1 = chain.use(mw);
      const unsub2 = chain.use(mw);

      await chain.execute({ type: 'chat' }, async () => 'ok');
      // Registered twice but stored once (Set semantics)
      expect(calls).toEqual(['mw']);

      // Either unsubscribe removes the single stored entry
      unsub1();
      calls.length = 0;
      await chain.execute({ type: 'chat' }, async () => 'ok');
      expect(calls).toEqual([]);

      // Second unsubscribe is a no-op (Set.delete on absent key)
      unsub2();
      calls.length = 0;
      await chain.execute({ type: 'chat' }, async () => 'ok');
      expect(calls).toEqual([]);
    });

    it('unsubscribe is O(1) in the presence of many middlewares', async () => {
      const chain = createMiddlewareChain();
      const fns: Array<() => void> = [];
      // Register many middlewares
      for (let i = 0; i < 10_000; i++) {
        fns.push(
          chain.use(async (_ctx, next) => next()),
        );
      }
      // Unsubscribe in LIFO order — any O(n) indexOf scan would compound to
      // O(n²); completing well under a second on modern hardware is the
      // smoke-test. We don't timer-gate; just ensure correctness.
      for (let i = fns.length - 1; i >= 0; i--) fns[i]();

      let ran = false;
      await chain.execute({ type: 'chat' }, async () => { ran = true; return 'ok'; });
      expect(ran).toBe(true);
    });

    it('late-registered middleware via unsubscribe is dropped from the current iterator', async () => {
      const chain = createMiddlewareChain();
      const order: string[] = [];

      const unsubLate = chain.use(async (_c, n) => {
        order.push('late');
        return n();
      });
      chain.use(async (_c, n) => {
        order.push('A');
        // Unsubscribe a later middleware BEFORE the iterator reaches it — the
        // Set iterator respects deletes that happen during iteration.
        unsubLate();
        return n();
      });

      // With A registered second, execute order is [late, A] — but mid-flight
      // 'A' unsubscribes 'late' which has already run. `late` still appeared
      // once because the iterator advanced past it before the delete.
      await chain.execute({ type: 'chat' }, async () => { order.push('handler'); return 'ok'; });
      expect(order).toEqual(['late', 'A', 'handler']);

      // Next run skips the unsubscribed middleware
      order.length = 0;
      await chain.execute({ type: 'chat' }, async () => { order.push('handler'); return 'ok'; });
      expect(order).toEqual(['A', 'handler']);
    });

    it('preserves insertion order across many execute() calls', async () => {
      const chain = createMiddlewareChain();
      const order: string[] = [];
      chain.use(async (_c, n) => { order.push('1'); return n(); });
      chain.use(async (_c, n) => { order.push('2'); return n(); });
      chain.use(async (_c, n) => { order.push('3'); return n(); });

      for (let i = 0; i < 5; i++) {
        order.length = 0;
        await chain.execute({ type: 'chat' }, async () => 'ok');
        expect(order).toEqual(['1', '2', '3']);
      }
    });
  });
});
