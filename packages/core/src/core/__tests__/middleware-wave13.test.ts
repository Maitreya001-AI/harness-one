/**
 * Wave-13 Track D — middleware fixes
 *
 *   D-1: HarnessError thrown from a middleware is re-wrapped with
 *        CORE_MIDDLEWARE_ERROR so observers can trace the middleware
 *        boundary in the cause chain.
 *   D-2: a throwing `onError` callback must not escape / clobber the
 *        original middleware failure.
 */

import { describe, it, expect, vi } from 'vitest';
import { createMiddlewareChain } from '../middleware.js';
import { HarnessError, HarnessErrorCode } from '../errors.js';

describe('middleware — Wave-13 D-1 HarnessError wrapped with middleware boundary', () => {
  it('wraps a HarnessError thrown from a middleware with CORE_MIDDLEWARE_ERROR, preserving original as cause', async () => {
    const chain = createMiddlewareChain();
    const inner = new HarnessError(
      'inner validation failure',
      HarnessErrorCode.CORE_INVALID_INPUT,
      'check input',
    );
    chain.use(async () => {
      throw inner;
    });

    await expect(chain.execute({ type: 'chat' }, async () => 'never')).rejects.toMatchObject({
      code: HarnessErrorCode.CORE_MIDDLEWARE_ERROR,
      cause: inner,
    });
  });

  it('still wraps non-HarnessError throws with CORE_MIDDLEWARE_ERROR (pre-D-1 behaviour intact)', async () => {
    const chain = createMiddlewareChain();
    const inner = new Error('plain throw');
    chain.use(async () => {
      throw inner;
    });

    await expect(chain.execute({ type: 'chat' }, async () => 'never')).rejects.toMatchObject({
      code: HarnessErrorCode.CORE_MIDDLEWARE_ERROR,
      cause: inner,
    });
  });

  it('preserves the inner HarnessError code via .cause for switch-on-code consumers', async () => {
    const chain = createMiddlewareChain();
    const inner = new HarnessError(
      'budget blown',
      HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED,
    );
    chain.use(async () => {
      throw inner;
    });

    try {
      await chain.execute({ type: 'chat' }, async () => 'never');
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      const wrapper = err as HarnessError;
      expect(wrapper.code).toBe(HarnessErrorCode.CORE_MIDDLEWARE_ERROR);
      expect(wrapper.cause).toBe(inner);
      expect((wrapper.cause as HarnessError).code).toBe(
        HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED,
      );
    }
  });
});

describe('middleware — Wave-13 D-2 throwing onError does not escape', () => {
  it('does not replace the original middleware throw when onError itself throws', async () => {
    const onError = vi.fn(() => {
      throw new Error('observer bug');
    });
    const chain = createMiddlewareChain({ onError });
    const inner = new Error('real failure');
    chain.use(async () => {
      throw inner;
    });

    await expect(chain.execute({ type: 'chat' }, async () => 'never')).rejects.toMatchObject({
      code: HarnessErrorCode.CORE_MIDDLEWARE_ERROR,
    });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('calls onError once per middleware failure even when it throws', async () => {
    const onError = vi.fn(() => {
      throw new Error('observer bug');
    });
    const chain = createMiddlewareChain({ onError });
    chain.use(async () => {
      throw new Error('failure');
    });

    await expect(chain.execute({ type: 'chat' }, async () => 'never')).rejects.toBeInstanceOf(
      HarnessError,
    );
    expect(onError).toHaveBeenCalledOnce();
  });
});
