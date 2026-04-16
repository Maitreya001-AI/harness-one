/**
 * Generic LRU (Least Recently Used) cache backed by Map insertion-order semantics.
 *
 * Uses delete-then-re-set to move accessed entries to the end of the map,
 * so `keys().next()` always returns the oldest (least recently used) entry.
 *
 * All operations are O(1).
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from '../core/errors.js';

export class LRUCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxSize: number) {
    if (maxSize < 1) {
      // CQ-032: throw via HarnessError so wrappers can catch-by-.code
      // instead of string-matching the message.
      throw new HarnessError(
        'LRUCache maxSize must be >= 1',
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Use a value >= 1',
      );
    }
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) {
      return undefined;
    }
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    // If key already exists, delete first so re-set moves it to end
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    // Evict oldest if over capacity
    while (this.map.size > this.maxSize) {
      const iter = this.map.keys().next();
      if (iter.done) break; // Safety: map unexpectedly empty
      this.map.delete(iter.value);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map[Symbol.iterator]();
  }
}
