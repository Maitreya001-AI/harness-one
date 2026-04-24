import { defineConfig } from 'tsup';

// `harness-one/testing` imports `describe` / `it` / `expect` from `vitest`
// inside the contract-suite factory. vitest is never pulled into a
// production bundle because this subpath is test-only (consumers install
// vitest themselves as a devDep); we just need tsup to leave the import
// alone instead of trying to resolve and bundle it.
const sharedExternal = ['vitest'] as const;

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'core/index': 'src/core/index.ts',
      'advanced/index': 'src/advanced/index.ts',
      'context/index': 'src/context/index.ts',
      'tools/index': 'src/tools/index.ts',
      'guardrails/index': 'src/guardrails/index.ts',
      'prompt/index': 'src/prompt/index.ts',
      'observe/index': 'src/observe/index.ts',
      'session/index': 'src/session/index.ts',
      'memory/index': 'src/memory/index.ts',
      'rag/index': 'src/rag/index.ts',
      'orchestration/index': 'src/orchestration/index.ts',
      'evolve-check/index': 'src/evolve-check/index.ts',
      'redact/index': 'src/redact/index.ts',
      'infra/index': 'src/infra/index.ts',
      'testing/index': 'src/testing/index.ts',
    },
    format: ['esm'],
    dts: true,
    outDir: 'dist',
    clean: true,
    splitting: true,
    treeshake: true,
    minify: true,
    target: 'node18',
    sourcemap: true,
    external: [...sharedExternal],
  },
  {
    entry: {
      index: 'src/index.ts',
      'core/index': 'src/core/index.ts',
      'advanced/index': 'src/advanced/index.ts',
      'context/index': 'src/context/index.ts',
      'tools/index': 'src/tools/index.ts',
      'guardrails/index': 'src/guardrails/index.ts',
      'prompt/index': 'src/prompt/index.ts',
      'observe/index': 'src/observe/index.ts',
      'session/index': 'src/session/index.ts',
      'memory/index': 'src/memory/index.ts',
      'rag/index': 'src/rag/index.ts',
      'orchestration/index': 'src/orchestration/index.ts',
      'evolve-check/index': 'src/evolve-check/index.ts',
      'redact/index': 'src/redact/index.ts',
      'infra/index': 'src/infra/index.ts',
      'testing/index': 'src/testing/index.ts',
    },
    format: ['cjs'],
    outDir: 'dist/cjs',
    outExtension: () => ({ js: '.cjs' }),
    splitting: true,
    treeshake: true,
    minify: true,
    target: 'node18',
    sourcemap: true,
    external: [...sharedExternal],
  },
]);
