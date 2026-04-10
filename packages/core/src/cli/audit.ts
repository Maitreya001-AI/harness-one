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
} {
  const files = scanFiles(cwd);
  const importPattern = /from\s+['"]harness-one\/(\w+)['"]/g;
  const found = new Set<ModuleName>();

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      let match: RegExpExecArray | null;
      while ((match = importPattern.exec(content)) !== null) {
        const mod = match[1] as ModuleName;
        if (ALL_MODULES.includes(mod)) {
          found.add(mod);
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  const used = ALL_MODULES.filter((m) => found.has(m));
  const unused = ALL_MODULES.filter((m) => !found.has(m));
  return { used, unused, fileCount: files.length };
}

export function maturityLabel(usedCount: number, c: {
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
}): string {
  if (usedCount >= 9) return c.green('Comprehensive');
  if (usedCount >= 7) return c.green('Advanced');
  if (usedCount >= 5) return c.yellow('Intermediate');
  if (usedCount >= 3) return c.yellow('Basic');
  if (usedCount >= 1) return c.red('Starter');
  return c.red('None');
}
