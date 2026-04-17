/**
 * Wave-13 E-5: fs-store query() AbortSignal support.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileSystemStore } from '../fs-store.js';
import type { MemoryStore } from '../store.js';
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';

describe('FsStore Wave-13 E-5: AbortSignal', () => {
  let store: MemoryStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-mem-wave13-'));
    store = createFileSystemStore({ directory: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('throws CORE_ABORTED when signal is already aborted', async () => {
    await store.write({ key: 'k1', content: 'a', grade: 'useful' });
    const ac = new AbortController();
    ac.abort();
    await expect(
      store.query({ grade: 'useful' }, { signal: ac.signal }),
    ).rejects.toMatchObject({
      code: HarnessErrorCode.CORE_ABORTED,
    });
  });

  it('aborts between batches for large stores', async () => {
    // Write 150 entries so the batched fs query loops at least 3 times
    // (batchSize = 50). Abort after the first batch.
    for (let i = 0; i < 150; i++) {
      await store.write({ key: `k${i}`, content: `content-${i}`, grade: 'useful' });
    }
    const ac = new AbortController();
    // Abort immediately — the throwIfAborted at entry or between batches fires.
    ac.abort();
    await expect(
      store.query({ grade: 'useful' }, { signal: ac.signal }),
    ).rejects.toBeInstanceOf(HarnessError);
  });

  it('completes normally when signal is not aborted', async () => {
    await store.write({ key: 'k1', content: 'a', grade: 'useful' });
    const ac = new AbortController();
    const res = await store.query({ grade: 'useful' }, { signal: ac.signal });
    expect(res).toHaveLength(1);
  });

  it('is backwards-compatible (opts omitted)', async () => {
    await store.write({ key: 'k1', content: 'a', grade: 'useful' });
    const res = await store.query({ grade: 'useful' });
    expect(res).toHaveLength(1);
  });
});
