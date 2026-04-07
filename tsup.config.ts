import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      'core/index': 'src/core/index.ts',
      'context/index': 'src/context/index.ts',
      'tools/index': 'src/tools/index.ts',
      'guardrails/index': 'src/guardrails/index.ts',
    },
    format: ['esm'],
    dts: true,
    outDir: 'dist',
    clean: true,
    splitting: false,
    treeshake: true,
    target: 'node18',
    sourcemap: true,
  },
  {
    entry: {
      'core/index': 'src/core/index.ts',
      'context/index': 'src/context/index.ts',
      'tools/index': 'src/tools/index.ts',
      'guardrails/index': 'src/guardrails/index.ts',
    },
    format: ['cjs'],
    outDir: 'dist/cjs',
    outExtension: () => ({ js: '.cjs' }),
    splitting: false,
    target: 'node18',
    sourcemap: true,
  },
]);
