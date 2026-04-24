/**
 * J4 · Property: `LRUCache` holds the three size-bookkeeping invariants that
 * every downstream consumer depends on (session caches, pricing tables,
 * trace-id side-tables):
 *
 *   (a) `size` never exceeds `capacity`.
 *   (b) `onEvict` fires exactly once per eviction (capacity-driven or
 *       explicit `delete`) — the counter stays locked to the observed
 *       eviction count.
 *   (c) The most-recently touched key survives the next capacity-driven
 *       eviction. Formally: after every `set(k, _)` or `get(k)` that hits,
 *       `k` is not in the evict-log that results from the NEXT over-capacity
 *       `set`.
 *
 * Operations are driven by a simple op arbitrary (set / get / delete) so
 * the state space mixes hot paths with explicit removal.
 *
 * @module
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { LRUCache } from '../lru-cache.js';

const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

type Op =
  | { readonly kind: 'set'; readonly key: string; readonly value: number }
  | { readonly kind: 'get'; readonly key: string }
  | { readonly kind: 'delete'; readonly key: string };

const keyArb = fc.string({ minLength: 1, maxLength: 3 });

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant<'set'>('set'),
    key: keyArb,
    value: fc.integer(),
  }),
  fc.record({
    kind: fc.constant<'get'>('get'),
    key: keyArb,
  }),
  fc.record({
    kind: fc.constant<'delete'>('delete'),
    key: keyArb,
  }),
);

describe('J4 · LRUCache (property)', () => {
  it('size ≤ capacity at all times', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(opArb, { minLength: 0, maxLength: 80 }),
        (capacity, ops) => {
          const cache = new LRUCache<string, number>(capacity);
          for (const op of ops) {
            if (op.kind === 'set') cache.set(op.key, op.value);
            else if (op.kind === 'get') cache.get(op.key);
            else cache.delete(op.key);
            expect(cache.size).toBeLessThanOrEqual(capacity);
          }
        },
      ),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('onEvict count equals observed number of actual evictions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.array(opArb, { minLength: 0, maxLength: 80 }),
        (capacity, ops) => {
          const evictions: Array<[string, number]> = [];
          const cache = new LRUCache<string, number>(capacity, {
            onEvict: (k, v) => {
              evictions.push([k, v]);
            },
          });
          // Ground truth: count (capacity overflow evictions) + (successful
          // deletes). Overwrites of the same key do NOT fire onEvict per
          // the LRUCache contract.
          let expectedEvicts = 0;
          for (const op of ops) {
            if (op.kind === 'set') {
              const hadKey = cache.has(op.key);
              const willOverflow = !hadKey && cache.size + 1 > capacity;
              cache.set(op.key, op.value);
              if (willOverflow) expectedEvicts++;
            } else if (op.kind === 'get') {
              cache.get(op.key);
            } else {
              const deleted = cache.delete(op.key);
              if (deleted) expectedEvicts++;
            }
          }
          expect(evictions.length).toBe(expectedEvicts);
        },
      ),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('a key touched AFTER the cache is full survives the next capacity-driven eviction', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.array(opArb, { minLength: 0, maxLength: 60 }),
        fc.string({ minLength: 1, maxLength: 3 }),
        fc.integer(),
        (capacity, ops, touchKey, touchValue) => {
          const evictions: string[] = [];
          const cache = new LRUCache<string, number>(capacity, {
            onEvict: (k) => evictions.push(k),
          });
          for (const op of ops) {
            if (op.kind === 'set') cache.set(op.key, op.value);
            else if (op.kind === 'get') cache.get(op.key);
            else cache.delete(op.key);
          }
          // Fill to capacity with fresh keys (none equal touchKey).
          let filler = 0;
          while (cache.size < capacity) {
            const fillerKey = `__filler_${filler++}`;
            if (fillerKey === touchKey) continue;
            cache.set(fillerKey, filler);
          }
          // NOW touch the key so it lands at MRU.
          cache.set(touchKey, touchValue);
          const trailStart = evictions.length;
          // One more set with a fresh key forces a capacity-driven eviction.
          let extraKey = `__extra_${filler}`;
          while (extraKey === touchKey) extraKey = `__extra_${++filler}`;
          cache.set(extraKey, -1);
          const newEvictions = evictions.slice(trailStart);
          expect(cache.has(touchKey)).toBe(true);
          expect(newEvictions).not.toContain(touchKey);
        },
      ),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('re-setting an existing key does not fire onEvict', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.string({ minLength: 1, maxLength: 3 }),
        fc.integer(),
        fc.integer(),
        (capacity, key, v1, v2) => {
          let evictCount = 0;
          const cache = new LRUCache<string, number>(capacity, {
            onEvict: () => evictCount++,
          });
          cache.set(key, v1);
          cache.set(key, v2);
          expect(evictCount).toBe(0);
          expect(cache.get(key)).toBe(v2);
        },
      ),
      { numRuns: 100, ...(seed !== undefined && { seed }) },
    );
  });
});
