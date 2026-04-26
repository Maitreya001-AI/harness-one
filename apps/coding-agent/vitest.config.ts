import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Resolve harness-one subpath imports to source so tests don't need a prior
// build step — mirrors the pattern used in apps/dogfood + packages/preset.
const coreSrc = path.resolve(__dirname, '../../packages/core/src');
const pkgs = path.resolve(__dirname, '../../packages');

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/cli/bin.ts',
        'src/index.ts',
        'src/**/index.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 80,
        statements: 90,
      },
    },
  },
  resolve: {
    alias: {
      'harness-one/core': path.join(coreSrc, 'core/index.ts'),
      'harness-one/advanced': path.join(coreSrc, 'advanced/index.ts'),
      'harness-one/observe': path.join(coreSrc, 'observe/index.ts'),
      'harness-one/prompt': path.join(coreSrc, 'prompt/index.ts'),
      'harness-one/tools': path.join(coreSrc, 'tools/index.ts'),
      'harness-one/guardrails': path.join(coreSrc, 'guardrails/index.ts'),
      'harness-one/context': path.join(coreSrc, 'context/index.ts'),
      'harness-one/session': path.join(coreSrc, 'session/index.ts'),
      'harness-one/memory': path.join(coreSrc, 'memory/index.ts'),
      'harness-one/rag': path.join(coreSrc, 'rag/index.ts'),
      'harness-one/redact': path.join(coreSrc, 'redact/index.ts'),
      'harness-one/infra': path.join(coreSrc, 'infra/index.ts'),
      'harness-one/orchestration': path.join(coreSrc, 'orchestration/index.ts'),
      'harness-one/evolve-check': path.join(coreSrc, 'evolve-check/index.ts'),
      'harness-one': path.join(coreSrc, 'index.ts'),
      '@harness-one/preset': path.join(pkgs, 'preset/src/index.ts'),
      '@harness-one/anthropic': path.join(pkgs, 'anthropic/src/index.ts'),
      '@harness-one/openai': path.join(pkgs, 'openai/src/index.ts'),
      '@harness-one/ajv': path.join(pkgs, 'ajv/src/index.ts'),
      '@harness-one/langfuse': path.join(pkgs, 'langfuse/src/index.ts'),
      '@harness-one/redis': path.join(pkgs, 'redis/src/index.ts'),
      '@harness-one/tiktoken': path.join(pkgs, 'tiktoken/src/index.ts'),
      '@harness-one/opentelemetry': path.join(pkgs, 'opentelemetry/src/index.ts'),
      '@harness-one/devkit': path.join(pkgs, 'devkit/src/index.ts'),
    },
  },
});
