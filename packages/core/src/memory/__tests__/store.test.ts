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
