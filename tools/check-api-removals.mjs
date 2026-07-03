#!/usr/bin/env node
// tools/check-api-removals.mjs — public-symbol removal gate.
//
// Complements `pnpm api:check` (which asserts the committed `*.api.md`
// snapshots still match a fresh api-extractor run). This gate adds the
// *policy* layer the snapshot diff cannot express on its own: once a symbol
// has shipped, it may not silently disappear.
//
// For every committed `packages/*/etc/*.api.md`, it compares the BASE-branch
// version (via `git show <base>:<path>`) against the current working-tree
// version and FAILS if any exported symbol present in the base file is absent
// from the current one — UNLESS one of the escape hatches applies:
//
//   (a) the base declaration already carried `@deprecated` (api-extractor
//       renders this on the release-tag line, e.g. `// @public @deprecated`,
//       or in a preceding `/** @deprecated */` doc block), OR
//   (b) MIGRATION.md's `## Unreleased` section mentions the symbol name.
//
// Rationale: post-`0.1.0` renames MUST carry a runtime-working `@deprecated`
// alias for a full major grace window (see MIGRATION.md § Release blockers).
// A hard rename that drops the old name without a deprecation window or a
// documented breaking-change note is exactly the regression this blocks.
//
// The current working-tree `*.api.md` is treated as the "regenerated" surface:
// the prior `pnpm api:check` step guarantees it matches a fresh api-extractor
// run against the PR source, so base-vs-worktree == base-vs-regenerated.
//
// Dependency-free Node (matches the other tools/*.mjs scripts). No network,
// no npm deps — only `git`, `node:fs`, and `node:child_process`.
//
// Base ref resolution (first that resolves wins):
//   1. $API_REMOVALS_BASE_REF   (workflow passes the PR base SHA here)
//   2. origin/$GITHUB_BASE_REF / $GITHUB_BASE_REF   (pull_request event)
//   3. HEAD~1
// If none resolve (e.g. a manual `workflow_dispatch` with no base), the gate
// prints a notice and exits 0 — there is nothing to diff against.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(repoRoot, 'packages');
const migrationPath = path.join(repoRoot, 'MIGRATION.md');

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

function git(args) {
  return spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function revExists(ref) {
  return git(['rev-parse', '--verify', '--quiet', ref]).status === 0;
}

/** Return file content at a ref, or null if the path did not exist there. */
function gitShow(ref, relPath) {
  const r = git(['show', `${ref}:${relPath}`]);
  return r.status === 0 ? r.stdout : null;
}

function resolveBaseRef() {
  const explicit = process.env.API_REMOVALS_BASE_REF;
  if (explicit && revExists(explicit)) return explicit;

  const prBase = process.env.GITHUB_BASE_REF;
  if (prBase) {
    if (revExists(`origin/${prBase}`)) return `origin/${prBase}`;
    if (revExists(prBase)) return prBase;
  }

  if (revExists('HEAD~1')) return 'HEAD~1';
  return null;
}

// ---------------------------------------------------------------------------
// api.md parsing
// ---------------------------------------------------------------------------

/** Pull the exported public identifier(s) out of a top-level `export ...` line. */
function extractNames(line) {
  // Re-export braces: `export { A as B, C }` / `export type { A }`.
  const brace = line.match(/^export\s+(?:type\s+)?\{([^}]*)\}/);
  if (brace) {
    return brace[1]
      .split(',')
      .map((seg) => {
        const parts = seg.trim().split(/\s+as\s+/);
        return (parts[1] ?? parts[0] ?? '').trim();
      })
      .filter((n) => /^[A-Za-z0-9_$]+$/.test(n));
  }

  // Declarations: class / interface / type / function / const / enum /
  // namespace / let / var, with optional `declare` / `abstract` modifiers.
  const decl = line.match(
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|function|const|enum|namespace|let|var)\s+([A-Za-z0-9_$]+)/,
  );
  if (decl) return [decl[1]];

  return [];
}

/**
 * Parse an api.md report into `Map<symbolName, { deprecated }>`.
 *
 * Only column-0 `export` lines are considered (namespace-nested members are
 * indented and roll up under their namespace symbol). Each symbol's leading
 * contiguous comment trivia is scanned for `@deprecated`.
 */
function parseApiReport(content) {
  const symbols = new Map();
  if (!content) return symbols;

  let leading = [];
  for (const rawLine of content.split(/\r?\n/)) {
    if (rawLine.startsWith('export ')) {
      const deprecated = /@deprecated/i.test(leading.join('\n'));
      for (const name of extractNames(rawLine)) {
        // If a name appears twice (overloads), sticky-OR the deprecated flag.
        const prev = symbols.get(name);
        symbols.set(name, { deprecated: deprecated || (prev?.deprecated ?? false) });
      }
      leading = [];
      continue;
    }

    const trimmed = rawLine.trim();
    if (trimmed === '') {
      leading = [];
    } else if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*')
    ) {
      leading.push(trimmed);
    } else {
      // Any other code line (member, closing brace, fence) breaks the trivia
      // run that belongs to the next top-level export.
      leading = [];
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// MIGRATION.md § Unreleased
// ---------------------------------------------------------------------------

function readUnreleasedSection() {
  if (!existsSync(migrationPath)) return '';
  const md = readFileSync(migrationPath, 'utf8');
  const lines = md.split(/\r?\n/);
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Unreleased\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,2}\s+/.test(line)) break; // next top-level/## heading
    if (inSection) out.push(line);
  }
  return out.join('\n');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** All committed api.md reports as repo-relative POSIX paths. */
function listApiReports() {
  const out = [];
  if (!existsSync(packagesDir)) return out;
  for (const pkg of readdirSync(packagesDir)) {
    const etcDir = path.join(packagesDir, pkg, 'etc');
    if (!existsSync(etcDir)) continue;
    for (const file of readdirSync(etcDir)) {
      if (!file.endsWith('.api.md')) continue;
      out.push(`packages/${pkg}/etc/${file}`);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const baseRef = resolveBaseRef();
  if (!baseRef) {
    console.log(
      'check-api-removals: no base ref to diff against (not a PR / shallow / first commit) — skipping.',
    );
    return;
  }

  const reports = listApiReports();
  if (reports.length === 0) {
    console.log('check-api-removals: no packages/*/etc/*.api.md reports found.');
    return;
  }

  const unreleased = readUnreleasedSection();
  const migrationMentions = (name) =>
    new RegExp(`\\b${escapeRegExp(name)}\\b`).test(unreleased);

  console.log(`check-api-removals: base ref = ${baseRef}`);

  const violations = [];
  let allowedDeprecated = 0;
  let allowedMigration = 0;

  for (const relPath of reports) {
    const baseContent = gitShow(baseRef, relPath); // null => new file in this change
    const curPath = path.join(repoRoot, relPath);
    const curContent = existsSync(curPath) ? readFileSync(curPath, 'utf8') : '';

    const oldSymbols = parseApiReport(baseContent);
    const newSymbols = parseApiReport(curContent);
    if (oldSymbols.size === 0) continue; // nothing existed to remove

    for (const [name, meta] of oldSymbols) {
      if (newSymbols.has(name)) continue;

      if (meta.deprecated) {
        allowedDeprecated += 1;
        console.log(`  ok  ${relPath}: '${name}' removed — was @deprecated in base.`);
        continue;
      }
      if (migrationMentions(name)) {
        allowedMigration += 1;
        console.log(
          `  ok  ${relPath}: '${name}' removed — named in MIGRATION.md § Unreleased.`,
        );
        continue;
      }
      violations.push({ relPath, name });
    }
  }

  if (violations.length > 0) {
    console.error('\ncheck-api-removals: FAIL — public symbol(s) removed without a grace path:\n');
    for (const v of violations) {
      console.error(`  ✗ ${v.relPath}: '${v.name}'`);
    }
    console.error(
      '\nTo resolve, either:\n' +
        "  1. Re-export the old name as a runtime-working `@deprecated` alias\n" +
        '     (grace window: one full major after first release), or\n' +
        "  2. Document the removal in MIGRATION.md's `## Unreleased` section by\n" +
        '     naming the symbol (intentional breaking change).\n' +
        'See MIGRATION.md § Release blockers for the policy.',
    );
    process.exit(1);
  }

  console.log(
    `\ncheck-api-removals: OK — ${reports.length} report(s) checked` +
      ` (${allowedDeprecated} deprecated removal(s), ${allowedMigration} migration-noted removal(s) allowed).`,
  );
}

main();
