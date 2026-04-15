/**
 * Harness lifecycle state machine + aggregated health check.
 *
 * Wave-5D ARCH-6: `Harness` was previously a bag of 13 subsystems with
 * no explicit `ready()` / `isHealthy()` / `drain()` contract. Hosts had
 * to probe each sub-component individually and couldn't tell if the
 * harness was about to reject new work, already shutting down, or
 * partially initialised.
 *
 * This module defines the canonical state transitions — callers get
 * `status()` + `health()` helpers to reason about the harness as a
 * single unit.
 *
 * States:
 *   `init` → bootstrapping (not yet accepting requests).
 *   `ready` → accepting new work.
 *   `draining` → rejecting NEW work but letting in-flight finish.
 *   `shutdown` → terminal; all resources disposed.
 *
 * Transitions (enforced):
 *   `init` → `ready` via `markReady()` (host signals boot complete).
 *   `ready` → `draining` via `beginDrain()`.
 *   `draining` → `shutdown` via `completeShutdown()` (all in-flight done).
 *   `any` → `shutdown` via `forceShutdown()` (emergency).
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from '../core/errors.js';

export type HarnessLifecycleState = 'init' | 'ready' | 'draining' | 'shutdown';

/**
 * Aggregated health record. Values are advisory — a `'degraded'` state
 * means "still serving but at risk"; callers decide whether to route
 * traffic away.
 */
export interface HarnessHealth {
  readonly state: HarnessLifecycleState;
  readonly ready: boolean;
  readonly components: Readonly<Record<string, HarnessComponentHealth>>;
  readonly checkedAt: number;
}

export type HarnessComponentHealth =
  | { readonly status: 'up'; readonly detail?: string }
  | { readonly status: 'degraded'; readonly detail: string }
  | { readonly status: 'down'; readonly detail: string };

/** Sync or async function that reports a single component's health. */
export type HarnessHealthCheck = () => HarnessComponentHealth | Promise<HarnessComponentHealth>;

export interface HarnessLifecycle {
  readonly status: () => HarnessLifecycleState;
  /** Register a component-level probe. Overwrites any prior check with the same name. */
  readonly registerHealthCheck: (name: string, check: HarnessHealthCheck) => void;
  /** Run all registered probes concurrently and return the aggregate. */
  readonly health: () => Promise<HarnessHealth>;
  readonly markReady: () => void;
  readonly beginDrain: () => void;
  readonly completeShutdown: () => void;
  readonly forceShutdown: () => void;
}

export function createHarnessLifecycle(): HarnessLifecycle {
  let state: HarnessLifecycleState = 'init';
  const checks = new Map<string, HarnessHealthCheck>();

  function assertTransition(next: HarnessLifecycleState, from: HarnessLifecycleState[]): void {
    if (!from.includes(state)) {
      throw new HarnessError(
        `Invalid lifecycle transition ${state} → ${next}; expected one of [${from.join(', ')}]`,
        HarnessErrorCode.CORE_INVALID_STATE,
        'Check the host boot sequence; lifecycle transitions are one-way except for forceShutdown',
      );
    }
    state = next;
  }

  return {
    status: () => state,
    registerHealthCheck: (name, check) => {
      checks.set(name, check);
    },
    health: async () => {
      const components: Record<string, HarnessComponentHealth> = {};
      const entries = [...checks.entries()];
      const results = await Promise.all(
        entries.map(async ([name, check]) => {
          try {
            return [name, await check()] as const;
          } catch (err) {
            return [
              name,
              {
                status: 'down',
                detail: err instanceof Error ? err.message : String(err),
              } as HarnessComponentHealth,
            ] as const;
          }
        }),
      );
      for (const [name, result] of results) components[name] = result;
      return {
        state,
        ready: state === 'ready',
        components,
        checkedAt: Date.now(),
      };
    },
    markReady: () => assertTransition('ready', ['init']),
    beginDrain: () => assertTransition('draining', ['ready']),
    completeShutdown: () => assertTransition('shutdown', ['draining']),
    forceShutdown: () => {
      state = 'shutdown';
    },
  };
}
