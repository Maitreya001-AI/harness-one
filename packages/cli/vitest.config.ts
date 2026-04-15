import { defineConfig } from 'vitest/config';
import path from 'path';

const coreSrc = path.resolve(__dirname, '../core/src');

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Core barrel + subpaths the CLI references at runtime
      'harness-one/core': path.join(coreSrc, 'core/index.ts'),
      'harness-one': path.join(coreSrc, 'index.ts'),
    },
  },
});
