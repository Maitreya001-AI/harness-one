#!/usr/bin/env node
// tools/compat/run-fixture.mjs — drive one cell of the peer-dep compat
// matrix against a smoke fixture.
//
// Usage:
//   node tools/compat/run-fixture.mjs <adapter> <peer-spec>
//
//   adapter    — one of: anthropic, openai
//   peer-spec  — npm install spec for the peer SDK
//                (e.g. '@anthropic-ai/sdk@0.30.0', 'openai@latest')
//
// What it does:
//   1. Builds nothing — assumes `pnpm build` already ran.
//   2. Packs harness-one/core and the target adapter into tmpdir/tarballs/.
//   3. Copies tools/compat/fixtures/<adapter>/ into tmpdir/fixture/.
//   4. Writes a package.json pinning the tarballs + peer-spec + installs
//      via npm (npm, not pnpm, because we want the installed tree to
//      look like what a downstream consumer sees — no workspace magic).
//   5. Runs node smoke.mjs.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const [, , adapterArg, peerSpecArg] = process.argv;
if (!adapterArg || !peerSpecArg) {
  console.error('usage: run-fixture.mjs <adapter> <peer-spec>');
  console.error("  e.g. run-fixture.mjs anthropic '@anthropic-ai/sdk@0.30.0'");
  process.exit(2);
}

const ADAPTERS = {
  anthropic: {
    adapterPkg: '@harness-one/anthropic',
    adapterDir: 'packages/anthropic',
    peerName: '@anthropic-ai/sdk',
  },
  openai: {
    adapterPkg: '@harness-one/openai',
    adapterDir: 'packages/openai',
    peerName: 'openai',
  },
};

const def = ADAPTERS[adapterArg];
if (!def) {
  console.error(`unknown adapter "${adapterArg}" — must be one of ${Object.keys(ADAPTERS).join(', ')}`);
  process.exit(2);
}

// Sanity-check that the peer spec actually refers to the expected peer.
// A silently-wrong matrix entry (e.g. `openai@...` on the anthropic row)
// would pass the smoke test against an unused dep and prove nothing.
if (!peerSpecArg.startsWith(def.peerName + '@')) {
  console.error(
    `peer-spec "${peerSpecArg}" does not target "${def.peerName}" for the ${adapterArg} adapter`,
  );
  process.exit(2);
}

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function pack(pkgDir, destDir) {
  // Each package gets its own destDir so a later pack can't see an
  // earlier one's tarball and trip the "exactly one tarball" check.
  mkdirSync(destDir, { recursive: true });
  run('pnpm', ['pack', '--pack-destination', destDir], { cwd: pkgDir });
  const tgz = readdirSync(destDir).filter((f) => f.endsWith('.tgz'));
  if (tgz.length !== 1) {
    throw new Error(
      `expected exactly one .tgz in ${destDir}, got ${tgz.length}: ${tgz.join(', ')}`,
    );
  }
  return path.join(destDir, tgz[0]);
}

const tmp = mkdtempSync(path.join(tmpdir(), `compat-${adapterArg}-`));
const fixtureDir = path.join(tmp, 'fixture');

try {
  console.log(`compat: tmp=${tmp}`);
  console.log(`compat: adapter=${adapterArg}  peer=${peerSpecArg}`);

  // 1. pack core + target adapter into isolated dirs.
  const coreTar = pack(path.join(repoRoot, 'packages/core'), path.join(tmp, 'core'));
  const adapterTar = pack(path.join(repoRoot, def.adapterDir), path.join(tmp, 'adapter'));

  // 2. copy fixture + write package.json with tarball + peer deps.
  cpSync(path.join(repoRoot, 'tools/compat/fixtures', adapterArg), fixtureDir, {
    recursive: true,
  });

  const fixturePkg = {
    name: `compat-install-${adapterArg}`,
    private: true,
    version: '0.0.0',
    type: 'module',
    dependencies: {
      'harness-one': `file:${coreTar}`,
      [def.adapterPkg]: `file:${adapterTar}`,
      [def.peerName]: peerSpecArg.split('@').slice(-1)[0],
    },
  };
  writeFileSync(
    path.join(fixtureDir, 'package.json'),
    JSON.stringify(fixturePkg, null, 2) + '\n',
  );

  // 3. install via npm (not pnpm) — we want a consumer-shaped node_modules.
  run('npm', ['install', '--no-audit', '--no-fund', '--no-save'], { cwd: fixtureDir });

  // 4. run smoke test.
  run('node', ['smoke.mjs'], { cwd: fixtureDir });

  console.log(`compat: OK — ${adapterArg} + ${peerSpecArg}`);
} finally {
  // Leave the tmpdir on failure for postmortem; clean on success.
  if (!process.exitCode) {
    rmSync(tmp, { recursive: true, force: true });
  } else {
    console.log(`compat: leaving tmp=${tmp} for postmortem`);
  }
}
