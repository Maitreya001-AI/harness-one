/**
 * Three-dimensional budget tracker for a single coding-agent task.
 *
 * Tracks tokens / iterations / wall-clock against the configured
 * `BudgetLimits` (DESIGN §3.9). Emits an `AbortReason` once any axis is
 * exhausted; the orchestrator then persists a final checkpoint and exits
 * with `reason: 'budget'`.
 *
 * Token cost is computed from `harness-one/observe`'s `CostTracker`,
 * keeping pricing tables centralised. The budget tracker holds only the
 * usage counters and the cost it pulls from the tracker.
 *
 * @module
 */

import type { TokenUsage } from 'harness-one/core';
import type { CostTracker } from 'harness-one/observe';

import type { BudgetLimits, BudgetState } from './types.js';

export type BudgetExhaustedAxis = 'tokens' | 'iterations' | 'duration';

export interface BudgetSnapshot {
  readonly state: BudgetState;
  readonly exhaustedAxis: BudgetExhaustedAxis | null;
}

export interface BudgetTracker {
  /** Bump iteration counter. Returns the new snapshot. */
  recordIteration(): BudgetSnapshot;
  /** Add token usage from an adapter call. Returns the new snapshot. */
  recordUsage(usage: TokenUsage, model?: string): BudgetSnapshot;
  /** Refresh elapsed time without changing other axes. */
  tick(): BudgetSnapshot;
  /** Current snapshot. */
  snapshot(): BudgetSnapshot;
}

export interface BudgetTrackerOptions {
  readonly limits: BudgetLimits;
  readonly costTracker: CostTracker;
  readonly initial?: BudgetState;
  /** Override `Date.now()` in tests. */
  readonly now?: () => number;
}

export function createBudgetTracker(options: BudgetTrackerOptions): BudgetTracker {
  const now = options.now ?? Date.now;
  const startedAt = now() - (options.initial?.elapsedMs ?? 0);
  let state: BudgetState = options.initial ?? {
    tokensUsed: 0,
    iterations: 0,
    elapsedMs: 0,
    costUsd: 0,
  };

  function exhaustedAxis(s: BudgetState): BudgetExhaustedAxis | null {
    if (s.tokensUsed >= options.limits.tokens) return 'tokens';
    if (s.iterations >= options.limits.iterations) return 'iterations';
    if (s.elapsedMs >= options.limits.durationMs) return 'duration';
    return null;
  }

  function bumpElapsed(): BudgetState {
    return { ...state, elapsedMs: now() - startedAt };
  }

  function snap(): BudgetSnapshot {
    return { state, exhaustedAxis: exhaustedAxis(state) };
  }

  return {
    recordIteration(): BudgetSnapshot {
      state = { ...bumpElapsed(), iterations: state.iterations + 1 };
      return snap();
    },
    recordUsage(usage, model): BudgetSnapshot {
      const tokens = usage.inputTokens + usage.outputTokens;
      const tokensUsed = state.tokensUsed + tokens;
      const record = options.costTracker.recordUsage({
        traceId: 'coding-agent',
        model: model ?? 'unknown',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cacheReadTokens !== undefined && { cacheReadTokens: usage.cacheReadTokens }),
        ...(usage.cacheWriteTokens !== undefined && { cacheWriteTokens: usage.cacheWriteTokens }),
      });
      const costUsd = state.costUsd + (record.estimatedCost ?? 0);
      state = { ...bumpElapsed(), tokensUsed, costUsd };
      return snap();
    },
    tick(): BudgetSnapshot {
      state = bumpElapsed();
      return snap();
    },
    snapshot(): BudgetSnapshot {
      return snap();
    },
  };
}
