import { describe, it, expect } from 'vitest';
import { createComponentRegistry } from '../component-registry.js';
import { HarnessError } from '../../core/errors.js';
import type { ComponentMeta } from '../types.js';

const makeMeta = (overrides: Partial<ComponentMeta> = {}): ComponentMeta => ({
  id: 'comp-1',
  name: 'Test Component',
  description: 'A test component',
  modelAssumption: 'Models have limited context',
  retirementCondition: 'When context is unlimited',
  createdAt: '2025-01-01',
  ...overrides,
});

describe('createComponentRegistry', () => {
  it('registers and retrieves a component', () => {
    const registry = createComponentRegistry();
    const meta = makeMeta();
    registry.register(meta);
    expect(registry.get('comp-1')).toEqual(meta);
  });

  it('returns undefined for unknown component', () => {
    const registry = createComponentRegistry();
    expect(registry.get('nope')).toBeUndefined();
  });

  it('throws on duplicate registration', () => {
    const registry = createComponentRegistry();
    registry.register(makeMeta());
    expect(() => registry.register(makeMeta())).toThrow(HarnessError);
  });

  describe('list', () => {
    it('lists all components', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta({ id: 'a', tags: ['x'] }));
      registry.register(makeMeta({ id: 'b', tags: ['y'] }));
      expect(registry.list()).toHaveLength(2);
    });

    it('filters by tags', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta({ id: 'a', tags: ['x'] }));
      registry.register(makeMeta({ id: 'b', tags: ['y'] }));
      expect(registry.list({ tags: ['x'] })).toHaveLength(1);
    });
  });

  describe('validate', () => {
    it('validates a registered component', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta());
      const result = registry.validate('comp-1');
      expect(result.valid).toBe(true);
    });

    it('throws for unknown component', () => {
      const registry = createComponentRegistry();
      expect(() => registry.validate('nope')).toThrow(HarnessError);
    });

    it('returns invalid when retirement condition is met (H1: validate stub fix)', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta({
        id: 'ctx-packer',
        retirementCondition: 'contextWindow > 1000000',
      }));
      // Provide a context where the retirement condition is met
      const result = registry.validate('ctx-packer', { contextWindow: 2000000 });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Retirement condition met');
    });

    it('returns valid when retirement condition is NOT met', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta({
        id: 'ctx-packer',
        retirementCondition: 'contextWindow > 1000000',
      }));
      const result = registry.validate('ctx-packer', { contextWindow: 500 });
      expect(result.valid).toBe(true);
    });

    it('returns valid when no context is provided (backwards compatible)', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta());
      const result = registry.validate('comp-1');
      expect(result.valid).toBe(true);
    });

    it('handles equality conditions', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta({
        id: 'c1',
        retirementCondition: 'modelVersion == 5',
      }));
      expect(registry.validate('c1', { modelVersion: 5 }).valid).toBe(false);
      expect(registry.validate('c1', { modelVersion: 4 }).valid).toBe(true);
    });

    it('handles less-than conditions', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta({
        id: 'c1',
        retirementCondition: 'accuracy < 0.5',
      }));
      expect(registry.validate('c1', { accuracy: 0.3 }).valid).toBe(false);
      expect(registry.validate('c1', { accuracy: 0.8 }).valid).toBe(true);
    });

    it('handles greater-than-or-equal conditions', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta({
        id: 'c1',
        retirementCondition: 'tokens >= 100',
      }));
      expect(registry.validate('c1', { tokens: 100 }).valid).toBe(false);
      expect(registry.validate('c1', { tokens: 99 }).valid).toBe(true);
    });

    it('handles less-than-or-equal conditions', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta({
        id: 'c1',
        retirementCondition: 'latency <= 10',
      }));
      expect(registry.validate('c1', { latency: 10 }).valid).toBe(false);
      expect(registry.validate('c1', { latency: 11 }).valid).toBe(true);
    });

    it('returns valid when context key is missing for the condition', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta({
        id: 'c1',
        retirementCondition: 'missingKey > 100',
      }));
      // Key not present in context, condition cannot be evaluated as met
      expect(registry.validate('c1', { otherKey: 999 }).valid).toBe(true);
    });
  });

  describe('markValidated', () => {
    it('updates lastValidated timestamp', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta());
      registry.markValidated('comp-1');
      const meta = registry.get('comp-1')!;
      expect(meta.lastValidated).toBeDefined();
    });

    it('throws for unknown component', () => {
      const registry = createComponentRegistry();
      expect(() => registry.markValidated('nope')).toThrow(HarnessError);
    });
  });

  describe('getStale', () => {
    it('returns components never validated', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta());
      const stale = registry.getStale(30);
      expect(stale).toHaveLength(1);
    });

    it('returns components validated long ago', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta({
        id: 'old',
        lastValidated: '2020-01-01T00:00:00.000Z',
      }));
      const stale = registry.getStale(30);
      expect(stale).toHaveLength(1);
    });

    it('excludes recently validated components', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta());
      registry.markValidated('comp-1');
      const stale = registry.getStale(30);
      expect(stale).toHaveLength(0);
    });

    it('getStale with various ages', () => {
      const registry = createComponentRegistry();
      // Validated 10 days ago
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      // Validated 60 days ago
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      registry.register(makeMeta({ id: 'recent', lastValidated: tenDaysAgo }));
      registry.register(makeMeta({ id: 'old', lastValidated: sixtyDaysAgo }));
      registry.register(makeMeta({ id: 'never' }));

      // maxAgeDays=30 should return 'old' (60 days) and 'never' (no validation)
      const stale30 = registry.getStale(30);
      expect(stale30).toHaveLength(2);
      expect(stale30.some(c => c.id === 'old')).toBe(true);
      expect(stale30.some(c => c.id === 'never')).toBe(true);

      // maxAgeDays=5 should return all three (10 > 5, 60 > 5, never)
      const stale5 = registry.getStale(5);
      expect(stale5).toHaveLength(3);

      // maxAgeDays=90 should return only 'never' (no validation)
      const stale90 = registry.getStale(90);
      expect(stale90).toHaveLength(1);
      expect(stale90[0].id).toBe('never');
    });
  });

  describe('edge cases', () => {
    it('validate() with context that meets retirement condition', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta({
        id: 'retire-me',
        retirementCondition: 'score >= 100',
      }));
      const result = registry.validate('retire-me', { score: 150 });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Retirement condition met');
    });

    it('validate() with context that does not meet condition', () => {
      const registry = createComponentRegistry();
      registry.register(makeMeta({
        id: 'keep-me',
        retirementCondition: 'score >= 100',
      }));
      const result = registry.validate('keep-me', { score: 50 });
      expect(result.valid).toBe(true);
    });

    it('multiple operators in retirement condition', () => {
      const registry = createComponentRegistry();

      // Test != operator
      registry.register(makeMeta({ id: 'ne-test', retirementCondition: 'version != 3' }));
      expect(registry.validate('ne-test', { version: 5 }).valid).toBe(false);
      expect(registry.validate('ne-test', { version: 3 }).valid).toBe(true);

      // Test <= operator
      registry.register(makeMeta({ id: 'le-test', retirementCondition: 'latency <= 50' }));
      expect(registry.validate('le-test', { latency: 50 }).valid).toBe(false);
      expect(registry.validate('le-test', { latency: 49 }).valid).toBe(false);
      expect(registry.validate('le-test', { latency: 51 }).valid).toBe(true);

      // Test < operator
      registry.register(makeMeta({ id: 'lt-test', retirementCondition: 'accuracy < 0.5' }));
      expect(registry.validate('lt-test', { accuracy: 0.3 }).valid).toBe(false);
      expect(registry.validate('lt-test', { accuracy: 0.5 }).valid).toBe(true);
      expect(registry.validate('lt-test', { accuracy: 0.8 }).valid).toBe(true);
    });
  });
});
