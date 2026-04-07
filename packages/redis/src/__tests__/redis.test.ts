import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRedisStore } from '../index.js';

// ---------------------------------------------------------------------------
// Mock Redis client
// ---------------------------------------------------------------------------

function createMockRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  const getSet = (key: string): Set<string> => {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key)!;
  };

  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
        sets.delete(key);
      }
      return count;
    }),
    sadd: vi.fn(async (key: string, ...members: string[]) => {
      const s = getSet(key);
      let added = 0;
      for (const m of members) {
        if (!s.has(m)) { s.add(m); added++; }
      }
      return added;
    }),
    srem: vi.fn(async (key: string, ...members: string[]) => {
      const s = getSet(key);
      let removed = 0;
      for (const m of members) {
        if (s.delete(m)) removed++;
      }
      return removed;
    }),
    smembers: vi.fn(async (key: string) => Array.from(getSet(key))),
    scard: vi.fn(async (key: string) => getSet(key).size),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
    _store: store,
    _sets: sets,
  } as any;
}

describe('createRedisStore', () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
  });

  it('writes and reads an entry', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    const entry = await store.write({
      key: 'pref',
      content: 'dark mode',
      grade: 'useful',
    });

    expect(entry.id).toBeDefined();
    expect(entry.key).toBe('pref');
    expect(entry.content).toBe('dark mode');
    expect(entry.grade).toBe('useful');

    const read = await store.read(entry.id);
    expect(read).not.toBeNull();
    expect(read!.content).toBe('dark mode');
  });

  it('returns null for non-existent entry', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const result = await store.read('nonexistent');
    expect(result).toBeNull();
  });

  it('queries entries by grade', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'critical item', grade: 'critical' });
    await store.write({ key: 'b', content: 'useful item', grade: 'useful' });
    await store.write({ key: 'c', content: 'another useful', grade: 'useful' });

    const results = await store.query({ grade: 'useful' });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.grade === 'useful')).toBe(true);
  });

  it('queries entries by search term', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'The quick brown fox', grade: 'useful' });
    await store.write({ key: 'b', content: 'Lazy dog sleeps', grade: 'useful' });

    const results = await store.query({ search: 'fox' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('The quick brown fox');
  });

  it('queries with limit', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'first', grade: 'useful' });
    await store.write({ key: 'b', content: 'second', grade: 'useful' });
    await store.write({ key: 'c', content: 'third', grade: 'useful' });

    const results = await store.query({ limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('updates an entry', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    const entry = await store.write({ key: 'k', content: 'original', grade: 'useful' });
    const updated = await store.update(entry.id, { content: 'modified' });

    expect(updated.content).toBe('modified');
    expect(updated.grade).toBe('useful');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(entry.updatedAt);
  });

  it('throws on update of non-existent entry', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    await expect(store.update('nonexistent', { content: 'x' })).rejects.toThrow('not found');
  });

  it('deletes an entry', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    const entry = await store.write({ key: 'k', content: 'to delete', grade: 'ephemeral' });
    const deleted = await store.delete(entry.id);
    expect(deleted).toBe(true);

    const read = await store.read(entry.id);
    expect(read).toBeNull();
  });

  it('returns false when deleting non-existent entry', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const deleted = await store.delete('nonexistent');
    expect(deleted).toBe(false);
  });

  it('counts entries', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'one', grade: 'useful' });
    await store.write({ key: 'b', content: 'two', grade: 'useful' });

    expect(await store.count()).toBe(2);
  });

  it('clears all entries', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'one', grade: 'useful' });
    await store.write({ key: 'b', content: 'two', grade: 'useful' });
    await store.clear();

    expect(await store.count()).toBe(0);
  });

  it('compacts by maxEntries', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'one', grade: 'ephemeral' });
    await store.write({ key: 'b', content: 'two', grade: 'useful' });
    await store.write({ key: 'c', content: 'three', grade: 'critical' });

    const result = await store.compact({ maxEntries: 2 });
    expect(result.removed).toBe(1);
    expect(result.remaining).toBe(2);
  });

  it('queries with tags filter', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'tagged', grade: 'useful', tags: ['important'] });
    await store.write({ key: 'b', content: 'untagged', grade: 'useful' });

    const results = await store.query({ tags: ['important'] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('tagged');
  });
});
