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
}

let idCounter = 0;

function generateId(): string {
  return `mem_${Date.now()}_${++idCounter}`;
}

/**
 * Create an in-memory MemoryStore for testing and simple use cases.
 *
 * @example
 * ```ts
 * const store = createInMemoryStore();
 * const entry = await store.write({ key: 'k', content: 'hello', grade: 'useful' });
 * ```
 */
export function createInMemoryStore(): MemoryStore {
  const entries = new Map<string, MemoryEntry>();

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
        metadata: input.metadata,
        tags: input.tags,
      };
      entries.set(entry.id, entry);
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
  };
}
