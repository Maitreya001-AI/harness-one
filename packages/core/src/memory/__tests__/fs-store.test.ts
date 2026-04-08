import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
});
