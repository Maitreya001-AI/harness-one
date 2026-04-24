import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files live in two roots: `src/**/*.test.ts` for unit tests colocated
    // with the code under test, and `tests/**/*.test.ts` for higher-layer
    // scenarios that compose real subsystems. The latter covers
    // `tests/integration/` (Track D cross-subsystem invariants) and
    // `tests/chaos/` (scenario files that exercise the chaos adapter across
    // 50–200 runs per scenario and stay under the suite-wide 60s budget).
    // Both are documented in `docs/architecture/17-testing.md`.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
