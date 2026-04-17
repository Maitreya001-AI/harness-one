/**
 * Tests for `cost-alert-manager.ts` — round-3 extraction from cost-tracker.
 */
import { describe, it, expect, vi } from 'vitest';
import { createCostAlertManager } from '../cost-alert-manager.js';
import type { CostAlert } from '../types.js';

describe('createCostAlertManager', () => {
  it('returns null when no budget configured', () => {
    let cost = 0;
    const mgr = createCostAlertManager({ getCurrentCost: () => cost });
    cost = 100;
    expect(mgr.checkBudget()).toBeNull();
    expect(mgr.getAlertMessage()).toBeNull();
    expect(mgr.isBudgetExceeded()).toBe(false);
    expect(mgr.budgetUtilization()).toBe(0);
  });

  it('fires warning → critical → exceeded as cost crosses thresholds', () => {
    let cost = 0;
    const mgr = createCostAlertManager({
      budget: 10,
      alertThresholds: { warning: 0.5, critical: 0.8 },
      getCurrentCost: () => cost,
    });
    cost = 1;
    expect(mgr.checkBudget()).toBeNull();
    cost = 5;
    expect(mgr.checkBudget()?.type).toBe('warning');
    cost = 8;
    expect(mgr.checkBudget()?.type).toBe('critical');
    cost = 15;
    expect(mgr.checkBudget()?.type).toBe('exceeded');
    expect(mgr.isBudgetExceeded()).toBe(true);
  });

  it('dedupes alerts within window', () => {
    const cost = 9;
    const calls: CostAlert[] = [];
    const mgr = createCostAlertManager({
      budget: 10,
      alertDedupeWindowMs: 10_000,
      getCurrentCost: () => cost,
    });
    mgr.registerHandler((a) => calls.push(a));
    const a = mgr.checkBudget() ?? {
      type: 'warning',
      currentCost: 9,
      budget: 10,
      percentUsed: 0.9,
      message: 'synth',
    };
    mgr.emit(a);
    mgr.emit(a);
    mgr.emit(a);
    expect(calls).toHaveLength(1);
  });

  it('resetDedupe() allows the next alert to re-fire', () => {
    const calls: CostAlert[] = [];
    const mgr = createCostAlertManager({
      budget: 10,
      alertDedupeWindowMs: 10_000,
      getCurrentCost: () => 9,
    });
    mgr.registerHandler((a) => calls.push(a));
    const synth: CostAlert = {
      type: 'warning',
      currentCost: 9,
      budget: 10,
      percentUsed: 0.9,
      message: 'synth',
    };
    mgr.emit(synth);
    mgr.emit(synth);
    mgr.resetDedupe();
    mgr.emit(synth);
    expect(calls).toHaveLength(2);
  });

  it('registerHandler returns an unsubscribe', () => {
    const mgr = createCostAlertManager({
      budget: 10,
      getCurrentCost: () => 9,
    });
    const spy = vi.fn();
    const off = mgr.registerHandler(spy);
    mgr.emit({
      type: 'warning',
      currentCost: 9,
      budget: 10,
      percentUsed: 0.9,
      message: 'synth',
    });
    off();
    // dedupe window default 500ms — reset to be safe:
    mgr.resetDedupe();
    mgr.emit({
      type: 'critical',
      currentCost: 10,
      budget: 10,
      percentUsed: 1.0,
      message: 'synth',
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('updateBudget and getBudget round-trip', () => {
    const mgr = createCostAlertManager({
      budget: 10,
      getCurrentCost: () => 0,
    });
    expect(mgr.getBudget()).toBe(10);
    mgr.updateBudget(20);
    expect(mgr.getBudget()).toBe(20);
    mgr.updateBudget(undefined);
    expect(mgr.getBudget()).toBeUndefined();
  });

  it('isBudgetExceeded treats zero/undefined budget as never exceeded', () => {
    const mgr = createCostAlertManager({
      getCurrentCost: () => 1e9,
    });
    expect(mgr.isBudgetExceeded()).toBe(false);
    mgr.updateBudget(0);
    expect(mgr.isBudgetExceeded()).toBe(false);
  });
});
