/**
 * Types for the memory module — memory entries, filters, compaction, and relay state.
 *
 * @module
 */

/** Grade indicating importance of a memory entry. */
export type MemoryGrade = 'critical' | 'useful' | 'ephemeral';

/**
 * A single memory entry stored in a MemoryStore.
 *
 * @example
 * ```ts
 * const entry: MemoryEntry = {
 *   id: 'abc123',
 *   key: 'user-preference',
 *   content: 'Prefers dark mode',
 *   grade: 'useful',
 *   createdAt: Date.now(),
 *   updatedAt: Date.now(),
 * };
 * ```
 */
export interface MemoryEntry {
  readonly id: string;
  readonly key: string;
  readonly content: string;
  readonly grade: MemoryGrade;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata?: Record<string, unknown>;
  readonly tags?: string[];
}

/** Filter criteria for querying memory entries. */
export interface MemoryFilter {
  readonly grade?: MemoryGrade;
  readonly tags?: string[];
  readonly since?: number;
  readonly limit?: number;
  readonly search?: string;
  /** Offset for pagination — skip this many results before applying limit. */
  readonly offset?: number;
}

/** Options for vector similarity search on embedding-backed stores. */
export interface VectorSearchOptions {
  /** The query embedding vector. */
  readonly embedding: readonly number[];
  /** Maximum number of results to return. */
  readonly limit?: number;
  /** Minimum similarity score threshold (0–1). */
  readonly minScore?: number;
}

/** Policy for compacting (pruning) memory entries. */
export interface CompactionPolicy {
  readonly maxEntries?: number;
  readonly maxAge?: number;
  readonly gradeWeights?: {
    critical: number;
    useful: number;
    ephemeral: number;
  };
}

/** Result of a compaction operation. */
export interface CompactionResult {
  readonly removed: number;
  readonly remaining: number;
  readonly freedEntries: string[];
}

/** State for cross-context relay handoff. */
export interface RelayState {
  readonly progress: Record<string, unknown>;
  readonly artifacts: string[];
  readonly checkpoint: string;
  readonly timestamp: number;
}
