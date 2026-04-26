import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/agent/index.ts',
    'cli/bin': 'src/cli/bin.ts',
    'tools/index': 'src/tools/index.ts',
    'guardrails/index': 'src/guardrails/index.ts',
    'config/index': 'src/config/index.ts',
  },
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  target: 'node22',
  sourcemap: true,
  treeshake: true,
  // Keep CLI bin readable on disk so users `cat $(which harness-coding)` and see real code.
  minify: false,
  // Ship the shebang on the CLI entry only.
  banner: ({ format }) => {
    if (format !== 'esm') return {};
    return { js: '' };
  },
  external: [
    'harness-one',
    '@harness-one/preset',
    '@harness-one/anthropic',
    '@anthropic-ai/sdk',
  ],
});
