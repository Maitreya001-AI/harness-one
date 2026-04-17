/**
 * Orchestrator facet interfaces — structural guard.
 *
 * Proves at compile-time that `createOrchestrator()` returns a value that
 * can be narrowed into each of the four facets (`AgentRegistry`,
 * `AgentMessageBus`, `AgentDelegator`, `OrchestratorLifecycle`) without a
 * cast. Consumers that only need one concern should declare a parameter
 * of that narrower facet type.
 */

import { describe, it, expect } from 'vitest';
import { createOrchestrator } from '../orchestrator.js';
import type {
  AgentDelegator,
  AgentMessageBus,
  AgentOrchestrator,
  AgentRegistry,
  OrchestratorLifecycle,
} from '../orchestrator.js';

function useRegistry(reg: AgentRegistry): number {
  reg.register('a1', 'agent-1');
  return reg.listAgents().length;
}

function useMessageBus(bus: AgentMessageBus, from: string, to: string): void {
  bus.send({ from, to, type: 'task', content: 'hi' });
}

function getMode(d: AgentDelegator): string {
  return d.mode;
}

function disposeIt(l: OrchestratorLifecycle): void {
  l.dispose();
}

describe('orchestrator facets', () => {
  it('AgentOrchestrator satisfies every facet', () => {
    const orch: AgentOrchestrator = createOrchestrator();
    try {
      expect(useRegistry(orch)).toBe(1);
      useMessageBus(orch, 'a1', 'a1');
      expect(getMode(orch)).toBe('peer');
    } finally {
      disposeIt(orch);
    }
  });

  it('narrow facet parameters accept the full orchestrator without a cast', () => {
    const orch = createOrchestrator();
    try {
      // If any facet member drifted out of sync, these assignments would fail.
      const reg: AgentRegistry = orch;
      const bus: AgentMessageBus = orch;
      const del: AgentDelegator = orch;
      const life: OrchestratorLifecycle = orch;
      expect(typeof reg.register).toBe('function');
      expect(typeof bus.send).toBe('function');
      expect(typeof del.delegate).toBe('function');
      expect(typeof life.dispose).toBe('function');
    } finally {
      orch.dispose();
    }
  });
});
