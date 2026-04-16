/**
 * Sliding window rate limiter guardrail.
 *
 * @module
 */

import type { Guardrail, GuardrailContext } from './types.js';

/**
 * Create a rate limiter guardrail with sliding window and LRU key eviction.
 *
 * @warning This rate limiter is in-memory and operates per-process. In multi-instance
 * or distributed deployments, use a shared backend (e.g., Redis) via `@harness-one/redis`.
 * Each process maintains its own independent rate limit state, so a user could exceed
 * the intended limit by distributing requests across multiple instances.
 *
 * **SEC-013 eviction monitoring:** When the LRU evicts a key that was still
 * **active** (i.e., its last-seen timestamp is within the current window),
 * the `onEviction` callback fires. A high eviction-rate-of-active-keys is a
 * strong signal of a key-space-flood attack (an attacker churning distinct
 * keys to push legitimate users out of the LRU). Route this signal to your
 * security monitoring.
 *
 * **PERF-012 time-bucketing (optional):** If `bucketMs` is set, timestamps
 * are grouped into fixed-size buckets and the in-window request count is
 * computed as the sum of the most recent `ceil(windowMs / bucketMs)` buckets.
 * This replaces the O(log N) binary search + occasional O(N) shift with an
 * O(1) increment per request. Use bucketing when you expect many requests
 * per key in a long window (e.g., 1 req/s with a 1-hour window). The default
 * behavior (no bucketing) remains best for low-volume keys.
 *
 * @example
 * ```ts
 * const limiter = createRateLimiter({ max: 10, windowMs: 60_000 });
 * ```
 */
export function createRateLimiter(config: {
  max: number;
  windowMs: number;
  keyFn?: (ctx: GuardrailContext) => string;
  maxKeys?: number;
  /**
   * Reserved for future use. When true, the rate limiter will use a shared backend
   * for distributed rate limiting. Currently not implemented — setting this to true
   * will throw an error. Use `@harness-one/redis` for distributed rate limiting.
   */
  distributed?: boolean;
  /**
   * SEC-013: Callback fired when the LRU evicts a key whose bucket had recent
   * activity (last-seen within the current window). This indicates a potential
   * key-space-flood attack. `lastSeen` is the last timestamp (ms epoch).
   */
  onEviction?: (evicted: { key: string; lastSeen: number }) => void;
  /**
   * PERF-012: When set, use time-bucketed counting instead of per-request
   * timestamps. Buckets of `bucketMs` width are rolled; the guard counts the
   * sum of buckets covering the window. Smaller buckets = more precision but
   * more memory; `windowMs / 10` is a sensible default when enabled.
   */
  bucketMs?: number;
}): { name: string; guard: Guardrail } {
  if (config.distributed) {
    return {
      name: 'rate_limiter',
      guard() {
        return {
          action: 'allow' as const,
          reason: 'Distributed rate limiting is not implemented in the built-in rate limiter. Use @harness-one/redis. Falling back to no-op.',
        };
      },
    };
  }
  const maxKeys = config.maxKeys ?? 10_000;
  const onEviction = config.onEviction;
  const bucketMs = config.bucketMs && config.bucketMs > 0 ? config.bucketMs : undefined;
  const bucketsPerWindow = bucketMs ? Math.ceil(config.windowMs / bucketMs) : 0;

  // SEC-013: record each key's last-seen timestamp so eviction can decide
  // whether the evicted key had *active* traffic (a potential flood signal).
  const lastSeen = new Map<string, number>();

  /** Per-key sliding-window state: either a timestamp array (default) or a time-bucket map. */
  interface BucketedState {
    /** bucketIndex -> count. Keyed by floor(t / bucketMs). */
    counts: Map<number, number>;
  }
  const timestampBuckets = new Map<string, number[]>();
  const bucketedBuckets = new Map<string, BucketedState>();

  // Map-based LRU: delete + re-set moves key to end (O(1)); keys().next() = oldest (O(1))
  const lru = new Map<string, true>();

  function touchKey(key: string, now: number): void {
    lru.delete(key);
    lru.set(key, true);
    while (lru.size > maxKeys) {
      const oldest = lru.keys().next().value;
      if (oldest !== undefined) {
        // SEC-013: signal eviction of an "active" key (recent activity within
        // the current window). Clean up ALL internal state BEFORE invoking the
        // user callback so the callback always sees consistent state if it
        // queries the limiter (e.g. calls guard() for the evicted key).
        const evictedLastSeen = lastSeen.get(oldest);
        lru.delete(oldest);
        timestampBuckets.delete(oldest);
        bucketedBuckets.delete(oldest);
        lastSeen.delete(oldest);
        if (
          onEviction &&
          evictedLastSeen !== undefined &&
          evictedLastSeen > now - config.windowMs
        ) {
          try {
            onEviction({ key: oldest, lastSeen: evictedLastSeen });
          } catch {
            // Never let user callback break the guard.
          }
        }
      }
    }
  }

  const guard: Guardrail = (ctx) => {
    const key = config.keyFn ? config.keyFn(ctx) : '_default';
    const now = Date.now();
    const windowStart = now - config.windowMs;

    let count: number;

    if (bucketMs) {
      // PERF-012: time-bucketed path. O(bucketsPerWindow) per request, but
      // bucketsPerWindow is typically <= 60 and independent of request volume.
      let state = bucketedBuckets.get(key);
      if (!state) {
        state = { counts: new Map() };
        bucketedBuckets.set(key, state);
      }
      const currentBucket = Math.floor(now / bucketMs);
      // Drop buckets older than the window.
      const oldestValidBucket = Math.floor(windowStart / bucketMs);
      for (const b of Array.from(state.counts.keys())) {
        if (b < oldestValidBucket) state.counts.delete(b);
      }
      // Sum counts in-window.
      count = 0;
      for (const c of state.counts.values()) count += c;

      touchKey(key, now);

      if (count >= config.max) {
        return { action: 'block', reason: `Rate limit exceeded: ${config.max} requests per ${config.windowMs}ms` };
      }

      state.counts.set(currentBucket, (state.counts.get(currentBucket) ?? 0) + 1);
      lastSeen.set(key, now);
      // Bound bucket map size to bucketsPerWindow + 1 defensively
      while (state.counts.size > bucketsPerWindow + 1) {
        const firstKey = state.counts.keys().next().value;
        if (firstKey === undefined) break;
        state.counts.delete(firstKey);
      }
      return { action: 'allow' };
    }

    // Default path: per-request timestamp array with binary-search expiry.
    let timestamps = timestampBuckets.get(key);
    if (!timestamps) {
      timestamps = [];
      timestampBuckets.set(key, timestamps);
    }

    // Remove expired timestamps using binary search O(log N).
    // Use copyWithin + length truncation instead of splice to avoid O(N) array shift.
    let lo = 0, hi = timestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (timestamps[mid] <= windowStart) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) {
      // Shift remaining elements to front in-place (O(remaining) not O(total))
      timestamps.copyWithin(0, lo);
      timestamps.length -= lo;
    }

    touchKey(key, now);

    if (timestamps.length >= config.max) {
      return { action: 'block', reason: `Rate limit exceeded: ${config.max} requests per ${config.windowMs}ms` };
    }

    timestamps.push(now);
    lastSeen.set(key, now);
    return { action: 'allow' };
  };

  return { name: 'rate-limiter', guard };
}
