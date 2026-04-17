/**
 * Budget alert machinery for the cost tracker.
 *
 * Extracted from `cost-tracker.ts` in round-3 cleanup. Owns:
 *
 *   - the runtime-mutable `budget` value and warning/critical thresholds,
 *   - alert-handler fan-out (Set-based, O(1) unsubscribe),
 *   - threshold evaluation (`checkBudget`, `getAlertMessage`,
 *     `isBudgetExceeded`, `budgetUtilization`, `shouldStop`),
 *   - alert dedupe per `{warning|critical|exceeded}` bucket,
 *   - structured logger + metrics counter emission per alert.
 *
 * The tracker injects a `getCurrentCost()` thunk so the alert manager never
 * touches the KahanSum accumulator directly — keeps the concerns separated
 * while still supporting fractional-cent precision under budget crossings.
 *
 * @module
 */

import type { CostAlert } from './types.js';
import type { Logger } from './logger.js';
import type { MetricsPort, MetricCounter } from './metrics-port.js';

export interface CostAlertManagerConfig {
  readonly budget?: number;
  readonly alertThresholds?: { readonly warning: number; readonly critical: number };
  /**
   * Suppress duplicate budget alerts emitted within this window (per alert
   * type). Default: 500ms. Set to `0` to disable dedupe.
   */
  readonly alertDedupeWindowMs?: number;
  readonly logger?: Logger;
  readonly metrics?: MetricsPort;
  /** Read the cost-tracker's current running total. */
  readonly getCurrentCost: () => number;
}

export interface CostAlertManager {
  /** Register an alert handler; returns an unsubscribe function. */
  registerHandler(handler: (alert: CostAlert) => void): () => void;
  /** Dispatch an alert (with dedupe, logger, metric, handler fan-out). */
  emit(alert: CostAlert): void;
  /**
   * Evaluate thresholds against the current running cost and return the alert
   * that should fire, or `null` when below the warning threshold.
   */
  checkBudget(): CostAlert | null;
  /** Short advisory message matching `checkBudget`, or `null`. */
  getAlertMessage(): string | null;
  /** True iff current cost is at or above the budget (budget must be set). */
  isBudgetExceeded(): boolean;
  /** Fraction of the budget consumed (0 when no budget is configured). */
  budgetUtilization(): number;
  /** `shouldStop()` is an alias for `isBudgetExceeded()`. */
  shouldStop(): boolean;
  /** Replace the budget; `undefined` clears it. */
  updateBudget(newBudget: number | undefined): void;
  /** Current configured budget (may be `undefined`). */
  getBudget(): number | undefined;
  /**
   * Reset dedupe state so every alert type can fire fresh. Intended for
   * cost-tracker `reset()` and test checkpoint workflows.
   */
  resetDedupe(): void;
}

export function createCostAlertManager(
  config: Readonly<CostAlertManagerConfig>,
): CostAlertManager {
  const alertHandlers = new Set<(alert: CostAlert) => void>();
  let budget: number | undefined = config.budget;
  const warningThreshold = config.alertThresholds?.warning ?? 0.8;
  const criticalThreshold = config.alertThresholds?.critical ?? 0.95;
  const alertDedupeWindowMs = config.alertDedupeWindowMs ?? 500;
  const lastAlertTs: Record<CostAlert['type'], number> = {
    warning: 0,
    critical: 0,
    exceeded: 0,
  };
  const logger = config.logger;
  const costAlertCounter: MetricCounter | undefined = config.metrics?.counter(
    'harness.cost.alerts.total',
    { description: 'Count of emitted budget alerts by type' },
  );

  function registerHandler(handler: (alert: CostAlert) => void): () => void {
    alertHandlers.add(handler);
    return () => {
      alertHandlers.delete(handler);
    };
  }

  function emit(alert: CostAlert): void {
    // Dedupe within a time window, per alert type. A single budget crossing
    // during a streaming recordUsage() burst produces exactly one alert per
    // type until the window elapses.
    if (alertDedupeWindowMs > 0) {
      const now = Date.now();
      const last = lastAlertTs[alert.type];
      if (last !== 0 && now - last < alertDedupeWindowMs) {
        return;
      }
      lastAlertTs[alert.type] = now;
    }
    if (logger) {
      try {
        logger.warn('[harness-one/cost-tracker] budget alert', {
          type: alert.type,
          percent_used: alert.percentUsed,
          current_cost: alert.currentCost,
          budget: alert.budget,
        });
      } catch {
        /* logger failure non-fatal */
      }
    }
    costAlertCounter?.add(1, { type: alert.type });
    for (const handler of alertHandlers) {
      handler(alert);
    }
  }

  function checkBudget(): CostAlert | null {
    if (budget === undefined || budget <= 0) return null;
    const currentCost = config.getCurrentCost();
    const percentUsed = currentCost / budget;

    if (percentUsed >= 1.0) {
      return {
        type: 'exceeded',
        currentCost,
        budget,
        percentUsed,
        message: `Exceeded: ${(percentUsed * 100).toFixed(1)}% of budget used ($${currentCost.toFixed(4)} / $${budget.toFixed(2)})`,
      };
    }
    if (percentUsed >= criticalThreshold) {
      return {
        type: 'critical',
        currentCost,
        budget,
        percentUsed,
        message: `Critical: ${(percentUsed * 100).toFixed(1)}% of budget used ($${currentCost.toFixed(4)} / $${budget.toFixed(2)})`,
      };
    }
    if (percentUsed >= warningThreshold) {
      return {
        type: 'warning',
        currentCost,
        budget,
        percentUsed,
        message: `Warning: ${(percentUsed * 100).toFixed(1)}% of budget used ($${currentCost.toFixed(4)} / $${budget.toFixed(2)})`,
      };
    }
    return null;
  }

  function getAlertMessage(): string | null {
    if (budget === undefined) return null;
    const currentCost = config.getCurrentCost();
    const percentUsed = currentCost / budget;

    if (percentUsed >= 1.0) {
      return `[BUDGET EXCEEDED] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Stop all non-essential operations.`;
    }
    if (percentUsed >= criticalThreshold) {
      return `[BUDGET CRITICAL] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Be extremely concise.`;
    }
    if (percentUsed >= warningThreshold) {
      return `[BUDGET WARNING] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Please be concise.`;
    }
    return null;
  }

  function isBudgetExceeded(): boolean {
    if (budget === undefined || budget <= 0) return false;
    return config.getCurrentCost() >= budget;
  }

  function budgetUtilization(): number {
    if (budget === undefined || budget <= 0) return 0;
    return config.getCurrentCost() / budget;
  }

  return {
    registerHandler,
    emit,
    checkBudget,
    getAlertMessage,
    isBudgetExceeded,
    budgetUtilization,
    shouldStop: isBudgetExceeded,
    updateBudget(newBudget): void {
      budget = newBudget;
    },
    getBudget(): number | undefined {
      return budget;
    },
    resetDedupe(): void {
      lastAlertTs.warning = 0;
      lastAlertTs.critical = 0;
      lastAlertTs.exceeded = 0;
    },
  };
}
