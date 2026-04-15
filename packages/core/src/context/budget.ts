/**
 * Token budget management with segment-level allocation.
 *
 * @module
 */

import type { TokenBudget, BudgetConfig } from './types.js';
import { HarnessError, HarnessErrorCode} from '../core/errors.js';

/**
 * Create a token budget tracker with named segments.
 *
 * @example
 * ```ts
 * const budget = createBudget({
 *   totalTokens: 4096,
 *   segments: [
 *     { name: 'system', maxTokens: 500, reserved: true },
 *     { name: 'history', maxTokens: 3000, trimPriority: 1 },
 *     { name: 'recent', maxTokens: 596, trimPriority: 0 },
 *   ],
 * });
 * budget.allocate('system', 200);
 * console.log(budget.remaining('system')); // 300
 * ```
 */
export function createBudget(config: BudgetConfig): TokenBudget {
  if (config.totalTokens <= 0) {
    throw new HarnessError(
      `totalTokens must be positive, got ${config.totalTokens}`,
      HarnessErrorCode.CORE_INVALID_BUDGET,
      'Provide a totalTokens value greater than 0',
    );
  }

  const responseReserve = config.responseReserve ?? 0;

  const segmentState = new Map<
    string,
    { maxTokens: number; used: number; trimPriority: number; reserved: boolean }
  >();

  for (const seg of config.segments) {
    if (seg.maxTokens <= 0) {
      throw new HarnessError(
        `Segment "${seg.name}" maxTokens must be positive, got ${seg.maxTokens}`,
        HarnessErrorCode.CORE_INVALID_BUDGET,
        'Provide a maxTokens value greater than 0 for each segment',
      );
    }
    segmentState.set(seg.name, {
      maxTokens: seg.maxTokens,
      used: 0,
      trimPriority: seg.trimPriority ?? 0,
      reserved: seg.reserved ?? false,
    });
  }

  function getSegment(name: string): { maxTokens: number; used: number; trimPriority: number; reserved: boolean } {
    const seg = segmentState.get(name);
    if (!seg) {
      throw new HarnessError(
        `Unknown segment: "${name}"`,
        HarnessErrorCode.CONTEXT_UNKNOWN_SEGMENT,
        `Available segments: ${[...segmentState.keys()].join(', ')}`,
      );
    }
    return seg;
  }

  return {
    totalTokens: config.totalTokens,
    responseReserve,

    remaining(segmentName: string): number {
      const seg = getSegment(segmentName);
      return Math.max(0, seg.maxTokens - seg.used);
    },

    allocate(segmentName: string, tokens: number): void {
      const seg = getSegment(segmentName);
      // H2: Validate that allocation doesn't exceed segment maxTokens
      if (seg.used + tokens > seg.maxTokens) {
        throw new HarnessError(
          `Allocation of ${tokens} tokens would exceed segment "${segmentName}" maxTokens (${seg.maxTokens}). Current usage: ${seg.used}`,
          HarnessErrorCode.CONTEXT_SEGMENT_OVERFLOW,
          `Remaining capacity: ${seg.maxTokens - seg.used}`,
        );
      }
      seg.used += tokens;
    },

    tryAllocate(segmentName: string, tokens: number): boolean {
      const seg = getSegment(segmentName);
      if (seg.used + tokens > seg.maxTokens) {
        return false;
      }
      seg.used += tokens;
      return true;
    },

    reset(segmentName: string): void {
      const seg = getSegment(segmentName);
      seg.used = 0;
    },

    needsTrimming(): boolean {
      let totalUsed = 0;
      for (const seg of segmentState.values()) {
        totalUsed += seg.used;
        // H1: Check if any segment exceeds its maxTokens
        if (seg.used > seg.maxTokens) {
          return true;
        }
      }
      // H3: responseReserve is already accounted for here
      return totalUsed + responseReserve > config.totalTokens;
    },

    trimOrder(): Array<{ segment: string; trimBy: number; priority: number }> {
      const entries: Array<{ segment: string; trimBy: number; priority: number }> = [];
      for (const [name, seg] of segmentState) {
        if (seg.reserved || seg.used === 0) continue;
        entries.push({
          segment: name,
          trimBy: seg.used,
          priority: seg.trimPriority,
        });
      }
      // Sort by trimPriority descending (highest first = trim first)
      entries.sort((a, b) => b.priority - a.priority);
      return entries;
    },
  };
}
