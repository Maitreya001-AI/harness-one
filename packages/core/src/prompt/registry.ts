/**
 * Template storage with versioning and variable resolution.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type { PromptTemplate, PromptBackend } from './types.js';

/**
 * Compare two semantic version strings (e.g. "1.10.2" vs "1.2.3").
 * Returns a positive number if a > b, negative if a < b, or 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** Options for template registration. */
export interface RegisterOptions {
  /** If true, silently overwrite an existing version. Default: false (logs a warning). */
  readonly force?: boolean;
}

/** Registry for storing and resolving versioned prompt templates. */
export interface PromptRegistry {
  /** Register a prompt template (immutable after registration). */
  register(template: PromptTemplate, options?: RegisterOptions): void;
  /** Get a template by ID and optional version. */
  get(id: string, version?: string): PromptTemplate | undefined;
  /** Resolve a template's variables and return the final string. */
  resolve(id: string, variables: Record<string, string>, version?: string): string;
  /** List all registered templates. */
  list(): PromptTemplate[];
  /** Check if a template ID exists. */
  has(id: string): boolean;
  /** Check whether a template has exceeded its TTL. Returns false for unknown ids or templates without expiresAt. */
  isExpired(id: string, version?: string): boolean;
  /** Return all templates whose expiresAt is in the past. */
  getExpired(): PromptTemplate[];
  /** Remove all expired templates from the registry and return the count removed. */
  removeExpired(): number;
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
  // Explicit latest version tracking: id -> latest version string
  const latestVersions = new Map<string, string>();

  function getLatestVersion(id: string): PromptTemplate | undefined {
    const latestVer = latestVersions.get(id);
    if (!latestVer) return undefined;
    return store.get(id)?.get(latestVer);
  }

  return {
    register(template: PromptTemplate, options?: RegisterOptions): void {
      const frozen = Object.freeze({ ...template });
      let versions = store.get(template.id);
      if (!versions) {
        versions = new Map();
        store.set(template.id, versions);
      }

      if (versions.has(template.version) && !(options?.force)) {
         
        console.warn(
          `[harness-one] Overwriting template "${template.id}@${template.version}". Pass { force: true } to suppress this warning.`,
        );
      }

      versions.set(template.version, frozen);

      const existing = latestVersions.get(template.id);
      if (!existing || compareSemver(template.version, existing) > 0) {
        latestVersions.set(template.id, template.version);
      }
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

    isExpired(id: string, version?: string): boolean {
      const template = this.get(id, version);
      if (!template || template.expiresAt == null) return false;
      return Date.now() > template.expiresAt;
    },

    getExpired(): PromptTemplate[] {
      const now = Date.now();
      const result: PromptTemplate[] = [];
      for (const versions of store.values()) {
        for (const t of versions.values()) {
          if (t.expiresAt != null && now > t.expiresAt) {
            result.push(t);
          }
        }
      }
      return result;
    },

    removeExpired(): number {
      const now = Date.now();
      let count = 0;
      for (const [id, versions] of store) {
        for (const [ver, t] of versions) {
          if (t.expiresAt != null && now > t.expiresAt) {
            versions.delete(ver);
            count++;
          }
        }
        if (versions.size === 0) {
          store.delete(id);
          latestVersions.delete(id);
        } else {
          // Recompute latest version for this id if it was affected
          const currentLatest = latestVersions.get(id);
          if (currentLatest && !versions.has(currentLatest)) {
            let newLatest: string | undefined;
            for (const ver of versions.keys()) {
              if (!newLatest || compareSemver(ver, newLatest) > 0) {
                newLatest = ver;
              }
            }
            if (newLatest) {
              latestVersions.set(id, newLatest);
            } else {
              latestVersions.delete(id);
            }
          }
        }
      }
      return count;
    },
  };
}

/** Async prompt registry that falls back to a remote backend when templates are not cached locally. */
export interface AsyncPromptRegistry {
  /** Register a template locally (local override). */
  register(template: PromptTemplate): void;
  /** Get a template by ID — checks local cache first, then falls back to backend. */
  get(id: string, version?: string): Promise<PromptTemplate | undefined>;
  /** Resolve a template's variables — fetches from backend if not cached locally. */
  resolve(id: string, variables: Record<string, string>, version?: string): Promise<string>;
  /** List all templates from both local cache and backend. */
  list(): Promise<PromptTemplate[]>;
  /** Check if a template ID exists in local cache only. */
  has(id: string): boolean;
  /** Pre-fetch templates from the backend into local cache. Returns which IDs succeeded/failed. */
  prefetch(ids: string[]): Promise<{ succeeded: string[]; failed: string[] }>;
}

/**
 * Create an async prompt registry backed by a remote PromptBackend.
 *
 * Local registrations take priority over backend results.
 *
 * @example
 * ```ts
 * const registry = createAsyncPromptRegistry(myLangfuseBackend);
 * const template = await registry.get('greeting');
 * const result = await registry.resolve('greeting', { name: 'Alice' });
 * ```
 */
export function createAsyncPromptRegistry(backend: PromptBackend): AsyncPromptRegistry {
  const localRegistry = createPromptRegistry();

  return {
    register(template: PromptTemplate): void {
      localRegistry.register(template);
    },

    async get(id: string, version?: string): Promise<PromptTemplate | undefined> {
      const local = localRegistry.get(id, version);
      if (local) return local;

      const remote = await backend.fetch(id, version);
      if (remote) {
        localRegistry.register(remote);
      }
      return remote;
    },

    async resolve(id: string, variables: Record<string, string>, version?: string): Promise<string> {
      const template = await this.get(id, version);
      if (!template) {
        throw new HarnessError(
          `Template not found: ${id}${version ? `@${version}` : ''}`,
          'TEMPLATE_NOT_FOUND',
          'Register the template or ensure the backend can provide it',
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

    async list(): Promise<PromptTemplate[]> {
      const localTemplates = localRegistry.list();
      if (!backend.list) return localTemplates;

      const remoteTemplates = await backend.list();
      const localIds = new Set(localTemplates.map((t) => `${t.id}@${t.version}`));
      const merged = [...localTemplates];
      for (const rt of remoteTemplates) {
        if (!localIds.has(`${rt.id}@${rt.version}`)) {
          merged.push(rt);
        }
      }
      return merged;
    },

    has(id: string): boolean {
      return localRegistry.has(id);
    },

    async prefetch(ids: string[]): Promise<{ succeeded: string[]; failed: string[] }> {
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          if (!localRegistry.has(id)) {
            const remote = await backend.fetch(id);
            if (remote) {
              localRegistry.register(remote);
            }
          }
          return id;
        }),
      );

      const succeeded: string[] = [];
      const failed: string[] = [];
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled') {
          succeeded.push(ids[i]);
        } else {
          failed.push(ids[i]);
        }
      }
      return { succeeded, failed };
    },
  };
}
