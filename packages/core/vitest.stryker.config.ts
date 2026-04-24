import { defineConfig } from 'vitest/config';

// Dedicated vitest config for Stryker runs. The default vitest.config.ts
// relies on the package's tsconfig.json, which `extends` the repo-root
// `tsconfig.base.json` via a relative path. When Stryker copies the
// package into a sandbox the relative extends chain no longer resolves
// (the sandbox lives two levels deeper than the package root), so
// `tsconfck` blows up during the dry run.
//
// We sidestep the issue by supplying an inline `tsconfigRaw` — the same
// compilerOptions the repo uses, expressed directly in vite's esbuild
// options. vite/esbuild then skips loading any tsconfig.json from disk.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
  esbuild: {
    tsconfigRaw: JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        types: ['node'],
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        isolatedModules: true,
        exactOptionalPropertyTypes: true,
      },
    }),
  },
});
