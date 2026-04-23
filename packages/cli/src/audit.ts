/**
 * Harness usage audit logic.
 *
 * Scans a project directory for harness-one module imports and reports coverage.
 *
 * @module
 */

import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_MODULES } from './parser.js';
import type { ModuleName } from './parser.js';

// ── File scanner ─────────────────────────────────────────────────────────────

export function scanFiles(dir: string, visited?: Set<string>): string[] {
  const seen = visited ?? new Set<string>();
  const results: string[] = [];
  try {
    // Resolve symlinks to detect cycles — if we've already visited this
    // real path, skip it to prevent infinite recursion.
    const realDir = realpathSync(dir);
    if (seen.has(realDir)) return results;
    seen.add(realDir);

    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          results.push(...scanFiles(full, seen));
        } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) {
          results.push(full);
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Skip inaccessible directories
  }
  return results;
}

// ── Audit logic ──────────────────────────────────────────────────────────────

export function auditProject(cwd: string): {
  used: ModuleName[];
  unused: ModuleName[];
  fileCount: number;
  moduleCounts: Readonly<Record<ModuleName, number>>;
  totalImportSites: number;
} {
  const files = scanFiles(cwd);
  // SPEC-010: accept both the legacy `harness-one/<mod>` subpath imports and
  // the scoped `@harness-one/core/<mod>` subpath (used by orchestration / rag
  // consumers after the preset rename).  Both produce the same ModuleName.
  const importPatterns: RegExp[] = [
    /from\s+['"]harness-one\/(\w+)['"]/g,
    /from\s+['"]@harness-one\/core\/(\w+)['"]/g,
  ];
  const found = new Set<ModuleName>();
  const moduleCounts = Object.fromEntries(
    ALL_MODULES.map((mod) => [mod, 0]),
  ) as Record<ModuleName, number>;

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      for (const pattern of importPatterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          const mod = match[1] as ModuleName;
          if (ALL_MODULES.includes(mod)) {
            found.add(mod);
            moduleCounts[mod]++;
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  const used = ALL_MODULES.filter((m) => found.has(m));
  const unused = ALL_MODULES.filter((m) => !found.has(m));
  const totalImportSites = Object.values(moduleCounts).reduce((sum, count) => sum + count, 0);
  return { used, unused, fileCount: files.length, moduleCounts, totalImportSites };
}

export function formatImportSiteCount(count: number): string {
  return count === 1 ? '1 import site' : `${count} import sites`;
}
