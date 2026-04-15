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

    it('CQ-032: throws HarnessError with INVALID_CONFIG code when maxSize < 1', () => {
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
});
