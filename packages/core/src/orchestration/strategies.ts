/**
 * Built-in delegation strategies for the orchestrator.
 *
 * @module
 */

import type { AgentRegistration, DelegationStrategy, DelegationTask } from './types.js';

/**
 * Round-robin delegation: cycles through available idle agents.
 *
 * @example
 * ```ts
 * const strategy = createRoundRobinStrategy();
 * const orch = createOrchestrator({ strategy });
 * ```
 */
export function createRoundRobinStrategy(): DelegationStrategy {
  let lastIndex = -1;

  return {
    select(agents: readonly AgentRegistration[], _task: DelegationTask): string | undefined {
      const idle = agents.filter((a) => a.status === 'idle');
      if (idle.length === 0) return undefined;
      lastIndex = (lastIndex + 1) % idle.length;
      return idle[lastIndex].id;
    },
  };
}

/**
 * Random delegation: picks a random available idle agent.
 *
 * @example
 * ```ts
 * const strategy = createRandomStrategy();
 * const orch = createOrchestrator({ strategy });
 * ```
 */
export function createRandomStrategy(): DelegationStrategy {
  return {
    select(agents: readonly AgentRegistration[], _task: DelegationTask): string | undefined {
      const idle = agents.filter((a) => a.status === 'idle');
      if (idle.length === 0) return undefined;
      const index = Math.floor(Math.random() * idle.length);
      return idle[index].id;
    },
  };
}

/**
 * First-available delegation: picks the first idle agent.
 *
 * @example
 * ```ts
 * const strategy = createFirstAvailableStrategy();
 * const orch = createOrchestrator({ strategy });
 * ```
 */
export function createFirstAvailableStrategy(): DelegationStrategy {
  return {
    select(agents: readonly AgentRegistration[], _task: DelegationTask): string | undefined {
      const idle = agents.filter((a) => a.status === 'idle');
      if (idle.length === 0) return undefined;
      return idle[0].id;
    },
  };
}
