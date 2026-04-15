/**
 * Component registry for tracking components and their model assumptions.
 *
 * @module
 */

import { HarnessError } from 'harness-one';
import type { ComponentMeta } from './types.js';

/** Registry for managing component metadata. */
export interface ComponentRegistry {
  register(meta: ComponentMeta): void;
  get(id: string): ComponentMeta | undefined;
  list(filter?: { tags?: string[] }): ComponentMeta[];
  validate(id: string, context?: Record<string, unknown>): { valid: boolean; reason: string };
  markValidated(id: string): void;
  getStale(maxAgeDays: number): ComponentMeta[];
}

/**
 * Create a component registry for tracking components and their retirement conditions.
 *
 * @example
 * ```ts
 * const registry = createComponentRegistry();
 * registry.register({
 *   id: 'ctx-packer',
 *   name: 'Context Packer',
 *   description: 'Packs messages into context window',
 *   modelAssumption: 'Models have limited context windows',
 *   retirementCondition: 'When models have unlimited context',
 *   createdAt: '2025-01-01',
 * });
 * ```
 */
export function createComponentRegistry(): ComponentRegistry {
  const components = new Map<string, ComponentMeta>();

  // Fix 10: Deep freeze utility for returning immutable copies
  function deepFreeze<T>(obj: T): T {
    if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
    // Use JSON parse/stringify for simple deep clone + freeze
    try {
      return JSON.parse(JSON.stringify(obj)) as T;
    } catch {
      // If not serializable (e.g., function conditions), return shallow copy
      return { ...obj } as T;
    }
  }

  return {
    register(meta) {
      if (components.has(meta.id)) {
        throw new HarnessError(
          `Component already registered: ${meta.id}`,
          'COMPONENT_DUPLICATE',
          'Use a unique component ID',
        );
      }
      components.set(meta.id, meta);
    },

    // Fix 10: Return a deep-frozen copy
    get(id) {
      const meta = components.get(id);
      if (!meta) return undefined;
      // For components with function retirement conditions, we can't JSON serialize
      // so return a frozen shallow copy
      if (typeof meta.retirementCondition === 'function') {
        return Object.freeze({ ...meta });
      }
      return Object.freeze(deepFreeze(meta));
    },

    list(filter) {
      let results = Array.from(components.values());
      if (filter?.tags && filter.tags.length > 0) {
        results = results.filter((c) =>
          filter.tags?.some((t) => c.tags?.includes(t)),
        );
      }
      return results;
    },

    validate(id, context) {
      const component = components.get(id);
      if (!component) {
        throw new HarnessError(
          `Component not found: ${id}`,
          'COMPONENT_NOT_FOUND',
          'Register the component before validating',
        );
      }
      // Evaluate retirement condition against provided context
      if (context && component.retirementCondition) {
        let conditionMet = false;
        if (typeof component.retirementCondition === 'function') {
          conditionMet = component.retirementCondition(context);
        } else {
          conditionMet = evaluateCondition(component.retirementCondition, context);
        }
        if (conditionMet) {
          const desc = typeof component.retirementCondition === 'function'
            ? 'Function condition met'
            : component.retirementCondition;
          return { valid: false, reason: `Retirement condition met: ${desc}` };
        }
      }
      if (!component.lastValidated) {
        return { valid: true, reason: 'Component has not been validated yet — assumption untested' };
      }
      return { valid: true, reason: 'Component assumption still valid' };
    },

    markValidated(id) {
      const component = components.get(id);
      if (!component) {
        throw new HarnessError(
          `Component not found: ${id}`,
          'COMPONENT_NOT_FOUND',
          'Register the component before marking as validated',
        );
      }
      components.set(id, {
        ...component,
        lastValidated: new Date().toISOString(),
      });
    },

    getStale(maxAgeDays) {
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      return Array.from(components.values()).filter((c) => {
        if (!c.lastValidated) return true;
        return new Date(c.lastValidated).getTime() < cutoff;
      });
    },
  };
}

/**
 * Evaluate a simple retirement condition string against a context object.
 *
 * Fix 11: Uses proper tokenization by splitting on whitespace first,
 * then identifying the operator token. This prevents matching operators
 * inside value strings. Validates that exactly 3 tokens exist (key, operator, value).
 *
 * Supports conditions in the form: `key operator value`
 * where operator is one of: >, <, >=, <=, ==, !=
 *
 * Also supports AND-chained conditions:
 *   "latency > 1000 AND accuracy < 0.5"
 * All clauses must be true for the overall condition to be true.
 *
 * Returns true if the condition is met (component should retire).
 * Returns false if the condition cannot be parsed or the key is missing from context.
 */
function evaluateCondition(condition: string, context: Record<string, unknown>): boolean {
  // Support: "clause1 AND clause2 [AND clause3 ...]"
  // Split is case-insensitive so "and" and "AND" both work.
  const clauses = condition.split(/\s+AND\s+/i);
  if (clauses.length > 1) {
    return clauses.every((clause) => evaluateSingleCondition(clause.trim(), context));
  }
  return evaluateSingleCondition(condition.trim(), context);
}

/**
 * Evaluate a single `key operator value` clause against a context object.
 *
 * Fix 11: Split by whitespace first, then identify the operator token.
 */
function evaluateSingleCondition(condition: string, context: Record<string, unknown>): boolean {
  const tokens = condition.trim().split(/\s+/);
  if (tokens.length !== 3) {
    // Not a valid 3-token condition
    return false;
  }

  const [key, op, valueStr] = tokens;
  const validOps = ['>=', '<=', '!=', '==', '>', '<'] as const;
  type ValidOp = typeof validOps[number];

  if (!validOps.includes(op as ValidOp)) {
    return false;
  }

  if (!key || !(key in context)) return false;

  const contextValue = context[key];
  const targetValue = Number(valueStr);

  if (typeof contextValue !== 'number' || Number.isNaN(targetValue)) return false;

  switch (op as ValidOp) {
    case '>':  return contextValue > targetValue;
    case '<':  return contextValue < targetValue;
    case '>=': return contextValue >= targetValue;
    case '<=': return contextValue <= targetValue;
    case '==': return contextValue === targetValue;
    case '!=': return contextValue !== targetValue;
  }
}
