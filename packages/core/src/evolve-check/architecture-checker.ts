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
 * Fix 13: Caches dependency graph analysis results (cycle detection) between
 * rule checks. The cache is invalidated when rules or modules change, avoiding
 * repeated O(V*(V+E)) DFS computations.
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
  // Fix 13: Cache for check results, keyed by a hash of context
  let lastContextHash = '';
  let cachedResult: { passed: boolean; violations: RuleResult[] } | null = null;
  let lastRuleCount = 0;

  function hashContext(context: RuleContext): string {
    return JSON.stringify({ files: context.files, imports: context.imports });
  }

  return {
    addRule(rule) {
      rules.push(rule);
      // Invalidate cache when rules change
      cachedResult = null;
    },

    check(context) {
      // Fix 13: Return cached result if context and rules haven't changed
      const contextHash = hashContext(context);
      if (cachedResult && contextHash === lastContextHash && rules.length === lastRuleCount) {
        return cachedResult;
      }

      const violations: RuleResult[] = [];
      let allPassed = true;

      for (const rule of rules) {
        const result = rule.check(context);
        if (!result.passed) {
          allPassed = false;
          violations.push(result);
        }
      }

      const result = { passed: allPassed, violations };

      // Update cache
      lastContextHash = contextHash;
      lastRuleCount = rules.length;
      cachedResult = result;

      return result;
    },

    listRules() {
      return [...rules];
    },
  };
}

/**
 * Create a rule that detects circular dependencies between modules.
 *
 * Fix 14: Enhanced violation suggestions include the specific modules
 * involved in the cycle, rather than generic advice.
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

      // Detect cycles using DFS — Fix 14: track the actual cycle path
      for (const mod of allowedModules) {
        const visited = new Set<string>();
        const stack = new Set<string>();
        const path: string[] = [];
        const cyclePath = findCyclePath(mod, graph, visited, stack, path);
        if (cyclePath) {
          // Fix 14: Specific suggestion with involved modules
          const cycleStr = cyclePath.join(' -> ');
          violations.push({
            file: mod,
            message: `Circular dependency detected: ${cycleStr}`,
            suggestion: `Circular dependency: ${cycleStr}. Consider extracting shared interface from ${cyclePath[0]} and ${cyclePath[cyclePath.length - 2]} into a separate module.`,
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

/**
 * Determine which module a file path belongs to.
 *
 * Uses exact directory-segment matching so that a module named "context" does
 * not accidentally match paths like "src/my_context/foo.ts" or
 * "src/scorecard/bar.ts".  A match only occurs when the module name appears as
 * a complete path segment delimited by slashes (or at the very end of the
 * path).
 */
function getModule(filePath: string, modules: string[]): string | undefined {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return modules.find((m) => {
    // Require the module name to be surrounded by slashes, or to end the path
    const pattern = `/${m}/`;
    return normalizedPath.includes(pattern) || normalizedPath.endsWith(`/${m}`);
  });
}

/** Find a cycle path using DFS. Returns the cycle path or null. */
function findCyclePath(
  node: string,
  graph: Map<string, Set<string>>,
  visited: Set<string>,
  stack: Set<string>,
  path: string[],
): string[] | null {
  visited.add(node);
  stack.add(node);
  path.push(node);

  for (const neighbor of graph.get(node) ?? []) {
    if (stack.has(neighbor)) {
      // Found a cycle — return path from neighbor back to neighbor
      const cycleStart = path.indexOf(neighbor);
      return [...path.slice(cycleStart), neighbor];
    }
    if (!visited.has(neighbor)) {
      const result = findCyclePath(neighbor, graph, visited, stack, path);
      if (result) return result;
    }
  }

  path.pop();
  stack.delete(node);
  return null;
}
