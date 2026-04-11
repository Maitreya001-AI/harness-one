import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRedisStore } from '../index.js';
import type { RedisStoreConfig } from '../index.js';

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

  const setFn = vi.fn((key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  });
  const saddFn = vi.fn((key: string, ...members: string[]) => {
    const s = getSet(key);
    let added = 0;
    for (const m of members) {
      if (!s.has(m)) { s.add(m); added++; }
    }
    return added;
  });

  const multi = vi.fn(() => {
    const queue: (() => unknown)[] = [];
    const pipeline = {
      set: vi.fn((...args: unknown[]) => {
        queue.push(() => setFn(...(args as [string, string])));
        return pipeline;
      }),
      sadd: vi.fn((...args: unknown[]) => {
        queue.push(() => saddFn(args[0] as string, ...(args.slice(1) as string[])));
        return pipeline;
      }),
      exec: vi.fn(async () => {
        const results: [null, unknown][] = [];
        for (const fn of queue) {
          results.push([null, fn()]);
        }
        return results;
      }),
    };
    return pipeline;
  });

  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: setFn,
    del: vi.fn(async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
        sets.delete(key);
      }
      return count;
    }),
    sadd: saddFn,
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
    multi,
    _store: store,
    _sets: sets,
  } as unknown as RedisStoreConfig['client'];
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

  it('queries with multiple tags using AND semantics (every tag must match)', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'both-tags', grade: 'useful', tags: ['urgent', 'critical'] });
    await store.write({ key: 'b', content: 'only-urgent', grade: 'useful', tags: ['urgent'] });
    await store.write({ key: 'c', content: 'only-critical', grade: 'useful', tags: ['critical'] });
    await store.write({ key: 'd', content: 'no-tags', grade: 'useful' });

    // Filtering with ['urgent', 'critical'] should return only entries with BOTH tags
    const results = await store.query({ tags: ['urgent', 'critical'] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('both-tags');
  });

  it('ignores non-string search values in query filter', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'Hello world', grade: 'useful' });
    await store.write({ key: 'b', content: 'Goodbye world', grade: 'useful' });

    // Passing a non-string search value should not crash -- it is silently ignored
    const results = await store.query({ search: 123 as unknown as string });
    // All entries should be returned since the non-string search is ignored
    expect(results).toHaveLength(2);
  });

  it('writes with TTL when defaultTTL is set', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test', defaultTTL: 3600 });

    await store.write({ key: 'k', content: 'ttl entry', grade: 'useful' });

    // set should have been called with 'EX' and the TTL value
    const mockRedis = redis as unknown as { set: ReturnType<typeof vi.fn> };
    const setCall = mockRedis.set.mock.calls[0];
    expect(setCall[2]).toBe('EX');
    expect(setCall[3]).toBe(3600);
  });

  it('queries with offset', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'first', grade: 'useful' });
    await store.write({ key: 'b', content: 'second', grade: 'useful' });
    await store.write({ key: 'c', content: 'third', grade: 'useful' });

    const results = await store.query({ offset: 1 });
    expect(results).toHaveLength(2);
  });

  it('queries with offset and limit combined', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'first', grade: 'useful' });
    await store.write({ key: 'b', content: 'second', grade: 'useful' });
    await store.write({ key: 'c', content: 'third', grade: 'useful' });

    const results = await store.query({ offset: 1, limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('queries with since filter', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    const entry1 = await store.write({ key: 'a', content: 'old', grade: 'useful' });
    // Adjust the timestamp of the first entry to simulate an old entry
    const mockRedis = redis as unknown as { _store: Map<string, string> };
    const key1 = `test:${entry1.id}`;
    const storedEntry = JSON.parse(mockRedis._store.get(key1)!);
    storedEntry.updatedAt = Date.now() - 100000;
    mockRedis._store.set(key1, JSON.stringify(storedEntry));

    await store.write({ key: 'b', content: 'recent', grade: 'useful' });

    const results = await store.query({ since: Date.now() - 1000 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('recent');
  });

  it('compacts by maxAge, removing non-critical old entries', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    const entry1 = await store.write({ key: 'a', content: 'old ephemeral', grade: 'ephemeral' });
    const entry2 = await store.write({ key: 'b', content: 'old useful', grade: 'useful' });
    await store.write({ key: 'c', content: 'new critical', grade: 'critical' });

    // Make first two entries old
    const mockRedis = redis as unknown as { _store: Map<string, string> };
    for (const entry of [entry1, entry2]) {
      const key = `test:${entry.id}`;
      const stored = JSON.parse(mockRedis._store.get(key)!);
      stored.createdAt = Date.now() - 200000;
      mockRedis._store.set(key, JSON.stringify(stored));
    }

    const result = await store.compact({ maxAge: 100000 });
    // Both ephemeral (0.1) and useful (0.5) are < 1.0, so they get removed
    expect(result.removed).toBe(2);
  });

  it('compact with maxAge does not remove critical entries', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    const entry1 = await store.write({ key: 'a', content: 'old critical', grade: 'critical' });

    // Make it old
    const mockRedis = redis as unknown as { _store: Map<string, string> };
    const key = `test:${entry1.id}`;
    const stored = JSON.parse(mockRedis._store.get(key)!);
    stored.createdAt = Date.now() - 200000;
    mockRedis._store.set(key, JSON.stringify(stored));

    const result = await store.compact({ maxAge: 100000 });
    // Critical grade has weight 1.0, should NOT be removed
    expect(result.removed).toBe(0);
  });

  it('compact with maxEntries stops evicting when only critical entries remain', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'critical1', grade: 'critical' });
    await store.write({ key: 'b', content: 'critical2', grade: 'critical' });
    await store.write({ key: 'c', content: 'critical3', grade: 'critical' });

    // Try to compact to 1 entry -- but all are critical, so none get removed
    const result = await store.compact({ maxEntries: 1 });
    expect(result.removed).toBe(0);
    expect(result.remaining).toBe(3);
  });

  it('clear on empty store does not throw', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    await expect(store.clear()).resolves.not.toThrow();
  });

  it('uses default prefix when none provided', async () => {
    const store = createRedisStore({ client: redis });
    await store.write({ key: 'k', content: 'test', grade: 'useful' });

    const mockRedis = redis as unknown as { set: ReturnType<typeof vi.fn> };
    const setCall = mockRedis.set.mock.calls[0];
    // Key should start with 'harness:memory:'
    expect(setCall[0]).toMatch(/^harness:memory:/);
  });

  it('silently cleans up corrupted JSON entry during read', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Write a valid entry, then corrupt it
    const entry = await store.write({ key: 'k', content: 'original', grade: 'useful' });
    const mockRedis = redis as unknown as { _store: Map<string, string>; del: ReturnType<typeof vi.fn>; srem: ReturnType<typeof vi.fn> };
    const key = `test:${entry.id}`;
    mockRedis._store.set(key, '{corrupted json!!!');

    // Reading should return null without logging a warning
    const result = await store.read(entry.id);
    expect(result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();

    // The corrupted entry should be removed from the store and index
    expect(mockRedis.del).toHaveBeenCalledWith(`test:${entry.id}`);
    expect(mockRedis.srem).toHaveBeenCalledWith('test:__keys__', entry.id);

    warnSpy.mockRestore();
  });

  it('cleans up only the corrupted entry, not valid ones', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Write two entries and corrupt only one
    const entry1 = await store.write({ key: 'a', content: 'good', grade: 'useful' });
    const entry2 = await store.write({ key: 'b', content: 'bad', grade: 'useful' });

    const mockRedis = redis as unknown as { _store: Map<string, string> };
    mockRedis._store.set(`test:${entry2.id}`, 'not valid json');

    // Reading the corrupted entry returns null without warning
    const corruptResult = await store.read(entry2.id);
    expect(corruptResult).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();

    // Reading the valid entry still works
    const validResult = await store.read(entry1.id);
    expect(validResult).not.toBeNull();
    expect(validResult!.content).toBe('good');

    warnSpy.mockRestore();
  });

  it('compact uses batched mget instead of sequential getEntry calls', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'one', grade: 'ephemeral' });
    await store.write({ key: 'b', content: 'two', grade: 'useful' });
    await store.write({ key: 'c', content: 'three', grade: 'critical' });

    // Reset mock call counts after writes
    const mockRedis = redis as unknown as { mget: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    mockRedis.get.mockClear();
    mockRedis.mget.mockClear();

    await store.compact({ maxEntries: 2 });

    // compact should use mget (batched) not individual get calls
    expect(mockRedis.mget).toHaveBeenCalled();
    // No individual get calls should be made during compact
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  // ── sessionId filtering ────────────────────────────────────────────────

  it('queries with sessionId filter returns only matching entries', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'session-1 entry', grade: 'useful', metadata: { sessionId: 'sess-1' } });
    await store.write({ key: 'b', content: 'session-2 entry', grade: 'useful', metadata: { sessionId: 'sess-2' } });
    await store.write({ key: 'c', content: 'no-session entry', grade: 'useful' });

    const results = await store.query({ sessionId: 'sess-1' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('session-1 entry');
  });

  it('queries with sessionId filter returns empty when no entries match', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'entry1', grade: 'useful', metadata: { sessionId: 'sess-1' } });

    const results = await store.query({ sessionId: 'nonexistent' });
    expect(results).toHaveLength(0);
  });

  it('queries with sessionId excludes entries without metadata', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'with session', grade: 'useful', metadata: { sessionId: 'sess-1' } });
    await store.write({ key: 'b', content: 'no metadata', grade: 'useful' });

    const results = await store.query({ sessionId: 'sess-1' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('with session');
  });

  // ── Atomic writes via multi/pipeline ───────────────────────────────────

  it('write uses atomic multi/pipeline for set + sadd', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const mockRedis = redis as unknown as { multi: ReturnType<typeof vi.fn> };

    // Clear any previous calls
    mockRedis.multi.mockClear();

    await store.write({ key: 'k', content: 'atomic test', grade: 'useful' });

    // multi should have been called to ensure atomicity
    expect(mockRedis.multi).toHaveBeenCalled();
    // The pipeline should include both set and sadd
    const pipeline = mockRedis.multi.mock.results[0].value;
    expect(pipeline.set).toHaveBeenCalled();
    expect(pipeline.sadd).toHaveBeenCalled();
    expect(pipeline.exec).toHaveBeenCalled();
  });

  it('write with TTL uses atomic multi/pipeline', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test', defaultTTL: 3600 });
    const mockRedis = redis as unknown as { multi: ReturnType<typeof vi.fn> };

    mockRedis.multi.mockClear();

    await store.write({ key: 'k', content: 'ttl atomic', grade: 'useful' });

    expect(mockRedis.multi).toHaveBeenCalled();
    const pipeline = mockRedis.multi.mock.results[0].value;
    // set should have been called with EX and TTL
    const setCall = pipeline.set.mock.calls[0];
    expect(setCall[2]).toBe('EX');
    expect(setCall[3]).toBe(3600);
    expect(pipeline.exec).toHaveBeenCalled();
  });
});
