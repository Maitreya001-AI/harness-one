/**
 * Token budget management with segment-level allocation.
 *
 * @module
 */

import type { TokenBudget, BudgetConfig } from './types.js';

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
  const responseReserve = config.responseReserve ?? 0;

  const segmentState = new Map<
    string,
    { maxTokens: number; used: number; trimPriority: number; reserved: boolean }
  >();

  for (const seg of config.segments) {
    segmentState.set(seg.name, {
      maxTokens: seg.maxTokens,
      used: 0,
      trimPriority: seg.trimPriority ?? 0,
      reserved: seg.reserved ?? false,
    });
  }

  function getSegment(name: string) {
    const seg = segmentState.get(name);
    if (!seg) {
      throw new Error(`Unknown segment: "${name}"`);
    }
    return seg;
  }

  return {
    totalTokens: config.totalTokens,

    remaining(segmentName: string): number {
      const seg = getSegment(segmentName);
      return Math.max(0, seg.maxTokens - seg.used);
    },

    allocate(segmentName: string, tokens: number): void {
      const seg = getSegment(segmentName);
      seg.used += tokens;
    },

    reset(segmentName: string): void {
      const seg = getSegment(segmentName);
      seg.used = 0;
    },

    needsTrimming(): boolean {
      let totalUsed = 0;
      for (const seg of segmentState.values()) {
        totalUsed += seg.used;
      }
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
