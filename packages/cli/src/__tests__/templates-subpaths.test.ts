/**
 * Build-time check (F-3 acceptance) that every `harness-one/<subpath>` or
 * `@harness-one/<pkg>` literal that appears in a CLI template is still a
 * valid export of its target workspace package.
 *
 * Rationale: CLI templates emit user-facing scaffold code — a stale subpath
 * here silently breaks `npx harness-one init --modules <x>` for every end
 * user who scaffolds after a package rename. The `SUBPATH_MAP` in
 * `templates/subpath-map.ts` is the source of truth the whole team edits
 * together; this test then (a) validates SUBPATH_MAP against real exports,
 * and (b) asserts every literal found in a template file is covered.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_MODULES } from '../parser.js';
import type { ModuleName } from '../parser.js';
import { SUBPATH_MAP } from '../templates/subpath-map.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');

// ── Helpers ──────────────────────────────────────────────────────────────────

interface PkgExports {
  exports?:
    | string
    | Record<string, unknown>;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/**
 * Extract every subpath key from a package.json `exports` map.
 * For example, `{ ".": {...}, "./core": {...} }` → [``, `core`].
 * The `.` key becomes the empty string (root export).
 */
function listExportSubpaths(pkgJsonPath: string): Set<string> {
  const pj = readJson<PkgExports>(pkgJsonPath);
  const out = new Set<string>();
  const exp = pj.exports;
  if (typeof exp !== 'object' || exp === null) {
    // `exports` is a string or missing — treat as root-only.
    out.add('');
    return out;
  }
  for (const key of Object.keys(exp)) {
    if (key === '.') {
      out.add('');
    } else if (key.startsWith('./')) {
      out.add(key.slice(2));
    }
  }
  return out;
}

/**
 * Parse a template string for every `from '<spec>'` import specifier where
 * `<spec>` is `harness-one`, `harness-one/<subpath>`, `@harness-one/<pkg>`,
 * or `@harness-one/<pkg>/<subpath>`.
 *
 * The `from ` prefix filter guards against unrelated string literals (e.g.
 * `project: 'harness-one'` content inside a prompt example).
 */
function extractSubpathsFromSource(source: string): Array<{ pkg: string; subpath: string }> {
  const re =
    /from\s+(?:'|")(@harness-one\/[a-z-]+|harness-one)(?:\/([a-z-]+))?(?:'|")/g;
  const out: Array<{ pkg: string; subpath: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ pkg: m[1], subpath: m[2] ?? '' });
  }
  return out;
}

// ── Package export maps ──────────────────────────────────────────────────────

const CORE_EXPORTS = listExportSubpaths(join(REPO_ROOT, 'packages/core/package.json'));
const DEVKIT_EXPORTS = listExportSubpaths(join(REPO_ROOT, 'packages/devkit/package.json'));

// ── Tests ────────────────────────────────────────────────────────────────────

describe('templates subpath literals', () => {
  it('SUBPATH_MAP covers every module in ALL_MODULES', () => {
    for (const mod of ALL_MODULES) {
      expect(SUBPATH_MAP[mod], `SUBPATH_MAP missing entry for ${mod}`).toBeDefined();
      expect(SUBPATH_MAP[mod].length).toBeGreaterThan(0);
    }
  });

  it('every SUBPATH_MAP entry resolves to an existing export', () => {
    for (const mod of ALL_MODULES) {
      for (const ref of SUBPATH_MAP[mod]) {
        if (ref.pkg === 'harness-one') {
          expect(
            CORE_EXPORTS.has(ref.subpath),
            `SUBPATH_MAP[${mod}] references harness-one/${ref.subpath} but packages/core/package.json exports does not declare it`,
          ).toBe(true);
        } else if (ref.pkg === '@harness-one/devkit') {
          expect(
            DEVKIT_EXPORTS.has(ref.subpath),
            `SUBPATH_MAP[${mod}] references @harness-one/devkit${ref.subpath ? '/' + ref.subpath : ''} but devkit package.json does not export it`,
          ).toBe(true);
        } else {
          throw new Error(`Unknown package in SUBPATH_MAP[${mod}]: ${ref.pkg}`);
        }
      }
    }
  });

  it('every subpath literal found in templates/*.ts is covered by SUBPATH_MAP', () => {
    const templatesDir = join(__dirname, '../templates');
    const files = readdirSync(templatesDir).filter(
      (f) => f.endsWith('.ts') && f !== 'index.ts' && f !== 'subpath-map.ts',
    );
    expect(files.length).toBe(ALL_MODULES.length);

    for (const file of files) {
      const mod = file.replace(/\.ts$/, '') as ModuleName;
      const source = readFileSync(join(templatesDir, file), 'utf8');
      const refs = extractSubpathsFromSource(source);
      expect(refs.length, `${file} contains no harness-one imports`).toBeGreaterThan(0);

      const declared = SUBPATH_MAP[mod];
      expect(declared, `SUBPATH_MAP missing for ${mod}`).toBeDefined();

      for (const ref of refs) {
        const covered = declared.some(
          (d) => d.pkg === ref.pkg && d.subpath === ref.subpath,
        );
        expect(
          covered,
          `${file}: literal "${ref.pkg}${ref.subpath ? '/' + ref.subpath : ''}" not declared in SUBPATH_MAP[${mod}]`,
        ).toBe(true);
      }
    }
  });

  it('every subpath literal found in templates resolves to a real export', () => {
    const templatesDir = join(__dirname, '../templates');
    const files = readdirSync(templatesDir).filter(
      (f) => f.endsWith('.ts') && f !== 'index.ts' && f !== 'subpath-map.ts',
    );

    for (const file of files) {
      const source = readFileSync(join(templatesDir, file), 'utf8');
      const refs = extractSubpathsFromSource(source);
      for (const ref of refs) {
        if (ref.pkg === 'harness-one') {
          expect(
            CORE_EXPORTS.has(ref.subpath),
            `${file}: harness-one/${ref.subpath} is not exported by packages/core/package.json`,
          ).toBe(true);
        } else if (ref.pkg === '@harness-one/devkit') {
          expect(
            DEVKIT_EXPORTS.has(ref.subpath),
            `${file}: @harness-one/devkit${ref.subpath ? '/' + ref.subpath : ''} is not exported by devkit package.json`,
          ).toBe(true);
        }
      }
    }
  });
});
