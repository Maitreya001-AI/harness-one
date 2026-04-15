/**
 * Taste-coding registry — codify lessons from incidents into enforceable rules.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type { TasteCodingRule } from './types.js';

/** Maximum allowed pattern length. Patterns exceeding this are rejected. */
const MAX_PATTERN_LENGTH = 500;

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

/** Escape special regex characters in a string for safe use in `new RegExp()`. */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

      // Fix 12: Validate pattern length
      if (rule.pattern.length > MAX_PATTERN_LENGTH) {
        throw new HarnessError(
          `Pattern too long (${rule.pattern.length} chars, max ${MAX_PATTERN_LENGTH}). Patterns should be simple word-match patterns, not complex regexes.`,
          'INVALID_PATTERN',
          `Reduce pattern length to ${MAX_PATTERN_LENGTH} characters or fewer`,
        );
      }

      // Fix 12: Validate that the pattern is a valid regex when escaped
      try {
        new RegExp(`\\b${escapeRegExp(rule.pattern)}\\b`);
      } catch {
        throw new HarnessError(
          `Invalid pattern: "${rule.pattern}". Patterns should be simple word-match patterns, not complex regexes.`,
          'INVALID_PATTERN',
          'Use a simple string pattern that can be safely converted to a regex',
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

        // Fix 12: Wrap regex construction in try-catch for safety
        let regex: RegExp;
        try {
          regex = new RegExp(`\\b${escapeRegExp(rule.pattern)}\\b`);
        } catch {
          // Skip invalid patterns gracefully
          continue;
        }

        if (regex.test(code)) {
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
