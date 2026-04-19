/**
 * Harness lifecycle state machine + aggregated health check.
 *
 * `Harness` was previously a bag of 13 subsystems with
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
  /** Run all health checks and only transition to ready if all are 'up'. Throws if any check is 'down'. */
  readonly markReadyAfterHealthCheck: () => Promise<void>;
  /** Release all registered health check references and transition to shutdown. */
  readonly dispose: () => void;
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

  const lifecycle: HarnessLifecycle = {
    status: () => state,
    registerHealthCheck: (name, check) => {
      checks.set(name, check);
    },
    health: async () => {
      const components: Record<string, HarnessComponentHealth> = {};
      const entries = [...checks.entries()];
      // Use Promise.allSettled for defense-in-depth: the inner try/catch
      // makes every promise resolve to a value today, but allSettled
      // guarantees one failing check cannot abort the aggregate even if a
      // future refactor removes that wrapper.
      const settled = await Promise.allSettled(
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
      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        if (outcome.status === 'fulfilled') {
          const [name, result] = outcome.value;
          components[name] = result;
          continue;
        }
        const name = entries[i][0];
        components[name] = {
          status: 'down',
          detail: outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
        };
      }
      return {
        state,
        ready: state === 'ready',
        components,
        checkedAt: Date.now(),
      };
    },
    markReady: () => assertTransition('ready', ['init']),
    markReadyAfterHealthCheck: async () => {
      const healthResult = await lifecycle.health();
      const downComponents = Object.entries(healthResult.components)
        .filter(([, h]) => h.status === 'down');
      if (downComponents.length > 0) {
        const names = downComponents.map(([n]) => n).join(', ');
        throw new HarnessError(
          `Cannot mark ready: components are down: ${names}`,
          HarnessErrorCode.CORE_INVALID_STATE,
          'Fix failing health checks before marking the harness as ready',
        );
      }
      assertTransition('ready', ['init']);
    },
    beginDrain: () => assertTransition('draining', ['ready']),
    completeShutdown: () => assertTransition('shutdown', ['draining']),
    forceShutdown: () => {
      state = 'shutdown';
    },
    /** Release all registered health check references to prevent memory leaks. */
    dispose: () => {
      checks.clear();
      state = 'shutdown';
    },
  };
  return lifecycle;
}
