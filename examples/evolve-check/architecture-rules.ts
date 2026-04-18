/**
 * Example: `createArchitectureChecker` — enforce layer + cycle invariants at CI/boot.
 *
 * Pattern:
 *   1. Build a `RuleContext` by scanning the project (file system + import map).
 *   2. Register one or more `ArchitectureRule`s.
 *   3. `checker.check(ctx)` — any violation fails CI.
 *
 * Two rules ship built-in:
 *   - `noCircularDepsRule(modules)` — DFS cycle detection in the import graph.
 *   - `layerDependencyRule(layers)` — "module X may only import from [A, B]".
 *
 * Runs at CI (via `scanProject` in `@harness-one/devkit`) OR at boot time
 * against your bundler's dependency graph. Both paths share the same API so
 * "CI passed but prod logic differs" drift is impossible by construction.
 */
import {
  createArchitectureChecker,
  noCircularDepsRule,
  layerDependencyRule,
} from 'harness-one/evolve-check';
import type { RuleContext, ArchitectureRule } from 'harness-one/evolve-check';

function main(): void {
  // ── 1. Build a context — normally from @harness-one/devkit's scanProject ─
  // For a runnable demo we hand-craft an example import graph:
  const ctx: RuleContext = {
    files: [
      'src/core/agent-loop.ts',
      'src/tools/registry.ts',
      'src/guardrails/pipeline.ts',
    ],
    imports: {
      'src/core/agent-loop.ts':   ['src/infra/backoff.ts'],
      'src/tools/registry.ts':    ['src/core/errors.ts', 'src/infra/json-schema.ts'],
      'src/guardrails/pipeline.ts': ['src/core/errors.ts'],
      // A cycle to trigger the built-in rule:
      'src/a/mod.ts': ['src/b/mod.ts'],
      'src/b/mod.ts': ['src/a/mod.ts'],
    },
  };

  // ── 2. Register rules ────────────────────────────────────────────────────
  const checker = createArchitectureChecker();

  checker.addRule(noCircularDepsRule(['a', 'b', 'core', 'tools', 'guardrails']));

  checker.addRule(
    layerDependencyRule({
      // L3 subsystems — may only import from core + infra, not each other.
      tools:      ['core', 'infra'],
      guardrails: ['core', 'infra'],
      // L2 core — may only depend on L1 infra.
      core:       ['infra'],
      // L1 infra — depends on nothing.
      infra:      [],
    }),
  );

  // ── 3. Custom rule: ban a deprecated module ─────────────────────────────
  const noLegacyHelper: ArchitectureRule = {
    id: 'no-legacy-helper',
    name: 'No legacy helper imports',
    description: 'Bans imports from src/legacy — module is slated for deletion.',
    check(context) {
      const violations: Array<{ file: string; message: string; suggestion: string }> = [];
      for (const [file, imps] of Object.entries(context.imports)) {
        for (const imp of imps) {
          if (imp.includes('/legacy/')) {
            violations.push({
              file,
              message: `imports deprecated legacy module: ${imp}`,
              suggestion: 'Replace with the modern equivalent or inline the helper.',
            });
          }
        }
      }
      return { passed: violations.length === 0, violations };
    },
  };
  checker.addRule(noLegacyHelper);

  // ── 4. Execute — any `passed: false` rule => fail CI ─────────────────────
  const result = checker.check(ctx);
  if (!result.passed) {
    console.error('Architecture check FAILED:');
    for (const ruleResult of result.violations) {
      for (const v of ruleResult.violations) {
        console.error(`  ${v.file}: ${v.message}`);
        console.error(`    → ${v.suggestion}`);
      }
    }
    process.exit(1);
  }
  console.log('Architecture check passed ✓');
}

main();
