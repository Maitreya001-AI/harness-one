import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createRoundRobinStrategy,
  createRandomStrategy,
  createFirstAvailableStrategy,
} from '../strategies.js';
import type { AgentRegistration, DelegationTask } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agent(id: string, status: 'idle' | 'running' | 'completed' | 'failed' = 'idle'): AgentRegistration {
  return { id, name: `Agent ${id}`, status };
}

const task: DelegationTask = { description: 'test task' };

// Safety net: restore any spies even if a test throws before its explicit
// mockRestore() call (e.g., via vi.spyOn(Math, 'random')).
afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// createRoundRobinStrategy
// ===========================================================================

describe('createRoundRobinStrategy', () => {
  it('cycles through idle agents in order', () => {
    const strategy = createRoundRobinStrategy();
    const agents = [agent('a1'), agent('a2'), agent('a3')];

    expect(strategy.select(agents, task)).toBe('a1');
    expect(strategy.select(agents, task)).toBe('a2');
    expect(strategy.select(agents, task)).toBe('a3');
    // Wraps around
    expect(strategy.select(agents, task)).toBe('a1');
  });

  it('returns undefined for empty agent list', () => {
    const strategy = createRoundRobinStrategy();
    expect(strategy.select([], task)).toBeUndefined();
  });

  it('filters by idle status only', () => {
    const strategy = createRoundRobinStrategy();
    const agents = [
      agent('a1', 'running'),
      agent('a2', 'idle'),
      agent('a3', 'completed'),
      agent('a4', 'idle'),
    ];

    // Only a2 and a4 are idle
    expect(strategy.select(agents, task)).toBe('a2');
    expect(strategy.select(agents, task)).toBe('a4');
    expect(strategy.select(agents, task)).toBe('a2'); // wraps
  });

  it('returns undefined when all agents are non-idle', () => {
    const strategy = createRoundRobinStrategy();
    const agents = [
      agent('a1', 'running'),
      agent('a2', 'completed'),
      agent('a3', 'failed'),
    ];

    expect(strategy.select(agents, task)).toBeUndefined();
  });

  it('handles single idle agent', () => {
    const strategy = createRoundRobinStrategy();
    const agents = [agent('a1')];

    expect(strategy.select(agents, task)).toBe('a1');
    expect(strategy.select(agents, task)).toBe('a1');
    expect(strategy.select(agents, task)).toBe('a1');
  });

  it('adapts when idle set changes between calls', () => {
    const strategy = createRoundRobinStrategy();

    // First call: 3 idle agents
    const agents1 = [agent('a1'), agent('a2'), agent('a3')];
    expect(strategy.select(agents1, task)).toBe('a1');
    expect(strategy.select(agents1, task)).toBe('a2');

    // Second call: only 2 idle agents (a2 is now running)
    const agents2 = [agent('a1'), agent('a2', 'running'), agent('a3')];
    // lastIndex was 1, next is (1+1) % 2 = 0
    const result = strategy.select(agents2, task);
    // Should pick from the idle set [a1, a3]
    expect(['a1', 'a3']).toContain(result);
  });

  it('maintains round-robin state across many calls', () => {
    const strategy = createRoundRobinStrategy();
    const agents = [agent('a1'), agent('a2')];

    const selections: string[] = [];
    for (let i = 0; i < 6; i++) {
      const selected = strategy.select(agents, task);
      if (selected) selections.push(selected);
    }

    // Should alternate: a1, a2, a1, a2, a1, a2
    expect(selections).toEqual(['a1', 'a2', 'a1', 'a2', 'a1', 'a2']);
  });

  it('handles agents with metadata', () => {
    const strategy = createRoundRobinStrategy();
    const agents = [
      { ...agent('a1'), metadata: { role: 'coder' } },
      { ...agent('a2'), metadata: { role: 'reviewer' } },
    ];

    expect(strategy.select(agents, task)).toBe('a1');
    expect(strategy.select(agents, task)).toBe('a2');
  });

  it('handles task with requirements', () => {
    const strategy = createRoundRobinStrategy();
    const agents = [agent('a1'), agent('a2')];
    const taskWithReqs: DelegationTask = {
      description: 'complex task',
      requirements: ['typescript', 'testing'],
    };

    // Round-robin does not use requirements, just cycles
    expect(strategy.select(agents, taskWithReqs)).toBe('a1');
  });
});

// ===========================================================================
// createRandomStrategy
// ===========================================================================

describe('createRandomStrategy', () => {
  it('selects from available idle agents', () => {
    const strategy = createRandomStrategy();
    const agents = [agent('a1'), agent('a2'), agent('a3')];

    const selected = strategy.select(agents, task);
    expect(['a1', 'a2', 'a3']).toContain(selected);
  });

  it('returns undefined for empty agent list', () => {
    const strategy = createRandomStrategy();
    expect(strategy.select([], task)).toBeUndefined();
  });

  it('filters by idle status only', () => {
    const strategy = createRandomStrategy();
    const agents = [
      agent('a1', 'running'),
      agent('a2', 'idle'),
      agent('a3', 'failed'),
    ];

    // Only a2 is idle
    expect(strategy.select(agents, task)).toBe('a2');
  });

  it('returns undefined when all agents are non-idle', () => {
    const strategy = createRandomStrategy();
    const agents = [
      agent('a1', 'running'),
      agent('a2', 'completed'),
    ];

    expect(strategy.select(agents, task)).toBeUndefined();
  });

  it('returns the only idle agent when there is exactly one', () => {
    const strategy = createRandomStrategy();
    const agents = [agent('a1')];

    expect(strategy.select(agents, task)).toBe('a1');
  });

  it('selects randomly (statistical distribution over many calls)', () => {
    const strategy = createRandomStrategy();
    const agents = [agent('a1'), agent('a2'), agent('a3')];

    const counts: Record<string, number> = { a1: 0, a2: 0, a3: 0 };
    for (let i = 0; i < 300; i++) {
      const selected = strategy.select(agents, task);
      if (selected) counts[selected]++;
    }

    // Each agent should be selected at least once in 300 trials
    expect(counts['a1']).toBeGreaterThan(0);
    expect(counts['a2']).toBeGreaterThan(0);
    expect(counts['a3']).toBeGreaterThan(0);
  });

  it('uses Math.random for selection', () => {
    const strategy = createRandomStrategy();
    const agents = [agent('a1'), agent('a2'), agent('a3')];

    // Mock Math.random to return 0 -> selects first
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(strategy.select(agents, task)).toBe('a1');

    // Mock to return 0.999 -> selects last (floor(0.999 * 3) = 2)
    spy.mockReturnValue(0.999);
    expect(strategy.select(agents, task)).toBe('a3');

    spy.mockRestore();
  });

  it('handles agents with parentId', () => {
    const strategy = createRandomStrategy();
    const agents = [
      { ...agent('a1'), parentId: 'root' },
      { ...agent('a2'), parentId: 'root' },
    ];

    const selected = strategy.select(agents, task);
    expect(['a1', 'a2']).toContain(selected);
  });

  it('handles task with metadata', () => {
    const strategy = createRandomStrategy();
    const agents = [agent('a1'), agent('a2')];
    const taskWithMeta: DelegationTask = {
      description: 'meta task',
      metadata: { priority: 'high' },
    };

    const selected = strategy.select(agents, taskWithMeta);
    expect(['a1', 'a2']).toContain(selected);
  });
});

// ===========================================================================
// createFirstAvailableStrategy
// ===========================================================================

describe('createFirstAvailableStrategy', () => {
  it('picks the first idle agent', () => {
    const strategy = createFirstAvailableStrategy();
    const agents = [agent('a1'), agent('a2'), agent('a3')];

    expect(strategy.select(agents, task)).toBe('a1');
  });

  it('consistently returns the first idle agent', () => {
    const strategy = createFirstAvailableStrategy();
    const agents = [agent('a1'), agent('a2')];

    // Always picks a1
    expect(strategy.select(agents, task)).toBe('a1');
    expect(strategy.select(agents, task)).toBe('a1');
    expect(strategy.select(agents, task)).toBe('a1');
  });

  it('returns undefined for empty agent list', () => {
    const strategy = createFirstAvailableStrategy();
    expect(strategy.select([], task)).toBeUndefined();
  });

  it('filters by idle status only', () => {
    const strategy = createFirstAvailableStrategy();
    const agents = [
      agent('a1', 'running'),
      agent('a2', 'failed'),
      agent('a3', 'idle'),
      agent('a4', 'idle'),
    ];

    // First idle is a3
    expect(strategy.select(agents, task)).toBe('a3');
  });

  it('returns undefined when all agents are non-idle', () => {
    const strategy = createFirstAvailableStrategy();
    const agents = [
      agent('a1', 'running'),
      agent('a2', 'completed'),
      agent('a3', 'failed'),
    ];

    expect(strategy.select(agents, task)).toBeUndefined();
  });

  it('handles single idle agent', () => {
    const strategy = createFirstAvailableStrategy();
    const agents = [agent('a1')];

    expect(strategy.select(agents, task)).toBe('a1');
  });

  it('picks the new first idle when agents change', () => {
    const strategy = createFirstAvailableStrategy();

    // First call: a1 is first idle
    const agents1 = [agent('a1'), agent('a2')];
    expect(strategy.select(agents1, task)).toBe('a1');

    // Second call: a1 is now running, a2 is first idle
    const agents2 = [agent('a1', 'running'), agent('a2')];
    expect(strategy.select(agents2, task)).toBe('a2');
  });

  it('preserves insertion order for tie-breaking', () => {
    const strategy = createFirstAvailableStrategy();
    const agents = [
      agent('z_last_alphabetically'),
      agent('a_first_alphabetically'),
    ];

    // Should pick based on array order, not alphabetical
    expect(strategy.select(agents, task)).toBe('z_last_alphabetically');
  });

  it('handles agents with all status types mixed', () => {
    const strategy = createFirstAvailableStrategy();
    const agents = [
      agent('a1', 'completed'),
      agent('a2', 'running'),
      agent('a3', 'failed'),
      agent('a4', 'idle'),
      agent('a5', 'idle'),
    ];

    expect(strategy.select(agents, task)).toBe('a4');
  });

  it('handles task with requirements and metadata', () => {
    const strategy = createFirstAvailableStrategy();
    const agents = [agent('a1'), agent('a2')];
    const complexTask: DelegationTask = {
      description: 'complex',
      requirements: ['typescript'],
      metadata: { urgency: 'low' },
    };

    // First-available ignores requirements, just picks first idle
    expect(strategy.select(agents, complexTask)).toBe('a1');
  });
});

// ===========================================================================
// Cross-strategy shared behavior
// ===========================================================================

describe('all strategies: shared behavior', () => {
  const strategies = [
    { name: 'round-robin', create: createRoundRobinStrategy },
    { name: 'random', create: createRandomStrategy },
    { name: 'first-available', create: createFirstAvailableStrategy },
  ];

  for (const { name, create } of strategies) {
    describe(`${name}`, () => {
      it('returns undefined for empty agent list', () => {
        const strategy = create();
        expect(strategy.select([], task)).toBeUndefined();
      });

      it('returns undefined when all agents are running', () => {
        const strategy = create();
        const agents = [agent('a1', 'running'), agent('a2', 'running')];
        expect(strategy.select(agents, task)).toBeUndefined();
      });

      it('returns undefined when all agents are completed', () => {
        const strategy = create();
        const agents = [agent('a1', 'completed'), agent('a2', 'completed')];
        expect(strategy.select(agents, task)).toBeUndefined();
      });

      it('returns undefined when all agents are failed', () => {
        const strategy = create();
        const agents = [agent('a1', 'failed'), agent('a2', 'failed')];
        expect(strategy.select(agents, task)).toBeUndefined();
      });

      it('selects from idle agents only', () => {
        const strategy = create();
        const agents = [
          agent('running1', 'running'),
          agent('idle1', 'idle'),
          agent('completed1', 'completed'),
        ];

        const selected = strategy.select(agents, task);
        expect(selected).toBe('idle1');
      });

      it('has a select method', () => {
        const strategy = create();
        expect(typeof strategy.select).toBe('function');
      });
    });
  }
});

// ===========================================================================
// AgentRegistration.sessionId (C9: per-agent session routing hook)
// ===========================================================================

describe('AgentRegistration sessionId field', () => {
  it('accepts an AgentRegistration with sessionId', () => {
    const reg: AgentRegistration = {
      id: 'a1',
      name: 'Worker',
      status: 'idle',
      sessionId: 'session-42',
    };
    expect(reg.sessionId).toBe('session-42');
  });

  it('sessionId is optional and defaults to undefined', () => {
    const reg: AgentRegistration = {
      id: 'a2',
      name: 'Worker',
      status: 'idle',
    };
    expect(reg.sessionId).toBeUndefined();
  });

  it('strategies work with agents that have sessionId set', () => {
    const strategy = createRoundRobinStrategy();
    const agents: AgentRegistration[] = [
      { id: 'a1', name: 'W1', status: 'idle', sessionId: 'sess-1' },
      { id: 'a2', name: 'W2', status: 'idle', sessionId: 'sess-2' },
    ];

    expect(strategy.select(agents, task)).toBe('a1');
    expect(strategy.select(agents, task)).toBe('a2');
  });
});
