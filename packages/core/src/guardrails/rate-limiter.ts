/**
 * Sliding window rate limiter guardrail.
 *
 * @module
 */

import type { Guardrail, GuardrailContext } from './types.js';

/**
 * Create a rate limiter guardrail with sliding window and LRU key eviction.
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
}): { name: string; guard: Guardrail } {
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

    // Remove expired timestamps
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
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
