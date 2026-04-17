/**
 * Unit tests for the extracted delegation tracker. Pins the cycle
 * detection + size cap + per-source lock behaviour that previously
 * lived inline in orchestrator.ts.
 */

import { describe, it, expect } from 'vitest';
import { createDelegationTracker } from '../delegation-tracker.js';
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';

describe('createDelegationTracker', () => {
  it('accepts edges without creating cycles', () => {
    const t = createDelegationTracker({ maxEntries: 100 });
    t.recordEdge('a', 'b');
    t.recordEdge('b', 'c');
    expect(() => t.assertNoCycle('c', 'd')).not.toThrow();
  });

  it('detects direct cycles (a → b, b → a)', () => {
    const t = createDelegationTracker({ maxEntries: 100 });
    t.recordEdge('a', 'b');
    expect(() => t.assertNoCycle('b', 'a')).toThrow(HarnessError);
  });

  it('detects transitive cycles (a → b → c → a)', () => {
    const t = createDelegationTracker({ maxEntries: 100 });
    t.recordEdge('a', 'b');
    t.recordEdge('b', 'c');
    expect(() => t.assertNoCycle('c', 'a')).toThrow(/cycle detected/);
  });

  it('uses ORCH_DELEGATION_CYCLE for the cycle error', () => {
    const t = createDelegationTracker({ maxEntries: 100 });
    t.recordEdge('a', 'b');
    try {
      t.assertNoCycle('b', 'a');
    } catch (err) {
      expect((err as HarnessError).code).toBe(HarnessErrorCode.ORCH_DELEGATION_CYCLE);
    }
  });

  it('enforces the cumulative size cap', () => {
    const t = createDelegationTracker({ maxEntries: 2 });
    t.recordEdge('a', 'b');
    t.recordEdge('a', 'c');
    // Third distinct edge breaches the cap.
    expect(() => t.recordEdge('a', 'd')).toThrow(/cap of 2 entries/);
  });

  it('does not double-count when the edge already exists', () => {
    const t = createDelegationTracker({ maxEntries: 1 });
    t.recordEdge('a', 'b');
    // Re-recording the same edge should not breach the cap.
    expect(() => t.recordEdge('a', 'b')).not.toThrow();
  });

  it('returns the same lock for repeated source ids', () => {
    const t = createDelegationTracker({ maxEntries: 10 });
    const l1 = t.getLock('a');
    const l2 = t.getLock('a');
    expect(l1).toBe(l2);
  });

  it('removeAgent purges the agent from every chain', () => {
    const t = createDelegationTracker({ maxEntries: 100 });
    t.recordEdge('a', 'b');
    t.recordEdge('c', 'b');
    t.recordEdge('b', 'd');
    t.removeAgent('b');
    // 'b' should no longer appear as source or target.
    expect(() => t.assertNoCycle('d', 'b')).not.toThrow();
  });

  it('clear() wipes every tracked edge and lock', () => {
    const t = createDelegationTracker({ maxEntries: 100 });
    t.recordEdge('a', 'b');
    t.clear();
    expect(() => t.assertNoCycle('a', 'b')).not.toThrow();
  });
});
