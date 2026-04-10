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
  remaining(segmentName: string): number;
  allocate(segmentName: string, tokens: number): void;
  /** Try to allocate tokens; returns true if successful, false if it would overflow. Does not throw. */
  tryAllocate(segmentName: string, tokens: number): boolean;
  reset(segmentName: string): void;
  needsTrimming(): boolean;
  trimOrder(): Array<{ segment: string; trimBy: number; priority: number }>;
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

/** Pluggable storage backend for checkpoints (sync interface). */
export interface CheckpointStorage {
  /** Save a checkpoint. */
  save(checkpoint: Checkpoint): void;
  /** Load a checkpoint by ID. Returns undefined if not found. */
  load(id: string): Checkpoint | undefined;
  /** List all checkpoints in insertion order (oldest first). */
  list(): readonly Checkpoint[];
  /** Delete a checkpoint by ID. Returns true if it existed. */
  delete(id: string): boolean;
}

/** Configuration for creating a CheckpointManager. */
export interface CheckpointManagerConfig {
  /** Maximum number of checkpoints to retain. Oldest evicted on overflow. Default: 5. */
  readonly maxCheckpoints?: number;
  /** Custom token counting function. Default: heuristic estimate. */
  readonly countTokens?: (messages: readonly Message[]) => number;
  /** Pluggable storage backend. Default: in-memory. */
  readonly storage?: CheckpointStorage;
}

/** Checkpoint manager for saving and restoring conversation state. */
export interface CheckpointManager {
  /** Save current messages as a checkpoint. Auto-prunes if at capacity. */
  save(messages: readonly Message[], label?: string, metadata?: Record<string, unknown>): Checkpoint;
  /** Restore messages from a checkpoint. Returns a fresh copy. Throws if not found. */
  restore(checkpointId: string): readonly Message[];
  /** List all checkpoints (oldest first). */
  list(): readonly Checkpoint[];
  /** Prune checkpoints by count and/or age. Returns number pruned. */
  prune(options?: { maxCheckpoints?: number; maxAge?: number }): number;
  /** Dispose the manager and clear all checkpoints. */
  dispose(): void;
}
