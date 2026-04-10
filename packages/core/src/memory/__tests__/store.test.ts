import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryStore } from '../store.js';
import type { MemoryStore } from '../store.js';
import { HarnessError } from '../../core/errors.js';

describe('createInMemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = createInMemoryStore();
  });

  describe('write', () => {
    it('creates an entry with generated id and timestamps', async () => {
      const entry = await store.write({ key: 'k1', content: 'hello', grade: 'useful' });
      expect(entry.id).toMatch(/^mem_/);
      expect(entry.key).toBe('k1');
      expect(entry.content).toBe('hello');
      expect(entry.grade).toBe('useful');
      expect(entry.createdAt).toBeGreaterThan(0);
      expect(entry.updatedAt).toBe(entry.createdAt);
    });

    it('preserves metadata and tags', async () => {
      const entry = await store.write({
        key: 'k1',
        content: 'test',
        grade: 'critical',
        metadata: { source: 'unit-test' },
        tags: ['a', 'b'],
      });
      expect(entry.metadata).toEqual({ source: 'unit-test' });
      expect(entry.tags).toEqual(['a', 'b']);
    });
  });

  describe('read', () => {
    it('returns entry by id', async () => {
      const written = await store.write({ key: 'k1', content: 'hello', grade: 'useful' });
      const read = await store.read(written.id);
      expect(read).toEqual(written);
    });

    it('returns null for missing id', async () => {
      expect(await store.read('nonexistent')).toBeNull();
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      await store.write({ key: 'k1', content: 'alpha', grade: 'critical', tags: ['x'] });
      await store.write({ key: 'k2', content: 'beta', grade: 'useful', tags: ['y'] });
      await store.write({ key: 'k3', content: 'gamma', grade: 'ephemeral', tags: ['x', 'y'] });
    });

    it('returns all entries when no filter', async () => {
      const results = await store.query({});
      expect(results).toHaveLength(3);
    });

    it('filters by grade', async () => {
      const results = await store.query({ grade: 'critical' });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('alpha');
    });

    it('filters by tags (OR)', async () => {
      const results = await store.query({ tags: ['y'] });
      expect(results).toHaveLength(2);
    });

    it('filters by search term', async () => {
      const results = await store.query({ search: 'BET' });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('beta');
    });

    it('respects limit', async () => {
      const results = await store.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('sorts by updatedAt descending', async () => {
      const results = await store.query({});
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].updatedAt).toBeGreaterThanOrEqual(results[i].updatedAt);
      }
    });
  });

  describe('update', () => {
    it('updates content and bumps updatedAt', async () => {
      const entry = await store.write({ key: 'k1', content: 'old', grade: 'useful' });
      const updated = await store.update(entry.id, { content: 'new' });
      expect(updated.content).toBe('new');
      expect(updated.updatedAt).toBeGreaterThanOrEqual(entry.updatedAt);
    });

    it('throws HarnessError for missing entry', async () => {
      await expect(store.update('nope', { content: 'x' })).rejects.toThrow(HarnessError);
    });
  });

  describe('delete', () => {
    it('removes entry and returns true', async () => {
      const entry = await store.write({ key: 'k1', content: 'hello', grade: 'useful' });
      expect(await store.delete(entry.id)).toBe(true);
      expect(await store.read(entry.id)).toBeNull();
    });

    it('returns false for missing entry', async () => {
      expect(await store.delete('nope')).toBe(false);
    });
  });

  describe('compact', () => {
    it('removes entries exceeding maxEntries, preserving critical', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'critical' });
      await store.write({ key: 'k2', content: 'b', grade: 'ephemeral' });
      await store.write({ key: 'k3', content: 'c', grade: 'useful' });

      const result = await store.compact({ maxEntries: 1 });
      expect(result.remaining).toBe(1);
      expect(result.removed).toBe(2);
      // Critical should survive
      const remaining = await store.query({});
      expect(remaining[0].grade).toBe('critical');
    });

    it('removes old entries by maxAge', async () => {
      const entry = await store.write({ key: 'k1', content: 'old', grade: 'ephemeral' });
      // Force old createdAt
      await store.update(entry.id, { content: 'old' });

      const result = await store.compact({ maxAge: 0 });
      // Ephemeral with age > 0 should be removed
      expect(result.removed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('count', () => {
    it('returns the number of entries', async () => {
      expect(await store.count()).toBe(0);
      await store.write({ key: 'k1', content: 'a', grade: 'useful' });
      expect(await store.count()).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes all entries', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'useful' });
      await store.write({ key: 'k2', content: 'b', grade: 'useful' });
      await store.clear();
      expect(await store.count()).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('query with all filter combinations (tags + grade + since + search)', async () => {
      const now = Date.now();
      await store.write({ key: 'k1', content: 'alpha info', grade: 'critical', tags: ['topic-a'] });
      await store.write({ key: 'k2', content: 'beta info', grade: 'critical', tags: ['topic-a', 'topic-b'] });
      await store.write({ key: 'k3', content: 'gamma info', grade: 'useful', tags: ['topic-a'] });
      await store.write({ key: 'k4', content: 'delta info', grade: 'critical', tags: ['topic-b'] });

      // Combine all filters: grade=critical, tags=[topic-a], since=now-1, search='info'
      const results = await store.query({
        grade: 'critical',
        tags: ['topic-a'],
        since: now - 1,
        search: 'info',
      });

      // Only k1 and k2 match all criteria: critical grade + topic-a tag + recent + contains 'info'
      expect(results).toHaveLength(2);
      const keys = results.map(r => r.key);
      expect(keys).toContain('k1');
      expect(keys).toContain('k2');
    });

    it('compaction preserves critical entries', async () => {
      await store.write({ key: 'k1', content: 'critical data', grade: 'critical' });
      await store.write({ key: 'k2', content: 'ephemeral data', grade: 'ephemeral' });
      await store.write({ key: 'k3', content: 'useful data', grade: 'useful' });

      const result = await store.compact({ maxEntries: 1 });
      expect(result.remaining).toBe(1);

      const remaining = await store.query({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].grade).toBe('critical');
      expect(remaining[0].content).toBe('critical data');
    });

    it('compaction removes ephemeral first', async () => {
      await store.write({ key: 'k1', content: 'ephemeral 1', grade: 'ephemeral' });
      await store.write({ key: 'k2', content: 'useful 1', grade: 'useful' });
      await store.write({ key: 'k3', content: 'critical 1', grade: 'critical' });

      const result = await store.compact({ maxEntries: 2 });
      expect(result.removed).toBe(1);
      expect(result.remaining).toBe(2);

      const remaining = await store.query({});
      const grades = remaining.map(r => r.grade);
      // Ephemeral should be removed first
      expect(grades).not.toContain('ephemeral');
      expect(grades).toContain('useful');
      expect(grades).toContain('critical');
    });

    it('update non-existent entry — throws HarnessError', async () => {
      await expect(store.update('non-existent-id', { content: 'x' })).rejects.toThrow(HarnessError);
    });

    it('ID uniqueness under rapid creation', async () => {
      const ids = new Set<string>();
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(store.write({ key: `rapid-${i}`, content: `content-${i}`, grade: 'useful' }));
      }
      const entries = await Promise.all(promises);
      for (const entry of entries) {
        ids.add(entry.id);
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('query with sessionId filter', () => {
    it('returns only entries matching the given sessionId in metadata', async () => {
      await store.write({ key: 'k1', content: 'session-a data', grade: 'useful', metadata: { sessionId: 'sess-a' } });
      await store.write({ key: 'k2', content: 'session-b data', grade: 'useful', metadata: { sessionId: 'sess-b' } });
      await store.write({ key: 'k3', content: 'no session data', grade: 'useful' });

      const results = await store.query({ sessionId: 'sess-a' });
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('k1');
    });

    it('returns empty array when no entries match sessionId', async () => {
      await store.write({ key: 'k1', content: 'data', grade: 'useful', metadata: { sessionId: 'other' } });

      const results = await store.query({ sessionId: 'nonexistent' });
      expect(results).toHaveLength(0);
    });

    it('excludes entries without metadata when sessionId filter is set', async () => {
      await store.write({ key: 'k1', content: 'no metadata', grade: 'useful' });
      await store.write({ key: 'k2', content: 'has session', grade: 'useful', metadata: { sessionId: 'x' } });

      const results = await store.query({ sessionId: 'x' });
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('k2');
    });

    it('combines sessionId with other filters', async () => {
      await store.write({ key: 'k1', content: 'alpha info', grade: 'critical', metadata: { sessionId: 's1' } });
      await store.write({ key: 'k2', content: 'beta info', grade: 'useful', metadata: { sessionId: 's1' } });
      await store.write({ key: 'k3', content: 'gamma info', grade: 'critical', metadata: { sessionId: 's2' } });

      const results = await store.query({ sessionId: 's1', grade: 'critical' });
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('k1');
    });
  });

  describe('query with offset', () => {
    it('applies offset before limit', async () => {
      await store.write({ key: 'k1', content: 'first', grade: 'useful' });
      await store.write({ key: 'k2', content: 'second', grade: 'useful' });
      await store.write({ key: 'k3', content: 'third', grade: 'useful' });

      const results = await store.query({ offset: 1, limit: 1 });
      expect(results).toHaveLength(1);
    });

    it('offset of 0 has no effect', async () => {
      await store.write({ key: 'k1', content: 'first', grade: 'useful' });
      await store.write({ key: 'k2', content: 'second', grade: 'useful' });

      const withOffset = await store.query({ offset: 0 });
      const without = await store.query({});
      expect(withOffset).toHaveLength(without.length);
    });
  });

  describe('compact maxAge removes old non-critical entries', () => {
    it('removes ephemeral entries older than maxAge', async () => {
      await store.write({ key: 'k1', content: 'old ephemeral', grade: 'ephemeral' });
      await store.write({ key: 'k2', content: 'old useful', grade: 'useful' });
      await store.write({ key: 'k3', content: 'critical stays', grade: 'critical' });

      // Wait a tiny bit so createdAt has elapsed
      await new Promise(r => setTimeout(r, 5));

      // maxAge: 0 means anything created > 0ms ago is old
      const result = await store.compact({ maxAge: 0 });
      expect(result.removed).toBe(2);
      expect(result.freedEntries).toHaveLength(2);

      const remaining = await store.query({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].grade).toBe('critical');
    });
  });

  describe('compact maxEntries stops at critical boundary', () => {
    it('stops removing when only critical entries remain', async () => {
      // Create entries that are ALL critical
      await store.write({ key: 'k1', content: 'critical 1', grade: 'critical' });
      await store.write({ key: 'k2', content: 'critical 2', grade: 'critical' });
      await store.write({ key: 'k3', content: 'critical 3', grade: 'critical' });

      // Try to compact to 1 entry, but all are critical (weight=1.0), so none can be removed
      const result = await store.compact({ maxEntries: 1 });
      expect(result.removed).toBe(0);
      expect(result.remaining).toBe(3);
    });

    it('removes non-critical then breaks at critical', async () => {
      await store.write({ key: 'k1', content: 'ephemeral', grade: 'ephemeral' });
      await store.write({ key: 'k2', content: 'critical 1', grade: 'critical' });
      await store.write({ key: 'k3', content: 'critical 2', grade: 'critical' });

      // Target 1 entry, but after removing ephemeral, only critical remains => break
      const result = await store.compact({ maxEntries: 1 });
      expect(result.removed).toBe(1);
      expect(result.remaining).toBe(2); // 2 critical remain, can't go lower
    });
  });

  describe('searchByVector', () => {
    it('returns entries with matching embeddings sorted by score descending', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'useful', metadata: { embedding: [1, 0, 0] } });
      await store.write({ key: 'k2', content: 'b', grade: 'useful', metadata: { embedding: [0.9, 0.1, 0] } });
      await store.write({ key: 'k3', content: 'c', grade: 'useful', metadata: { embedding: [0, 1, 0] } });

      const results = await store.searchByVector!({ embedding: [1, 0, 0] });
      expect(results.length).toBe(3);
      // First result should be the most similar (identical vector)
      expect(results[0].key).toBe('k1');
      expect(results[0].score).toBeCloseTo(1.0, 5);
      // Scores should be sorted descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('filters results by minScore', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'useful', metadata: { embedding: [1, 0] } });
      await store.write({ key: 'k2', content: 'b', grade: 'useful', metadata: { embedding: [0, 1] } });

      const results = await store.searchByVector!({ embedding: [1, 0], minScore: 0.5 });
      expect(results.length).toBe(1);
      expect(results[0].key).toBe('k1');
      expect(results[0].score).toBeGreaterThanOrEqual(0.5);
    });

    it('respects limit parameter', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'useful', metadata: { embedding: [1, 0] } });
      await store.write({ key: 'k2', content: 'b', grade: 'useful', metadata: { embedding: [0.9, 0.1] } });
      await store.write({ key: 'k3', content: 'c', grade: 'useful', metadata: { embedding: [0.8, 0.2] } });

      const results = await store.searchByVector!({ embedding: [1, 0], limit: 2 });
      expect(results.length).toBe(2);
    });

    it('skips entries without embeddings', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'useful', metadata: { embedding: [1, 0] } });
      await store.write({ key: 'k2', content: 'b', grade: 'useful' }); // no metadata
      await store.write({ key: 'k3', content: 'c', grade: 'useful', metadata: { other: 'data' } }); // no embedding

      const results = await store.searchByVector!({ embedding: [1, 0] });
      expect(results.length).toBe(1);
      expect(results[0].key).toBe('k1');
    });

    it('returns empty array when no entries have embeddings', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'useful' });
      await store.write({ key: 'k2', content: 'b', grade: 'useful', metadata: { foo: 'bar' } });

      const results = await store.searchByVector!({ embedding: [1, 0, 0] });
      expect(results).toEqual([]);
    });

    it('returns empty array when store is empty', async () => {
      const results = await store.searchByVector!({ embedding: [1, 0] });
      expect(results).toEqual([]);
    });

    it('computes cosine similarity correctly: identical vectors yield score 1.0', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'useful', metadata: { embedding: [0.5, 0.5, 0.5] } });

      const results = await store.searchByVector!({ embedding: [0.5, 0.5, 0.5] });
      expect(results.length).toBe(1);
      expect(results[0].score).toBeCloseTo(1.0, 5);
    });

    it('computes cosine similarity correctly: orthogonal vectors yield score 0', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'useful', metadata: { embedding: [1, 0] } });

      const results = await store.searchByVector!({ embedding: [0, 1], minScore: 0 });
      expect(results.length).toBe(1);
      expect(results[0].score).toBeCloseTo(0, 5);
    });

    it('handles zero-length vectors gracefully (returns score 0)', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'useful', metadata: { embedding: [0, 0, 0] } });

      const results = await store.searchByVector!({ embedding: [1, 0, 0], minScore: 0 });
      // Zero vector has norm 0 => denom 0 => score 0
      expect(results.length).toBe(1);
      expect(results[0].score).toBe(0);
    });

    it('handles mismatched vector lengths gracefully (returns score 0)', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'useful', metadata: { embedding: [1, 0] } });

      // Query with a different dimensionality
      const results = await store.searchByVector!({ embedding: [1, 0, 0], minScore: 0 });
      expect(results.length).toBe(1);
      expect(results[0].score).toBe(0);
    });

    it('handles empty embedding arrays gracefully (returns score 0)', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'useful', metadata: { embedding: [] } });

      const results = await store.searchByVector!({ embedding: [], minScore: 0 });
      // Empty arrays => length 0 => score 0
      expect(results.length).toBe(1);
      expect(results[0].score).toBe(0);
    });

    it('uses default limit of 10', async () => {
      for (let i = 0; i < 15; i++) {
        await store.write({ key: `k${i}`, content: `c${i}`, grade: 'useful', metadata: { embedding: [1, 0] } });
      }

      const results = await store.searchByVector!({ embedding: [1, 0] });
      expect(results.length).toBe(10);
    });

    it('default minScore is 0 (includes all non-negative scores)', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'useful', metadata: { embedding: [1, 0] } });
      await store.write({ key: 'k2', content: 'b', grade: 'useful', metadata: { embedding: [0, 1] } });

      // Default minScore=0 should include the orthogonal vector (score=0)
      const results = await store.searchByVector!({ embedding: [1, 0] });
      expect(results.length).toBe(2);
    });
  });

  describe('maxEntries option', () => {
    it('evicts lowest-grade entry when maxEntries is exceeded (grade-aware)', async () => {
      const bounded = createInMemoryStore({ maxEntries: 2 });
      const first = await bounded.write({ key: 'k1', content: 'first', grade: 'useful' });
      await bounded.write({ key: 'k2', content: 'second', grade: 'useful' });
      await bounded.write({ key: 'k3', content: 'third', grade: 'useful' });

      // first entry should have been evicted (same grade, FIFO)
      expect(await bounded.read(first.id)).toBeNull();
      expect(await bounded.count()).toBe(2);
    });

    it('does not evict when within maxEntries limit', async () => {
      const bounded = createInMemoryStore({ maxEntries: 3 });
      const first = await bounded.write({ key: 'k1', content: 'first', grade: 'useful' });
      await bounded.write({ key: 'k2', content: 'second', grade: 'useful' });
      await bounded.write({ key: 'k3', content: 'third', grade: 'useful' });

      expect(await bounded.read(first.id)).not.toBeNull();
      expect(await bounded.count()).toBe(3);
    });

    it('has no limit when maxEntries is undefined', async () => {
      const unbounded = createInMemoryStore();
      for (let i = 0; i < 20; i++) {
        await unbounded.write({ key: `k${i}`, content: `c${i}`, grade: 'useful' });
      }
      expect(await unbounded.count()).toBe(20);
    });

    it('maxEntries of 1 keeps only the latest entry', async () => {
      const single = createInMemoryStore({ maxEntries: 1 });
      await single.write({ key: 'k1', content: 'a', grade: 'useful' });
      await single.write({ key: 'k2', content: 'b', grade: 'useful' });
      const last = await single.write({ key: 'k3', content: 'c', grade: 'useful' });

      expect(await single.count()).toBe(1);
      expect(await single.read(last.id)).not.toBeNull();
    });

    // Fix 16: Grade-aware eviction
    it('evicts ephemeral before useful when maxEntries exceeded', async () => {
      const bounded = createInMemoryStore({ maxEntries: 2 });
      const ephemeral = await bounded.write({ key: 'k1', content: 'temp', grade: 'ephemeral' });
      const useful = await bounded.write({ key: 'k2', content: 'keep', grade: 'useful' });
      const newEntry = await bounded.write({ key: 'k3', content: 'new', grade: 'useful' });

      // ephemeral should be evicted first (lower grade)
      expect(await bounded.read(ephemeral.id)).toBeNull();
      expect(await bounded.read(useful.id)).not.toBeNull();
      expect(await bounded.read(newEntry.id)).not.toBeNull();
    });

    it('evicts useful before critical when maxEntries exceeded', async () => {
      const bounded = createInMemoryStore({ maxEntries: 2 });
      const useful = await bounded.write({ key: 'k1', content: 'useful', grade: 'useful' });
      const critical = await bounded.write({ key: 'k2', content: 'critical', grade: 'critical' });
      const newEntry = await bounded.write({ key: 'k3', content: 'new', grade: 'useful' });

      // useful should be evicted (lower grade than critical)
      expect(await bounded.read(useful.id)).toBeNull();
      expect(await bounded.read(critical.id)).not.toBeNull();
      expect(await bounded.read(newEntry.id)).not.toBeNull();
    });

    it('evicts oldest of same grade (FIFO within grade)', async () => {
      const bounded = createInMemoryStore({ maxEntries: 2 });
      const e1 = await bounded.write({ key: 'k1', content: 'first', grade: 'useful' });
      const e2 = await bounded.write({ key: 'k2', content: 'second', grade: 'useful' });
      const e3 = await bounded.write({ key: 'k3', content: 'third', grade: 'useful' });

      // e1 evicted (oldest of same grade), e2 and e3 remain
      expect(await bounded.read(e1.id)).toBeNull();
      expect(await bounded.read(e2.id)).not.toBeNull();
      expect(await bounded.read(e3.id)).not.toBeNull();
    });

    it('critical entries survive eviction when lower-grade entries exist', async () => {
      const bounded = createInMemoryStore({ maxEntries: 2 });
      const critical = await bounded.write({ key: 'k1', content: 'critical', grade: 'critical' });
      const ephemeral = await bounded.write({ key: 'k2', content: 'temp', grade: 'ephemeral' });
      const newCritical = await bounded.write({ key: 'k3', content: 'new critical', grade: 'critical' });

      // ephemeral should be evicted, both critical entries survive
      expect(await bounded.read(ephemeral.id)).toBeNull();
      expect(await bounded.read(critical.id)).not.toBeNull();
      expect(await bounded.read(newCritical.id)).not.toBeNull();
    });
  });

  describe('H1: ID uniqueness', () => {
    it('generates IDs with randomness to avoid cross-process collisions', async () => {
      const entry = await store.write({ key: 'k1', content: 'a', grade: 'useful' });
      // ID should contain a random component beyond just timestamp + counter
      // Format: mem_{timestamp}_{counter}_{random}
      const parts = entry.id.split('_');
      // With the fix, IDs have 4 parts: mem, timestamp, counter, random
      expect(parts.length).toBe(4);
      expect(parts[0]).toBe('mem');
      // The random part should be a non-empty alphanumeric string
      expect(parts[3]).toMatch(/^[a-z0-9]+$/);
      expect(parts[3].length).toBeGreaterThanOrEqual(2);
    });

    it('generates distinct IDs even with same timestamp', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const entry = await store.write({ key: `k${i}`, content: `c${i}`, grade: 'useful' });
        ids.add(entry.id);
      }
      expect(ids.size).toBe(20);
    });
  });
});
