import { describe, it, expect, vi } from 'vitest';
import { DisposeAggregateError, disposeAll, type Disposable } from '../disposable.js';
import { HarnessError, HarnessErrorCode } from '../errors-base.js';

function makeDisposable(
  opts: {
    onDispose?: () => Promise<void> | void;
    throwOn?: boolean;
    delay?: number;
  } = {},
): Disposable & { disposeCount: number } {
  let disposed = false;
  let count = 0;
  const obj: Disposable & { disposeCount: number } = {
    get disposed(): boolean {
      return disposed;
    },
    async dispose(): Promise<void> {
      count++;
      if (opts.delay !== undefined) {
        await new Promise((r) => setTimeout(r, opts.delay));
      }
      if (opts.onDispose) await opts.onDispose();
      if (opts.throwOn) {
        disposed = true;
        throw new Error('dispose failed');
      }
      disposed = true;
    },
    get disposeCount(): number {
      return count;
    },
  };
  return obj;
}

describe('Disposable', () => {
  it('marks disposed true after successful dispose', async () => {
    const d = makeDisposable();
    expect(d.disposed).toBe(false);
    await d.dispose();
    expect(d.disposed).toBe(true);
  });
});

describe('disposeAll', () => {
  it('runs disposables sequentially in the given order', async () => {
    const order: string[] = [];
    const a: Disposable = {
      disposed: false,
      async dispose() {
        order.push('a-start');
        await new Promise((r) => setTimeout(r, 20));
        order.push('a-end');
      },
    };
    const b: Disposable = {
      disposed: false,
      async dispose() {
        order.push('b-start');
        order.push('b-end');
      },
    };
    await disposeAll([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('awaits every disposable even if earlier ones throw', async () => {
    const bad = makeDisposable({ throwOn: true });
    const good = makeDisposable();
    await expect(disposeAll([bad, good])).rejects.toBeInstanceOf(DisposeAggregateError);
    expect(bad.disposeCount).toBe(1);
    expect(good.disposeCount).toBe(1);
    expect(good.disposed).toBe(true);
  });

  it('aggregates multiple errors into a single DisposeAggregateError', async () => {
    const bad1 = makeDisposable({ throwOn: true });
    const bad2 = makeDisposable({ throwOn: true });
    try {
      await disposeAll([bad1, bad2]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DisposeAggregateError);
      const agg = err as DisposeAggregateError;
      expect(agg.errors).toHaveLength(2);
      expect(agg.indices).toEqual([0, 1]);
      expect(agg.message).toContain('2 disposable(s) failed');
    }
  });

  it('records indices of failing disposables', async () => {
    const a = makeDisposable();
    const bad = makeDisposable({ throwOn: true });
    const b = makeDisposable();
    const c = makeDisposable({ throwOn: true });
    try {
      await disposeAll([a, bad, b, c]);
      throw new Error('expected throw');
    } catch (err) {
      const agg = err as DisposeAggregateError;
      expect(agg.indices).toEqual([1, 3]);
      expect(a.disposeCount).toBe(1);
      expect(b.disposeCount).toBe(1);
    }
  });

  it('resolves without error on empty input', async () => {
    await expect(disposeAll([])).resolves.toBeUndefined();
  });

  it('does not short-circuit on the first failure', async () => {
    const log: string[] = [];
    const bad: Disposable = {
      disposed: false,
      async dispose() {
        log.push('bad');
        throw new Error('boom');
      },
    };
    const good: Disposable = {
      disposed: false,
      async dispose() {
        log.push('good');
      },
    };
    await expect(disposeAll([bad, good])).rejects.toBeInstanceOf(DisposeAggregateError);
    expect(log).toEqual(['bad', 'good']);
  });

  it('swallows non-Error rejections into aggregate', async () => {
    const weird: Disposable = {
      disposed: false,
      async dispose() {
        throw 'stringy rejection';
      },
    };
    try {
      await disposeAll([weird]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DisposeAggregateError);
      const agg = err as DisposeAggregateError;
      expect(agg.errors).toEqual(['stringy rejection']);
      expect(agg.message).toContain('stringy rejection');
    }
  });

  it('preserves error references in order they occurred', async () => {
    const err1 = new Error('first');
    const err2 = new Error('second');
    const a: Disposable = { disposed: false, async dispose() { throw err1; } };
    const b: Disposable = { disposed: false, async dispose() { throw err2; } };
    try {
      await disposeAll([a, b]);
    } catch (e) {
      const agg = e as DisposeAggregateError;
      expect(agg.errors[0]).toBe(err1);
      expect(agg.errors[1]).toBe(err2);
    }
  });

  it('aggregate error is a HarnessError with CORE_DISPOSE_AGGREGATE code', async () => {
    const bad = makeDisposable({ throwOn: true });
    try {
      await disposeAll([bad]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect(err).toBeInstanceOf(DisposeAggregateError);
      const agg = err as DisposeAggregateError;
      expect(agg.code).toBe(HarnessErrorCode.CORE_DISPOSE_AGGREGATE);
      expect(agg.suggestion).toBeDefined();
      expect(agg.name).toBe('DisposeAggregateError');
    }
  });

  it('invokes disposables only once each', async () => {
    const d = makeDisposable();
    await disposeAll([d]);
    expect(d.disposeCount).toBe(1);
  });

  it('works with synchronous dispose implementations (as long as they return void)', async () => {
    const spy = vi.fn();
    const d: Disposable = {
      disposed: false,
      dispose: async () => {
        spy();
      },
    };
    await disposeAll([d]);
    expect(spy).toHaveBeenCalledOnce();
  });
});
