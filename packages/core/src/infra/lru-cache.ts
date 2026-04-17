/**
 * Generic LRU (Least Recently Used) cache backed by Map insertion-order semantics.
 *
 * Uses delete-then-re-set to move accessed entries to the end of the map,
 * so `keys().next()` always returns the oldest (least recently used) entry.
 *
 * All operations are O(1).
 *
 * ## When to use this vs. `observe/trace-lru-list`
 *
 * - **`LRUCache` (this file)**: generic key-→-value cache for any key type.
 *   Holds values. Use when callers look up by key and expect a value back
 *   (model pricing tables, session metadata caches, init-promise caches, etc.).
 * - **`TraceLruList` (`observe/trace-lru-list`)**: intrusive doubly-linked
 *   list of trace-id strings, with O(1) move-to-tail and O(1) pop-head. Holds
 *   no payload — callers keep values in a sibling `Map` and use the list only
 *   to pick the next eviction victim. Used by the trace-manager where one
 *   eviction must fan out to span-count and metadata bookkeeping in multiple
 *   side-tables.
 *
 * Rule of thumb: reach for `LRUCache` first. Only switch to `TraceLruList` if
 * you need eviction ordering decoupled from the value storage, or if eviction
 * must be driven by multiple touchpoints (add / access / resize) against a
 * shared side-table.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from './errors-base.js';

/**
 * Options accepted by {@link LRUCache}. Wave-15 added `onEvict` so callers
 * that maintain side-tables (the trace-manager's span count, for example)
 * can keep their accounting in lockstep with the cache's eviction without
 * reaching into private state.
 */
export interface LRUCacheOptions<K, V> {
  /** Fires synchronously for every key/value evicted from the cache. */
  onEvict?: (key: K, value: V) => void;
}

export class LRUCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(
    private readonly maxSize: number,
    options?: LRUCacheOptions<K, V>,
  ) {
    if (maxSize < 1) {
      // CQ-032: throw via HarnessError so wrappers can catch-by-.code
      // instead of string-matching the message.
      throw new HarnessError(
        'LRUCache maxSize must be >= 1',
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Use a value >= 1',
      );
    }
    if (options?.onEvict) this.onEvict = options.onEvict;
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
      const evictedKey = iter.value;
      const evictedValue = this.map.get(evictedKey) as V;
      this.map.delete(evictedKey);
      if (this.onEvict) {
        try { this.onEvict(evictedKey, evictedValue); } catch { /* never let an evict hook corrupt the cache */ }
      }
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

  /** Maximum capacity of the cache (fixed at construction time). */
  get capacity(): number {
    return this.maxSize;
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
