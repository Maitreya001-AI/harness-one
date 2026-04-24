import { defineConfig } from 'vitest/config';

// Fuzz-test runner config. Kept separate from the main `vitest.config.ts`
// so that:
//   - `pnpm test` does NOT pick up `tests/fuzz/**` (slow, high numRuns).
//   - `pnpm fuzz` can run the fuzz-only suite without triggering the
//     coverage threshold on `src/**/*.ts` (fuzz targets exercise code paths
//     for survival, not coverage).
//
// Schedule: the `fuzz` workflow runs nightly + on demand
// (see `.github/workflows/fuzz.yml`).
export default defineConfig({
  test: {
    include: ['tests/fuzz/**/*.fuzz.test.ts'],
    // Fuzz seeds with high numRuns need more per-test headroom than the
    // default 5s. Each property-based assertion still has to stay cheap —
    // the budget is for pathological samples fast-check emits (very large
    // strings, deep nesting).
    testTimeout: 120_000,
    hookTimeout: 30_000,
    // Fuzz workflows print `seed: <n>` on failure so shrink output is
    // reproducible; disable the progress reporter so CI logs stay readable.
    reporters: ['default'],
  },
});
