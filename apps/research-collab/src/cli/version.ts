/**
 * Resolve harness-one + app version strings for the run report.
 *
 * Wrapped in try/catch so a missing/malformed package.json never crashes
 * the entry point — the report just records `0.0.0`.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface VersionPair {
  readonly app: string;
  readonly harness: string;
}

export function readVersions(): VersionPair {
  const appPkgPath = resolve(getDirname(), '..', '..', 'package.json');
  const harnessPkgPath = resolve(getDirname(), '..', '..', '..', '..', 'packages', 'core', 'package.json');
  return {
    app: readVersion(appPkgPath),
    harness: readVersion(harnessPkgPath),
  };
}

function getDirname(): string {
  // Compatible with both ESM (import.meta.url) and CJS test runners — we
  // duck-type around the missing `import.meta` in jest-style envs.
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

function readVersion(path: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
