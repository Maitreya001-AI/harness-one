import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: true,
  target: 'node18',
  sourcemap: true,
  treeshake: true,
  minify: true,
  external: ['harness-one', 'ajv', 'ajv-formats'],
});
