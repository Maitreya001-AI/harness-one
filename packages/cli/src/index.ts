#!/usr/bin/env node

/**
 * CLI scaffolding tool for harness-one.
 *
 * Usage:
 *   npx harness-one init                    # Interactive -- choose modules
 *   npx harness-one init --all              # Scaffold all modules
 *   npx harness-one init --modules core,guardrails,context
 *   npx harness-one audit                   # Check which modules are in use
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// Re-export public API from sub-modules
export { ALL_MODULES, parseArgs, MODULE_DESCRIPTIONS } from './parser.js';
export type { ModuleName, ParsedArgs } from './parser.js';
export { getTemplate, FILE_NAMES } from './templates.js';
export { auditProject, scanFiles, maturityLabel } from './audit.js';
export { c, SUPPORTS_COLOR } from './ui.js';

// Internal imports for the main() function
import { ALL_MODULES, parseArgs, MODULE_DESCRIPTIONS } from './parser.js';
import type { ModuleName, ParsedArgs } from './parser.js';
import { getTemplate, FILE_NAMES } from './templates.js';
import { auditProject, maturityLabel } from './audit.js';
import { c } from './ui.js';

// ── Init command ──────────────────────────────────────────────────────────────

/** @internal Exported for testing only. */
export async function promptModules(): Promise<ModuleName[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((res) => rl.question(q, res));

  console.log(c.bold('\nAvailable modules:\n'));
  ALL_MODULES.forEach((mod, i) => {
    console.log(`  ${c.cyan(`${i + 1}.`)} ${c.bold(mod)} -- ${MODULE_DESCRIPTIONS[mod]}`);
  });

  console.log(`\n  ${c.cyan('a.')} ${c.bold('all')} -- scaffold all modules\n`);

  const answer = await ask(c.bold('Select modules (comma-separated numbers, or "a" for all): '));
  rl.close();

  if (answer.trim().toLowerCase() === 'a') {
    return [...ALL_MODULES];
  }

  const indices = answer
    .split(',')
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((i) => i >= 0 && i < ALL_MODULES.length);

  return indices.map((i) => ALL_MODULES[i]);
}

/** @internal Exported for testing only. */
export function writeModuleFiles(modules: ModuleName[], cwd: string): string[] {
  const dir = join(cwd, 'harness');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const written: string[] = [];
  for (const mod of modules) {
    const fileName = FILE_NAMES[mod];
    const filePath = join(dir, fileName);
    if (existsSync(filePath)) {
      console.log(c.yellow(`  skip  ${filePath} (already exists)`));
      continue;
    }
    writeFileSync(filePath, getTemplate(mod), 'utf-8');
    console.log(c.green(`  create  ${filePath}`));
    written.push(filePath);
  }
  return written;
}

/** @internal Exported for testing only. */
export async function runInit(parsed: ParsedArgs): Promise<void> {
  console.log(c.bold('\nharness-one init\n'));

  let modules = parsed.modules;
  if (modules.length === 0) {
    modules = await promptModules();
  }

  if (modules.length === 0) {
    console.log(c.yellow('No modules selected. Exiting.'));
    return;
  }

  console.log(c.dim(`\nScaffolding ${modules.length} module(s)...\n`));
  const cwd = process.cwd();
  const written = writeModuleFiles(modules, cwd);

  console.log(
    `\n${c.green('Done!')} Created ${c.bold(String(written.length))} file(s) in ${c.cyan('harness/')}`,
  );
  if (written.length > 0) {
    console.log(c.dim('\nNext steps:'));
    console.log(c.dim('  1. Install harness-one:  npm install harness-one'));
    console.log(c.dim('  2. Edit the generated files to fit your project'));
    console.log(c.dim('  3. Run: npx harness-one audit  to check coverage\n'));
  }
}

// ── Audit command ─────────────────────────────────────────────────────────────

/** @internal Exported for testing only. */
export function runAudit(): void {
  console.log(c.bold('\nharness-one audit\n'));
  const cwd = process.cwd();
  const { used, unused, fileCount } = auditProject(cwd);

  console.log(c.dim(`Scanned ${fileCount} source files\n`));

  if (used.length > 0) {
    console.log(c.green('Modules in use:'));
    for (const mod of used) {
      console.log(`  ${c.green('*')} ${c.bold(mod)} -- ${MODULE_DESCRIPTIONS[mod]}`);
    }
  } else {
    console.log(c.yellow('No harness-one imports found.'));
  }

  if (unused.length > 0) {
    console.log(c.yellow('\nModules not used:'));
    for (const mod of unused) {
      console.log(`  ${c.dim('-')} ${c.dim(mod)} -- ${MODULE_DESCRIPTIONS[mod]}`);
    }
  }

  console.log(`\n${c.bold('Coverage:')} ${used.length}/${ALL_MODULES.length} modules`);
  console.log(`${c.bold('Maturity:')} ${maturityLabel(used.length, c)}\n`);
}

// ── Help ──────────────────────────────────────────────────────────────────────

/** @internal Exported for testing only. */
export function showHelp(): void {
  console.log(`
${c.bold('harness-one')} -- CLI scaffolding tool

${c.bold('Usage:')}
  npx harness-one init                     Interactive module selection
  npx harness-one init --all               Scaffold all modules
  npx harness-one init --modules core,tools Scaffold specific modules
  npx harness-one audit                    Check module usage in project
  npx harness-one help                     Show this help message
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  switch (parsed.command) {
    case 'init':
      await runInit(parsed);
      break;
    case 'audit':
      runAudit();
      break;
    case 'help':
    default:
      showHelp();
      break;
  }
}

main().catch((err) => {
  console.error(c.red('Error:'), err instanceof Error ? err.message : String(err));
  process.exit(1);
});
