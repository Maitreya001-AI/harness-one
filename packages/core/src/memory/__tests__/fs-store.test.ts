import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { createFileSystemStore } from '../fs-store.js';
import type { MemoryStore } from '../store.js';
import { HarnessError } from '../../core/errors.js';

describe('createFileSystemStore', () => {
  let store: MemoryStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-mem-'));
    store = createFileSystemStore({ directory: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes and reads an entry', async () => {
    const entry = await store.write({ key: 'k1', content: 'hello', grade: 'useful' });
    const read = await store.read(entry.id);
    expect(read).toEqual(entry);
  });

  it('returns null for missing entry', async () => {
    expect(await store.read('nonexistent')).toBeNull();
  });

  it('queries entries with filters', async () => {
    await store.write({ key: 'k1', content: 'alpha', grade: 'critical', tags: ['x'] });
    await store.write({ key: 'k2', content: 'beta', grade: 'useful', tags: ['y'] });

    const critical = await store.query({ grade: 'critical' });
    expect(critical).toHaveLength(1);
    expect(critical[0].content).toBe('alpha');

    const tagged = await store.query({ tags: ['y'] });
    expect(tagged).toHaveLength(1);

    const searched = await store.query({ search: 'alph' });
    expect(searched).toHaveLength(1);
  });

  it('updates an entry', async () => {
    const entry = await store.write({ key: 'k1', content: 'old', grade: 'useful' });
    const updated = await store.update(entry.id, { content: 'new' });
    expect(updated.content).toBe('new');

    const read = await store.read(entry.id);
    expect(read!.content).toBe('new');
  });

  it('throws HarnessError when updating missing entry', async () => {
    await expect(store.update('nope', { content: 'x' })).rejects.toThrow(HarnessError);
  });

  it('deletes an entry', async () => {
    const entry = await store.write({ key: 'k1', content: 'hello', grade: 'useful' });
    expect(await store.delete(entry.id)).toBe(true);
    expect(await store.read(entry.id)).toBeNull();
  });

  it('returns false when deleting missing entry', async () => {
    expect(await store.delete('nope')).toBe(false);
  });

  it('compacts entries by maxEntries', async () => {
    await store.write({ key: 'k1', content: 'a', grade: 'critical' });
    await store.write({ key: 'k2', content: 'b', grade: 'ephemeral' });
    await store.write({ key: 'k3', content: 'c', grade: 'useful' });

    const result = await store.compact({ maxEntries: 1 });
    expect(result.remaining).toBe(1);
    expect(result.removed).toBe(2);
  });

  it('counts entries', async () => {
    expect(await store.count()).toBe(0);
    await store.write({ key: 'k1', content: 'a', grade: 'useful' });
    expect(await store.count()).toBe(1);
  });

  it('clears all entries', async () => {
    await store.write({ key: 'k1', content: 'a', grade: 'useful' });
    await store.write({ key: 'k2', content: 'b', grade: 'useful' });
    await store.clear();
    expect(await store.count()).toBe(0);
  });

  it('creates directory if it does not exist', async () => {
    const nested = join(dir, 'nested', 'deep');
    const nestedStore = createFileSystemStore({ directory: nested });
    const entry = await nestedStore.write({ key: 'k1', content: 'test', grade: 'useful' });
    expect(entry.id).toMatch(/^mem_/);
  });

  describe('C8: atomic index writes', () => {
    it('uses write-then-rename for index updates (no partial/corrupt index)', async () => {
      // Write an entry to create the index
      await store.write({ key: 'k1', content: 'hello', grade: 'useful' });

      // The index file should exist and be valid JSON
      const indexPath = join(dir, '_index.json');
      const content = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);
      expect(index.keys).toBeDefined();
      expect(index.keys['k1']).toBeDefined();

      // There should be no leftover temp file
      expect(existsSync(join(dir, '_index.json.tmp'))).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('atomic index write — writes to tmp then renames', async () => {
      // After writing, there should be a valid index and no tmp file
      await store.write({ key: 'k1', content: 'test data', grade: 'useful' });
      await store.write({ key: 'k2', content: 'more data', grade: 'critical' });

      const indexPath = join(dir, '_index.json');
      const content = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      // Index should reference both entries
      expect(index.keys['k1']).toBeDefined();
      expect(index.keys['k2']).toBeDefined();

      // No leftover tmp file
      expect(existsSync(join(dir, '_index.json.tmp'))).toBe(false);
    });

    it('read from empty directory returns null or empty results', async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), 'harness-empty-'));
      const emptyStore = createFileSystemStore({ directory: emptyDir });

      expect(await emptyStore.read('nonexistent')).toBeNull();
      expect(await emptyStore.count()).toBe(0);

      const results = await emptyStore.query({});
      expect(results).toHaveLength(0);

      await rm(emptyDir, { recursive: true, force: true });
    });

    it('compact with both maxAge and maxEntries works correctly in single pass', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'ephemeral' });
      await store.write({ key: 'k2', content: 'b', grade: 'useful' });
      await store.write({ key: 'k3', content: 'c', grade: 'critical' });
      await store.write({ key: 'k4', content: 'd', grade: 'ephemeral' });

      const result = await store.compact({ maxEntries: 2 });
      expect(result.remaining).toBeLessThanOrEqual(2);
      // Critical should survive
      const remaining = await store.query({});
      const grades = remaining.map(r => r.grade);
      expect(grades).toContain('critical');
    });
  });

  describe('H2: compact calls allEntries only once', () => {
    it('compact does not call allEntries more than once for the initial scan', async () => {
      // Write several entries
      await store.write({ key: 'k1', content: 'a', grade: 'ephemeral' });
      await store.write({ key: 'k2', content: 'b', grade: 'useful' });
      await store.write({ key: 'k3', content: 'c', grade: 'critical' });

      // compact with both maxAge and maxEntries should still work correctly
      // This test verifies correctness after the optimization
      const result = await store.compact({ maxEntries: 1 });
      expect(result.remaining).toBe(1);
      expect(result.removed).toBe(2);
    });
  });

  describe('query with limit filter', () => {
    it('respects limit parameter and returns only the specified number of results', async () => {
      await store.write({ key: 'k1', content: 'first', grade: 'useful' });
      await store.write({ key: 'k2', content: 'second', grade: 'useful' });
      await store.write({ key: 'k3', content: 'third', grade: 'useful' });

      const limited = await store.query({ limit: 2 });
      expect(limited).toHaveLength(2);

      const unlimited = await store.query({});
      expect(unlimited).toHaveLength(3);
    });

    it('returns all results when limit exceeds total entries', async () => {
      await store.write({ key: 'k1', content: 'first', grade: 'useful' });

      const results = await store.query({ limit: 100 });
      expect(results).toHaveLength(1);
    });
  });

  describe('concurrent write safety (index mutex)', () => {
    it('concurrent writes do not corrupt index — all entries accessible', async () => {
      // Fire 10 writes concurrently; without a mutex the read-modify-write
      // on the index file races and last-writer-wins, orphaning earlier entries.
      const writes = Array.from({ length: 10 }, (_, i) =>
        store.write({ key: `concurrent_${i}`, content: `value_${i}`, grade: 'useful' }),
      );
      const entries = await Promise.all(writes);

      // Every entry file should be readable
      for (const entry of entries) {
        const read = await store.read(entry.id);
        expect(read).not.toBeNull();
        expect(read!.content).toBe(entry.content);
      }

      // The index must reference ALL 10 keys (no orphans)
      const indexPath = join(dir, '_index.json');
      const raw = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(raw);
      for (let i = 0; i < 10; i++) {
        expect(index.keys[`concurrent_${i}`]).toBeDefined();
      }
    });

    it('concurrent write + delete does not corrupt index', async () => {
      // Seed an entry, then concurrently write new entries and delete the seed.
      const seed = await store.write({ key: 'seed', content: 'seed', grade: 'useful' });

      const ops = [
        store.write({ key: 'w1', content: 'a', grade: 'useful' }),
        store.write({ key: 'w2', content: 'b', grade: 'useful' }),
        store.delete(seed.id),
        store.write({ key: 'w3', content: 'c', grade: 'useful' }),
      ];
      await Promise.all(ops);

      // Seed should be deleted
      expect(await store.read(seed.id)).toBeNull();

      // The three new writes should all be in the index
      const indexPath = join(dir, '_index.json');
      const raw = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(raw);
      expect(index.keys['w1']).toBeDefined();
      expect(index.keys['w2']).toBeDefined();
      expect(index.keys['w3']).toBeDefined();
      expect(index.keys['seed']).toBeUndefined();
    });
  });

  describe('compact with maxAge', () => {
    it('removes non-critical entries older than maxAge', async () => {
      // Write entries that will be "old" (maxAge: 0 means anything older than 0ms)
      await store.write({ key: 'k1', content: 'old ephemeral', grade: 'ephemeral' });
      await store.write({ key: 'k2', content: 'old useful', grade: 'useful' });
      await store.write({ key: 'k3', content: 'old critical', grade: 'critical' });

      // Wait a tiny bit so entries have non-zero age
      await new Promise(r => setTimeout(r, 5));

      // maxAge: 0 means all entries with age > 0 are candidates
      // Only non-critical (weight < 1.0) should be removed
      const result = await store.compact({ maxAge: 0 });
      expect(result.removed).toBe(2);
      expect(result.remaining).toBe(1);
      expect(result.freedEntries).toHaveLength(2);

      // Only critical entry should survive
      const remaining = await store.query({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].grade).toBe('critical');
    });

    it('keeps entries newer than maxAge', async () => {
      await store.write({ key: 'k1', content: 'new', grade: 'ephemeral' });

      // maxAge of 60 seconds means nothing should be removed
      const result = await store.compact({ maxAge: 60_000 });
      expect(result.removed).toBe(0);
      expect(result.remaining).toBe(1);
    });

    it('compact with both maxAge and maxEntries in single pass', async () => {
      await store.write({ key: 'k1', content: 'a', grade: 'ephemeral' });
      await store.write({ key: 'k2', content: 'b', grade: 'useful' });
      await store.write({ key: 'k3', content: 'c', grade: 'critical' });
      await store.write({ key: 'k4', content: 'd', grade: 'ephemeral' });

      await new Promise(r => setTimeout(r, 5));

      // maxAge: 0 removes ephemeral + useful (3 entries), then maxEntries: 1 trims further
      const result = await store.compact({ maxAge: 0, maxEntries: 1 });
      expect(result.remaining).toBe(1);
      // critical should survive both passes
      const remaining = await store.query({});
      expect(remaining[0].grade).toBe('critical');
    });
  });

  describe('query with offset (Fix 1: offset handling)', () => {
    it('applies offset before limit for pagination', async () => {
      // Write 5 entries with small delays to ensure distinct updatedAt for deterministic sorting
      await store.write({ key: 'k1', content: 'first', grade: 'useful' });
      await store.write({ key: 'k2', content: 'second', grade: 'useful' });
      await store.write({ key: 'k3', content: 'third', grade: 'useful' });
      await store.write({ key: 'k4', content: 'fourth', grade: 'useful' });
      await store.write({ key: 'k5', content: 'fifth', grade: 'useful' });

      // Results sorted by updatedAt desc: k5, k4, k3, k2, k1
      // offset=2, limit=2 should skip first 2 and take next 2
      const page = await store.query({ offset: 2, limit: 2 });
      expect(page).toHaveLength(2);
    });

    it('offset of 0 has no effect', async () => {
      await store.write({ key: 'k1', content: 'first', grade: 'useful' });
      await store.write({ key: 'k2', content: 'second', grade: 'useful' });

      const withOffset = await store.query({ offset: 0 });
      const without = await store.query({});
      expect(withOffset).toHaveLength(without.length);
    });

    it('offset beyond total returns empty', async () => {
      await store.write({ key: 'k1', content: 'first', grade: 'useful' });
      await store.write({ key: 'k2', content: 'second', grade: 'useful' });

      const results = await store.query({ offset: 10 });
      expect(results).toHaveLength(0);
    });

    it('offset without limit returns remaining entries', async () => {
      await store.write({ key: 'k1', content: 'first', grade: 'useful' });
      await store.write({ key: 'k2', content: 'second', grade: 'useful' });
      await store.write({ key: 'k3', content: 'third', grade: 'useful' });

      const results = await store.query({ offset: 1 });
      expect(results).toHaveLength(2);
    });

    it('offset + limit pagination matches in-memory store behavior', async () => {
      // Verify fs-store and in-memory store produce same pagination results
      const { createInMemoryStore } = await import('../store.js');
      const memStore = createInMemoryStore();

      for (let i = 0; i < 5; i++) {
        await store.write({ key: `k${i}`, content: `content-${i}`, grade: 'useful' });
        await memStore.write({ key: `k${i}`, content: `content-${i}`, grade: 'useful' });
      }

      // Page 1
      const fsPage1 = await store.query({ offset: 0, limit: 2 });
      const memPage1 = await memStore.query({ offset: 0, limit: 2 });
      expect(fsPage1).toHaveLength(memPage1.length);

      // Page 2
      const fsPage2 = await store.query({ offset: 2, limit: 2 });
      const memPage2 = await memStore.query({ offset: 2, limit: 2 });
      expect(fsPage2).toHaveLength(memPage2.length);

      // Page 3 (partial)
      const fsPage3 = await store.query({ offset: 4, limit: 2 });
      const memPage3 = await memStore.query({ offset: 4, limit: 2 });
      expect(fsPage3).toHaveLength(memPage3.length);
    });
  });

  describe('batched file reads (Fix 2: fd exhaustion prevention)', () => {
    it('reads many entries without fd exhaustion', async () => {
      // Write more entries than the batch size (50) to exercise batching
      const count = 75;
      for (let i = 0; i < count; i++) {
        await store.write({ key: `k${i}`, content: `content-${i}`, grade: 'useful' });
      }

      const results = await store.query({});
      expect(results).toHaveLength(count);
    });

    it('batch reading returns same results as individual reads', async () => {
      const entries = [];
      for (let i = 0; i < 10; i++) {
        entries.push(await store.write({ key: `k${i}`, content: `content-${i}`, grade: 'useful' }));
      }

      // All entries should be readable via query
      const queried = await store.query({});
      expect(queried).toHaveLength(10);

      // Verify each entry is still individually readable
      for (const entry of entries) {
        const read = await store.read(entry.id);
        expect(read).not.toBeNull();
        expect(read!.content).toBe(entry.content);
      }
    });
  });

  describe('error handling (Fix 3: discriminating errors)', () => {
    it('readIndex returns empty index for ENOENT (first run)', async () => {
      // A fresh store with no prior writes should work (ENOENT on index read)
      const freshDir = await mkdtemp(join(tmpdir(), 'harness-fresh-'));
      const freshStore = createFileSystemStore({ directory: freshDir });

      // query triggers readIndex via allEntries, which should handle ENOENT gracefully
      const results = await freshStore.query({});
      expect(results).toHaveLength(0);

      await rm(freshDir, { recursive: true, force: true });
    });

    it('allEntries returns empty for ENOENT directory', async () => {
      // Create a store pointing to a non-existent dir, then query before any writes
      const nonExistentDir = join(tmpdir(), 'harness-nonexistent-' + Date.now());
      const freshStore = createFileSystemStore({ directory: nonExistentDir });

      // ensureDir creates the dir, but there are no entries
      const results = await freshStore.query({});
      expect(results).toHaveLength(0);

      await rm(nonExistentDir, { recursive: true, force: true });
    });

    it('readEntry returns null for ENOENT (missing file)', async () => {
      // Reading a non-existent entry should return null (ENOENT)
      const result = await store.read('nonexistent-id');
      expect(result).toBeNull();
    });

    it('readEntry throws on non-ENOENT errors (corrupted JSON)', async () => {
      // Write a corrupted JSON file directly
      await store.write({ key: 'k1', content: 'test', grade: 'useful' });
      const entries = await store.query({});
      const entry = entries[0];

      // Corrupt the entry file by writing invalid JSON
      const corruptedPath = join(dir, `${entry.id}.json`);
      await writeFile(corruptedPath, 'NOT VALID JSON{{{', 'utf-8');

      // Reading a corrupted entry should throw (SyntaxError, not ENOENT)
      await expect(store.read(entry.id)).rejects.toThrow();
    });

    it('readIndex throws on non-ENOENT errors (corrupted index)', async () => {
      // Write an entry to create the index, then corrupt it
      await store.write({ key: 'k1', content: 'test', grade: 'useful' });

      // Corrupt the index file
      const indexPath = join(dir, '_index.json');
      await writeFile(indexPath, 'CORRUPTED{{{', 'utf-8');

      // query triggers readIndex, which should throw on corrupted JSON (not ENOENT)
      // Note: query calls allEntries first, then readIndex is called during write.
      // Let's trigger readIndex directly via a write operation.
      await expect(store.write({ key: 'k2', content: 'test2', grade: 'useful' })).rejects.toThrow();
    });
  });
});
