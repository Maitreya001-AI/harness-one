#!/usr/bin/env node
// tools/check-migrations.mjs — drive every executable migration fixture.
//
// For each `tools/migrations/<version>/<slug>/` directory:
//   - run `pre/code.mjs` and assert a non-zero exit (the breaking change
//     must actually break). A deprecation-warn fixture can opt in via
//     a `// expect: warn` marker on the first non-empty line of the
//     pre file.
//   - run `post/code.mjs` and assert a zero exit (the migration target
//     must actually work).
//
// Fixtures need `harness-one` resolvable at import time. Node's ESM
// resolver walks up from the file's own directory, not cwd, so the
// fixtures are copied to a scratch dir inside `examples/` (which has
// harness-one as a direct workspace dependency) before being run.
// A downstream consumer sees the same resolution shape.
//
// Requires `pnpm install` + `pnpm build` to have run first (the subpath
// exports need packages/*/dist/ to exist on disk).

import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdtempSync,
  cpSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(repoRoot, 'tools/migrations');
const scratchRoot = path.join(repoRoot, 'examples');

function listFixtures() {
  const out = [];
  if (!existsSync(migrationsDir)) return out;
  for (const version of readdirSync(migrationsDir)) {
    const vdir = path.join(migrationsDir, version);
    if (!statSync(vdir).isDirectory()) continue;
    for (const slug of readdirSync(vdir)) {
      const dir = path.join(vdir, slug);
      if (!statSync(dir).isDirectory()) continue;
      const pre = path.join(dir, 'pre/code.mjs');
      const post = path.join(dir, 'post/code.mjs');
      if (!existsSync(pre) || !existsSync(post)) {
        console.error(`fixture ${version}/${slug} is missing pre/code.mjs or post/code.mjs`);
        process.exitCode = 1;
        continue;
      }
      out.push({ version, slug, dir, pre, post });
    }
  }
  return out;
}

function firstLine(file) {
  const src = readFileSync(file, 'utf8');
  for (const line of src.split(/\r?\n/)) {
    if (line.trim().length > 0) return line;
  }
  return '';
}

function run(file) {
  const scratch = mkdtempSync(path.join(scratchRoot, '.migration-scratch-'));
  try {
    const dest = path.join(scratch, path.basename(file));
    cpSync(file, dest);
    const r = spawnSync(process.execPath, [dest], {
      cwd: scratch,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      status: r.status ?? -1,
      stdout: r.stdout?.toString('utf8') ?? '',
      stderr: r.stderr?.toString('utf8') ?? '',
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const fixtures = listFixtures();
  if (fixtures.length === 0) {
    console.log('check-migrations: no fixtures found under tools/migrations/');
    return;
  }

  let failures = 0;

  for (const f of fixtures) {
    const id = `${f.version}/${f.slug}`;
    console.log(`\n=== ${id} ===`);

    // PRE side: must fail (or, if opted-in, emit a deprecation warning).
    const expectsWarn = /expect:\s*warn/i.test(firstLine(f.pre));
    const preResult = run(f.pre);
    if (expectsWarn) {
      const saw = /deprecat/i.test(preResult.stderr) || /deprecat/i.test(preResult.stdout);
      if (preResult.status !== 0 || !saw) {
        console.error(`  pre : FAIL — expected clean exit + deprecation warning`);
        console.error(`        status=${preResult.status}`);
        console.error(`        stderr=${preResult.stderr.trim()}`);
        failures += 1;
      } else {
        console.log('  pre : OK (deprecation warning emitted as expected)');
      }
    } else {
      if (preResult.status === 0) {
        console.error(`  pre : FAIL — pre-migration code ran cleanly but the migration`);
        console.error(`        claims this API no longer works. Either fix the fixture`);
        console.error(`        or remove the MIGRATION.md entry.`);
        console.error(`        stdout=${preResult.stdout.trim()}`);
        failures += 1;
      } else {
        console.log(`  pre : OK (exited ${preResult.status} — breaking change confirmed)`);
      }
    }

    // POST side: must succeed.
    const postResult = run(f.post);
    if (postResult.status !== 0) {
      console.error(`  post: FAIL — post-migration recipe does not run cleanly`);
      console.error(`        status=${postResult.status}`);
      console.error(`        stderr=${postResult.stderr.trim()}`);
      failures += 1;
    } else {
      console.log('  post: OK');
    }
  }

  if (failures > 0) {
    console.error(`\ncheck-migrations: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log(`\ncheck-migrations: OK (${fixtures.length} fixture(s)).`);
}

main();
