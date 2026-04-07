/**
 * Architecture checker — validates architectural rules and constraints.
 *
 * @module
 */

import type { ArchitectureRule, RuleContext, RuleResult } from './types.js';

/** Interface for checking architecture rules. */
export interface ArchitectureChecker {
  addRule(rule: ArchitectureRule): void;
  check(context: RuleContext): { passed: boolean; violations: RuleResult[] };
  listRules(): ArchitectureRule[];
}

/**
 * Create an architecture checker that validates rules against a codebase context.
 *
 * @example
 * ```ts
 * const checker = createArchitectureChecker();
 * checker.addRule(noCircularDepsRule(['core', 'context']));
 * const result = checker.check({ files: ['src/core/index.ts'], imports: {} });
 * ```
 */
export function createArchitectureChecker(): ArchitectureChecker {
  const rules: ArchitectureRule[] = [];

  return {
    addRule(rule) {
      rules.push(rule);
    },

    check(context) {
      const violations: RuleResult[] = [];
      let allPassed = true;

      for (const rule of rules) {
        const result = rule.check(context);
        if (!result.passed) {
          allPassed = false;
          violations.push(result);
        }
      }

      return { passed: allPassed, violations };
    },

    listRules() {
      return [...rules];
    },
  };
}

/**
 * Create a rule that detects circular dependencies between modules.
 *
 * @example
 * ```ts
 * const rule = noCircularDepsRule(['core', 'context', 'tools']);
 * ```
 */
export function noCircularDepsRule(allowedModules: string[]): ArchitectureRule {
  return {
    id: 'no-circular-deps',
    name: 'No Circular Dependencies',
    description: `Ensures no circular imports between modules: ${allowedModules.join(', ')}`,
    check(context: RuleContext): RuleResult {
      const violations: Array<{ file: string; message: string; suggestion: string }> = [];

      // Build adjacency list from imports
      const graph = new Map<string, Set<string>>();
      for (const mod of allowedModules) {
        graph.set(mod, new Set());
      }

      for (const [file, imports] of Object.entries(context.imports)) {
        const sourceModule = getModule(file, allowedModules);
        if (!sourceModule) continue;

        for (const imp of imports) {
          const targetModule = getModule(imp, allowedModules);
          if (targetModule && targetModule !== sourceModule) {
            graph.get(sourceModule)?.add(targetModule);
          }
        }
      }

      // Detect cycles using DFS
      for (const mod of allowedModules) {
        const visited = new Set<string>();
        const stack = new Set<string>();
        if (hasCycle(mod, graph, visited, stack)) {
          violations.push({
            file: mod,
            message: `Circular dependency detected involving module: ${mod}`,
            suggestion: `Refactor to break the cycle in module: ${mod}`,
          });
        }
      }

      return { passed: violations.length === 0, violations };
    },
  };
}

/**
 * Create a rule that enforces layer dependency constraints.
 *
 * @example
 * ```ts
 * const rule = layerDependencyRule({
 *   core: [],
 *   context: ['core'],
 *   tools: ['core'],
 * });
 * ```
 */
export function layerDependencyRule(layers: Record<string, string[]>): ArchitectureRule {
  return {
    id: 'layer-dependency',
    name: 'Layer Dependency',
    description: 'Ensures modules only import from allowed layers',
    check(context: RuleContext): RuleResult {
      const violations: Array<{ file: string; message: string; suggestion: string }> = [];
      const moduleNames = Object.keys(layers);

      for (const [file, imports] of Object.entries(context.imports)) {
        const sourceModule = getModule(file, moduleNames);
        if (!sourceModule) continue;

        const allowed = layers[sourceModule] ?? [];

        for (const imp of imports) {
          const targetModule = getModule(imp, moduleNames);
          if (targetModule && targetModule !== sourceModule && !allowed.includes(targetModule)) {
            violations.push({
              file,
              message: `Module '${sourceModule}' imports from '${targetModule}', which is not allowed`,
              suggestion: `Only import from: ${allowed.length > 0 ? allowed.join(', ') : '(none)'}`,
            });
          }
        }
      }

      return { passed: violations.length === 0, violations };
    },
  };
}

function getModule(filePath: string, modules: string[]): string | undefined {
  const segments = filePath.split('/');
  return modules.find((m) => segments.includes(m));
}

function hasCycle(
  node: string,
  graph: Map<string, Set<string>>,
  visited: Set<string>,
  stack: Set<string>,
): boolean {
  visited.add(node);
  stack.add(node);

  for (const neighbor of graph.get(node) ?? []) {
    if (stack.has(neighbor)) return true;
    if (!visited.has(neighbor) && hasCycle(neighbor, graph, visited, stack)) return true;
  }

  stack.delete(node);
  return false;
}
