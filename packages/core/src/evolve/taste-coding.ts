/**
 * Taste-coding registry — codify lessons from incidents into enforceable rules.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type { TasteCodingRule } from './types.js';

/** A single compliance violation found during checkCompliance. */
export interface TasteViolation {
  readonly ruleId: string;
  readonly rule: string;
  readonly pattern: string;
  readonly enforcement: string;
}

/** Metrics about the taste-coding registry state. */
export interface TasteMetrics {
  readonly totalRules: number;
  readonly byEnforcement: { lint: number; ci: number; manual: number };
  readonly lastCheckTimestamp: number | null;
}

/** Registry for managing taste-coding rules. */
export interface TasteCodingRegistry {
  addRule(rule: TasteCodingRule): void;
  getRules(filter?: { enforcement?: string }): TasteCodingRule[];
  removeRule(id: string): void;
  exportRules(): string;
  count(): number;
  checkCompliance(code: string): TasteViolation[];
  getMetrics(): TasteMetrics;
}

/**
 * Create a taste-coding registry for managing incident-derived coding rules.
 *
 * @example
 * ```ts
 * const registry = createTasteCodingRegistry();
 * registry.addRule({
 *   id: 'tc-001',
 *   pattern: 'Using plain Error instead of HarnessError',
 *   rule: 'Always use HarnessError with a code and suggestion',
 *   enforcement: 'lint',
 *   createdFrom: 'PR #42',
 *   createdAt: '2025-06-01',
 * });
 * ```
 */
export function createTasteCodingRegistry(): TasteCodingRegistry {
  const rules = new Map<string, TasteCodingRule>();
  let lastCheckTimestamp: number | null = null;

  return {
    addRule(rule) {
      if (rules.has(rule.id)) {
        throw new HarnessError(
          `Taste-coding rule already exists: ${rule.id}`,
          'TASTE_DUPLICATE',
          'Use a unique rule ID or remove the existing rule first',
        );
      }
      rules.set(rule.id, rule);
    },

    getRules(filter) {
      let results = Array.from(rules.values());
      if (filter?.enforcement) {
        results = results.filter((r) => r.enforcement === filter.enforcement);
      }
      return results;
    },

    removeRule(id) {
      if (!rules.delete(id)) {
        throw new HarnessError(
          `Taste-coding rule not found: ${id}`,
          'TASTE_NOT_FOUND',
          'Check the rule ID',
        );
      }
    },

    exportRules() {
      const allRules = Array.from(rules.values());
      if (allRules.length === 0) return '# Taste-Coding Rules\n\nNo rules defined.\n';

      const lines = ['# Taste-Coding Rules', ''];
      for (const rule of allRules) {
        lines.push(`## ${rule.id}: ${rule.rule}`);
        lines.push('');
        lines.push(`- **Pattern**: ${rule.pattern}`);
        lines.push(`- **Enforcement**: ${rule.enforcement}`);
        lines.push(`- **Created from**: ${rule.createdFrom}`);
        lines.push(`- **Date**: ${rule.createdAt}`);
        lines.push('');
      }
      return lines.join('\n');
    },

    count() {
      return rules.size;
    },

    checkCompliance(code) {
      const violations: TasteViolation[] = [];
      for (const rule of rules.values()) {
        if (rule.enforcement !== 'lint' && rule.enforcement !== 'ci') continue;
        if (code.includes(rule.pattern)) {
          violations.push({
            ruleId: rule.id,
            rule: rule.rule,
            pattern: rule.pattern,
            enforcement: rule.enforcement,
          });
        }
      }
      lastCheckTimestamp = Date.now();
      return violations;
    },

    getMetrics() {
      const allRules = Array.from(rules.values());
      const byEnforcement = { lint: 0, ci: 0, manual: 0 };
      for (const rule of allRules) {
        if (rule.enforcement in byEnforcement) {
          byEnforcement[rule.enforcement]++;
        }
      }
      return {
        totalRules: allRules.length,
        byEnforcement,
        lastCheckTimestamp,
      };
    },
  };
}
