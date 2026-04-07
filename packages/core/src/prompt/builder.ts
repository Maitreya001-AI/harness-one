/**
 * Multi-layer prompt assembly with KV-cache optimization.
 *
 * @module
 */

import type { PromptLayer, AssembledPrompt } from './types.js';

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
  const layers = new Map<string, PromptLayer>();
  const variables = new Map<string, string>();

  function estimateTokens(text: string): number {
    // ~4 chars per token heuristic
    return Math.ceil(text.length / 4);
  }

  function replaceVariables(text: string): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const value = variables.get(key);
      return value !== undefined ? value : `{{${key}}}`;
    });
  }

  function hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
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
    },

    removeLayer(name: string): void {
      layers.delete(name);
    },

    setVariable(key: string, value: string): void {
      variables.set(key, value);
    },

    build(): AssembledPrompt {
      let sorted = getSortedLayers();

      // Apply variable replacement
      sorted = sorted.map(l => ({
        ...l,
        content: replaceVariables(l.content),
      }));

      // Trim if maxTokens set — remove non-cacheable layers from highest priority number first
      if (maxTokens !== undefined) {
        let totalTokens = sorted.reduce((sum, l) => sum + estimateTokens(l.content), 0);
        if (totalTokens > maxTokens) {
          // Sort non-cacheable layers by priority descending (highest priority number = least important)
          const cacheableLayers = sorted.filter(l => l.cacheable);
          const nonCacheable = sorted.filter(l => !l.cacheable)
            .sort((a, b) => b.priority - a.priority);

          const kept: PromptLayer[] = [...cacheableLayers];
          totalTokens = cacheableLayers.reduce((sum, l) => sum + estimateTokens(l.content), 0);

          for (const layer of nonCacheable.reverse()) {
            const layerTokens = estimateTokens(layer.content);
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
      const stablePrefixHash = hashString(cacheableContent);
      const totalTokens = estimateTokens(systemPrompt);
      const cacheableTokens = estimateTokens(cacheableContent);

      return Object.freeze({
        systemPrompt,
        layers: Object.freeze(sorted),
        stablePrefixHash,
        metadata: Object.freeze({
          totalTokens,
          cacheableTokens,
          layerCount: sorted.length,
        }),
      });
    },

    getStablePrefixHash(): string {
      const sorted = getSortedLayers();
      const cacheableContent = sorted
        .filter(l => l.cacheable)
        .map(l => replaceVariables(l.content))
        .join(separator);
      return hashString(cacheableContent);
    },
  };
}
