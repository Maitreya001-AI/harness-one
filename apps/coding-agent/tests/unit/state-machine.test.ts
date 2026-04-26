import { describe, expect, it } from 'vitest';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

import {
  assertTransition,
  isLegalTransition,
  isTerminal,
  nextStates,
} from '../../src/agent/state-machine.js';
import type { TaskState } from '../../src/agent/types.js';

const ALL_STATES: readonly TaskState[] = [
  'planning',
  'executing',
  'testing',
  'reviewing',
  'done',
  'aborted',
];

describe('state-machine.isLegalTransition', () => {
  it('allows the canonical happy-path forward chain', () => {
    expect(isLegalTransition('planning', 'executing')).toBe(true);
    expect(isLegalTransition('executing', 'testing')).toBe(true);
    expect(isLegalTransition('testing', 'reviewing')).toBe(true);
    expect(isLegalTransition('reviewing', 'done')).toBe(true);
  });

  it('allows the testing → executing retry loop and executing self-loop', () => {
    expect(isLegalTransition('testing', 'executing')).toBe(true);
    expect(isLegalTransition('executing', 'executing')).toBe(true);
  });

  it('rejects non-executing self-loops', () => {
    expect(isLegalTransition('planning', 'planning')).toBe(false);
    expect(isLegalTransition('testing', 'testing')).toBe(false);
    expect(isLegalTransition('reviewing', 'reviewing')).toBe(false);
    expect(isLegalTransition('done', 'done')).toBe(false);
    expect(isLegalTransition('aborted', 'aborted')).toBe(false);
  });

  it('allows abort from every non-terminal state', () => {
    for (const s of ['planning', 'executing', 'testing', 'reviewing'] as TaskState[]) {
      expect(isLegalTransition(s, 'aborted')).toBe(true);
    }
  });

  it('forbids abort from terminal states', () => {
    expect(isLegalTransition('done', 'aborted')).toBe(false);
    expect(isLegalTransition('aborted', 'aborted')).toBe(false);
  });

  it('forbids backward jumps that skip phases', () => {
    expect(isLegalTransition('reviewing', 'planning')).toBe(false);
    expect(isLegalTransition('done', 'planning')).toBe(false);
    expect(isLegalTransition('reviewing', 'executing')).toBe(false);
    expect(isLegalTransition('planning', 'testing')).toBe(false);
    expect(isLegalTransition('planning', 'reviewing')).toBe(false);
    expect(isLegalTransition('planning', 'done')).toBe(false);
  });

  it('terminal states have no outgoing transitions other than (none)', () => {
    for (const target of ALL_STATES) {
      expect(isLegalTransition('done', target)).toBe(false);
    }
  });
});

describe('state-machine.assertTransition', () => {
  it('passes silently on legal transitions', () => {
    expect(() => assertTransition('planning', 'executing')).not.toThrow();
  });

  it('throws CORE_INVALID_STATE on illegal transitions', () => {
    let caught: unknown;
    try {
      assertTransition('done', 'planning');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    expect((caught as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_STATE);
    expect((caught as HarnessError).message).toContain('done → planning');
  });
});

describe('state-machine.isTerminal', () => {
  it('flags only done and aborted', () => {
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('aborted')).toBe(true);
    expect(isTerminal('planning')).toBe(false);
    expect(isTerminal('executing')).toBe(false);
    expect(isTerminal('testing')).toBe(false);
    expect(isTerminal('reviewing')).toBe(false);
  });
});

describe('state-machine.nextStates', () => {
  it('returns the legal successor list including abort', () => {
    expect(nextStates('planning')).toEqual(['executing', 'aborted']);
    expect(nextStates('reviewing')).toEqual(['done', 'aborted']);
  });

  it('returns empty list for terminal states', () => {
    expect(nextStates('done')).toEqual([]);
    expect(nextStates('aborted')).toEqual([]);
  });

  it('lists self-loop + advance from executing', () => {
    expect(nextStates('executing')).toEqual(['executing', 'testing', 'aborted']);
  });
});
