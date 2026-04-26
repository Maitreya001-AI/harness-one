import path from 'node:path';
import { defineConfig } from 'vitest/config';

const coreSrc = path.resolve(__dirname, '../../packages/core/src');
const pkgs = path.resolve(__dirname, '../../packages');
const codingSrc = path.resolve(__dirname, '../coding-agent/src');

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // VS Code module replaced by an in-memory shim in tests/vscode-shim.ts
      vscode: path.resolve(__dirname, 'tests/vscode-shim.ts'),
      'harness-one-coding': path.join(codingSrc, 'agent/index.ts'),
      'harness-one/core': path.join(coreSrc, 'core/index.ts'),
      'harness-one/observe': path.join(coreSrc, 'observe/index.ts'),
      'harness-one/tools': path.join(coreSrc, 'tools/index.ts'),
      'harness-one/guardrails': path.join(coreSrc, 'guardrails/index.ts'),
      'harness-one/memory': path.join(coreSrc, 'memory/index.ts'),
      'harness-one/redact': path.join(coreSrc, 'redact/index.ts'),
      'harness-one/infra': path.join(coreSrc, 'infra/index.ts'),
      'harness-one/io': path.join(coreSrc, 'io/index.ts'),
      'harness-one': path.join(coreSrc, 'index.ts'),
      '@harness-one/preset': path.join(pkgs, 'preset/src/index.ts'),
      '@harness-one/anthropic': path.join(pkgs, 'anthropic/src/index.ts'),
    },
  },
});
