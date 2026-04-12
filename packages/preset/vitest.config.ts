import { defineConfig } from 'vitest/config';
import path from 'path';

const coreSrc = path.resolve(__dirname, '../core/src');
const pkgs = path.resolve(__dirname, '..');

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
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
  resolve: {
    alias: {
      // Core sub-path exports
      'harness-one/core': path.join(coreSrc, 'core/index.ts'),
      'harness-one/observe': path.join(coreSrc, 'observe/index.ts'),
      'harness-one/prompt': path.join(coreSrc, 'prompt/index.ts'),
      'harness-one/tools': path.join(coreSrc, 'tools/index.ts'),
      'harness-one/guardrails': path.join(coreSrc, 'guardrails/index.ts'),
      'harness-one/context': path.join(coreSrc, 'context/index.ts'),
      'harness-one/session': path.join(coreSrc, 'session/index.ts'),
      'harness-one/memory': path.join(coreSrc, 'memory/index.ts'),
      'harness-one/eval': path.join(coreSrc, 'eval/index.ts'),
      'harness-one/evolve': path.join(coreSrc, 'evolve/index.ts'),
      // Integration packages
      '@harness-one/anthropic': path.join(pkgs, 'anthropic/src/index.ts'),
      '@harness-one/openai': path.join(pkgs, 'openai/src/index.ts'),
      '@harness-one/langfuse': path.join(pkgs, 'langfuse/src/index.ts'),
      '@harness-one/redis': path.join(pkgs, 'redis/src/index.ts'),
      '@harness-one/ajv': path.join(pkgs, 'ajv/src/index.ts'),
      '@harness-one/tiktoken': path.join(pkgs, 'tiktoken/src/index.ts'),
      '@harness-one/opentelemetry': path.join(pkgs, 'opentelemetry/src/index.ts'),
    },
  },
});
