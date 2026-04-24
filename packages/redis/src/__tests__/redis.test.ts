import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRedisStore } from '../index.js';
import type { RedisStoreConfig } from '../index.js';

// ---------------------------------------------------------------------------
// Mock Redis client
// ---------------------------------------------------------------------------

function createMockRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  /**
   * Absolute expiry timestamp (ms since epoch) per key. Only populated
   * when `set()` is called with `'PX' <ms>` / `'EX' <sec>` options. Absent
   * entries have no TTL (ioredis `pttl` returns -1 for those).
   */
  const expiries = new Map<string, number>();

  const getSet = (key: string): Set<string> => {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key)!;
  };

  /**
   * Lazy-evict: if `key` is past its expiry, drop the store entry and
   * its expiry record, then signal the caller via the returned boolean
   * so read paths can treat it as missing.
   */
  const evictIfExpired = (key: string): boolean => {
    const expireAt = expiries.get(key);
    if (expireAt === undefined) return false;
    if (Date.now() < expireAt) return false;
    store.delete(key);
    expiries.delete(key);
    return true;
  };

  /**
   * Parse ioredis variadic `set()` options (PX <ms> / EX <sec>) and
   * return the absolute expiry timestamp when a TTL was requested.
   * Returns `undefined` when the call is plain `set(key, value)`.
   */
  const extractExpiry = (extras: unknown[]): number | undefined => {
    for (let i = 0; i < extras.length - 1; i++) {
      const flag = extras[i];
      const amount = extras[i + 1];
      if (typeof flag !== 'string' || typeof amount !== 'number' || !Number.isFinite(amount)) continue;
      const lower = flag.toLowerCase();
      if (lower === 'px') return Date.now() + amount;
      if (lower === 'ex') return Date.now() + amount * 1000;
    }
    return undefined;
  };

  const setFn = vi.fn((key: string, value: string, ...extras: unknown[]) => {
    store.set(key, value);
    const expireAt = extractExpiry(extras);
    if (expireAt !== undefined) {
      expiries.set(key, expireAt);
    } else {
      // Plain `set` clears any prior TTL — matches ioredis semantics.
      expiries.delete(key);
    }
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
  const delFn = vi.fn((...keys: string[]) => {
    let count = 0;
    for (const key of keys) {
      if (store.delete(key)) count++;
      expiries.delete(key);
      sets.delete(key);
    }
    return count;
  });
  const sremFn = vi.fn((key: string, ...members: string[]) => {
    const s = getSet(key);
    let removed = 0;
    for (const m of members) {
      if (s.delete(m)) removed++;
    }
    return removed;
  });

  const multi = vi.fn(() => {
    const queue: (() => unknown)[] = [];
    const pipeline = {
      set: vi.fn((...args: unknown[]) => {
        queue.push(() => setFn(args[0] as string, args[1] as string, ...args.slice(2)));
        return pipeline;
      }),
      sadd: vi.fn((...args: unknown[]) => {
        queue.push(() => saddFn(args[0] as string, ...(args.slice(1) as string[])));
        return pipeline;
      }),
      del: vi.fn((...keys: unknown[]) => {
        queue.push(() => delFn(...(keys as string[])));
        return pipeline;
      }),
      srem: vi.fn((...args: unknown[]) => {
        queue.push(() => sremFn(args[0] as string, ...(args.slice(1) as string[])));
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
    get: vi.fn(async (key: string) => {
      evictIfExpired(key);
      return store.get(key) ?? null;
    }),
    set: setFn,
    del: vi.fn(async (...keys: string[]) => delFn(...keys)),
    sadd: saddFn,
    srem: vi.fn(async (key: string, ...members: string[]) => sremFn(key, ...members)),
    smembers: vi.fn(async (key: string) => Array.from(getSet(key))),
    scard: vi.fn(async (key: string) => getSet(key).size),
    mget: vi.fn(async (...keys: string[]) =>
      keys.map((k) => {
        evictIfExpired(k);
        return store.get(k) ?? null;
      }),
    ),
    /**
     * ioredis `pttl` contract:
     *   - `-2` if the key does not exist
     *   - `-1` if the key exists but has no associated TTL
     *   - remaining milliseconds otherwise
     */
    pttl: vi.fn(async (key: string) => {
      evictIfExpired(key);
      if (!store.has(key)) return -2;
      const expireAt = expiries.get(key);
      if (expireAt === undefined) return -1;
      return Math.max(0, expireAt - Date.now());
    }),
    multi,
    watch: vi.fn(async () => 'OK'),
    unwatch: vi.fn(async () => 'OK'),
    _store: store,
    _sets: sets,
    _expiries: expiries,
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

  it('queries with multiple tags using OR semantics (any tag may match)', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'both-tags', grade: 'useful', tags: ['urgent', 'critical'] });
    await store.write({ key: 'b', content: 'only-urgent', grade: 'useful', tags: ['urgent'] });
    await store.write({ key: 'c', content: 'only-critical', grade: 'useful', tags: ['critical'] });
    await store.write({ key: 'd', content: 'no-tags', grade: 'useful' });

    // Filtering with ['urgent', 'critical'] must return every entry carrying
    // AT LEAST ONE of the tags — OR semantics aligned with the in-memory and
    // fs-store backends (semantic divergence between providers).
    const results = await store.query({ tags: ['urgent', 'critical'] });
    expect(results).toHaveLength(3);
    const contents = results.map((r) => r.content).sort();
    expect(contents).toEqual(['both-tags', 'only-critical', 'only-urgent']);
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
    const key1 = `test:default:${entry1.id}`;
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
      const key = `test:default:${entry.id}`;
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
    const key = `test:default:${entry1.id}`;
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

  it('returns null and warns for corrupted JSON — but does NOT auto-delete (SEC-014)', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Write a valid entry, then corrupt it
    const entry = await store.write({ key: 'k', content: 'original', grade: 'useful' });
    const mockRedis = redis as unknown as { _store: Map<string, string>; del: ReturnType<typeof vi.fn>; srem: ReturnType<typeof vi.fn> };
    const key = `test:default:${entry.id}`;
    mockRedis._store.set(key, '{corrupted json!!!');

    // Reset mock call counts from the write pathway
    mockRedis.del.mockClear();
    mockRedis.srem.mockClear();

    // Reading should return null AND log a diagnostic warning
    const result = await store.read(entry.id);
    expect(result).toBeNull();
    // Default logger shim forwards only the message to console.warn so the
    // existing operator tooling keeps working. Structured context travels on
    // the injected-logger path — see the custom-logger test below.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('corrupted entry'),
    );

    // SEC-014: read must be read-only. Silent auto-delete on corrupt payload
    // was a DoS gadget — one malformed write could erase arbitrary entries on
    // the next read. The fix requires callers to opt in to destructive cleanup
    // via `repair()`, so DEL/SREM must NOT be invoked here.
    expect(mockRedis.del).not.toHaveBeenCalled();
    expect(mockRedis.srem).not.toHaveBeenCalled();

    // The corrupted payload stays on disk, still findable by index iteration:
    expect(mockRedis._store.get(key)).toBe('{corrupted json!!!');

    warnSpy.mockRestore();
  });

  it('warns for each corrupt read but leaves valid entries untouched (SEC-014)', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Write two entries and corrupt only one
    const entry1 = await store.write({ key: 'a', content: 'good', grade: 'useful' });
    const entry2 = await store.write({ key: 'b', content: 'bad', grade: 'useful' });

    const mockRedis = redis as unknown as { _store: Map<string, string> };
    mockRedis._store.set(`test:default:${entry2.id}`, 'not valid json');

    // Corrupted → null + one warning (identifying the entry)
    const corruptResult = await store.read(entry2.id);
    expect(corruptResult).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Valid entry still works, no additional warnings
    const validResult = await store.read(entry1.id);
    expect(validResult).not.toBeNull();
    expect(validResult!.content).toBe('good');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('repair() removes corrupted entries and returns the count (SEC-014)', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Two valid entries, one corrupt payload, one dangling index (string gone).
    const good = await store.write({ key: 'a', content: 'good', grade: 'useful' });
    const badJson = await store.write({ key: 'b', content: 'bad', grade: 'useful' });
    const danglingId = 'mem_dangling';
    const mockRedis = redis as unknown as {
      _store: Map<string, string>;
      _sets: Map<string, Set<string>>;
    };
    mockRedis._store.set(`test:default:${badJson.id}`, 'not valid json');
    // simulate dangling index entry: id exists in set but no STRING
    mockRedis._sets.get('test:default:__keys__')!.add(danglingId);

    // repair() is the ONLY supported way to evict corrupt payloads.
    const result = await store.repair();
    expect(result.repaired).toBe(2); // corrupt + dangling

    // The good entry must survive untouched.
    const stillThere = await store.read(good.id);
    expect(stillThere).not.toBeNull();
    expect(stillThere!.content).toBe('good');

    // The corrupted entry is gone from the STRING bucket and the index.
    expect(mockRedis._store.get(`test:default:${badJson.id}`)).toBeUndefined();
    expect(mockRedis._sets.get('test:default:__keys__')!.has(badJson.id)).toBe(false);
    expect(mockRedis._sets.get('test:default:__keys__')!.has(danglingId)).toBe(false);

    warnSpy.mockRestore();
  });

  it('repair() is a no-op when the store has no corruption', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    await store.write({ key: 'a', content: 'good1', grade: 'useful' });
    await store.write({ key: 'b', content: 'good2', grade: 'critical' });

    const result = await store.repair();
    expect(result.repaired).toBe(0);
    expect(await store.count()).toBe(2);
  });

  it('accepts a custom logger and forwards corruption warnings to it (SEC-014)', async () => {
    const warnFn = vi.fn();
    const customLogger = { warn: warnFn };
    const store = createRedisStore({ client: redis, prefix: 'test', logger: customLogger });

    const entry = await store.write({ key: 'k', content: 'original', grade: 'useful' });
    const mockRedis = redis as unknown as { _store: Map<string, string> };
    mockRedis._store.set(`test:default:${entry.id}`, '{corrupted!!!');

    const result = await store.read(entry.id);
    expect(result).toBeNull();
    // Custom logger received the structured warning, console.warn was not touched.
    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining('corrupted entry'),
      expect.objectContaining({ entryId: entry.id, reason: 'invalid_json' }),
    );
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

  it('compact batches DEL + SREM through a single multi() pipeline', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    // Ten ephemeral entries — all evictable under maxEntries: 0.
    for (let i = 0; i < 10; i++) {
      await store.write({ key: `k${i}`, content: `v${i}`, grade: 'ephemeral' });
    }

    const mockRedis = redis as unknown as {
      multi: ReturnType<typeof vi.fn>;
      srem: ReturnType<typeof vi.fn>;
      del: ReturnType<typeof vi.fn>;
    };

    // Clear counters from the writes (each write fires one multi()).
    mockRedis.multi.mockClear();
    mockRedis.srem.mockClear();
    mockRedis.del.mockClear();

    const result = await store.compact({ maxEntries: 0 });
    expect(result.removed).toBe(10);

    // One pipeline for the whole eviction (up to chunkSize=1000). The
    // pipeline's inner `srem` must be invoked exactly once with every id as a
    // vararg — witness that the fix collapses N sequential round-trips into a
    // single MULTI/EXEC.
    expect(mockRedis.multi).toHaveBeenCalledTimes(1);
    const pipeline = mockRedis.multi.mock.results[0].value as {
      del: ReturnType<typeof vi.fn>;
      srem: ReturnType<typeof vi.fn>;
      exec: ReturnType<typeof vi.fn>;
    };
    expect(pipeline.srem).toHaveBeenCalledTimes(1);
    const sremCall = pipeline.srem.mock.calls[0];
    expect(sremCall[0]).toBe('test:default:__keys__');
    expect(sremCall.slice(1)).toHaveLength(10);
    // One DEL per victim is fine — they all travel on the same pipeline.
    expect(pipeline.del).toHaveBeenCalledTimes(10);
    expect(pipeline.exec).toHaveBeenCalledTimes(1);
    // Top-level (non-pipelined) del/srem are NOT used for the eviction itself.
    expect(mockRedis.del).not.toHaveBeenCalled();
    expect(mockRedis.srem).not.toHaveBeenCalled();
  });

  it('compact does not open a pipeline when there is nothing to evict', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    await store.write({ key: 'a', content: 'v', grade: 'critical' });
    const mockRedis = redis as unknown as { multi: ReturnType<typeof vi.fn> };
    mockRedis.multi.mockClear();

    const result = await store.compact({ maxEntries: 10 });
    expect(result.removed).toBe(0);
    // No victims → no maintenance pipeline opened.
    expect(mockRedis.multi).not.toHaveBeenCalled();
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

  // ── Mid-batch connection failure handling ──────────────────────────────

  it('query returns partial results when mget fails mid-batch', async () => {
    // Opt in to partial-ok semantics — default is strict (throw on
    // any MGET sub-batch failure).
    const store = createRedisStore({ client: redis, prefix: 'test', partialOk: true });

    // Write enough entries to span multiple batches (>100)
    // We'll simulate this by directly manipulating the mock to have many IDs
    // and making mget fail on the second call
    const mockRedis = redis as unknown as {
      smembers: ReturnType<typeof vi.fn>;
      mget: ReturnType<typeof vi.fn>;
      _store: Map<string, string>;
      _sets: Map<string, Set<string>>;
    };

    // Create 150 entries directly in the store to span 2 batches
    const indexKey = 'test:default:__keys__';
    const keySet = new Set<string>();
    for (let i = 0; i < 150; i++) {
      const id = `entry_${i}`;
      const entry = {
        id,
        key: `key_${i}`,
        content: `content ${i}`,
        grade: 'useful',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis._store.set(`test:default:${id}`, JSON.stringify(entry));
      keySet.add(id);
    }
    mockRedis._sets.set(indexKey, keySet);

    // Make mget fail on the second call (simulating connection drop mid-batch)
    let mgetCallCount = 0;
    mockRedis.mget.mockImplementation(async (...keys: string[]) => {
      mgetCallCount++;
      if (mgetCallCount === 2) {
        throw new Error('Connection lost: ECONNRESET');
      }
      return keys.map((k: string) => mockRedis._store.get(k) ?? null);
    });

    // query should NOT throw — it should return partial results from successful batches
    const results = await store.query({});
    // First batch of 100 should succeed, second batch of 50 should fail gracefully
    expect(results.length).toBe(100);
  });

  it('query does not throw when mget fails on first batch', async () => {
    // Explicit opt-in to partial-ok semantics.
    const store = createRedisStore({ client: redis, prefix: 'test', partialOk: true });

    const mockRedis = redis as unknown as {
      smembers: ReturnType<typeof vi.fn>;
      mget: ReturnType<typeof vi.fn>;
      _store: Map<string, string>;
      _sets: Map<string, Set<string>>;
    };

    // Create 50 entries
    const indexKey = 'test:default:__keys__';
    const keySet = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = `entry_${i}`;
      const entry = {
        id,
        key: `key_${i}`,
        content: `content ${i}`,
        grade: 'useful',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis._store.set(`test:default:${id}`, JSON.stringify(entry));
      keySet.add(id);
    }
    mockRedis._sets.set(indexKey, keySet);

    // Make mget always fail
    mockRedis.mget.mockRejectedValue(new Error('Connection refused'));

    // Should return empty array, not throw
    const results = await store.query({});
    expect(results).toEqual([]);
  });

  // ── Optimistic locking on update ────────────────────────────────

  it('update uses WATCH/MULTI/EXEC for optimistic locking', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const mockRedis = redis as unknown as {
      watch: ReturnType<typeof vi.fn>;
      unwatch: ReturnType<typeof vi.fn>;
      multi: ReturnType<typeof vi.fn>;
    };

    const entry = await store.write({ key: 'k', content: 'original', grade: 'useful' });
    mockRedis.watch.mockClear();
    mockRedis.multi.mockClear();

    const updated = await store.update(entry.id, { content: 'modified' });

    expect(updated.content).toBe('modified');
    // WATCH must be called before the read-modify-write
    expect(mockRedis.watch).toHaveBeenCalledTimes(1);
    // The pipeline must be used for the write
    expect(mockRedis.multi).toHaveBeenCalledTimes(1);
  });

  it('update retries on WATCH conflict (exec returns null)', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const mockRedis = redis as unknown as {
      watch: ReturnType<typeof vi.fn>;
      multi: ReturnType<typeof vi.fn>;
    };

    const entry = await store.write({ key: 'k', content: 'original', grade: 'useful' });
    mockRedis.watch.mockClear();
    mockRedis.multi.mockClear();

    // Make exec return null (conflict) on first two attempts, succeed on third
    let execCallCount = 0;
    mockRedis.multi.mockImplementation(() => {
      const queue: (() => unknown)[] = [];
      const pipeline = {
        set: vi.fn((..._args: unknown[]) => {
          queue.push(() => 'OK');
          return pipeline;
        }),
        sadd: vi.fn((..._args: unknown[]) => {
          queue.push(() => 1);
          return pipeline;
        }),
        exec: vi.fn(async () => {
          execCallCount++;
          if (execCallCount <= 2) return null; // conflict
          const results: [null, unknown][] = [];
          for (const fn of queue) {
            results.push([null, fn()]);
          }
          return results;
        }),
      };
      return pipeline;
    });

    const updated = await store.update(entry.id, { content: 'retried' });
    expect(updated.content).toBe('retried');
    // 3 attempts total: 2 conflicts + 1 success
    expect(mockRedis.watch).toHaveBeenCalledTimes(3);
  });

  it('update throws after 3 failed retry attempts', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const mockRedis = redis as unknown as {
      watch: ReturnType<typeof vi.fn>;
      multi: ReturnType<typeof vi.fn>;
    };

    const entry = await store.write({ key: 'k', content: 'original', grade: 'useful' });
    mockRedis.watch.mockClear();
    mockRedis.multi.mockClear();

    // Make exec always return null (persistent conflict)
    mockRedis.multi.mockImplementation(() => {
      const pipeline = {
        set: vi.fn(() => pipeline),
        sadd: vi.fn(() => pipeline),
        exec: vi.fn(async () => null),
      };
      return pipeline;
    });

    await expect(store.update(entry.id, { content: 'fail' })).rejects.toThrow(
      'Concurrent update conflict after 3 retries',
    );
    // All 3 retries were attempted
    expect(mockRedis.watch).toHaveBeenCalledTimes(3);
  });

  it('update calls unwatch when entry not found during optimistic locking', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const mockRedis = redis as unknown as {
      watch: ReturnType<typeof vi.fn>;
      unwatch: ReturnType<typeof vi.fn>;
    };

    await expect(store.update('nonexistent', { content: 'x' })).rejects.toThrow('not found');
    expect(mockRedis.watch).toHaveBeenCalledTimes(1);
    expect(mockRedis.unwatch).toHaveBeenCalledTimes(1);
  });

  it('update does not crash when unwatch fails during "not found" path (H2)', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const mockRedis = redis as unknown as {
      watch: ReturnType<typeof vi.fn>;
      unwatch: ReturnType<typeof vi.fn>;
    };

    // Make unwatch throw an error (simulating connection drop after WATCH)
    mockRedis.unwatch.mockRejectedValue(new Error('ECONNRESET: unwatch failed'));

    // update() should still throw the "not found" error, not the unwatch error
    await expect(store.update('nonexistent', { content: 'x' })).rejects.toThrow('not found');
    // WATCH was called once, and unwatch was attempted (and failed) once
    expect(mockRedis.watch).toHaveBeenCalledTimes(1);
    expect(mockRedis.unwatch).toHaveBeenCalledTimes(1);
  });

  it('update does not crash when unwatch fails during corrupted entry path (H2)', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const mockRedis = redis as unknown as {
      watch: ReturnType<typeof vi.fn>;
      unwatch: ReturnType<typeof vi.fn>;
      _store: Map<string, string>;
      _sets: Map<string, Set<string>>;
    };

    // Write a valid entry, then corrupt it
    const entry = await store.write({ key: 'k', content: 'valid', grade: 'useful' });
    const key = `test:default:${entry.id}`;
    mockRedis._store.set(key, '{corrupt json!!!');

    // Make unwatch throw — the update should still surface the corruption error
    mockRedis.unwatch.mockRejectedValue(new Error('Connection lost'));

    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(store.update(entry.id, { content: 'x' })).rejects.toThrow('Corrupted');
    expect(mockRedis.unwatch).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('batch read failure includes structured metadata in logs (M6)', async () => {
    const warnFn = vi.fn();
    const customLogger = { warn: warnFn };
    // partial-ok preserves warn-and-continue semantics for this test.
    const store = createRedisStore({ client: redis, prefix: 'test', logger: customLogger, partialOk: true });

    const mockRedis = redis as unknown as {
      smembers: ReturnType<typeof vi.fn>;
      mget: ReturnType<typeof vi.fn>;
      _store: Map<string, string>;
      _sets: Map<string, Set<string>>;
    };

    // Create entries directly so they exist in the index
    const indexKey = 'test:default:__keys__';
    const keySet = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const id = `entry_${i}`;
      const entryData = {
        id,
        key: `key_${i}`,
        content: `content ${i}`,
        grade: 'useful',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis._store.set(`test:default:${id}`, JSON.stringify(entryData));
      keySet.add(id);
    }
    mockRedis._sets.set(indexKey, keySet);

    // Make mget fail with a specific error
    const batchError = new Error('ECONNRESET: Connection reset by peer');
    mockRedis.mget.mockRejectedValue(batchError);

    // query should return empty (all batches failed), not throw
    const results = await store.query({});
    expect(results).toEqual([]);

    // The custom logger should have been called with structured metadata
    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining('batch read failed'),
      expect.objectContaining({
        batchSize: 5,
        error: 'ECONNRESET: Connection reset by peer',
      }),
    );
  });

  it('compact handles mget failure mid-batch gracefully', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });

    const mockRedis = redis as unknown as {
      smembers: ReturnType<typeof vi.fn>;
      mget: ReturnType<typeof vi.fn>;
      _store: Map<string, string>;
      _sets: Map<string, Set<string>>;
      scard: ReturnType<typeof vi.fn>;
    };

    // Create 150 entries to span 2 batches
    const indexKey = 'test:default:__keys__';
    const keySet = new Set<string>();
    for (let i = 0; i < 150; i++) {
      const id = `entry_${i}`;
      const entry = {
        id,
        key: `key_${i}`,
        content: `content ${i}`,
        grade: 'ephemeral',
        createdAt: Date.now() - 200000, // old entries
        updatedAt: Date.now() - 200000,
      };
      mockRedis._store.set(`test:default:${id}`, JSON.stringify(entry));
      keySet.add(id);
    }
    mockRedis._sets.set(indexKey, keySet);

    // Make mget fail on the second call
    let mgetCallCount = 0;
    mockRedis.mget.mockImplementation(async (...keys: string[]) => {
      mgetCallCount++;
      if (mgetCallCount === 2) {
        throw new Error('Connection lost: ECONNRESET');
      }
      return keys.map((k: string) => mockRedis._store.get(k) ?? null);
    });

    // compact should NOT throw — it should work with entries from successful batches
    const result = await store.compact({ maxAge: 100000 });
    // Should have compacted entries from the first batch (100 entries)
    expect(result.removed).toBe(100);
  });

  // ── WATCH/UNWATCH transaction contract ───────────────────────────────────

  it('update() calls UNWATCH when the key is missing (error path)', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const mockRedis = redis as unknown as {
      unwatch: ReturnType<typeof vi.fn>;
    };
    await expect(store.update('missing-id', { content: 'x' })).rejects.toMatchObject({
      code: 'MEMORY_NOT_FOUND',
    });
    expect(mockRedis.unwatch).toHaveBeenCalled();
  });

  it('update() calls UNWATCH when parse fails (corruption path)', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const mockRedis = redis as unknown as {
      unwatch: ReturnType<typeof vi.fn>;
      _store: Map<string, string>;
      _sets: Map<string, Set<string>>;
    };
    // Seed a corrupt JSON payload
    mockRedis._store.set('test:default:bad', '{"not":"memory"}'); // parse-ok but shape-bad
    const indexKey = 'test:default:__keys__';
    const existing = mockRedis._sets.get(indexKey) ?? new Set<string>();
    existing.add('bad');
    mockRedis._sets.set(indexKey, existing);

    await expect(store.update('bad', { content: 'x' })).rejects.toMatchObject({
      code: 'MEMORY_CORRUPT',
    });
    expect(mockRedis.unwatch).toHaveBeenCalled();
  });

  it('update() calls UNWATCH when client.get throws', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const mockRedis = redis as unknown as {
      get: ReturnType<typeof vi.fn>;
      unwatch: ReturnType<typeof vi.fn>;
    };
    mockRedis.get.mockRejectedValueOnce(new Error('boom'));
    await expect(store.update('id', { content: 'x' })).rejects.toThrow('boom');
    expect(mockRedis.unwatch).toHaveBeenCalled();
  });

  it('update() uses WATCH -> GET -> MULTI -> EXEC with no intervening awaits between MULTI and EXEC', async () => {
    // Verify call ordering: for a successful update() the sequence must be
    // watch(key), get(key), multi(), <pipeline commands>, exec(). This is the
    // canonical optimistic-lock shape.
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const written = await store.write({ key: 'k', content: 'v', grade: 'useful' });

    const calls: string[] = [];
    const mockRedis = redis as unknown as {
      watch: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
      multi: ReturnType<typeof vi.fn>;
      unwatch: ReturnType<typeof vi.fn>;
    };
    mockRedis.watch.mockImplementationOnce(async () => { calls.push('watch'); return 'OK'; });
    const origGet = mockRedis.get.getMockImplementation();
    mockRedis.get.mockImplementationOnce(async (k: string) => {
      calls.push('get');
      return origGet ? await origGet(k) : null;
    });
    const origMulti = mockRedis.multi.getMockImplementation();
    mockRedis.multi.mockImplementationOnce(() => {
      calls.push('multi');
      const pipeline = origMulti!() as { exec: ReturnType<typeof vi.fn> };
      const origExec = pipeline.exec;
      pipeline.exec = vi.fn(async () => {
        calls.push('exec');
        return origExec();
      });
      return pipeline;
    });

    await store.update(written.id, { content: 'updated' });
    // Order: watch → get → multi → exec (no extra awaits interleaved).
    expect(calls).toEqual(['watch', 'get', 'multi', 'exec']);
  });

  it('query() throws HarnessError(MEMORY_CORRUPT) by default when mget fails', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    const mockRedis = redis as unknown as {
      mget: ReturnType<typeof vi.fn>;
      _store: Map<string, string>;
      _sets: Map<string, Set<string>>;
    };
    const indexKey = 'test:default:__keys__';
    const keySet = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const entry = {
        id: `id_${i}`, key: `k_${i}`, content: 'c', grade: 'useful',
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      mockRedis._store.set(`test:default:id_${i}`, JSON.stringify(entry));
      keySet.add(`id_${i}`);
    }
    mockRedis._sets.set(indexKey, keySet);
    mockRedis.mget.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(store.query({})).rejects.toMatchObject({
      code: 'MEMORY_CORRUPT',
    });
  });

  it('partialOk=true restores warn-and-continue behaviour', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test', partialOk: true });
    const mockRedis = redis as unknown as {
      mget: ReturnType<typeof vi.fn>;
      _store: Map<string, string>;
      _sets: Map<string, Set<string>>;
    };
    const indexKey = 'test:default:__keys__';
    const keySet = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const entry = {
        id: `id_${i}`, key: `k_${i}`, content: 'c', grade: 'useful',
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      mockRedis._store.set(`test:default:id_${i}`, JSON.stringify(entry));
      keySet.add(`id_${i}`);
    }
    mockRedis._sets.set(indexKey, keySet);
    mockRedis.mget.mockRejectedValueOnce(new Error('ECONNRESET'));

    const result = await store.query({});
    expect(result).toEqual([]);
  });

  it('createRedisStore() returns a RedisMemoryStore with repair()', async () => {
    const store = createRedisStore({ client: redis, prefix: 'test' });
    // Compile-time + runtime guard: `repair()` must be directly callable.
    expect(typeof store.repair).toBe('function');
    const res = await store.repair();
    expect(res).toEqual({ repaired: 0 });
  });
});

// ---------------------------------------------------------------------------
// MemoryStore conformance suite — run the core contract tests against the
// Redis-backed implementation so semantic divergence (tag semantics,
// pagination, delete semantics) can never silently regress.
// ---------------------------------------------------------------------------
import { runMemoryStoreConformance } from 'harness-one/memory';

runMemoryStoreConformance(
  {
    describe,
    it,
    expect: expect as unknown as Parameters<typeof runMemoryStoreConformance>[0]['expect'],
    beforeEach,
  },
  () => createRedisStore({ client: createMockRedis(), prefix: 'conf' }),
);
