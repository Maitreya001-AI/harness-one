/**
 * Wave-13 E-5: MemoryStore.query() AbortSignal support.
 */

import { describe, it, expect } from 'vitest';
import { createInMemoryStore } from '../store.js';
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';

describe('InMemoryStore Wave-13 E-5: AbortSignal', () => {
  it('throws CORE_ABORTED when signal is already aborted before query()', async () => {
    const store = createInMemoryStore();
    await store.write({ key: 'k1', content: 'hello', grade: 'useful' });

    const ac = new AbortController();
    ac.abort();

    await expect(store.query({}, { signal: ac.signal })).rejects.toMatchObject({
      code: HarnessErrorCode.CORE_ABORTED,
    });
  });

  it('completes normally when signal is not aborted', async () => {
    const store = createInMemoryStore();
    await store.write({ key: 'k1', content: 'hello', grade: 'useful' });

    const ac = new AbortController();
    const results = await store.query({}, { signal: ac.signal });
    expect(results).toHaveLength(1);
  });

  it('is backwards-compatible (opts omitted)', async () => {
    const store = createInMemoryStore();
    await store.write({ key: 'k1', content: 'hello', grade: 'useful' });
    const results = await store.query({});
    expect(results).toHaveLength(1);
  });

  it('throws HarnessError instance on abort', async () => {
    const store = createInMemoryStore();
    const ac = new AbortController();
    ac.abort();
    await expect(store.query({}, { signal: ac.signal })).rejects.toBeInstanceOf(HarnessError);
  });
});
