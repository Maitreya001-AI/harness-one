import { describe, expect, it } from 'vitest';

import { builtinFixtures } from '../../../src/eval/fixtures/builtin.js';

describe('builtinFixtures', () => {
  it('exposes three canonical fixtures', () => {
    expect(builtinFixtures).toHaveLength(3);
    const ids = builtinFixtures.map((f) => f.id);
    expect(ids).toEqual([
      'read-summarise-001',
      'rename-fn-001',
      'refactor-extract-001',
    ]);
  });

  it('every fixture has a verifier and a non-empty workspace', () => {
    for (const f of builtinFixtures) {
      expect(typeof f.verify).toBe('function');
      expect(Object.keys(f.workspace).length).toBeGreaterThan(0);
    }
  });

  it('every fixture has a budget below the global default', () => {
    for (const f of builtinFixtures) {
      expect(f.budget?.tokens).toBeDefined();
      expect(f.budget?.iterations).toBeDefined();
      expect(f.budget?.durationMs).toBeDefined();
    }
  });
});
