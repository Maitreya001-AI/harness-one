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
  readonly recommendations: string[];
}
