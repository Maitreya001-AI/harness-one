/**
 * Seeded PRNG for chaos tests.
 *
 * Uses a mulberry32 generator — 32-bit state, uniform over [0, 1),
 * period 2^32, deterministic given the seed. Chaos scenarios drive
 * every fault-injection decision through this PRNG so runs are bit-for-bit
 * reproducible across machines and node versions. `Math.random` is
 * intentionally NOT used anywhere in the chaos layer.
 *
 * @module
 */

/** Seeded random number generator. `next()` returns a float in [0, 1). */
export interface SeededRng {
  /** Returns a float in [0, 1). */
  next(): number;
  /** Returns true with probability `p` (0..1). */
  chance(p: number): boolean;
  /** Current internal state — useful for assertions / debugging. */
  readonly seed: number;
}

/**
 * Create a mulberry32 PRNG seeded with `seed`. Zero and negative seeds are
 * coerced to 1 so the generator never degenerates. The generator is
 * synchronous and deterministic.
 */
export function createSeededRng(seed: number): SeededRng {
  let state = seed | 0;
  if (state <= 0) state = 1;
  const originalSeed = state;

  function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    chance(p: number): boolean {
      if (p <= 0) return false;
      if (p >= 1) return true;
      return next() < p;
    },
    seed: originalSeed,
  };
}
