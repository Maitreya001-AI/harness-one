/**
 * Template storage with versioning and variable resolution.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type { PromptTemplate } from './types.js';

/** Registry for storing and resolving versioned prompt templates. */
export interface PromptRegistry {
  /** Register a prompt template (immutable after registration). */
  register(template: PromptTemplate): void;
  /** Get a template by ID and optional version. */
  get(id: string, version?: string): PromptTemplate | undefined;
  /** Resolve a template's variables and return the final string. */
  resolve(id: string, variables: Record<string, string>, version?: string): string;
  /** List all registered templates. */
  list(): PromptTemplate[];
  /** Check if a template ID exists. */
  has(id: string): boolean;
}

/**
 * Create a new PromptRegistry instance.
 *
 * @example
 * ```ts
 * const registry = createPromptRegistry();
 * registry.register({ id: 'greeting', version: '1.0', content: 'Hello {{name}}!', variables: ['name'] });
 * const result = registry.resolve('greeting', { name: 'Alice' });
 * // result === 'Hello Alice!'
 * ```
 */
export function createPromptRegistry(): PromptRegistry {
  // Map<id, Map<version, PromptTemplate>>
  const store = new Map<string, Map<string, PromptTemplate>>();

  function getLatestVersion(id: string): PromptTemplate | undefined {
    const versions = store.get(id);
    if (!versions || versions.size === 0) return undefined;
    // Return the last inserted version
    let latest: PromptTemplate | undefined;
    for (const t of versions.values()) {
      latest = t;
    }
    return latest;
  }

  return {
    register(template: PromptTemplate): void {
      const frozen = Object.freeze({ ...template });
      let versions = store.get(template.id);
      if (!versions) {
        versions = new Map();
        store.set(template.id, versions);
      }
      versions.set(template.version, frozen);
    },

    get(id: string, version?: string): PromptTemplate | undefined {
      const versions = store.get(id);
      if (!versions) return undefined;
      if (version) return versions.get(version);
      return getLatestVersion(id);
    },

    resolve(id: string, variables: Record<string, string>, version?: string): string {
      const template = this.get(id, version);
      if (!template) {
        throw new HarnessError(
          `Template not found: ${id}${version ? `@${version}` : ''}`,
          'TEMPLATE_NOT_FOUND',
          'Register the template before resolving',
        );
      }

      let content = template.content;
      for (const varName of template.variables) {
        if (!(varName in variables)) {
          throw new HarnessError(
            `Missing required variable: ${varName} for template ${id}`,
            'MISSING_VARIABLE',
            `Provide a value for "{{${varName}}}"`,
          );
        }
        content = content.replaceAll(`{{${varName}}}`, variables[varName]);
      }
      return content;
    },

    list(): PromptTemplate[] {
      const result: PromptTemplate[] = [];
      for (const versions of store.values()) {
        for (const t of versions.values()) {
          result.push(t);
        }
      }
      return result;
    },

    has(id: string): boolean {
      return store.has(id);
    },
  };
}
