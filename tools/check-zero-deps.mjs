#!/usr/bin/env node
// tools/check-zero-deps.mjs — zero-runtime-dep enforce (Track B1).
//
// Scans every packages/*/package.json and fails if any `dependencies` entry
// references an external (non-workspace:) npm package.
//
// The supply-chain promise: end users installing harness-one pull zero
// external runtime deps. Internal workspace:* references resolve to sibling
// @harness-one/* packages at publish time — those are our own code and are
// intentional. External SDKs must live in `peerDependencies` so the
// consumer owns the install (and the audit).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(repoRoot, 'packages');

const violations = [];
let scanned = 0;

for (const entry of readdirSync(packagesDir)) {
  const dir = path.join(packagesDir, entry);
  if (!statSync(dir).isDirectory()) continue;
  const pjPath = path.join(dir, 'package.json');
  if (!existsSync(pjPath)) continue;
  const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
  scanned += 1;
  const deps = pj.dependencies ?? {};
  for (const [name, version] of Object.entries(deps)) {
    if (typeof version !== 'string' || !version.startsWith('workspace:')) {
      violations.push(
        `${pj.name ?? entry}: dependencies["${name}"] = "${version}" — external runtime dep not allowed`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error('check-zero-deps: runtime dependency violations');
  for (const v of violations) console.error('  - ' + v);
  console.error(
    '\nharness-one packages may only carry workspace: references in `dependencies`.',
  );
  console.error(
    'Move external SDKs to `peerDependencies` so consumers own the install.',
  );
  process.exit(1);
}

console.log(`check-zero-deps: OK (${scanned} package.json scanned).`);
