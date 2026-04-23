/**
 * Runs the MemoryStore conformance testkit against the in-memory impl,
 * dogfooding the testkit itself. Third-party backends can copy this pattern.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryStore } from '../store.js';
import { runMemoryStoreConformance } from '../testkit.js';

runMemoryStoreConformance(
  { describe, it, expect: expect as unknown as Parameters<typeof runMemoryStoreConformance>[0]['expect'], beforeEach },
  () => createInMemoryStore(),
);

describe('MemoryStore in-memory capabilities flags', () => {
  it('declares the capabilities supported by the in-memory impl', () => {
    const store = createInMemoryStore();
    expect(store.capabilities?.atomicWrite).toBe(true);
    expect(store.capabilities?.atomicBatch).toBe(true);
    expect(store.capabilities?.vectorSearch).toBe(true);
    expect(store.capabilities?.batchWrites).toBe(true);
    expect(store.capabilities?.supportsTtl).toBe(true);
    expect(store.capabilities?.supportsOptimisticLock).toBe(true);
  });

  it('writeBatch commits all entries atomically', async () => {
    const store = createInMemoryStore();
    const result = await store.writeBatch!([
      { key: 'a', content: '1', grade: 'useful' },
      { key: 'b', content: '2', grade: 'critical' },
      { key: 'c', content: '3', grade: 'ephemeral' },
    ]);
    expect(result).toHaveLength(3);
    expect(await store.count()).toBe(3);
  });

  it('writeBatch aborts entire batch on embedding dimension mismatch', async () => {
    const store = createInMemoryStore();
    await store.write({
      key: 'first',
      content: 'established',
      grade: 'useful',
      metadata: { embedding: [0.1, 0.2, 0.3] },
    });
    await expect(
      store.writeBatch!([
        { key: 'a', content: '1', grade: 'useful', metadata: { embedding: [0.1, 0.2] } }, // wrong dim
      ]),
    ).rejects.toThrow(/Embedding dimension mismatch/);
    expect(await store.count()).toBe(1); // the earlier single write persists
  });
});
