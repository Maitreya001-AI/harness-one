import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
});
