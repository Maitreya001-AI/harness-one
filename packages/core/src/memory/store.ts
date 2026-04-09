/**
 * MemoryStore interface and in-memory implementation.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type {
  MemoryEntry,
  MemoryFilter,
  CompactionPolicy,
  CompactionResult,
  VectorSearchOptions,
} from './types.js';

/** Interface for memory storage backends. */
export interface MemoryStore {
  write(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry>;
  read(id: string): Promise<MemoryEntry | null>;
  query(filter: MemoryFilter): Promise<MemoryEntry[]>;
  update(id: string, updates: Partial<Pick<MemoryEntry, 'content' | 'grade' | 'metadata' | 'tags'>>): Promise<MemoryEntry>;
  delete(id: string): Promise<boolean>;
  compact(policy: CompactionPolicy): Promise<CompactionResult>;
  count(): Promise<number>;
  clear(): Promise<void>;
  /** Optional: Vector similarity search for embedding-backed stores. */
  searchByVector?(options: VectorSearchOptions): Promise<Array<MemoryEntry & { score: number }>>;
}

/**
 * Create an in-memory MemoryStore with optional vector similarity search.
 *
 * Vector search uses cosine similarity on embeddings stored in `metadata.embedding`.
 *
 * @example
 * ```ts
 * const store = createInMemoryStore();
 * const entry = await store.write({ key: 'k', content: 'hello', grade: 'useful', metadata: { embedding: [0.1, 0.2] } });
 * const results = await store.searchByVector!({ embedding: [0.1, 0.2], limit: 5 });
 * ```
 */
export function createInMemoryStore(config?: { maxEntries?: number }): MemoryStore {
  const maxEntries = config?.maxEntries;
  const entries = new Map<string, MemoryEntry>();
  let idCounter = 0;

  function generateId(): string {
    return `mem_${Date.now()}_${++idCounter}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  return {
    async write(input) {
      const now = Date.now();
      const entry: MemoryEntry = {
        id: generateId(),
        key: input.key,
        content: input.content,
        grade: input.grade,
        createdAt: now,
        updatedAt: now,
        ...(input.metadata !== undefined && { metadata: input.metadata }),
        ...(input.tags !== undefined && { tags: input.tags }),
      };
      entries.set(entry.id, entry);
      if (maxEntries !== undefined && entries.size > maxEntries) {
        const firstKey = entries.keys().next().value;
        if (firstKey !== undefined) entries.delete(firstKey);
      }
      return entry;
    },

    async read(id) {
      return entries.get(id) ?? null;
    },

    async query(filter) {
      let results = Array.from(entries.values());

      if (filter.grade) {
        results = results.filter((e) => e.grade === filter.grade);
      }
      if (filter.tags && filter.tags.length > 0) {
        results = results.filter((e) =>
          filter.tags!.some((t) => e.tags?.includes(t)),
        );
      }
      if (filter.since !== undefined) {
        results = results.filter((e) => e.updatedAt >= filter.since!);
      }
      if (filter.search) {
        const term = filter.search.toLowerCase();
        results = results.filter((e) => e.content.toLowerCase().includes(term));
      }

      results.sort((a, b) => b.updatedAt - a.updatedAt);

      if (filter.offset !== undefined && filter.offset > 0) {
        results = results.slice(filter.offset);
      }

      if (filter.limit !== undefined && filter.limit > 0) {
        results = results.slice(0, filter.limit);
      }

      return results;
    },

    async update(id, updates) {
      const existing = entries.get(id);
      if (!existing) {
        throw new HarnessError(
          `Memory entry not found: ${id}`,
          'MEMORY_NOT_FOUND',
          'Check that the entry ID is correct',
        );
      }
      const updated: MemoryEntry = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
      };
      entries.set(id, updated);
      return updated;
    },

    async delete(id) {
      return entries.delete(id);
    },

    async compact(policy) {
      const all = Array.from(entries.values());
      const now = Date.now();
      const weights = policy.gradeWeights ?? {
        critical: 1.0,
        useful: 0.5,
        ephemeral: 0.1,
      };
      const freed: string[] = [];

      // Remove entries older than maxAge
      if (policy.maxAge !== undefined) {
        for (const entry of all) {
          if (now - entry.createdAt > policy.maxAge && weights[entry.grade] < 1.0) {
            entries.delete(entry.id);
            freed.push(entry.id);
          }
        }
      }

      // Trim to maxEntries by removing lowest-weighted entries first
      if (policy.maxEntries !== undefined && entries.size > policy.maxEntries) {
        const sorted = Array.from(entries.values()).sort(
          (a, b) => weights[a.grade] - weights[b.grade] || a.updatedAt - b.updatedAt,
        );
        while (entries.size > policy.maxEntries && sorted.length > 0) {
          const victim = sorted.shift()!;
          if (weights[victim.grade] < 1.0) {
            entries.delete(victim.id);
            freed.push(victim.id);
          } else {
            break;
          }
        }
      }

      return {
        removed: freed.length,
        remaining: entries.size,
        freedEntries: freed,
      };
    },

    async count() {
      return entries.size;
    },

    async clear() {
      entries.clear();
    },

    async searchByVector(options: VectorSearchOptions) {
      const { embedding, limit = 10, minScore = 0 } = options;
      const scored: Array<MemoryEntry & { score: number }> = [];

      for (const entry of entries.values()) {
        const entryEmbedding = entry.metadata?.['embedding'];
        if (!Array.isArray(entryEmbedding)) continue;
        const score = cosineSimilarity(embedding, entryEmbedding as number[]);
        if (score >= minScore) {
          scored.push({ ...entry, score });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },
  };
}
