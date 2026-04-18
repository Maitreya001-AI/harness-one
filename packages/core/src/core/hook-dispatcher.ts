/**
 * Shared dispatcher for {@link AgentLoopHook} callbacks.
 *
 * Both `agent-loop.ts` and `iteration-runner.ts` need to fire hooks with
 * identical exception semantics: swallow-and-log by default, re-throw when
 * `strictHooks` is set. Extracting the dispatcher here keeps that contract
 * in a single place.
 *
 * @module
 * @internal
 */

import type { AgentLoopHook } from './agent-loop-types.js';

/** Config accepted by {@link createHookDispatcher}. */
export interface HookDispatcherConfig {
  readonly hooks: readonly AgentLoopHook[];
  readonly strictHooks?: boolean;
  readonly logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Type of the dispatcher function returned by {@link createHookDispatcher}.
 *
 * Exposed so `IterationRunner` can receive a single dispatcher instance from
 * `AgentLoop` rather than rebuilding one from the same hooks + strict flag.
 */
export type AgentLoopHookDispatcher = <E extends keyof AgentLoopHook>(
  event: E,
  info: Parameters<NonNullable<AgentLoopHook[E]>>[0],
) => void;

/**
 * Build a `(event, info) => void` dispatcher over the registered hooks.
 * Hooks are invoked synchronously in registration order. A throwing hook
 * is logged (or forwarded to `console.error` when no logger is configured)
 * and otherwise swallowed — the caller never observes the failure. When
 * `strictHooks: true` the dispatcher re-throws instead.
 */
export function createHookDispatcher(
  config: HookDispatcherConfig,
): AgentLoopHookDispatcher {
  const { hooks, strictHooks = false, logger } = config;
  return function dispatch<E extends keyof AgentLoopHook>(
    event: E,
    info: Parameters<NonNullable<AgentLoopHook[E]>>[0],
  ): void {
    if (hooks.length === 0) return;
    for (const hook of hooks) {
      const fn = hook[event];
      if (typeof fn !== 'function') continue;
      try {
        // Cast required because TS can't narrow the parameter type from the
        // generic event key without explicit per-event overloads. Hooks are
        // a typed contract at the public boundary (`AgentLoopHook`).
        (fn as (i: typeof info) => void).call(hook, info);
      } catch (err) {
        if (strictHooks) throw err;
        if (logger) {
          try {
            logger.warn('[harness-one/agent-loop] hook threw', {
              event,
              error: err instanceof Error ? err.message : String(err),
            });
            continue;
          } catch {
            // Logger itself threw — fall through to console.
          }
        }
        try {
          console.error('[harness-one/agent-loop] hook threw:', err);
        } catch {
          // Truly unreachable — even console is missing.
        }
      }
    }
  };
}
