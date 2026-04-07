import { describe, it, expect } from 'vitest';
import { createBudget } from '../budget.js';

describe('createBudget', () => {
  const config = {
    totalTokens: 4096,
    segments: [
      { name: 'system', maxTokens: 500, reserved: true },
      { name: 'history', maxTokens: 3000, trimPriority: 2 },
      { name: 'recent', maxTokens: 596, trimPriority: 1 },
    ],
  };

  it('tracks totalTokens', () => {
    const budget = createBudget(config);
    expect(budget.totalTokens).toBe(4096);
  });

  describe('remaining', () => {
    it('returns max when nothing allocated', () => {
      const budget = createBudget(config);
      expect(budget.remaining('system')).toBe(500);
      expect(budget.remaining('history')).toBe(3000);
    });

    it('decreases after allocate', () => {
      const budget = createBudget(config);
      budget.allocate('system', 200);
      expect(budget.remaining('system')).toBe(300);
    });

    it('floors at 0', () => {
      const budget = createBudget(config);
      budget.allocate('system', 600);
      expect(budget.remaining('system')).toBe(0);
    });

    it('throws on unknown segment', () => {
      const budget = createBudget(config);
      expect(() => budget.remaining('unknown')).toThrow('Unknown segment');
    });
  });

  describe('allocate', () => {
    it('accumulates allocations', () => {
      const budget = createBudget(config);
      budget.allocate('history', 100);
      budget.allocate('history', 200);
      expect(budget.remaining('history')).toBe(2700);
    });
  });

  describe('reset', () => {
    it('resets a segment to full capacity', () => {
      const budget = createBudget(config);
      budget.allocate('history', 2000);
      budget.reset('history');
      expect(budget.remaining('history')).toBe(3000);
    });
  });

  describe('needsTrimming', () => {
    it('returns false when under budget', () => {
      const budget = createBudget(config);
      budget.allocate('system', 500);
      budget.allocate('history', 2000);
      expect(budget.needsTrimming()).toBe(false);
    });

    it('returns true when over total', () => {
      const budget = createBudget(config);
      budget.allocate('system', 500);
      budget.allocate('history', 3000);
      budget.allocate('recent', 597);
      expect(budget.needsTrimming()).toBe(true);
    });

    it('accounts for responseReserve', () => {
      const budget = createBudget({ ...config, responseReserve: 1000 });
      budget.allocate('system', 500);
      budget.allocate('history', 3000);
      // 500 + 3000 + 1000(reserve) = 4500 > 4096
      expect(budget.needsTrimming()).toBe(true);
    });
  });

  describe('trimOrder', () => {
    it('returns segments sorted by trimPriority descending', () => {
      const budget = createBudget(config);
      budget.allocate('history', 1000);
      budget.allocate('recent', 500);

      const order = budget.trimOrder();
      expect(order[0].segment).toBe('history');
      expect(order[0].priority).toBe(2);
      expect(order[1].segment).toBe('recent');
      expect(order[1].priority).toBe(1);
    });

    it('excludes reserved segments', () => {
      const budget = createBudget(config);
      budget.allocate('system', 500);
      budget.allocate('history', 1000);

      const order = budget.trimOrder();
      const names = order.map((o) => o.segment);
      expect(names).not.toContain('system');
    });

    it('excludes segments with 0 usage', () => {
      const budget = createBudget(config);
      budget.allocate('history', 1000);

      const order = budget.trimOrder();
      expect(order).toHaveLength(1);
      expect(order[0].segment).toBe('history');
    });
  });
});
