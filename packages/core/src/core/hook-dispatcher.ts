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
import type { Message, ToolCallRequest } from './types.js';

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

/** Async message interceptor dispatcher for `onBeforeChat`. */
export type BeforeChatHookDispatcher = (
  info: { messages: readonly Message[]; iteration: number },
) => Promise<readonly Message[]>;

/** Async tool interceptor dispatcher for `onBeforeToolCall`. */
export type BeforeToolCallHookDispatcher = (
  info: { call: ToolCallRequest; iteration: number },
) => Promise<ToolCallRequest | { abort: true; reason: string }>;

/**
 * Build a `(event, info) => void` dispatcher over the registered hooks.
 * Hooks are invoked synchronously in registration order. A throwing hook
 * is logged (or forwarded to `console.warn` when no logger is configured)
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
          // Last-resort fallback after the caller-supplied logger also threw.
          // console.warn is the project-wide allowed channel (see eslint rule).
          console.warn('[harness-one/agent-loop] hook threw:', err);
        } catch {
          // Truly unreachable — even console is missing.
        }
      }
    }
  };
}

function logHookError(
  err: unknown,
  event: string,
  strictHooks: boolean,
  logger?: HookDispatcherConfig['logger'],
): void {
  if (strictHooks) throw err;
  if (logger) {
    try {
      logger.warn('[harness-one/agent-loop] hook threw', {
        event,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    } catch {
      // Logger itself threw — fall back to console below.
    }
  }
  try {
    // Last-resort fallback after the caller-supplied logger also threw.
    // console.warn is the project-wide allowed channel (see eslint rule).
    console.warn('[harness-one/agent-loop] hook threw:', err);
  } catch {
    // Truly unreachable — even console is missing.
  }
}

/** Build a sequential async interceptor over registered `onBeforeChat` hooks. */
export function createBeforeChatHookDispatcher(
  config: HookDispatcherConfig,
): BeforeChatHookDispatcher {
  const { hooks, strictHooks = false, logger } = config;
  return async ({ messages, iteration }) => {
    let current = messages;
    for (const hook of hooks) {
      if (typeof hook.onBeforeChat !== 'function') continue;
      try {
        const next = await hook.onBeforeChat({ messages: current, iteration });
        if (next !== undefined) current = next;
      } catch (err) {
        logHookError(err, 'onBeforeChat', strictHooks, logger);
      }
    }
    return current;
  };
}

/** Build a sequential async interceptor over registered `onBeforeToolCall` hooks. */
export function createBeforeToolCallHookDispatcher(
  config: HookDispatcherConfig,
): BeforeToolCallHookDispatcher {
  const { hooks, strictHooks = false, logger } = config;
  return async ({ call, iteration }) => {
    let current: ToolCallRequest | { abort: true; reason: string } = call;
    for (const hook of hooks) {
      if (typeof hook.onBeforeToolCall !== 'function') continue;
      try {
        if ('abort' in current && current.abort) return current;
        const next = await hook.onBeforeToolCall({ call: current as ToolCallRequest, iteration });
        if (next !== undefined) current = next;
      } catch (err) {
        logHookError(err, 'onBeforeToolCall', strictHooks, logger);
      }
    }
    return current;
  };
}
