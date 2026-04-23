/**
 * MemoryStore interface and in-memory implementation.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { secureId } from '../infra/ids.js';
import { assertMemoryEntrySize } from './_schemas.js';
import { resolveCandidateIds } from './memory-query.js';
import type {
  MemoryEntry,
  MemoryFilter,
  CompactionPolicy,
  CompactionResult,
  VectorSearchOptions,
} from './types.js';

/**
 * Capabilities declared by a MemoryStore implementation. Consumers can
 * inspect `store.capabilities` to decide whether a feature is supported
 * (e.g., TTL, atomic batch writes) without probing and catching errors.
 *
 * All fields are optional. A missing capability is equivalent to `false`.
 */
export interface MemoryStoreCapabilities {
  /** `write()` is atomic under concurrent callers within a single process. */
  readonly atomicWrite?: boolean;
  /** `writeBatch()` is atomic — either every entry is written or none is. */
  readonly atomicBatch?: boolean;
  /** `update()` uses compare-and-swap semantics at the store level. */
  readonly atomicUpdate?: boolean;
  /** Per-entry TTL via `setWithTtl()` or backend-native expiry. */
  readonly supportsTtl?: boolean;
  /** Vector similarity via `searchByVector()`. */
  readonly vectorSearch?: boolean;
  /** Batch writes via `writeBatch()`. */
  readonly batchWrites?: boolean;
  /** Isolated tenant-scoped views via `scopedView()`. */
  readonly supportsTenantScope?: boolean;
  /** Optimistic concurrency via `updateWithVersion()`. */
  readonly supportsOptimisticLock?: boolean;
}

/**
 * Interface for memory storage backends.
 *
 * ### Contract requirements
 *
 * - **`write`** MUST be atomic under concurrent single-process access: two
 *   writes to the same backend never result in partial state.
 * - **`update`** SHOULD use compare-and-swap where the backend supports it.
 *   Non-atomic backends must document this in their `capabilities`.
 * - **`read`** after `write` resolving MUST return the written entry.
 * - **`delete`** returns `true` iff the entry existed prior to the call.
 *
 * Implementations SHOULD declare supported features in `capabilities` so
 * callers can adapt behavior (e.g., only use `writeBatch` when atomic).
 */
export interface MemoryStore {
  /** Declared capabilities. Defaults to all-`false` when omitted. */
  readonly capabilities?: MemoryStoreCapabilities;

  write(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry>;
  read(id: string): Promise<MemoryEntry | null>;
  /**
   * Filter/query entries. E-5: accepts an optional `opts.signal`
   * `AbortSignal`. When aborted, implementations SHOULD throw
   * `HarnessError(CORE_ABORTED)` at the next batch/check boundary.
   * The signature is backwards compatible — `opts` is optional.
   */
  query(filter: MemoryFilter, opts?: { signal?: AbortSignal }): Promise<MemoryEntry[]>;
  update(id: string, updates: Partial<Pick<MemoryEntry, 'content' | 'grade' | 'metadata' | 'tags'>>): Promise<MemoryEntry>;
  delete(id: string): Promise<boolean>;
  compact(policy: CompactionPolicy): Promise<CompactionResult>;
  count(): Promise<number>;
  clear(): Promise<void>;

  /**
   * Optional: write many entries in one call. When `capabilities.atomicBatch`
   * is `true` the backend guarantees all-or-nothing semantics; otherwise
   * entries are written sequentially and a mid-batch failure leaves partial
   * state.
   */
  writeBatch?(entries: Array<Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>>): Promise<MemoryEntry[]>;

  /** Optional: Vector similarity search for embedding-backed stores. */
  searchByVector?(options: VectorSearchOptions): Promise<Array<MemoryEntry & { score: number }>>;
  /** Optional: write a logical key with a per-entry TTL. */
  setWithTtl?(key: string, value: unknown, ttlMs: number): Promise<void>;
  /** Optional: return a tenant-isolated view of the store. */
  scopedView?(tenantId: string): MemoryStore;
  /** Optional: compare-and-swap update on a logical key. */
  updateWithVersion?<T>(
    key: string,
    expectedVersion: number,
    updater: (value: T | undefined) => T,
  ): Promise<{ newVersion: number }>;
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
  const keyIndex = new Map<string, string>();
  const versionIndex = new Map<string, number>();
  const expiryIndex = new Map<string, number>();
  /** Secondary index: tag -> set of entry IDs that have that tag. */
  const tagIndex = new Map<string, Set<string>>();
  /** Secondary index: grade -> set of entry IDs with that grade. */
  const gradeIndex = new Map<string, Set<string>>();
  /** Eviction priority: ephemeral first, then useful, then critical. */
  const GRADE_EVICTION_ORDER: readonly string[] = ['ephemeral', 'useful', 'critical'];
  function generateId(): string {
    // SEC-002: Use cryptographically secure randomness instead of
    // Math.random(), which is predictable and enables enumeration attacks
    // on reachable memory entry IDs.
    return `mem_${Date.now()}_${secureId()}`;
  }

  /**
   * Compute cosine similarity between two vectors.
   *
   * Expects embeddings to be provided as-is. The function computes raw cosine
   * similarity. For optimal results, embeddings should be L2-normalized before
   * storage, in which case cosine similarity reduces to a dot product.
   *
   * @throws {HarnessError} When vectors have different lengths (dimension mismatch).
   */
  function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length) {
      throw new HarnessError(
        `Embedding dimension mismatch: ${a.length} vs ${b.length}`,
        HarnessErrorCode.CORE_INVALID_INPUT,
        'Ensure all embeddings use the same model and dimensionality',
      );
    }
    if (a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Get the dimension of existing embeddings in the store, or undefined if none exist.
   * Used for dimension validation in write().
   */
  function getExistingEmbeddingDimension(): number | undefined {
    for (const entry of entries.values()) {
      const emb = entry.metadata?.['embedding'];
      if (Array.isArray(emb) && emb.length > 0) {
        return emb.length;
      }
    }
    return undefined;
  }

  /** Add an entry to the secondary indexes. */
  function addToIndexes(entry: MemoryEntry): void {
    keyIndex.set(entry.key, entry.id);
    // Grade index
    let gradeSet = gradeIndex.get(entry.grade);
    if (!gradeSet) {
      gradeSet = new Set();
      gradeIndex.set(entry.grade, gradeSet);
    }
    gradeSet.add(entry.id);

    // Tag index
    if (entry.tags) {
      for (const tag of entry.tags) {
        let tagSet = tagIndex.get(tag);
        if (!tagSet) {
          tagSet = new Set();
          tagIndex.set(tag, tagSet);
        }
        tagSet.add(entry.id);
      }
    }
  }

  /** Remove an entry from the secondary indexes. */
  function removeFromIndexes(entry: MemoryEntry): void {
    if (keyIndex.get(entry.key) === entry.id) keyIndex.delete(entry.key);
    expiryIndex.delete(entry.id);
    // Grade index
    const gradeSet = gradeIndex.get(entry.grade);
    if (gradeSet) {
      gradeSet.delete(entry.id);
      if (gradeSet.size === 0) gradeIndex.delete(entry.grade);
    }

    // Tag index
    if (entry.tags) {
      for (const tag of entry.tags) {
        const tagSet = tagIndex.get(tag);
        if (tagSet) {
          tagSet.delete(entry.id);
          if (tagSet.size === 0) tagIndex.delete(tag);
        }
      }
    }
  }

  function purgeExpiredEntry(id: string): void {
    const expiresAt = expiryIndex.get(id);
    if (expiresAt === undefined || Date.now() < expiresAt) return;
    const entry = entries.get(id);
    if (entry) removeFromIndexes(entry);
    entries.delete(id);
  }

  function purgeExpiredEntries(): void {
    for (const [id, expiresAt] of expiryIndex) {
      if (Date.now() >= expiresAt) {
        const entry = entries.get(id);
        if (entry) removeFromIndexes(entry);
        entries.delete(id);
      }
    }
  }

  function serializeMemoryValue(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  function parseMemoryValue<T>(content: string): T | undefined {
    try {
      return JSON.parse(content) as T;
    } catch {
      return content as T;
    }
  }

  return {
    capabilities: {
      atomicWrite: true,
      atomicUpdate: true,
      atomicBatch: true, // in-memory is single-threaded, so batch is atomic
      batchWrites: true,
      supportsTtl: true,
      vectorSearch: true,
      supportsOptimisticLock: true,
    },

    async write(input) {
      // enforce byte caps + reject reserved metadata keys.
      assertMemoryEntrySize(input);
      // Validate embedding dimension consistency before storing
      const inputEmbedding = input.metadata?.['embedding'];
      if (Array.isArray(inputEmbedding)) {
        const existingDim = getExistingEmbeddingDimension();
        if (existingDim !== undefined && inputEmbedding.length !== existingDim) {
          throw new HarnessError(
            `Embedding dimension mismatch: new entry has ${inputEmbedding.length} dimensions but store contains embeddings with ${existingDim} dimensions`,
            HarnessErrorCode.CORE_INVALID_INPUT,
            'Ensure all embeddings use the same model and dimensionality',
          );
        }
      }

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
      addToIndexes(entry);
      // Fix 16 + PERF: Grade-aware eviction with O(1) victim lookup.
      // Each grade maintains a Map (insertion-ordered). To evict, we check
      // the lowest-priority non-empty bucket and take its first entry.
      if (maxEntries !== undefined && entries.size > maxEntries) {
        let victimId: string | undefined;
        for (const grade of GRADE_EVICTION_ORDER) {
          const bucket = gradeIndex.get(grade);
          if (bucket && bucket.size > 0) {
            victimId = bucket.keys().next().value;
            break;
          }
        }
        if (victimId !== undefined) {
          const victimEntry = entries.get(victimId);
          // removeFromIndexes already handles grade + tag index cleanup,
          // so no need for a separate gradeIndex deletion afterwards.
          if (victimEntry) removeFromIndexes(victimEntry);
          entries.delete(victimId);
        }
      }
      return entry;
    },

    async writeBatch(inputs) {
      // Atomic batch write for the in-memory store: build the full list of
      // new entries first, then commit all in a single synchronous loop.
      // If any input fails validation, nothing is written.
      const now = Date.now();
      const prepared: MemoryEntry[] = [];
      for (const input of inputs) {
        const inputEmbedding = input.metadata?.['embedding'];
        if (Array.isArray(inputEmbedding)) {
          const existingDim = getExistingEmbeddingDimension();
          if (existingDim !== undefined && inputEmbedding.length !== existingDim) {
            throw new HarnessError(
              `Embedding dimension mismatch: entry has ${inputEmbedding.length} dimensions but store contains embeddings with ${existingDim} dimensions`,
              HarnessErrorCode.CORE_INVALID_INPUT,
              'Ensure all embeddings use the same model and dimensionality',
            );
          }
        }
        prepared.push({
          id: generateId(),
          key: input.key,
          content: input.content,
          grade: input.grade,
          createdAt: now,
          updatedAt: now,
          ...(input.metadata !== undefined && { metadata: input.metadata }),
          ...(input.tags !== undefined && { tags: input.tags }),
        });
      }
      // Commit all entries and indexes. `Map.set` and our index mutations
      // are pure synchronous operations that cannot throw — so "rollback on
      // failure" is dead code for the in-memory backend. A real
      // rollback contract only applies to storage backends that can fail
      // mid-commit (see `@harness-one/redis`).
      for (const entry of prepared) {
        entries.set(entry.id, entry);
        addToIndexes(entry);
      }
      // Apply grade-aware eviction after batch commit (same logic as write()).
      if (maxEntries !== undefined) {
        while (entries.size > maxEntries) {
          let victimId: string | undefined;
          for (const grade of GRADE_EVICTION_ORDER) {
            const bucket = gradeIndex.get(grade);
            if (bucket && bucket.size > 0) {
              victimId = bucket.keys().next().value;
              break;
            }
          }
          if (victimId === undefined) break;
          const victimEntry = entries.get(victimId);
          if (victimEntry) removeFromIndexes(victimEntry);
          entries.delete(victimId);
        }
      }
      return prepared;
    },

    async read(id) {
      purgeExpiredEntry(id);
      return entries.get(id) ?? null;
    },

    async query(filter, opts) {
      purgeExpiredEntries();
      // honor AbortSignal. Check at entry and again after each
      // filter stage so long-running queries over large stores can be
      // interrupted promptly.
      const signal = opts?.signal;
      const throwIfAborted = (): void => {
        if (signal?.aborted) {
          throw new HarnessError(
            'Memory query aborted',
            HarnessErrorCode.CORE_ABORTED,
            'The provided AbortSignal was aborted before query completion',
          );
        }
      };
      throwIfAborted();

      // index set-algebra (union / intersect) lives in
      // `memory-query.ts` so this function can focus on orchestration.
      const candidateIds = resolveCandidateIds(filter, { gradeIndex, tagIndex });

      // Resolve candidates to entries, or fall back to full scan.
      // In the full-scan path we intentionally iterate directly over
      // `entries.values()` without copying via Array.from. The earlier copy was
      // wasted work — we still need to allocate a results array anyway to
      // apply filters + sort.
      let results: MemoryEntry[] = [];
      if (candidateIds !== null) {
        for (const id of candidateIds) {
          const entry = entries.get(id);
          if (entry) results.push(entry);
        }
      } else {
        for (const entry of entries.values()) {
          results.push(entry);
        }
      }

      throwIfAborted();
      // Apply remaining filters that are not indexed
      if (filter.since !== undefined) {
        results = results.filter((e) => e.updatedAt >= (filter.since as number));
      }
      if (filter.search) {
        const term = filter.search.toLowerCase();
        results = results.filter((e) => e.content.toLowerCase().includes(term));
      }
      if (filter.sessionId !== undefined) {
        results = results.filter((e) => e.metadata?.['sessionId'] === filter.sessionId);
      }

      throwIfAborted();
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
      purgeExpiredEntry(id);
      const existing = entries.get(id);
      if (!existing) {
        throw new HarnessError(
          `Memory entry not found: ${id}`,
          HarnessErrorCode.MEMORY_NOT_FOUND,
          'Check that the entry ID is correct',
        );
      }
      // Remove old entry from indexes before applying updates
      removeFromIndexes(existing);
      const updated: MemoryEntry = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
      };
      entries.set(id, updated);
      // Add updated entry to indexes
      addToIndexes(updated);
      return updated;
    },

    async delete(id) {
      purgeExpiredEntry(id);
      const entry = entries.get(id);
      if (entry) {
        removeFromIndexes(entry);
        entries.delete(id);
        return true;
      }
      return false;
    },

    async compact(policy) {
      purgeExpiredEntries();
      if (policy.maxEntries !== undefined && policy.maxEntries < 0) {
        throw new HarnessError(
          'CompactionPolicy.maxEntries must be non-negative',
          HarnessErrorCode.CORE_INVALID_CONFIG,
          'Provide a non-negative value for maxEntries',
        );
      }
      if (policy.maxAge !== undefined && policy.maxAge < 0) {
        throw new HarnessError(
          'CompactionPolicy.maxAge must be non-negative',
          HarnessErrorCode.CORE_INVALID_CONFIG,
          'Provide a non-negative value for maxAge (milliseconds)',
        );
      }
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
            removeFromIndexes(entry);
            entries.delete(entry.id);
            freed.push(entry.id);
          }
        }
      }

      // Trim to maxEntries by removing lowest-weighted entries first.
      // Previously `shift()` was called in a while-loop, giving
      // O(n²) behavior on large stores. Sort once, iterate by index instead.
      if (policy.maxEntries !== undefined && entries.size > policy.maxEntries) {
        const sorted = Array.from(entries.values()).sort(
          (a, b) => weights[a.grade] - weights[b.grade] || a.updatedAt - b.updatedAt,
        );
        for (let i = 0; i < sorted.length && entries.size > policy.maxEntries; i++) {
          const victim = sorted[i];
          if (weights[victim.grade] >= 1.0) {
            // Remaining entries are all protected (weight >= 1.0) — stop.
            break;
          }
          removeFromIndexes(victim);
          entries.delete(victim.id);
          freed.push(victim.id);
        }
      }

      return {
        removed: freed.length,
        remaining: entries.size,
        freedEntries: freed,
      };
    },

    async count() {
      purgeExpiredEntries();
      return entries.size;
    },

    async clear() {
      entries.clear();
      keyIndex.clear();
      versionIndex.clear();
      expiryIndex.clear();
      tagIndex.clear();
      gradeIndex.clear();
    },

    async searchByVector(options: VectorSearchOptions) {
      purgeExpiredEntries();
      const { embedding, limit = 10, minScore = 0 } = options;
      // Binary min-heap of size <= limit. Insert/replace is O(log k),
      // versus the previous O(k) double-scan on every replacement.
      const heap: Array<MemoryEntry & { score: number }> = [];

      function siftUp(i: number): void {
        while (i > 0) {
          const parent = (i - 1) >>> 1;
          if (heap[parent].score <= heap[i].score) return;
          [heap[i], heap[parent]] = [heap[parent], heap[i]];
          i = parent;
        }
      }
      function siftDown(i: number): void {
        const n = heap.length;
        for (;;) {
          const l = 2 * i + 1;
          const r = 2 * i + 2;
          let smallest = i;
          if (l < n && heap[l].score < heap[smallest].score) smallest = l;
          if (r < n && heap[r].score < heap[smallest].score) smallest = r;
          if (smallest === i) return;
          [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
          i = smallest;
        }
      }

      for (const entry of entries.values()) {
        const entryEmbedding = entry.metadata?.['embedding'];
        if (!Array.isArray(entryEmbedding)) continue;
        const score = cosineSimilarity(embedding, entryEmbedding as number[]);
        if (score < minScore) continue;

        if (heap.length < limit) {
          heap.push({ ...entry, score });
          siftUp(heap.length - 1);
        } else if (score > heap[0].score) {
          heap[0] = { ...entry, score };
          siftDown(0);
        }
      }

      return heap.sort((a, b) => b.score - a.score);
    },

    async setWithTtl(key: string, value: unknown, ttlMs: number) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new HarnessError(
          'ttlMs must be a positive finite number',
          HarnessErrorCode.CORE_INVALID_CONFIG,
          'Provide a positive TTL in milliseconds',
        );
      }
      const existingId = keyIndex.get(key);
      const content = serializeMemoryValue(value);
      if (existingId) {
        const updated = await this.update(existingId, { content, grade: 'ephemeral' });
        expiryIndex.set(updated.id, Date.now() + ttlMs);
        versionIndex.set(key, (versionIndex.get(key) ?? 0) + 1);
        return;
      }
      const entry = await this.write({ key, content, grade: 'ephemeral' });
      expiryIndex.set(entry.id, Date.now() + ttlMs);
      versionIndex.set(key, 1);
    },

    async updateWithVersion<T>(
      key: string,
      expectedVersion: number,
      updater: (value: T | undefined) => T,
    ) {
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        throw new HarnessError(
          'expectedVersion must be a non-negative integer',
          HarnessErrorCode.CORE_INVALID_CONFIG,
        );
      }
      const currentVersion = versionIndex.get(key) ?? 0;
      if (currentVersion !== expectedVersion) {
        throw new HarnessError(
          `Version conflict for key "${key}": expected ${expectedVersion}, found ${currentVersion}`,
          HarnessErrorCode.STORE_VERSION_CONFLICT,
        );
      }

      const existingId = keyIndex.get(key);
      const existing = existingId ? await this.read(existingId) : null;
      const nextValue = updater(existing ? parseMemoryValue<T>(existing.content) : undefined);
      const nextContent = serializeMemoryValue(nextValue);
      const newVersion = currentVersion + 1;

      if (existing) {
        await this.update(existing.id, { content: nextContent });
      } else {
        await this.write({ key, content: nextContent, grade: 'useful' });
      }
      versionIndex.set(key, newVersion);
      return { newVersion };
    },
  };
}
