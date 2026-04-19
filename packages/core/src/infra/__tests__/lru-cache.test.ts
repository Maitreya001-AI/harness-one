import { describe, it, expect } from 'vitest';
import { LRUCache } from '../lru-cache.js';
import { HarnessError, HarnessErrorCode} from '../../core/errors.js';

describe('LRUCache', () => {
  describe('constructor', () => {
    it('creates a cache with the given max size', () => {
      const cache = new LRUCache<string, number>(5);
      expect(cache.size).toBe(0);
    });

    it('throws if maxSize is less than 1', () => {
      expect(() => new LRUCache<string, number>(0)).toThrow('maxSize must be >= 1');
      expect(() => new LRUCache<string, number>(-1)).toThrow('maxSize must be >= 1');
    });

    it('throws HarnessError with INVALID_CONFIG code when maxSize < 1', () => {
      try {
        new LRUCache<string, number>(0);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
        expect((err as HarnessError).suggestion).toBe('Use a value >= 1');
      }
    });
  });

  describe('set and get', () => {
    it('stores and retrieves values', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
    });

    it('returns undefined for missing keys', () => {
      const cache = new LRUCache<string, number>(3);
      expect(cache.get('missing')).toBeUndefined();
    });

    it('overwrites existing values', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('a', 99);
      expect(cache.get('a')).toBe(99);
      expect(cache.size).toBe(1);
    });
  });

  describe('LRU eviction', () => {
    it('evicts the oldest entry when capacity is exceeded', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3); // evicts 'a'
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
      expect(cache.size).toBe(2);
    });

    it('get() promotes entry to most recently used', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.get('a'); // promote 'a' to most recent
      cache.set('c', 3); // should evict 'b' (oldest), not 'a'
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe(3);
    });

    it('set() on existing key promotes it to most recently used', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('a', 10); // promote 'a' to most recent
      cache.set('c', 3); // should evict 'b' (oldest)
      expect(cache.get('a')).toBe(10);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe(3);
    });

    it('evicts multiple entries in sequence', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3); // evicts 'a'
      cache.set('d', 4); // evicts 'b'
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(true);
      expect(cache.has('d')).toBe(true);
    });

    it('handles maxSize of 1', () => {
      const cache = new LRUCache<string, number>(1);
      cache.set('a', 1);
      expect(cache.get('a')).toBe(1);
      cache.set('b', 2);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(cache.size).toBe(1);
    });
  });

  describe('delete', () => {
    it('removes an existing entry and returns true', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      expect(cache.delete('a')).toBe(true);
      expect(cache.has('a')).toBe(false);
      expect(cache.size).toBe(0);
    });

    it('returns false for non-existent key', () => {
      const cache = new LRUCache<string, number>(3);
      expect(cache.delete('missing')).toBe(false);
    });
  });

  describe('has', () => {
    it('returns true for existing key', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      expect(cache.has('a')).toBe(true);
    });

    it('returns false for missing key', () => {
      const cache = new LRUCache<string, number>(3);
      expect(cache.has('missing')).toBe(false);
    });

    it('returns false after key is evicted', () => {
      const cache = new LRUCache<string, number>(1);
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.has('a')).toBe(false);
    });
  });

  describe('size', () => {
    it('returns 0 for empty cache', () => {
      const cache = new LRUCache<string, number>(5);
      expect(cache.size).toBe(0);
    });

    it('increases with entries', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      expect(cache.size).toBe(1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
    });

    it('does not exceed maxSize', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.size).toBe(2);
    });

    it('decreases after delete', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.delete('a');
      expect(cache.size).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBeUndefined();
    });
  });

  describe('iterators', () => {
    it('keys() returns all keys in insertion order (oldest first)', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect([...cache.keys()]).toEqual(['a', 'b', 'c']);
    });

    it('keys().next() returns the oldest entry', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.keys().next().value).toBe('a');
    });

    it('values() returns all values in insertion order', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect([...cache.values()]).toEqual([1, 2, 3]);
    });

    it('entries() returns all key-value pairs in insertion order', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      expect([...cache.entries()]).toEqual([['a', 1], ['b', 2]]);
    });

    it('Symbol.iterator works with for-of', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('x', 10);
      cache.set('y', 20);
      const collected: [string, number][] = [];
      for (const entry of cache) {
        collected.push(entry);
      }
      expect(collected).toEqual([['x', 10], ['y', 20]]);
    });

    it('iterator reflects LRU order after get()', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.get('a'); // promote 'a' to end
      expect([...cache.keys()]).toEqual(['b', 'c', 'a']);
    });
  });

  describe('type support', () => {
    it('works with number keys', () => {
      const cache = new LRUCache<number, string>(3);
      cache.set(1, 'one');
      cache.set(2, 'two');
      expect(cache.get(1)).toBe('one');
    });

    it('works with object values', () => {
      const cache = new LRUCache<string, { name: string }>(3);
      const obj = { name: 'test' };
      cache.set('key', obj);
      expect(cache.get('key')).toBe(obj);
    });
  });

  describe('stress test', () => {
    it('handles rapid set/get cycles without exceeding capacity', () => {
      const cache = new LRUCache<number, number>(100);
      for (let i = 0; i < 10_000; i++) {
        cache.set(i, i * 2);
      }
      expect(cache.size).toBe(100);
      // Only the last 100 entries should remain
      for (let i = 9900; i < 10_000; i++) {
        expect(cache.get(i)).toBe(i * 2);
      }
      // Earlier entries should be evicted
      expect(cache.get(0)).toBeUndefined();
      expect(cache.get(9899)).toBeUndefined();
    });
  });

  // Property-style invariants for the LRU cache. Uses a
  // deterministic seeded PRNG (mulberry32) rather than fast-check because
  // fast-check is not a project dependency.
  describe('LRU cache invariants (property tests)', () => {
    function mulberry32(seed: number): () => number {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    it('size never exceeds maxSize after any sequence of set/get/delete', () => {
      const rng = mulberry32(0xABCDEF);
      // Run several independent scenarios with varying maxSize.
      for (let scenario = 0; scenario < 20; scenario++) {
        const maxSize = Math.floor(rng() * 20) + 1; // [1, 20]
        const cache = new LRUCache<number, number>(maxSize);
        const ops = 500;
        for (let i = 0; i < ops; i++) {
          const op = Math.floor(rng() * 3);
          const key = Math.floor(rng() * (maxSize * 3)); // allow key overlap
          if (op === 0) {
            cache.set(key, i);
          } else if (op === 1) {
            cache.get(key);
          } else {
            cache.delete(key);
          }
          // Invariant: size is always bounded by maxSize.
          expect(cache.size).toBeLessThanOrEqual(maxSize);
          // Size must also match the keys iterator length (no internal drift).
          expect([...cache.keys()].length).toBe(cache.size);
        }
      }
    });

    it('re-setting an existing key promotes it to MRU position', () => {
      const rng = mulberry32(0x12345);
      // Fill cache to capacity with distinct keys, pick a non-MRU key, re-set
      // it with a new value, and confirm: (a) the value updated, (b) the key
      // now appears last in iteration order (MRU), and (c) adding one more
      // key evicts the NEW oldest (not the re-promoted key).
      for (let scenario = 0; scenario < 50; scenario++) {
        const maxSize = Math.floor(rng() * 8) + 3; // [3, 10]
        const cache = new LRUCache<string, number>(maxSize);
        // Fill with keys k0..k{maxSize-1}.
        for (let i = 0; i < maxSize; i++) cache.set(`k${i}`, i);
        // Pick any non-MRU key — one of k0..k{maxSize-2}.
        const promoteIdx = Math.floor(rng() * (maxSize - 1));
        const promoteKey = `k${promoteIdx}`;
        cache.set(promoteKey, 999);

        // (a) value updated.
        expect(cache.get(promoteKey)).toBe(999);

        // `get` also promotes — to test the MRU property of set specifically,
        // we need to re-promote + re-check via keys().
        cache.set(promoteKey, 999);
        const keys = [...cache.keys()];
        // (b) promoteKey is at the tail of the keys iterator (MRU).
        expect(keys[keys.length - 1]).toBe(promoteKey);

        // (c) Add a new key — the new oldest should be evicted, not promoteKey.
        cache.set('new', 0);
        expect(cache.has(promoteKey)).toBe(true);
        expect(cache.has('new')).toBe(true);
      }
    });

    it('cache contents after randomized operations match a reference map of last-seen values bounded by maxSize', () => {
      // A weaker correctness property: after a sequence of `set`s only, every
      // key present in the cache must map to its most-recently-set value.
      const rng = mulberry32(0xDEADBEEF);
      const maxSize = 10;
      const cache = new LRUCache<number, number>(maxSize);
      const expected = new Map<number, number>();
      for (let i = 0; i < 1000; i++) {
        const key = Math.floor(rng() * 25);
        const val = i;
        cache.set(key, val);
        expected.set(key, val);
      }
      // Snapshot the keys first — calling `cache.get()` inside the loop would
      // mutate iteration order (LRU promotion does delete-then-set on the
      // backing Map), which causes the live iterator to revisit promoted keys
      // indefinitely. Materializing to an array severs that hazard.
      const snapshot = [...cache.keys()];
      for (const k of snapshot) {
        expect(cache.get(k)).toBe(expected.get(k));
      }
      expect(cache.size).toBeLessThanOrEqual(maxSize);
    });
  });

  describe('onEvict callback (unified across set/delete/clear)', () => {
    it('fires onEvict exactly once for each capacity-driven eviction', () => {
      const evicted: Array<[string, number]> = [];
      const cache = new LRUCache<string, number>(2, {
        onEvict: (k, v) => {
          evicted.push([k, v]);
        },
      });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3); // evicts 'a'
      cache.set('d', 4); // evicts 'b'
      expect(evicted).toEqual([
        ['a', 1],
        ['b', 2],
      ]);
    });

    it('does NOT fire onEvict when set() overwrites a live key', () => {
      const evicted: Array<[string, number]> = [];
      const cache = new LRUCache<string, number>(3, {
        onEvict: (k, v) => {
          evicted.push([k, v]);
        },
      });
      cache.set('a', 1);
      cache.set('a', 2); // overwrite — not an eviction
      cache.set('a', 3);
      expect(evicted).toEqual([]);
      expect(cache.get('a')).toBe(3);
    });

    it('fires onEvict when delete() removes a live key', () => {
      const evicted: Array<[string, number]> = [];
      const cache = new LRUCache<string, number>(5, {
        onEvict: (k, v) => {
          evicted.push([k, v]);
        },
      });
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.delete('a')).toBe(true);
      expect(cache.delete('missing')).toBe(false);
      expect(evicted).toEqual([['a', 1]]);
    });

    it('fires onEvict for every entry when clear() drains the cache', () => {
      const evicted: Array<[string, number]> = [];
      const cache = new LRUCache<string, number>(5, {
        onEvict: (k, v) => {
          evicted.push([k, v]);
        },
      });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(evicted.sort()).toEqual([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]);
    });

    it('clear() on an empty cache does not fire onEvict', () => {
      const evicted: Array<[string, number]> = [];
      const cache = new LRUCache<string, number>(5, {
        onEvict: (k, v) => {
          evicted.push([k, v]);
        },
      });
      cache.clear();
      expect(evicted).toEqual([]);
    });

    it('swallows hook errors so cache invariants hold', () => {
      const cache = new LRUCache<string, number>(1, {
        onEvict: () => {
          throw new Error('hook boom');
        },
      });
      // Capacity 1 — the second set must succeed and evict the first despite
      // the hook throwing.
      cache.set('a', 1);
      expect(() => cache.set('b', 2)).not.toThrow();
      expect(cache.size).toBe(1);
      expect(cache.get('b')).toBe(2);
      expect(cache.get('a')).toBeUndefined();
      // delete + clear likewise tolerate hook failures.
      expect(() => cache.delete('b')).not.toThrow();
      cache.set('c', 3);
      expect(() => cache.clear()).not.toThrow();
      expect(cache.size).toBe(0);
    });

    it('clear() snapshots entries before firing hooks (re-entrant set is safe)', () => {
      // If a hook re-inserts into the cache, those new entries must survive
      // because the snapshot was taken before clear() emptied the map.
      const ref: { cache: LRUCache<string, number> | null } = { cache: null };
      const evictedKeys: string[] = [];
      ref.cache = new LRUCache<string, number>(5, {
        onEvict: (k) => {
          evictedKeys.push(k);
          if (k === 'a') ref.cache!.set('reinserted', 99);
        },
      });
      ref.cache.set('a', 1);
      ref.cache.set('b', 2);
      ref.cache.clear();
      expect(evictedKeys.sort()).toEqual(['a', 'b']);
      // The reinsert happened DURING clear() — its key survives because clear
      // snapshot-then-cleared-then-fired-hooks.
      expect(ref.cache.get('reinserted')).toBe(99);
    });
  });
});
