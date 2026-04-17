/**
 * Core implementation of {@link createHarness} — constructs a fully-wired
 * {@link Harness} instance from a {@link HarnessConfig}. Extracted verbatim
 * from the monolithic `index.ts` as a pure reorganization; behavior is
 * unchanged bit-for-bit.
 *
 * The public entry point `createHarness` in `../index.ts` is a one-line
 * delegate to {@link buildHarness} below.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import {
  createAgentLoop,
  HarnessError,
  createMiddlewareChain,
  HarnessErrorCode,
} from 'harness-one/core';
import type { AgentAdapter, Message, AgentEvent } from 'harness-one/core';
import {
  createTraceManager,
  createCostTracker,
  createLogger,
} from 'harness-one/observe';
import type { TraceExporter } from 'harness-one/observe';
import { createPromptBuilder } from 'harness-one/prompt';
import { registerTokenizer, countTokens } from 'harness-one/context';
import { createRegistry } from 'harness-one/tools';
import type { SchemaValidator } from 'harness-one/tools';
import { runInput, runOutput } from 'harness-one/guardrails';
import { createSessionManager, createInMemoryConversationStore } from 'harness-one/session';
import type { MemoryStore } from 'harness-one/memory';
import { createEvalRunner, createRelevanceScorer } from '@harness-one/devkit';

import { createAjvValidator } from '@harness-one/ajv';
import type { AjvSchemaValidator } from '@harness-one/ajv';

import { createLangfuseCostTracker } from '@harness-one/langfuse';
import { registerTiktokenModels } from '@harness-one/tiktoken';

import {
  DEFAULT_ADAPTER_TIMEOUT_MS,
  DRAIN_DEFAULT_TIMEOUT_MS,
} from './types.js';
import type {
  AnthropicHarnessConfig,
  OpenAIHarnessConfig,
  Harness,
  HarnessConfig,
  Tokenizer,
} from './types.js';

import { createAdapter } from './adapter.js';
import { createExporters } from './exporters.js';
import { createMemory } from './memory.js';
import { createGuardrails } from './guardrails.js';

/**
 * Build a fully-wired {@link Harness} instance.
 *
 * Every auto-configured component can be overridden by passing the
 * explicit config field (`adapter`, `exporters`, `memoryStore`, etc.).
 *
 * This is the implementation behind `createHarness()`; exported separately so
 * the public `index.ts` entry can stay a thin re-export while the 600-line
 * body lives here.
 */
export function buildHarness(config: HarnessConfig): Harness {
  // Validate config
  if (!config.adapter && !(config as AnthropicHarnessConfig | OpenAIHarnessConfig).client) {
    throw new HarnessError('Either adapter or client must be provided', HarnessErrorCode.CORE_INVALID_CONFIG, 'Pass a pre-built adapter or a provider client');
  }
  // CQ-039: Require finite positive *integers* for iteration / token caps so
  // fractional values (25.7), non-finite ones (`NaN`, `Infinity`, `-Infinity`)
  // and negatives are rejected uniformly. `Number.isFinite` admits `0` and
  // negatives, and prior `<= 0 || !isFinite` left `NaN` comparisons
  // (which evaluate to `false` for both) as a silent accept.
  if (
    config.maxIterations !== undefined &&
    (!Number.isInteger(config.maxIterations) || config.maxIterations <= 0)
  ) {
    throw new HarnessError('maxIterations must be a positive integer', HarnessErrorCode.CORE_INVALID_CONFIG, 'Use an integer value >= 1');
  }
  if (
    config.maxTotalTokens !== undefined &&
    (!Number.isInteger(config.maxTotalTokens) || config.maxTotalTokens <= 0)
  ) {
    throw new HarnessError('maxTotalTokens must be a positive integer', HarnessErrorCode.CORE_INVALID_CONFIG, 'Use an integer value >= 1');
  }
  // Budget is cost in currency units — may be fractional, but must be
  // finite and strictly positive.
  if (
    config.budget !== undefined &&
    (!Number.isFinite(config.budget) || config.budget <= 0)
  ) {
    throw new HarnessError('budget must be a finite positive number', HarnessErrorCode.CORE_INVALID_CONFIG, 'Use a value > 0');
  }

  // Validate guardrails sub-config — rate-limit max/windowMs are counts, so
  // integer-only. Same defence-in-depth against NaN/Infinity as above.
  if (config.guardrails?.rateLimit) {
    const rl = config.guardrails.rateLimit;
    if (!Number.isInteger(rl.max) || rl.max <= 0) {
      throw new HarnessError('guardrails.rateLimit.max must be a positive integer', HarnessErrorCode.CORE_INVALID_CONFIG, 'Use an integer value >= 1');
    }
    if (!Number.isInteger(rl.windowMs) || rl.windowMs <= 0) {
      throw new HarnessError('guardrails.rateLimit.windowMs must be a positive integer', HarnessErrorCode.CORE_INVALID_CONFIG, 'Use an integer value >= 1');
    }
  }

  // Validate pricing values. Wave-5F m-4: reject NaN/Infinity alongside
  // negatives — otherwise `p.inputPer1kTokens = NaN` would silently produce
  // NaN cost attributions downstream that break budget enforcement.
  if (config.pricing) {
    for (const p of config.pricing) {
      const invalid = (n: number): boolean => !Number.isFinite(n) || n < 0;
      if (invalid(p.inputPer1kTokens) || invalid(p.outputPer1kTokens) ||
        (p.cacheReadPer1kTokens !== undefined && invalid(p.cacheReadPer1kTokens)) ||
        (p.cacheWritePer1kTokens !== undefined && invalid(p.cacheWritePer1kTokens))) {
        // Wave-13 F-7: quote the model name with backticks so hostile model
        // strings containing quote characters cannot break the error-message
        // shape, and so the surrounding backticks clearly delimit the
        // caller-supplied identifier from the prose.
        throw new HarnessError(
          `Pricing for model \`${p.model}\` has non-finite or negative values`,
          HarnessErrorCode.CORE_INVALID_CONFIG,
          'All pricing values must be finite numbers >= 0',
        );
      }
    }
  }
  if (
    config.maxAdapterRetries !== undefined &&
    (!Number.isInteger(config.maxAdapterRetries) || config.maxAdapterRetries < 0)
  ) {
    throw new HarnessError('maxAdapterRetries must be a non-negative integer', HarnessErrorCode.CORE_INVALID_CONFIG, 'Use an integer >= 0');
  }
  if (
    config.baseRetryDelayMs !== undefined &&
    (!Number.isFinite(config.baseRetryDelayMs) || config.baseRetryDelayMs < 0)
  ) {
    throw new HarnessError('baseRetryDelayMs must be a non-negative finite number', HarnessErrorCode.CORE_INVALID_CONFIG, 'Use a value >= 0');
  }

  // 1. Adapter — prefer injected adapter; fall back to provider-based factory
  const adapter: AgentAdapter = config.adapter ?? createAdapter(config as AnthropicHarnessConfig | OpenAIHarnessConfig);

  // 2. Exporters
  const exporters: TraceExporter[] = config.exporters ?? createExporters(config);

  // 3. Memory store
  const memory: MemoryStore = config.memoryStore ?? createMemory(config);

  // 4. Schema validator (AjvSchemaValidator is async; SchemaValidator supports both)
  const schemaValidator: SchemaValidator | AjvSchemaValidator = config.schemaValidator
    ? config.schemaValidator
    : createAjvValidator();

  // 5. Tokenizer — only call the global registerTiktokenModels() when explicitly
  //    requested via the legacy 'tiktoken' string value.  Function or object
  //    tokenizers are stored for later use without mutating global state.
  let customTokenizer: Tokenizer | undefined;
  if (config.tokenizer === 'tiktoken') {
    registerTiktokenModels();
  } else if (typeof config.tokenizer === 'function' || (config.tokenizer && typeof config.tokenizer === 'object')) {
    // SPEC-009: retain the custom tokenizer so it reaches consumers via
    // `harness.tokenizer`.  Also register it under the configured model name
    // (when one exists) so `countTokens(model, messages)` and the context
    // packer pick it up automatically.
    customTokenizer = config.tokenizer as Tokenizer;
    if (config.model) {
      const tok: { encode(text: string): { length: number } } =
        typeof customTokenizer === 'function'
          ? { encode: (text: string) => ({ length: (customTokenizer as (t: string) => number)(text) }) }
          : customTokenizer;
      registerTokenizer(config.model, tok);
    } else {
      // CQ-038: Previously a silent no-op when a function/object tokenizer was
      // supplied without a model — the tokenizer would be stored on the harness
      // but never wired to `countTokens()`. Warn loudly so misconfiguration
      // surfaces instead of hiding behind "why isn't my tokenizer being
      // called?". Logger is resolved here because `logger` isn't yet
      // constructed at this point; fall back to `console.warn` until then.
      (config.logger ?? createLogger()).warn(
        'harness-one: custom tokenizer supplied but config.model is not set; ' +
        'tokenizer will not be auto-registered. Pass config.model or call ' +
        'registerTokenizer() manually.',
      );
    }
  }

  // 6. Cost tracker — pass pricing/budget at factory time instead of mutating
  // post-construction. `createCostTracker({ pricing, budget })` is the only
  // supported initial-load path; `updatePricing()` / `updateBudget()` remain
  // for later mutation.
  const costs = config.langfuse
    ? createLangfuseCostTracker({
        client: config.langfuse,
        ...(config.pricing !== undefined && { pricing: config.pricing }),
        ...(config.budget !== undefined && { budget: config.budget }),
      })
    : createCostTracker({
        ...(config.pricing !== undefined && { pricing: config.pricing }),
        ...(config.budget !== undefined && { budget: config.budget }),
      });

  // 7. Trace manager
  const traces = createTraceManager({ exporters });

  // 8. Tool registry
  const tools = createRegistry({ validator: schemaValidator });

  // 9. Guardrails
  const guardrailPipeline = createGuardrails(config);

  // 10. Session manager
  const sessions = createSessionManager();

  // 11. Prompt builder
  const prompts = createPromptBuilder();

  // 12. Eval runner (default relevance scorer)
  const evalRunner = createEvalRunner({ scorers: [createRelevanceScorer()] });

  // 13. Logger — no longer depends on the deleted eventBus stub.
  const logger = config.logger ?? createLogger();

  // 14. Conversation store
  const conversations = createInMemoryConversationStore();

  // 16. Middleware chain
  const middleware = createMiddlewareChain();

  // 17. Agent loop — wire the shared traceManager so iteration/tool spans
  // appear alongside harness-level spans in a unified trace backend.
  // Wave-13 F-2: supply a default adapterTimeoutMs so provider hangs cannot
  // stall requests indefinitely. Caller-supplied value takes precedence;
  // passing `0` is forwarded verbatim to the AgentLoop (which treats it as
  // "disabled"), preserving the pre-Wave-13 unbounded behavior for callers who
  // need it. The option is forwarded under an expanding config shape —
  // `AgentLoopConfig` does not formally declare it today, but the underlying
  // `AdapterCaller` already reads it from its own config. We widen via a type
  // assertion at the boundary so the preset can supply the default without
  // coupling to the internal wiring; a future core-side change will promote
  // the field to `AgentLoopConfig` proper (tracked in the Wave-13 research
  // report under F-2).
  const effectiveAdapterTimeoutMs =
    config.adapterTimeoutMs !== undefined ? config.adapterTimeoutMs : DEFAULT_ADAPTER_TIMEOUT_MS;
  const loop = createAgentLoop({
    adapter,
    traceManager: traces,
    ...(config.maxIterations !== undefined && { maxIterations: config.maxIterations }),
    ...(config.maxTotalTokens !== undefined && { maxTotalTokens: config.maxTotalTokens }),
    ...(config.maxAdapterRetries !== undefined && { maxAdapterRetries: config.maxAdapterRetries }),
    ...(config.baseRetryDelayMs !== undefined && { baseRetryDelayMs: config.baseRetryDelayMs }),
    ...(config.retryableErrors !== undefined && { retryableErrors: config.retryableErrors }),
    // Forwarded verbatim; see comment above. Cast narrows only the
    // added-field shape and does not launder unrelated types.
    ...({ adapterTimeoutMs: effectiveAdapterTimeoutMs } as { readonly adapterTimeoutMs: number }),
    onToolCall: async (call) => {
      return tools.execute(call);
    },
  });

  // Warn at construction time when running without a cost budget — production
  // deployments without a budget have no upper bound on token spend. Emits
  // exactly once per harness instance.
  if (config.budget === undefined) {
    logger.warn(
      'harness-one: no cost budget configured. Runaway token usage is unbounded. ' +
      'Set HarnessConfig.budget to enable automatic budget alerts and circuit breaking.',
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
      'harness-one: harness.run() invoked without a sessionId. An auto-generated unique ' +
      'session ID is being used, which prevents message interleaving but means conversation ' +
      'history cannot be resumed. Pass harness.run(messages, { sessionId }) to enable ' +
      'persistent, resumable conversations.',
    );
  }

  /**
   * LM-013: `shutdownPromise` is a latch, not a flag. Concurrent callers
   * (signal handlers, user code, integration-test teardown) all await the
   * same promise so the sequence below runs exactly once. A plain `boolean`
   * flag allowed a second caller through the check before the first await
   * point had completed.
   */
  let shutdownPromise: Promise<void> | null = null;
  /**
   * ARCH-007: `initializePromise` is the same latch pattern. Eager
   * initialization awaits exporter `initialize()` hooks once and caches
   * the result so second callers see the in-flight promise instead of
   * re-initializing.
   */
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
     * ARCH-007: Eager initialization.
     *
     * Awaits `traces.initialize()` (which calls `initialize()` on every
     * exporter that declares one), warms the tokenizer when
     * `config.tokenizer === 'tiktoken'`, and marks the harness as
     * initialized. Idempotent via `initializePromise`. Calling `run()`
     * before `initialize()` still works — this method only accelerates
     * the first use, turning what would be a lazy cold-start latency
     * spike on the first `run()` into an explicit boot-time step.
     */
    initialize(): Promise<void> {
      if (initializePromise) return initializePromise;
      initializePromise = (async () => {
        try {
          await traces.initialize();
        } catch (err) {
          logger.warn('TraceManager initialize error', { error: err });
          // Initialization failure is non-fatal — exporter `isHealthy`
          // gates future exports. Re-throw if you want fail-fast semantics
          // at your call site.
        }
        // F18a: Pre-warm tiktoken WASM by encoding a dummy string so the
        // first real request doesn't pay a cold-start latency penalty.
        // `registerTiktokenModels()` ran synchronously at factory time;
        // this forces the WASM module to actually load.
        if (config.tokenizer === 'tiktoken') {
          try {
            const model = config.model ?? 'gpt-4';
            countTokens(model, [{ role: 'user', content: '' }]);
          } catch {
            // Non-fatal — lazy loading will still work on first real call
          }
        }
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
      // callers can persist / log / resume the auto-generated value.  The
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
          logger.error('[harness-one/preset] Failed to persist input messages to conversation store — session history may have gaps', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
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
              logger.error('[harness-one/preset] Failed to persist message to conversation store — session history may have gaps', {
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
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
              logger.error('[harness-one/preset] Failed to persist tool result to conversation store — session history may have gaps', {
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
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
     * LM-001 / LM-002 / LM-013: Ordered async shutdown DAG.
     *
     * Concurrent `shutdown()` calls all await the same cached
     * `shutdownPromise` so the sequence runs exactly once. The order is:
     *
     *   1. `loop.dispose?.()` — stop the agent loop; detaches its external
     *      abort signal so downstream listeners can't fire after teardown.
     *   2. `sessions.dispose()` — clears the session GC timer; sync but
     *      awaited via `Promise.resolve` for future-proofing.
     *   3. `middleware.clear()` — drop middleware references so closures
     *      over per-request state can be GC'd.
     *   4. `traces.dispose()` — awaits `pendingExports` internally
     *      (LM-001), flushes every exporter, then shuts each exporter down
     *      with a bounded per-exporter timeout (5s) so a hanging exporter
     *      cannot stall the whole DAG.
     *
     * Timers and in-flight promises are explicitly awaited so no work
     * remains in flight when this method resolves.
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
          try { logger.warn('AgentLoop dispose error', { error: err }); } catch { /* logger failure non-fatal */ }
        }

        // 2. Session manager (stops GC timer, clears session store).
        try {
          await Promise.resolve(sessions.dispose());
        } catch (err) {
          try { logger.warn('SessionManager dispose error', { error: err }); } catch { /* logger failure non-fatal */ }
        }

        // 3. Middleware chain — drop references so closures can be GC'd.
        try {
          middleware.clear();
        } catch (err) {
          try { logger.warn('Middleware clear error', { error: err }); } catch { /* logger failure non-fatal */ }
        }

        // 4. Trace manager — settles pendingExports, flushes, then races
        //    each exporter's shutdown() against a bounded per-exporter
        //    timeout (handled inside TraceManager.dispose()). Failures are
        //    reported via the configured onExportError / logger.warn.
        try {
          await traces.dispose();
        } catch (err) {
          try { logger.warn('TraceManager dispose error', { error: err }); } catch { /* logger failure non-fatal */ }
        }
      })();
      return shutdownPromise;
    },

    /**
     * LM-002: Graceful drain — abort the loop, let in-flight work settle for
     * a brief window, then delegate to `shutdown()` while respecting the
     * caller's timeoutMs as a hard deadline for the whole operation.
     *
     * Wave-13 F-6: default is {@link DRAIN_DEFAULT_TIMEOUT_MS} (30_000 ms);
     * the constant is exported so callers can read / log it without hard-
     * coding the magic number.
     */
    async drain(timeoutMs: number = DRAIN_DEFAULT_TIMEOUT_MS): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      // 1. Tell the loop to stop taking new work.
      loop.abort();
      // 2. Brief settle: shortest of 100ms or timeoutMs. Timer is unref'd
      //    so it cannot keep the process alive during graceful shutdown.
      const settleMs = Math.min(100, timeoutMs);
      if (settleMs > 0) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, settleMs);
          if (typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref();
        });
      }
      // 3. Delegate to shutdown, respecting the remaining deadline. We
      //    cannot cancel the shutdown mid-flight, so we attach a watchdog
      //    that resolves on deadline expiry. Shutdown will continue in the
      //    background until complete; drain() returns once either side wins.
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining === 0) {
        // Deadline already expired — kick off shutdown but don't wait past
        // the caller's budget. We still `.catch` any rejection so a
        // rejected shutdown doesn't become an unhandled rejection.
        void this.shutdown().catch(() => {});
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
