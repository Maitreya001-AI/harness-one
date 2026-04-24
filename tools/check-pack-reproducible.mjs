#!/usr/bin/env node
// tools/check-pack-reproducible.mjs — verify `pnpm pack` determinism.
//
// Packs the target package twice with SOURCE_DATE_EPOCH pinned, hashes
// both tarballs, and fails if they differ. Byte-identical tarballs are
// the baseline for SLSA provenance + supply-chain audit: the same source
// must reproduce to the same artifact or an attestation is meaningless.
//
// Assumes the target has already been built (`pnpm -r build`). The script
// does not run `build` itself — it checks packaging, not compilation.
//
// Usage:
//   pnpm check:pack                     # packages/core
//   node tools/check-pack-reproducible.mjs --package packages/anthropic

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 2024-01-01T00:00:00Z — any stable value works; what matters is that the
// two packs below see the same one. If reproducibility ever regresses,
// the value itself is not the bug, drift within a single run is.
const SOURCE_DATE_EPOCH = '1704067200';

function parseArgs(argv) {
  const out = { pkg: 'packages/core' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package' && argv[i + 1]) {
      out.pkg = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function pack(pkgDir, destDir) {
  execFileSync('pnpm', ['pack', '--pack-destination', destDir], {
    cwd: pkgDir,
    env: { ...process.env, SOURCE_DATE_EPOCH },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const tarballs = readdirSync(destDir).filter((f) => f.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(
      `expected 1 tarball in ${destDir}, found ${tarballs.length}: ${tarballs.join(', ')}`,
    );
  }
  return path.join(destDir, tarballs[0]);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkgDir = path.resolve(repoRoot, args.pkg);

  const dirA = mkdtempSync(path.join(tmpdir(), 'pack-A-'));
  const dirB = mkdtempSync(path.join(tmpdir(), 'pack-B-'));

  try {
    console.log(
      `check-pack-reproducible: packing ${args.pkg} twice (SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH})`,
    );
    const tarA = pack(pkgDir, dirA);
    const tarB = pack(pkgDir, dirB);
    const hashA = sha256(tarA);
    const hashB = sha256(tarB);
    console.log(`  A: ${path.basename(tarA)}  sha256=${hashA}`);
    console.log(`  B: ${path.basename(tarB)}  sha256=${hashB}`);

    if (hashA !== hashB) {
      console.error('\ncheck-pack-reproducible: FAIL — tarballs differ.');
      console.error('Likely causes:');
      console.error('  - unpinned file mtimes (SOURCE_DATE_EPOCH not honored by pnpm)');
      console.error('  - nondeterministic tarball entry ordering');
      console.error('  - env-dependent fields leaked into package.json');
      console.error('Diff the tarballs locally with:');
      console.error(`  diffoscope ${tarA} ${tarB}`);
      console.error('(or `tar -tzf` both and compare listings)');
      process.exit(1);
    }

    console.log('check-pack-reproducible: OK — byte-identical tarballs.');
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}

main();
