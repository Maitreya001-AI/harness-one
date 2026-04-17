/**
 * Core implementation of {@link createHarness} — constructs a fully-wired
 * {@link Harness} instance from a {@link HarnessConfig}.
 *
 * This file is intentionally thin: it handles config validation and
 * lifecycle (`initialize` / `shutdown` / `drain` / `run`) orchestration.
 * Component wiring lives in `./wire-components.ts` so callers reading
 * this file see the behaviour, not 150 lines of conditional spreads.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import type { Message, AgentEvent } from 'harness-one/core';
import { runInput, runOutput } from 'harness-one/guardrails';

import {
  DRAIN_DEFAULT_TIMEOUT_MS,
} from './types.js';
import type {
  Harness,
  HarnessConfig,
} from './types.js';

import { wireComponents, warmTiktokenIfNeeded } from './wire-components.js';
import { validateHarnessRuntimeConfig } from '../validate-config.js';

/**
 * Build a fully-wired {@link Harness} instance. Every auto-configured
 * component can be overridden by passing the explicit config field
 * (`adapter`, `exporters`, `memoryStore`, etc.).
 */
export function buildHarness(config: HarnessConfig): Harness {
  validateHarnessRuntimeConfig(config);

  const wired = wireComponents(config);
  const {
    adapter: _adapter,
    exporters: _exporters,
    memory,
    schemaValidator: _schemaValidator,
    customTokenizer,
    costs,
    traces,
    tools,
    guardrailPipeline,
    sessions,
    prompts,
    evalRunner,
    logger,
    conversations,
    middleware,
    loop,
  } = wired;

  // Warn at construction time when running without a cost budget — production
  // deployments without a budget have no upper bound on token spend. Emits
  // exactly once per harness instance.
  if (config.budget === undefined) {
    logger.warn(
      'harness-one: no cost budget configured. Runaway token usage is unbounded. '
      + 'Set HarnessConfig.budget to enable automatic budget alerts and circuit breaking.',
    );
  }

  // Warn when the in-memory ConversationStore is used with the default session
  // id — concurrent run() calls would interleave messages in the same bucket.
  // Log once at construction. See harness.run({ sessionId }) to opt in.
  let defaultSessionWarnEmitted = false;
  function warnDefaultSessionOnce(): void {
    if (defaultSessionWarnEmitted) return;
    defaultSessionWarnEmitted = true;
    logger.warn(
      'harness-one: harness.run() invoked without a sessionId. An auto-generated unique '
      + 'session ID is being used, which prevents message interleaving but means conversation '
      + 'history cannot be resumed. Pass harness.run(messages, { sessionId }) to enable '
      + 'persistent, resumable conversations.',
    );
  }

  /**
   * LM-013 / ARCH-007: `shutdownPromise` and `initializePromise` are
   * latches, not flags. Concurrent callers await the same promise so the
   * sequence below runs exactly once. A plain `boolean` flag allowed a
   * second caller through the check before the first await had resolved.
   */
  let shutdownPromise: Promise<void> | null = null;
  let initializePromise: Promise<void> | null = null;

  const harness: Harness = {
    loop,
    tools,
    guardrails: guardrailPipeline,
    traces,
    costs,
    sessions,
    memory,
    prompts,
    eval: evalRunner,
    logger,
    conversations,
    middleware,
    // SPEC-009: only present when a function/object tokenizer was supplied.
    ...(customTokenizer !== undefined && { tokenizer: customTokenizer }),

    /**
     * ARCH-007: Eager initialization. Awaits `traces.initialize()` and
     * warms the tiktoken WASM when `config.tokenizer === 'tiktoken'`.
     * Idempotent via `initializePromise`.
     */
    initialize(): Promise<void> {
      if (initializePromise) return initializePromise;
      initializePromise = (async () => {
        try {
          await traces.initialize();
        } catch (err) {
          logger.warn('TraceManager initialize error', { error: err });
          /* noop: initialization failure is non-fatal — exporter isHealthy
             gates future exports */
        }
        warmTiktokenIfNeeded(config);
      })();
      return initializePromise;
    },

    async *run(
      messages: Message[],
      options?: {
        sessionId?: string;
        onSessionId?: (sessionId: string) => void;
      },
    ): AsyncGenerator<AgentEvent> {
      // F14: Auto-generate a unique session ID when none is provided,
      // preventing accidental message interleaving across concurrent requests.
      let sessionId: string;
      if (options?.sessionId) {
        sessionId = options.sessionId;
      } else {
        sessionId = `session_${randomUUID()}`;
        warnDefaultSessionOnce();
      }

      // P1-20 (Wave-12): surface the effective session id via callback so
      // callers can persist / log / resume the auto-generated value. The
      // callback is invoked before any event is yielded and exceptions are
      // logged-and-swallowed so a misbehaving observer cannot abort the
      // generator.
      if (options?.onSessionId) {
        try {
          options.onSessionId(sessionId);
        } catch (err) {
          logger.warn('[harness-one/preset] onSessionId callback threw; continuing', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Start a harness-level trace so pre-loop and per-event guardrail checks
      // produce structured spans a human can correlate to loop iteration spans.
      const harnessTraceId = traces.startTrace('harness.run', {
        sessionId,
        messageCount: messages.length,
      });

      // Run a guardrail and emit it as a span in the harness trace.
      async function traceGuardrail<T extends { passed: boolean; verdict: { action: string; reason?: string } }>(
        spanName: string,
        fn: () => Promise<T>,
      ): Promise<T> {
        const spanId = traces.startSpan(harnessTraceId, spanName);
        const start = Date.now();
        try {
          const result = await fn();
          traces.setSpanAttributes(spanId, {
            passed: result.passed,
            verdict: result.verdict.action,
            latencyMs: Date.now() - start,
            ...(result.verdict.reason ? { reason: String(result.verdict.reason).slice(0, 500) } : {}),
          });
          traces.endSpan(spanId, result.passed ? 'completed' : 'error');
          return result;
        } catch (err) {
          traces.setSpanAttributes(spanId, {
            error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          });
          traces.endSpan(spanId, 'error');
          throw err;
        }
      }

      try {
        // Run input guardrails on user messages before passing to agent loop.
        // F18d: Guardrail checks run first; persistence is batched after all
        // checks pass so a mid-batch guardrail failure doesn't leave partial
        // state in the conversation store.
        for (const msg of messages) {
          if (msg.role === 'user') {
            const inputResult = await traceGuardrail('guardrail:input', () =>
              runInput(guardrailPipeline, { content: msg.content }),
            );
            if (!inputResult.passed) {
              loop.abort();
              yield {
                type: 'error',
                error: new HarnessError(
                  `Input blocked by guardrail: ${'reason' in inputResult.verdict ? inputResult.verdict.reason : 'policy violation'}`,
                  HarnessErrorCode.GUARD_BLOCKED,
                  'Modify the input to comply with configured guardrails',
                ),
              };
              yield { type: 'done', reason: 'error', totalUsage: { inputTokens: 0, outputTokens: 0 } };
              return;
            }
          }
        }
        // F18d: Atomic batch persist — all input messages in one save() call.
        try {
          const existing = await conversations.load(sessionId);
          await conversations.save(sessionId, [...existing, ...messages]);
        } catch (err) {
          logger.error(
            '[harness-one/preset] Failed to persist input messages to conversation store — session history may have gaps',
            {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
          yield {
            type: 'warning' as const,
            message: `Conversation persistence failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        for await (const event of loop.run(messages)) {
          // Validate tool call arguments against input guardrails before executing
          if (event.type === 'tool_call') {
            const argContent = typeof event.toolCall.arguments === 'string'
              ? event.toolCall.arguments
              : JSON.stringify(event.toolCall.arguments);
            const argCheck = await traceGuardrail('guardrail:tool-args', () =>
              runInput(guardrailPipeline, { content: argContent }),
            );
            if (!argCheck.passed) {
              loop.abort();
              yield {
                type: 'error',
                error: new HarnessError(
                  `Tool arguments blocked by guardrails: ${'reason' in argCheck.verdict ? argCheck.verdict.reason : 'policy violation'}`,
                  HarnessErrorCode.GUARD_BLOCKED,
                  'Tool call arguments were blocked by input guardrails',
                ),
              };
              yield { type: 'done', reason: 'error', totalUsage: loop.usage };
              return;
            }
          }
          // Run output guardrails on assistant messages
          if (event.type === 'message' && event.message) {
            const outputResult = await traceGuardrail('guardrail:output', () =>
              runOutput(guardrailPipeline, { content: event.message.content }),
            );
            if (!outputResult.passed) {
              loop.abort();
              yield {
                type: 'error',
                error: new HarnessError(
                  `Output blocked by guardrail: ${'reason' in outputResult.verdict ? outputResult.verdict.reason : 'policy violation'}`,
                  HarnessErrorCode.GUARD_BLOCKED,
                  'The model response was blocked by output guardrails',
                ),
              };
              yield { type: 'done', reason: 'error', totalUsage: loop.usage };
              return;
            }
            try {
              await conversations.append(sessionId, event.message);
            } catch (err) {
              logger.error(
                '[harness-one/preset] Failed to persist message to conversation store — session history may have gaps',
                {
                  sessionId,
                  error: err instanceof Error ? err.message : String(err),
                },
              );
              yield {
                type: 'warning' as const,
                message: `Conversation persistence failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          } else if (event.type === 'tool_result') {
            // Run output guardrails on tool results
            const toolOutputResult = await traceGuardrail('guardrail:tool-result', () =>
              runOutput(guardrailPipeline, {
                content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
              }),
            );
            if (!toolOutputResult.passed) {
              loop.abort();
              yield {
                type: 'error',
                error: new HarnessError(
                  `Tool output blocked by guardrail: ${'reason' in toolOutputResult.verdict ? toolOutputResult.verdict.reason : 'policy violation'}`,
                  HarnessErrorCode.GUARD_BLOCKED,
                  'A tool result was blocked by output guardrails',
                ),
              };
              yield { type: 'done', reason: 'error', totalUsage: loop.usage };
              return;
            }
            try {
              await conversations.append(sessionId, {
                role: 'tool' as const,
                content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
                toolCallId: event.toolCallId,
              });
            } catch (err) {
              logger.error(
                '[harness-one/preset] Failed to persist tool result to conversation store — session history may have gaps',
                {
                  sessionId,
                  error: err instanceof Error ? err.message : String(err),
                },
              );
              yield {
                type: 'warning' as const,
                message: `Conversation persistence failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
          yield event;
        }
      } finally {
        traces.endTrace(harnessTraceId);
      }
    },

    /**
     * LM-001 / LM-002 / LM-013: Ordered async shutdown DAG — see
     * inline comments on each step. Idempotent via `shutdownPromise`.
     */
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        // 1. Stop the loop. AgentLoop.dispose() is sync today; `Promise.resolve`
        //    keeps the call site safe if it ever returns a promise.
        try {
          const result = loop.dispose?.() as unknown;
          if (result !== undefined) {
            await Promise.resolve(result as Promise<void>);
          }
        } catch (err) {
          try { logger.warn('AgentLoop dispose error', { error: err }); } catch {
            /* noop: logger failure during shutdown is non-fatal */
          }
        }

        // 2. Session manager (stops GC timer, clears session store).
        try {
          await Promise.resolve(sessions.dispose());
        } catch (err) {
          try { logger.warn('SessionManager dispose error', { error: err }); } catch {
            /* noop: logger failure during shutdown is non-fatal */
          }
        }

        // 3. Middleware chain — drop references so closures can be GC'd.
        try {
          middleware.clear();
        } catch (err) {
          try { logger.warn('Middleware clear error', { error: err }); } catch {
            /* noop: logger failure during shutdown is non-fatal */
          }
        }

        // 4. Trace manager — settles pendingExports, flushes, then races
        //    each exporter's shutdown() against a bounded per-exporter
        //    timeout. Failures are reported via onExportError / logger.warn.
        try {
          await traces.dispose();
        } catch (err) {
          try { logger.warn('TraceManager dispose error', { error: err }); } catch {
            /* noop: logger failure during shutdown is non-fatal */
          }
        }
      })();
      return shutdownPromise;
    },

    /**
     * LM-002: Graceful drain — abort the loop, let in-flight work settle
     * briefly, then delegate to `shutdown()` while respecting the caller's
     * `timeoutMs` as a hard deadline.
     */
    async drain(timeoutMs: number = DRAIN_DEFAULT_TIMEOUT_MS): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      loop.abort();
      const settleMs = Math.min(100, timeoutMs);
      if (settleMs > 0) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, settleMs);
          if (typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref();
        });
      }
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining === 0) {
        // Deadline already expired — kick off shutdown but don't wait past
        // the caller's budget. We still attach a `.catch` so a rejected
        // shutdown doesn't become an unhandled rejection.
        void this.shutdown().catch(() => {
          /* noop: background shutdown errors surface via logger already */
        });
        return;
      }
      let watchdogHandle: ReturnType<typeof setTimeout> | undefined;
      const watchdog = new Promise<void>((resolve) => {
        watchdogHandle = setTimeout(resolve, remaining);
        if (typeof watchdogHandle === 'object' && 'unref' in watchdogHandle) {
          (watchdogHandle as NodeJS.Timeout).unref();
        }
      });
      try {
        await Promise.race([
          this.shutdown().catch((err: unknown) => {
            logger.warn('Harness shutdown during drain failed', { error: err });
          }),
          watchdog,
        ]);
      } finally {
        if (watchdogHandle) clearTimeout(watchdogHandle);
      }
    },
  };

  return harness;
}
