import { describe, it, expect, vi } from 'vitest';
import { createMiddlewareChain } from '../middleware.js';
import type { MiddlewareContext } from '../middleware.js';
import { HarnessError } from '../errors.js';

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
        expect((err as HarnessError).code).toBe('MIDDLEWARE_ERROR');
        expect((err as HarnessError).message).toBe('middleware broke');
        expect((err as HarnessError).cause).toBeInstanceOf(Error);
      }
    });

    it('preserves HarnessError thrown from middleware (does not double-wrap)', async () => {
      const chain = createMiddlewareChain();
      const original = new HarnessError('custom error', 'CUSTOM_CODE', 'fix it');

      chain.use(async () => {
        throw original;
      });

      try {
        await chain.execute({ type: 'chat' }, async () => 'ok');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBe(original);
        expect((err as HarnessError).code).toBe('CUSTOM_CODE');
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
        expect((err as HarnessError).code).toBe('MIDDLEWARE_ERROR');
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
});
