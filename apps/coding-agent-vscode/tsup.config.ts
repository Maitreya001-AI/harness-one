import { defineConfig } from 'tsup';

// VS Code extensions are CommonJS Node bundles loaded by the editor host.
// The `vscode` module is provided by the host at runtime — never bundle it.
//
// We force the output extension to `.js` because VS Code resolves `main`
// using legacy CommonJS rules and refuses `.cjs` even though tsup defaults
// to it for ESM-typed packages.
export default defineConfig({
  entry: { extension: 'src/extension.ts' },
  format: ['cjs'],
  dts: false,
  outDir: 'dist',
  clean: true,
  target: 'node18',
  sourcemap: true,
  minify: false,
  external: ['vscode'],
  outExtension: () => ({ js: '.js' }),
});
