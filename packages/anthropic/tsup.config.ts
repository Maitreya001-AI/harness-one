import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: true,
  target: 'node18',
  sourcemap: true,
  external: ['harness-one', '@anthropic-ai/sdk'],
});
