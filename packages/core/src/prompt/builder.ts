/**
 * Multi-layer prompt assembly with KV-cache optimization.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import type { PromptLayer, AssembledPrompt } from './types.js';
import { estimateTokens as estimateTokensInternal } from '../_internal/token-estimator.js';

/** Builder for assembling multi-layer prompts with cache optimization. */
export interface PromptBuilder {
  /** Add a layer to the prompt assembly. */
  addLayer(layer: PromptLayer): void;
  /** Remove a layer by name. */
  removeLayer(name: string): void;
  /** Set a template variable value. */
  setVariable(key: string, value: string): void;
  /** Assemble all layers into a final prompt. */
  build(): AssembledPrompt;
  /** Get the hash of cacheable layers for KV-cache hit tracking. */
  getStablePrefixHash(): string;
}

/**
 * Create a new PromptBuilder instance.
 *
 * @example
 * ```ts
 * const builder = createPromptBuilder({ separator: '\n\n' });
 * builder.addLayer({ name: 'system', content: 'You are helpful.', priority: 0, cacheable: true });
 * builder.addLayer({ name: 'user', content: 'Hello {{name}}', priority: 10, cacheable: false });
 * builder.setVariable('name', 'Alice');
 * const result = builder.build();
 * ```
 */
export function createPromptBuilder(config?: {
  separator?: string;
  maxTokens?: number;
  model?: string;
}): PromptBuilder {
  const separator = config?.separator ?? '\n\n';
  const maxTokens = config?.maxTokens;
  const model = config?.model ?? 'default';
  const layers = new Map<string, PromptLayer>();
  const variables = new Map<string, string>();
  // Dirty flag: set when layers or variables change, cleared after build().
  // Avoids recomputing sorted layers and token counts when nothing changed.
  let dirty = true;
  let cachedResult: AssembledPrompt | undefined;

  function estimateTokens(text: string): number {
    return estimateTokensInternal(model, text);
  }

  function replaceVariables(text: string): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const value = variables.get(key);
      return value !== undefined ? value : `{{${key}}}`;
    });
  }

  function hashString(str: string): string {
    return createHash('sha256').update(str).digest('hex').slice(0, 16);
  }

  function getSortedLayers(): PromptLayer[] {
    const all = Array.from(layers.values());
    // Cacheable first, then by priority (lower = more important)
    return all.sort((a, b) => {
      if (a.cacheable !== b.cacheable) return a.cacheable ? -1 : 1;
      return a.priority - b.priority;
    });
  }

  return {
    addLayer(layer: PromptLayer): void {
      layers.set(layer.name, Object.freeze({ ...layer }));
      dirty = true;
    },

    removeLayer(name: string): void {
      layers.delete(name);
      dirty = true;
    },

    setVariable(key: string, value: string): void {
      if (variables.get(key) !== value) {
        variables.set(key, value);
        dirty = true;
      }
    },

    build(): AssembledPrompt {
      // Return cached result if nothing changed since last build
      if (!dirty && cachedResult) return cachedResult;
      let sorted = getSortedLayers();

      // Compute stable prefix hash from raw (unreplaced) cacheable content.
      // Using raw templates (with {{variables}}) ensures that variable replacement
      // doesn't invalidate the KV-cache prefix — the cacheable structure is stable
      // even as variable values change between calls.
      const rawCacheableContent = sorted
        .filter(l => l.cacheable)
        .map(l => l.content)
        .join(separator);
      const stablePrefixHash = hashString(rawCacheableContent);

      // Apply variable replacement
      sorted = sorted.map(l => ({
        ...l,
        content: replaceVariables(l.content),
      }));

      // Cache token counts to avoid recomputation
      const tokenCounts = new Map<string, number>();
      function getTokens(content: string): number {
        let count = tokenCounts.get(content);
        if (count === undefined) {
          count = estimateTokens(content);
          tokenCounts.set(content, count);
        }
        return count;
      }

      // Trim if maxTokens set — remove non-cacheable layers from highest priority number first
      if (maxTokens !== undefined) {
        let totalTokens = sorted.reduce((sum, l) => sum + getTokens(l.content), 0);
        if (totalTokens > maxTokens) {
          // Sort non-cacheable layers by priority ascending (lowest priority number = most important = added first)
          const cacheableLayers = sorted.filter(l => l.cacheable);
          const nonCacheable = sorted.filter(l => !l.cacheable)
            .sort((a, b) => a.priority - b.priority);

          const kept: PromptLayer[] = [...cacheableLayers];
          totalTokens = cacheableLayers.reduce((sum, l) => sum + getTokens(l.content), 0);

          for (const layer of nonCacheable) {
            const layerTokens = getTokens(layer.content);
            if (totalTokens + layerTokens <= maxTokens) {
              kept.push(layer);
              totalTokens += layerTokens;
            }
          }

          // Re-sort kept layers
          sorted = kept.sort((a, b) => {
            if (a.cacheable !== b.cacheable) return a.cacheable ? -1 : 1;
            return a.priority - b.priority;
          });
        }
      }

      const systemPrompt = sorted.map(l => l.content).join(separator);
      const cacheableContent = sorted.filter(l => l.cacheable).map(l => l.content).join(separator);
      const totalTokens = getTokens(systemPrompt);
      const cacheableTokens = getTokens(cacheableContent);

      cachedResult = Object.freeze({
        systemPrompt,
        layers: Object.freeze(sorted),
        stablePrefixHash,
        metadata: Object.freeze({
          totalTokens,
          cacheableTokens,
          layerCount: sorted.length,
        }),
      });
      dirty = false;
      return cachedResult;
    },

    getStablePrefixHash(): string {
      const sorted = getSortedLayers();
      const cacheableContent = sorted
        .filter(l => l.cacheable)
        .map(l => l.content)
        .join(separator);
      return hashString(cacheableContent);
    },
  };
}
