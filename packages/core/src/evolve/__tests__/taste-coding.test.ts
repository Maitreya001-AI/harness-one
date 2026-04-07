import { describe, it, expect } from 'vitest';
import { createTasteCodingRegistry } from '../taste-coding.js';
import { HarnessError } from '../../core/errors.js';
import type { TasteCodingRule } from '../types.js';

const makeRule = (overrides: Partial<TasteCodingRule> = {}): TasteCodingRule => ({
  id: 'tc-001',
  pattern: 'Using plain Error',
  rule: 'Use HarnessError instead',
  enforcement: 'lint',
  createdFrom: 'PR #42',
  createdAt: '2025-06-01',
  ...overrides,
});

describe('createTasteCodingRegistry', () => {
  it('adds and retrieves rules', () => {
    const registry = createTasteCodingRegistry();
    registry.addRule(makeRule());
    const rules = registry.getRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('tc-001');
  });

  it('throws on duplicate rule id', () => {
    const registry = createTasteCodingRegistry();
    registry.addRule(makeRule());
    expect(() => registry.addRule(makeRule())).toThrow(HarnessError);
  });

  it('filters by enforcement type', () => {
    const registry = createTasteCodingRegistry();
    registry.addRule(makeRule({ id: 'r1', enforcement: 'lint' }));
    registry.addRule(makeRule({ id: 'r2', enforcement: 'ci' }));
    registry.addRule(makeRule({ id: 'r3', enforcement: 'manual' }));

    expect(registry.getRules({ enforcement: 'lint' })).toHaveLength(1);
    expect(registry.getRules({ enforcement: 'ci' })).toHaveLength(1);
  });

  it('removes a rule', () => {
    const registry = createTasteCodingRegistry();
    registry.addRule(makeRule());
    registry.removeRule('tc-001');
    expect(registry.count()).toBe(0);
  });

  it('throws when removing unknown rule', () => {
    const registry = createTasteCodingRegistry();
    expect(() => registry.removeRule('nope')).toThrow(HarnessError);
  });

  it('counts rules', () => {
    const registry = createTasteCodingRegistry();
    expect(registry.count()).toBe(0);
    registry.addRule(makeRule({ id: 'r1' }));
    registry.addRule(makeRule({ id: 'r2' }));
    expect(registry.count()).toBe(2);
  });

  describe('exportRules', () => {
    it('exports as markdown', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule());
      const md = registry.exportRules();
      expect(md).toContain('# Taste-Coding Rules');
      expect(md).toContain('tc-001');
      expect(md).toContain('Use HarnessError instead');
      expect(md).toContain('**Enforcement**: lint');
    });

    it('handles empty registry', () => {
      const registry = createTasteCodingRegistry();
      const md = registry.exportRules();
      expect(md).toContain('No rules defined');
    });
  });
});
