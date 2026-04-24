#!/usr/bin/env tsx
/**
 * tools/verify-deps.ts — workspace dependency auditor.
 *
 * Scans every workspace package for runtime imports
 * of `harness-one`, `harness-one/<subpath>`, or `@harness-one/<pkg>` and
 * asserts the importer declares each one in its own `package.json` under
 * `dependencies`, `peerDependencies`, or `optionalDependencies` with the
 * `workspace:*` (or `workspace:^`/`workspace:~`) protocol.
 *
 * Also performs the merge-guard: `@harness-one/ajv` and
 * `@harness-one/tiktoken` must exist as independent workspace packages with
 * their own `package.json`.
 *
 * Exits 0 on success. Prints every violation and exits 1 on failure.
 *
 * Runs on ubuntu / macOS / windows — uses `node:path` everywhere and does
 * not shell out, so the `windows-latest` CI matrix is covered.
 *
 * Usage:
 *   pnpm verify:deps
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Paths ────────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(repoRoot, 'packages');

// ── Types ────────────────────────────────────────────────────────────────────

interface PkgJson {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface Violation {
  readonly importer: string;   // e.g. "@harness-one/openai"
  readonly importerFile: string; // absolute path
  readonly missing: string;    // the imported package name, e.g. "harness-one"
  readonly reason: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJson(file: string): PkgJson {
  return JSON.parse(readFileSync(file, 'utf8')) as PkgJson;
}

function listWorkspacePackages(): Array<{ name: string; dir: string; pkg: PkgJson }> {
  const entries = readdirSync(packagesDir);
  const out: Array<{ name: string; dir: string; pkg: PkgJson }> = [];
  for (const entry of entries) {
    const dir = path.join(packagesDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const pjPath = path.join(dir, 'package.json');
    if (!existsSync(pjPath)) continue;
    const pkg = readJson(pjPath);
    if (!pkg.name) continue;
    out.push({ name: pkg.name, dir, pkg });
  }
  return out;
}

function walkTs(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__lint-fixtures__') continue;
      walkTs(full, files);
      continue;
    }
    if (!st.isFile()) continue;
    if (!/\.(ts|tsx|mts|cts)$/.test(entry)) continue;
    if (/\.d\.ts$/.test(entry)) continue;
    files.push(full);
  }
  return files;
}

// Strip // line comments and /* block */ comments so commented-out imports
// don't produce false positives. Template literals are left intact —
// harmless because they rarely look like module specifiers.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

const IMPORT_RE =
  /(?:^|\s)(?:import|export)\s[^'"`;]*?from\s+['"`]([^'"`]+)['"`]/gms;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

function collectSpecifiers(src: string): string[] {
  const stripped = stripComments(src);
  const specs: string[] = [];
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      specs.push(m[1]);
    }
  }
  return specs;
}

// Reduce `harness-one/core/foo` → `harness-one`; `@harness-one/openai/sub` → `@harness-one/openai`.
// Only returns workspace-scoped specifiers.
function toWorkspacePkgName(spec: string): string | null {
  if (spec === 'harness-one' || spec.startsWith('harness-one/')) return 'harness-one';
  if (spec.startsWith('@harness-one/')) {
    const parts = spec.split('/');
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  }
  return null;
}

function hasWorkspaceDep(pkg: PkgJson, depName: string): { field: string; version: string } | null {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const rec = pkg[field];
    if (rec && rec[depName]) {
      return { field, version: rec[depName] };
    }
  }
  return null;
}

function isWorkspaceProtocol(version: string): boolean {
  return version.startsWith('workspace:');
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const violations: Violation[] = [];
  const infos: string[] = [];

  // merge-guard: ajv + tiktoken must exist as separate workspace packages.
  const ajvPkg = path.join(packagesDir, 'ajv', 'package.json');
  const tiktokenPkg = path.join(packagesDir, 'tiktoken', 'package.json');
  if (!existsSync(ajvPkg)) {
    violations.push({
      importer: '(merge-guard)',
      importerFile: ajvPkg,
      missing: '@harness-one/ajv',
      reason: 'merge-guard: packages/ajv/package.json missing (ADR §3.c requires ajv/tiktoken stay separate).',
    });
  }
  if (!existsSync(tiktokenPkg)) {
    violations.push({
      importer: '(merge-guard)',
      importerFile: tiktokenPkg,
      missing: '@harness-one/tiktoken',
      reason: 'merge-guard: packages/tiktoken/package.json missing (ADR §3.c requires ajv/tiktoken stay separate).',
    });
  }
  // Broader sanity: ≥10 package.json files under packages/.
  let pkgJsonCount = 0;
  for (const entry of readdirSync(packagesDir)) {
    const pj = path.join(packagesDir, entry, 'package.json');
    if (existsSync(pj)) pkgJsonCount += 1;
  }
  if (pkgJsonCount < 9) {
    // Main-5C expectation is 9 (ajv, anthropic, core, langfuse, openai,
    // opentelemetry, preset, redis, tiktoken). PR-2 grows this to ≥ 11
    // once cli + devkit land. Fire if we drop below 9 — that means a
    // package was deleted without an ADR amendment.
    violations.push({
      importer: '(sanity)',
      importerFile: packagesDir,
      missing: '(package count)',
      reason: `Expected ≥ 9 workspace packages under packages/, found ${pkgJsonCount}.`,
    });
  }

  // Package-by-package audit.
  const pkgs = listWorkspacePackages();
  for (const { name, dir, pkg } of pkgs) {
    const srcDir = path.join(dir, 'src');
    const files = walkTs(srcDir);
    const seen = new Map<string, string>(); // importedPkg → first file that imports it
    for (const f of files) {
      // Skip test files — they can legitimately reach into anything.
      if (f.includes('__tests__') || /\.test\.(ts|tsx)$/.test(f)) continue;
      const src = readFileSync(f, 'utf8');
      const specs = collectSpecifiers(src);
      for (const s of specs) {
        const dep = toWorkspacePkgName(s);
        if (dep === null) continue;
        if (dep === name) continue; // self-import (shouldn't happen but safe)
        if (!seen.has(dep)) seen.set(dep, f);
      }
    }

    for (const [dep, srcFile] of seen) {
      const found = hasWorkspaceDep(pkg, dep);
      if (!found) {
        violations.push({
          importer: name,
          importerFile: srcFile,
          missing: dep,
          reason: `${name} imports "${dep}" but declares no dependency for it in dependencies/peerDependencies/optionalDependencies.`,
        });
        continue;
      }
      if (!isWorkspaceProtocol(found.version)) {
        violations.push({
          importer: name,
          importerFile: srcFile,
          missing: dep,
          reason: `${name}.${found.field}["${dep}"] = "${found.version}" — expected a "workspace:*" (or workspace:^/~) protocol for an intra-monorepo import.`,
        });
        continue;
      }
      // R-08 informational: flag the preset/tiktoken entry as optional
      // so a reviewer can eyeball the intentional classification.
      if (name === '@harness-one/preset' && dep === '@harness-one/tiktoken' && found.field === 'optionalDependencies') {
        infos.push(`[R-08] ${name} → ${dep} is in optionalDependencies (intended per risk-decisions R-08).`);
      }
    }
  }

  if (infos.length > 0) {
    for (const info of infos) console.log(info);
  }
  if (violations.length === 0) {
    console.log(`verify-deps: ${pkgs.length} workspace packages scanned. OK.`);
    process.exit(0);
  }

  console.error(`verify-deps: ${violations.length} violation(s) found:`);
  for (const v of violations) {
    console.error(`  - [${v.importer}] ${v.reason}`);
    console.error(`    src: ${path.relative(repoRoot, v.importerFile)}`);
    console.error(`    missing: ${v.missing}`);
  }
  process.exit(1);
}

main();
