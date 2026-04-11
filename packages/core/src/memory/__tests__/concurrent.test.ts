import { describe, it, expect } from 'vitest';
import { createInMemoryStore } from '../store.js';
// MemoryStore type used implicitly via createInMemoryStore return

describe('MemoryStore concurrent access', () => {
  describe('multiple concurrent writes to the same store', () => {
    it('all writes succeed and produce unique IDs', async () => {
      const store = createInMemoryStore();
      const writes = Array.from({ length: 50 }, (_, i) =>
        store.write({ key: `key-${i}`, content: `content-${i}`, grade: 'useful' }),
      );

      const entries = await Promise.all(writes);
      const ids = new Set(entries.map((e) => e.id));
      expect(ids.size).toBe(50);
      expect(await store.count()).toBe(50);
    });

    it('concurrent writes with different grades all persist correctly', async () => {
      const store = createInMemoryStore();
      const grades: Array<'critical' | 'useful' | 'ephemeral'> = ['critical', 'useful', 'ephemeral'];
      const writes = Array.from({ length: 30 }, (_, i) =>
        store.write({ key: `key-${i}`, content: `content-${i}`, grade: grades[i % 3] }),
      );

      const entries = await Promise.all(writes);
      expect(entries).toHaveLength(30);

      // Verify each grade category
      const criticalEntries = entries.filter((e) => e.grade === 'critical');
      const usefulEntries = entries.filter((e) => e.grade === 'useful');
      const ephemeralEntries = entries.filter((e) => e.grade === 'ephemeral');
      expect(criticalEntries).toHaveLength(10);
      expect(usefulEntries).toHaveLength(10);
      expect(ephemeralEntries).toHaveLength(10);
    });
  });

  describe('concurrent read + write does not corrupt data', () => {
    it('reads return consistent data while writes are happening', async () => {
      const store = createInMemoryStore();

      // Seed some initial entries
      const seeded = await store.write({ key: 'seed', content: 'initial', grade: 'useful' });

      // Run reads and writes concurrently
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 20; i++) {
        ops.push(store.write({ key: `new-${i}`, content: `content-${i}`, grade: 'useful' }));
        ops.push(store.read(seeded.id));
      }

      const results = await Promise.all(ops);

      // All reads should return the seeded entry (not null, not corrupted)
      const reads = results.filter((_, idx) => idx % 2 === 1);
      for (const r of reads) {
        expect(r).not.toBeNull();
        const entry = r as { id: string; content: string };
        expect(entry.id).toBe(seeded.id);
        expect(entry.content).toBe('initial');
      }
    });

    it('concurrent update and read return a valid state', async () => {
      const store = createInMemoryStore();
      const entry = await store.write({ key: 'k1', content: 'original', grade: 'useful' });

      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 10; i++) {
        ops.push(store.update(entry.id, { content: `updated-${i}` }));
        ops.push(store.read(entry.id));
      }

      await Promise.all(ops);
      // After all ops complete, the final read should have one of the updated values
      const finalRead = await store.read(entry.id);
      expect(finalRead).not.toBeNull();
      // Content should be some valid string (either original or one of the updates)
      expect(finalRead!.content).toBeDefined();
      expect(typeof finalRead!.content).toBe('string');
    });
  });

  describe('concurrent query while write is happening', () => {
    it('query returns a consistent snapshot while writes occur', async () => {
      const store = createInMemoryStore();

      // Seed entries
      for (let i = 0; i < 5; i++) {
        await store.write({ key: `seed-${i}`, content: `seed-${i}`, grade: 'useful' });
      }

      // Run queries and writes concurrently
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 10; i++) {
        ops.push(store.write({ key: `new-${i}`, content: `new-${i}`, grade: 'ephemeral' }));
        ops.push(store.query({ grade: 'useful' }));
      }

      const results = await Promise.all(ops);

      // Each query should return at least the 5 seeded useful entries
      const queries = results.filter((_, idx) => idx % 2 === 1) as Array<{ grade: string }[]>;
      for (const q of queries) {
        // All returned entries should be 'useful' grade
        for (const entry of q) {
          expect(entry.grade).toBe('useful');
        }
        // Should have at least the 5 seeded entries
        expect(q.length).toBeGreaterThanOrEqual(5);
      }
    });

    it('concurrent query with search filter returns correct results', async () => {
      const store = createInMemoryStore();

      await store.write({ key: 'target', content: 'findable content', grade: 'useful' });
      await store.write({ key: 'other', content: 'other stuff', grade: 'useful' });

      // Concurrent writes + search queries
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 10; i++) {
        ops.push(store.write({ key: `noise-${i}`, content: `noise-${i}`, grade: 'ephemeral' }));
        ops.push(store.query({ search: 'findable' }));
      }

      const results = await Promise.all(ops);
      const queries = results.filter((_, idx) => idx % 2 === 1) as Array<{ key: string }[]>;

      for (const q of queries) {
        expect(q.length).toBeGreaterThanOrEqual(1);
        expect(q.some((e) => e.key === 'target')).toBe(true);
      }
    });
  });

  describe('grade-aware eviction under concurrent writes (maxEntries reached)', () => {
    it('maintains maxEntries limit with concurrent writes', async () => {
      const store = createInMemoryStore({ maxEntries: 5 });

      // Write 20 entries concurrently, all the same grade
      const writes = Array.from({ length: 20 }, (_, i) =>
        store.write({ key: `key-${i}`, content: `content-${i}`, grade: 'useful' }),
      );

      await Promise.all(writes);
      const count = await store.count();
      expect(count).toBeLessThanOrEqual(5);
    });

    it('preserves critical entries over ephemeral during concurrent writes', async () => {
      const store = createInMemoryStore({ maxEntries: 3 });

      // Write critical entries first
      await store.write({ key: 'c1', content: 'critical1', grade: 'critical' });
      await store.write({ key: 'c2', content: 'critical2', grade: 'critical' });

      // Now concurrently write ephemeral entries that should trigger eviction
      const ephemeralWrites = Array.from({ length: 5 }, (_, i) =>
        store.write({ key: `e-${i}`, content: `ephemeral-${i}`, grade: 'ephemeral' }),
      );
      await Promise.all(ephemeralWrites);

      const count = await store.count();
      expect(count).toBeLessThanOrEqual(3);

      // At least one critical entry should still exist
      const remaining = await store.query({});
      const criticalRemaining = remaining.filter((e) => e.grade === 'critical');
      expect(criticalRemaining.length).toBeGreaterThanOrEqual(1);
    });

    it('concurrent writes with mixed grades respect grade priority', async () => {
      const store = createInMemoryStore({ maxEntries: 4 });

      const writes: Promise<unknown>[] = [];
      // Mix of grades written concurrently
      writes.push(store.write({ key: 'c1', content: 'critical', grade: 'critical' }));
      writes.push(store.write({ key: 'e1', content: 'ephemeral1', grade: 'ephemeral' }));
      writes.push(store.write({ key: 'u1', content: 'useful1', grade: 'useful' }));
      writes.push(store.write({ key: 'e2', content: 'ephemeral2', grade: 'ephemeral' }));
      writes.push(store.write({ key: 'c2', content: 'critical2', grade: 'critical' }));
      writes.push(store.write({ key: 'e3', content: 'ephemeral3', grade: 'ephemeral' }));

      await Promise.all(writes);

      const count = await store.count();
      expect(count).toBeLessThanOrEqual(4);

      // Check that critical entries are more likely to survive
      const remaining = await store.query({});
      const grades = remaining.map((e) => e.grade);
      // Critical entries should be present (they have highest eviction resistance)
      const criticalCount = grades.filter((g) => g === 'critical').length;
      expect(criticalCount).toBeGreaterThanOrEqual(1);
    });

    it('concurrent delete and write do not corrupt store', async () => {
      const store = createInMemoryStore();

      // Seed entries
      const entries = [];
      for (let i = 0; i < 10; i++) {
        entries.push(await store.write({ key: `k-${i}`, content: `c-${i}`, grade: 'useful' }));
      }

      // Concurrently delete some and write new ones
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 10; i++) {
        ops.push(store.delete(entries[i].id));
        ops.push(store.write({ key: `new-${i}`, content: `new-${i}`, grade: 'useful' }));
      }

      await Promise.all(ops);

      // Count should be consistent
      const count = await store.count();
      const queried = await store.query({});
      expect(queried.length).toBe(count);
    });
  });
});
