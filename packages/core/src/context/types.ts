/**
 * Types for the context module.
 *
 * @module
 */

import type { Message } from '../core/types.js';

/** A named segment of the context budget. */
export interface Segment {
  readonly name: string;
  readonly maxTokens: number;
  readonly trimPriority?: number;
  readonly reserved?: boolean;
}

/** Configuration for creating a TokenBudget. */
export interface BudgetConfig {
  readonly totalTokens: number;
  readonly segments: readonly Segment[];
  readonly responseReserve?: number;
}

/** Token budget tracker with segment-level allocation. */
export interface TokenBudget {
  readonly totalTokens: number;
  readonly responseReserve: number;
  /**
   * Remaining capacity for a segment, **clamped at 0**. Never returns a
   * negative number — overflow attempts via {@link TokenBudget.allocate}
   * throw, and {@link TokenBudget.tryAllocate} refuses the write, so the
   * stored `used` counter cannot exceed `maxTokens` by construction.
   */
  remaining(segmentName: string): number;
  /**
   * Deduct `tokens` from a segment. Throws `CONTEXT_SEGMENT_OVERFLOW`
   * when the cumulative allocation would exceed the segment's
   * `maxTokens`. The segment state is left unchanged on overflow.
   */
  allocate(segmentName: string, tokens: number): void;
  /** Try to allocate tokens; returns true if successful, false if it would overflow. Does not throw. */
  tryAllocate(segmentName: string, tokens: number): boolean;
  reset(segmentName: string): void;
  needsTrimming(): boolean;
  trimOrder(): Array<{ segment: string; trimBy: number; priority: number }>;
  /**
   * true once the cumulative usage across all segments
   * (plus {@link TokenBudget.responseReserve}) has been observed to
   * exceed `totalTokens`. The flag is sticky — it remains set even after
   * later {@link TokenBudget.reset} calls bring usage back down, so
   * callers can detect that a prior packing attempt had to resort to
   * trimming or budget extension.
   *
   * Does **not** fire on per-segment overflow (that path throws instead,
   * so the invalid state never reaches the aggregate). The flag reflects
   * the same condition {@link TokenBudget.needsTrimming} reports, but
   * persists after trimming reduces `used` back under the total.
   */
  hasOverflowed(): boolean;
}

/**
 * Layout for packing context into a message array.
 *
 * @example
 * ```ts
 * const layout: ContextLayout = {
 *   head: [systemMsg],
 *   mid: conversationHistory,
 *   tail: [latestUserMsg],
 *   budget,
 * };
 * ```
 */
export interface ContextLayout {
  readonly head: Message[];
  readonly mid: Message[];
  readonly tail: Message[];
  readonly budget: TokenBudget;
}

/**
 * Strategy for compressing messages to fit within a token budget.
 *
 * @example
 * ```ts
 * const strategy: CompressionStrategy = {
 *   name: 'truncate',
 *   async compress(messages, targetTokens) { return messages.slice(-5); }
 * };
 * ```
 */
export interface CompressionStrategy {
  readonly name: string;
  compress(
    messages: readonly Message[],
    targetTokens: number,
    options?: {
      preserve?: (msg: Message) => boolean;
      signal?: AbortSignal;
    },
  ): Promise<readonly Message[]>;
}

/** Report from analyzing cache stability between two message arrays. */
export interface CacheStabilityReport {
  readonly prefixMatchRatio: number;
  readonly firstDivergenceIndex: number;
  readonly stablePrefixTokens: number;
  /** Ratio of content shared between two arrays regardless of position (0-1). */
  readonly contentOverlapRatio: number;
  readonly recommendations: string[];
}

// ---------------------------------------------------------------------------
// Checkpoint Manager types
// ---------------------------------------------------------------------------

/** A saved checkpoint of conversation state. */
export interface Checkpoint {
  readonly id: string;
  readonly label?: string;
  readonly messages: readonly Message[];
  readonly tokenCount: number;
  readonly timestamp: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Pluggable storage backend for checkpoints — **async interface as of 0.3**.
 *
 * The previous sync interface composed badly with the async {@link MemoryStore}
 * (showcase 03 FRICTION_LOG `CheckpointManager doesn't natively compose
 * with FsMemoryStore`). The async migration lets fs-backed and remote
 * (Redis, S3, …) backends slot in directly without forcing callers to
 * write a write-through cache + queue bridge.
 */
export interface CheckpointStorage {
  /** Save a checkpoint. */
  save(checkpoint: Checkpoint): Promise<void>;
  /** Load a checkpoint by ID. Returns undefined if not found. */
  load(id: string): Promise<Checkpoint | undefined>;
  /** List all checkpoints in insertion order (oldest first). */
  list(): Promise<readonly Checkpoint[]>;
  /** Delete a checkpoint by ID. Returns true if it existed. */
  delete(id: string): Promise<boolean>;
}

/** Configuration for creating a CheckpointManager. */
export interface CheckpointManagerConfig {
  /** Maximum number of checkpoints to retain. Oldest evicted on overflow. Default: 5. */
  readonly maxCheckpoints?: number;
  /** Custom token counting function. Default: heuristic estimate. */
  readonly countTokens?: (messages: readonly Message[]) => number;
  /** Pluggable storage backend. Default: in-memory (still async). */
  readonly storage?: CheckpointStorage;
}

/**
 * Checkpoint manager for saving and restoring conversation state — async
 * since 0.3 (matches the underlying {@link CheckpointStorage} interface).
 */
export interface CheckpointManager {
  /** Save current messages as a checkpoint. Auto-prunes if at capacity. */
  save(
    messages: readonly Message[],
    label?: string,
    metadata?: Record<string, unknown>,
  ): Promise<Checkpoint>;
  /** Restore messages from a checkpoint. Returns a fresh copy. Throws if not found. */
  restore(checkpointId: string): Promise<readonly Message[]>;
  /** List all checkpoints (oldest first). */
  list(): Promise<readonly Checkpoint[]>;
  /** Prune checkpoints by count and/or age. Returns number pruned. */
  prune(options?: { maxCheckpoints?: number; maxAge?: number }): Promise<number>;
  /** Dispose the manager and clear all checkpoints. */
  dispose(): Promise<void>;
}
