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
 * Options accepted by {@link LRUCache}.
 */
export interface LRUCacheOptions<K, V> {
  /**
   * Fires synchronously for every key/value removed from the cache —
   * capacity-driven eviction, explicit `delete(key)`, and `clear()`
   * all route through the hook so side-table accounting stays in
   * lockstep regardless of which API removed the entry.
   *
   * Thrown errors from the hook are caught and swallowed to protect
   * cache invariants (the cache never half-evicts on a hook failure).
   */
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
    // A re-set is not an eviction — overwriting a live entry must NOT fire
    // onEvict, otherwise side-tables would double-count. Drop-and-reinsert
    // only to move the entry to the tail for LRU ordering.
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
      this.fireEvict(evictedKey, evictedValue);
    }
  }

  delete(key: K): boolean {
    // Explicit deletes fire onEvict so callers that maintain side-tables
    // don't need to special-case the "I removed it myself" path.
    if (!this.map.has(key)) return false;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.fireEvict(key, value);
    return true;
  }

  /** Invoke the user-supplied onEvict hook, swallowing any errors. */
  private fireEvict(key: K, value: V): void {
    if (!this.onEvict) return;
    try {
      this.onEvict(key, value);
    } catch {
      /* never let an evict hook corrupt the cache */
    }
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
    // Mirror delete() — fire onEvict for every entry before clearing so
    // side-table accounting (trace-manager span counts, cost-tracker
    // per-key totals, etc.) stays consistent regardless of how the cache
    // was drained.
    if (this.onEvict && this.map.size > 0) {
      // Snapshot first so a hook that mutates the cache cannot affect the
      // iteration we are driving.
      const snapshot = Array.from(this.map.entries());
      this.map.clear();
      for (const [key, value] of snapshot) {
        this.fireEvict(key, value);
      }
      return;
    }
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
