import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scenario files under `tests/chaos/` exercise the chaos adapter across
    // 50–200 runs per scenario and stay under the suite-wide 60s budget
    // documented in `docs/architecture/17-testing.md`. Keeping them in the
    // default include so `pnpm test -- chaos` works without extra flags.
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
