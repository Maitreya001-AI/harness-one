import { defineConfig } from 'vitest/config';
import path from 'path';

const coreSrc = path.resolve(__dirname, '../core/src');

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Devkit imports `HarnessError` from `harness-one` root barrel and
      // occasionally from core subpaths.
      'harness-one/core': path.join(coreSrc, 'core/index.ts'),
      'harness-one': path.join(coreSrc, 'index.ts'),
    },
  },
});
