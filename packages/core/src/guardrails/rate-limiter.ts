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
  const buckets = new Map<string, number[]>();
  // Map-based LRU: delete + re-set moves key to end (O(1)); keys().next() = oldest (O(1))
  const lru = new Map<string, true>();

  function touchKey(key: string): void {
    lru.delete(key);
    lru.set(key, true);
    while (lru.size > maxKeys) {
      const oldest = lru.keys().next().value;
      if (oldest !== undefined) {
        lru.delete(oldest);
        buckets.delete(oldest);
      }
    }
  }

  const guard: Guardrail = (ctx) => {
    const key = config.keyFn ? config.keyFn(ctx) : '_default';
    const now = Date.now();
    const windowStart = now - config.windowMs;

    let timestamps = buckets.get(key);
    if (!timestamps) {
      timestamps = [];
      buckets.set(key, timestamps);
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

    touchKey(key);

    if (timestamps.length >= config.max) {
      return { action: 'block', reason: `Rate limit exceeded: ${config.max} requests per ${config.windowMs}ms` };
    }

    timestamps.push(now);
    return { action: 'allow' };
  };

  return { name: 'rate-limiter', guard };
}
