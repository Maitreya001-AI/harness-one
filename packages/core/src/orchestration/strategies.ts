/**
 * Built-in delegation strategies for the orchestrator.
 *
 * @module
 */

import type { AgentRegistration, DelegationStrategy } from './types.js';

/**
 * Round-robin delegation: cycles through available idle agents.
 *
 * **Thread safety** (Fix 33): This strategy maintains internal state (lastIndex
 * counter) that is NOT thread-safe across concurrent delegate() calls. In
 * single-threaded JavaScript, this is safe because delegate() calls are
 * sequential within an event loop tick. However, if used in a worker thread
 * or distributed environment, add external synchronization or use a stateless
 * strategy instead.
 *
 * @example
 * ```ts
 * const strategy = createBasicRoundRobinStrategy();
 * const orch = createOrchestrator({ strategy });
 * ```
 */
export function createBasicRoundRobinStrategy(): DelegationStrategy {
  let lastIndex = -1;

  return {
    select(agents: readonly AgentRegistration[]): string | undefined {
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
 * **Randomness**: Uses `Math.random()` (non-cryptographic) for load-balancing
 * purposes. This is intentional — agent selection is not a security boundary,
 * and the slight predictability has no security impact. Do NOT use this
 * strategy for any form of token generation, session assignment, or other
 * security-sensitive randomness. For those, use `crypto.randomBytes` via
 * the helpers in `infra/ids.ts`.
 *
 * **Thread safety** (Fix 33): This strategy is stateless and safe for
 * concurrent use. Each call independently selects a random idle agent.
 *
 * @example
 * ```ts
 * const strategy = createBasicRandomStrategy();
 * const orch = createOrchestrator({ strategy });
 * ```
 */
export function createBasicRandomStrategy(): DelegationStrategy {
  return {
    select(agents: readonly AgentRegistration[]): string | undefined {
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
 * **Thread safety** (Fix 33): This strategy is stateless and safe for
 * concurrent use. Each call independently selects the first idle agent
 * in the provided array order.
 *
 * @example
 * ```ts
 * const strategy = createBasicFirstAvailableStrategy();
 * const orch = createOrchestrator({ strategy });
 * ```
 */
export function createBasicFirstAvailableStrategy(): DelegationStrategy {
  return {
    select(agents: readonly AgentRegistration[]): string | undefined {
      const idle = agents.filter((a) => a.status === 'idle');
      if (idle.length === 0) return undefined;
      return idle[0].id;
    },
  };
}
