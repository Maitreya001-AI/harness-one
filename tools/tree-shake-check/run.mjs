#!/usr/bin/env node
// tools/tree-shake-check/run.mjs — assert tree-shaking of opt-in subsystems.
//
// Contract being enforced (DX promise from the public barrel doc):
//   "A user who does `import { createAgentLoop } from 'harness-one'` does NOT
//    pay for the RAG pipeline, evolve-check architecture rules, or other
//    subsystems that live on opt-in subpaths."
//
// Mechanism:
//   1. Bundle the fixture (core-only.ts) with esbuild — minified, Node
//      platform, treeShaking enabled, tsconfig paths-aware so workspace
//      imports resolve to /dist.
//   2. Grep the output for a blacklist of symbols that are exported only by
//      the opt-in subpaths (`harness-one/rag`, `harness-one/evolve-check`).
//      Presence of any of them = leak.
//   3. Grep the output for a sanity whitelist (must-contain symbols that the
//      fixture actually uses) — catches the case where esbuild accidentally
//      drops everything or our regex logic is broken.
//
// Blacklist discipline: include only symbols with distinctive names that
// cannot reasonably appear in core code. A substring collision with a common
// word would produce a false positive and erode trust in the check.

import { build } from 'esbuild';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(toolRoot, 'out');
const outFile = path.join(outDir, 'core-only.js');
const fixture = path.join(toolRoot, 'fixtures', 'core-only.ts');

// Tokens that must NOT appear in a `createAgentLoop`-only bundle. Picked so
// they survive esbuild's rename pass — top-level export names DO get
// mangled when bundled, so we look for:
//   - method names (not renamed unless --mangle-props is set, which we don't)
//   - string-literal rule IDs and class-name literals (strings never mangled)
// Each token is distinctive enough that a substring match in core code would
// be a genuine surprise worth investigating (conservative blacklist per
// task discipline #3).
const forbidden = [
  // RAG subsystem (harness-one/rag)
  { symbol: 'indexScoped', origin: 'harness-one/rag — InMemoryRetriever method' },
  // evolve-check subsystem (harness-one/evolve-check) — top-level factory
  // names are renamed by the bundler. Cover two branches:
  //   (1) the factory (`createArchitectureChecker`) is imported → its method
  //       names `addRule` / `listRules` survive (method names aren't
  //       mangled and both are unique to evolve-check in the core dist).
  //   (2) the rules (`noCircularDepsRule` / `layerDependencyRule`) are
  //       imported → their rule-ID string literals survive.
  { symbol: 'addRule', origin: 'harness-one/evolve-check — ArchitectureChecker.addRule method' },
  { symbol: 'listRules', origin: 'harness-one/evolve-check — ArchitectureChecker.listRules method' },
  { symbol: 'no-circular-deps', origin: 'harness-one/evolve-check — noCircularDepsRule id string' },
  { symbol: 'layer-dependency', origin: 'harness-one/evolve-check — layerDependencyRule id string' },
];

// Sanity: these strings MUST appear, otherwise the check is broken (the
// fixture failed to link against core, or tree-shaking dropped the entire
// bundle). Must be STRING LITERALS that survive identifier minification —
// `packages/core/dist/chunk-*.js` ships pre-minified, so identifier names
// like `createAgentLoop` are already mangled to short aliases like `qt`.
// Class-name string literals (`this.name = "HarnessError"`) do survive.
const required = [
  'HarnessError', // class name literal in errors-base.ts
  '@@harness-one/sanity', // sentinel printed by the fixture below
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Resolve `harness-one` directly to the built `dist/` that npm will ship —
// bypasses the root-level node_modules (there is no root-level harness-one
// install; the package is workspace-only). The aliases mirror the
// `exports` map of packages/core/package.json for the subpaths a user might
// reach. If a subpath is added to the public exports, add it here too.
const coreDist = path.join(repoRoot, 'packages', 'core', 'dist');
const alias = {
  'harness-one': path.join(coreDist, 'index.js'),
  'harness-one/core': path.join(coreDist, 'core', 'index.js'),
  'harness-one/advanced': path.join(coreDist, 'advanced', 'index.js'),
  'harness-one/prompt': path.join(coreDist, 'prompt', 'index.js'),
  'harness-one/context': path.join(coreDist, 'context', 'index.js'),
  'harness-one/tools': path.join(coreDist, 'tools', 'index.js'),
  'harness-one/guardrails': path.join(coreDist, 'guardrails', 'index.js'),
  'harness-one/observe': path.join(coreDist, 'observe', 'index.js'),
  'harness-one/session': path.join(coreDist, 'session', 'index.js'),
  'harness-one/memory': path.join(coreDist, 'memory', 'index.js'),
  'harness-one/evolve-check': path.join(coreDist, 'evolve-check', 'index.js'),
  'harness-one/rag': path.join(coreDist, 'rag', 'index.js'),
  'harness-one/orchestration': path.join(coreDist, 'orchestration', 'index.js'),
  'harness-one/redact': path.join(coreDist, 'redact', 'index.js'),
  'harness-one/infra': path.join(coreDist, 'infra', 'index.js'),
  'harness-one/testing': path.join(coreDist, 'testing', 'index.js'),
};

await build({
  entryPoints: [fixture],
  outfile: outFile,
  bundle: true,
  // NOT minified: minification renames identifiers, which would make the
  // blacklist grep unreliable and break the `createAgentLoop` sanity check.
  // Tree-shaking (dead-code elimination from side-effect-free modules) runs
  // regardless of minification — minification only trims whitespace and
  // mangles names, it is not what drops unused exports.
  minify: false,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  treeShaking: true,
  logLevel: 'error',
  alias,
});

const bundle = readFileSync(outFile, 'utf8');

const leaks = forbidden.filter(({ symbol }) => bundle.includes(symbol));
const missing = required.filter((symbol) => !bundle.includes(symbol));

if (missing.length > 0) {
  console.error('tree-shake-check: sanity check failed — expected symbols missing from bundle');
  for (const s of missing) console.error(`  - ${s}`);
  console.error('\nThis usually means the fixture did not import correctly; the check is broken.');
  process.exit(2);
}

if (leaks.length > 0) {
  console.error('tree-shake-check: opt-in subsystem symbols leaked into root-barrel bundle');
  for (const { symbol, origin } of leaks) {
    console.error(`  - ${symbol}  (${origin})`);
  }
  console.error(
    '\nFixture: tools/tree-shake-check/fixtures/core-only.ts imports only `createAgentLoop`',
  );
  console.error(
    'If a subsystem symbol appears here, the root barrel (packages/core/src/index.ts)',
  );
  console.error(
    'or an intermediate module is pulling it in transitively. Do NOT bump the limit —',
  );
  console.error('open an issue and flag the leak to the owner.');
  process.exit(1);
}

const kb = (bundle.length / 1024).toFixed(2);
console.log(
  `tree-shake-check: OK — ${forbidden.length} forbidden symbols absent, ${required.length} required symbols present (bundle ${kb} KB unminified-on-disk).`,
);
