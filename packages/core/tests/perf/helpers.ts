/**
 * Small sampling / percentile helpers shared across bench cases.
 *
 * Rolling our own (instead of tinybench) because:
 *   1. Not every case fits a "function-run-N-times" loop — I2 is a single
 *      memory snapshot, I4 is a one-shot 10MB throughput measurement.
 *   2. We need exact control over warmup and the p-value list we report
 *      (tinybench 6 exposes p50/p75/p99 only; we publish p50/p95/p99).
 *
 * Deterministic by design: seed-driven RNG for every case that generates
 * input, never Math.random. That way two runs on the same machine produce
 * the same samples modulo pure timer noise.
 *
 * @module
 */

/** Percentile of a sorted samples array. `p` is in [0, 100]. */
export function percentile(sortedSamples: readonly number[], p: number): number {
  if (sortedSamples.length === 0) return 0;
  if (sortedSamples.length === 1) return sortedSamples[0];
  const rank = (p / 100) * (sortedSamples.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedSamples[lo];
  const w = rank - lo;
  return sortedSamples[lo] * (1 - w) + sortedSamples[hi] * w;
}

/**
 * Run `fn` `iterations` times, returning nanosecond latency samples sorted
 * ascending. A short warmup pass is done first so JIT noise does not
 * contaminate the first few iterations.
 *
 * When `fn` is async, the per-iteration await cost IS counted — callers
 * that want to measure only sync cost should use `sampleSync`.
 */
export async function sample(
  fn: () => Promise<void> | void,
  iterations: number,
  warmup: number = Math.min(50, Math.floor(iterations / 10)),
): Promise<number[]> {
  for (let i = 0; i < warmup; i++) {
    await fn();
  }
  const samples = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    const t1 = performance.now();
    // performance.now() returns ms with µs fractional resolution on V8;
    // convert to ns so percentile() and the public metric name agree.
    samples[i] = (t1 - t0) * 1_000_000;
  }
  samples.sort((a, b) => a - b);
  return samples;
}

/** Synchronous variant for cases that must not await inside the hot loop. */
export function sampleSync(
  fn: () => void,
  iterations: number,
  warmup: number = Math.min(50, Math.floor(iterations / 10)),
): number[] {
  for (let i = 0; i < warmup; i++) fn();
  const samples = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    const t1 = performance.now();
    samples[i] = (t1 - t0) * 1_000_000;
  }
  samples.sort((a, b) => a - b);
  return samples;
}

/**
 * Seeded LCG — good enough for benchmark inputs that should be
 * reproducible across runs on the same host. NOT for crypto use.
 *
 * Knuth's LCG parameters; we treat the 32-bit mantissa as our entropy.
 */
export function createRng(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Best-effort manual GC — requires Node with `--expose-gc`. */
export function forceGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') gc();
}

/** Current timestamp for emitted samples. */
export function nowIso(): string {
  return new Date().toISOString();
}
