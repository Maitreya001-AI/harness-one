/**
 * Component registry for tracking components and their model assumptions.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type { ComponentMeta } from './types.js';

/** Registry for managing component metadata. */
export interface ComponentRegistry {
  register(meta: ComponentMeta): void;
  get(id: string): ComponentMeta | undefined;
  list(filter?: { tags?: string[] }): ComponentMeta[];
  validate(id: string): { valid: boolean; reason: string };
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

    get(id) {
      return components.get(id);
    },

    list(filter) {
      let results = Array.from(components.values());
      if (filter?.tags && filter.tags.length > 0) {
        results = results.filter((c) =>
          filter.tags!.some((t) => c.tags?.includes(t)),
        );
      }
      return results;
    },

    validate(id) {
      const component = components.get(id);
      if (!component) {
        throw new HarnessError(
          `Component not found: ${id}`,
          'COMPONENT_NOT_FOUND',
          'Register the component before validating',
        );
      }
      // The actual retirement check is domain-specific; here we return valid
      // unless the component has never been validated
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
