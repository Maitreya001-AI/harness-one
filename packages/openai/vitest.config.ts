import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Include `tests/**` so the cassette-backed contract suite
    // (`tests/contract.test.ts`) is picked up alongside the unit
    // tests that live in `src/__tests__/`.
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
