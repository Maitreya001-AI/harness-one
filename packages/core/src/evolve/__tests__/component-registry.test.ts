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
  });
});
