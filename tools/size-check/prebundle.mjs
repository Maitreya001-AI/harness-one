#!/usr/bin/env node
// tools/size-check/prebundle.mjs — pre-bundle public entrypoints for size-limit.
//
// Why: harness-one ships pure-ESM Node libraries that re-export from shared
// internal chunks. `@size-limit/file` on the published entry only measures the
// thin re-export shell (< 1 KB) and misses the actual cost users pay once the
// bundler follows the imports. `@size-limit/preset-small-lib` assumes a
// browser target and chokes on `node:crypto`.
//
// What: bundle each entrypoint with esbuild (platform=node, minify, bundle,
// external=node-builtins + peerDeps) into `tools/size-check/bundles/<id>.js`.
// size-limit then measures the gzip of those real bundles via its `file`
// preset — the number is what downstream Node apps actually pay after
// tree-shaking a realistic build.

import { build } from 'esbuild';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(repoRoot, 'tools', 'size-check', 'bundles');

const entries = [
  { id: 'core', pkg: 'packages/core', file: 'dist/index.js' },
  { id: 'advanced', pkg: 'packages/core', file: 'dist/advanced/index.js' },
  { id: 'testing', pkg: 'packages/core', file: 'dist/testing/index.js' },
  { id: 'preset', pkg: 'packages/preset', file: 'dist/index.js' },
  { id: 'anthropic', pkg: 'packages/anthropic', file: 'dist/index.js' },
  { id: 'openai', pkg: 'packages/openai', file: 'dist/index.js' },
];

// Externals for a realistic "what does the user actually pay" number:
//   - peerDependencies: the consumer installs these separately.
//   - workspace siblings: at publish time each @harness-one/* package is its
//     own npm tarball. Bundling `harness-one` into `@harness-one/preset`
//     would double-count what npm installs side-by-side.
//   - Node built-ins: handled by platform=node.
// Pattern externals catch subpath imports like `harness-one/core`.
function packageExternals(pkgDir) {
  const pj = JSON.parse(readFileSync(path.join(repoRoot, pkgDir, 'package.json'), 'utf8'));
  const peer = Object.keys(pj.peerDependencies ?? {});
  const deps = Object.entries(pj.dependencies ?? {})
    .filter(([, v]) => typeof v === 'string' && v.startsWith('workspace:'))
    .map(([k]) => k);
  const siblings = new Set(peer.concat(deps));
  const patterns = [];
  for (const name of siblings) patterns.push(name, `${name}/*`);
  return patterns;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const entry of entries) {
  const entryFile = path.join(repoRoot, entry.pkg, entry.file);
  const outFile = path.join(outDir, `${entry.id}.js`);
  await build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    external: packageExternals(entry.pkg),
    logLevel: 'error',
    treeShaking: true,
  });
  console.log(`bundled ${entry.id} → ${path.relative(repoRoot, outFile)}`);
}
