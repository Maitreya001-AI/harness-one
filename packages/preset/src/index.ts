/**
 * @harness-one/preset — Batteries-included harness-one preset with all integrations.
 *
 * Provides a `createHarness()` factory that wires together the core library
 * with provider adapters, observability, memory, validation, and more.
 *
 * @module
 */

import { AgentLoop, HarnessError, createMiddlewareChain, HarnessErrorCode} from 'harness-one/core';
import type { AgentAdapter, Message, AgentEvent, MiddlewareChain } from 'harness-one/core';
import { createTraceManager, createConsoleExporter, createCostTracker, createLogger } from 'harness-one/observe';
import type { TraceExporter, TraceManager, CostTracker, ModelPricing, Logger } from 'harness-one/observe';
import { createPromptBuilder } from 'harness-one/prompt';
import type { PromptBuilder } from 'harness-one/prompt';
import { registerTokenizer } from 'harness-one/context';
import { createRegistry } from 'harness-one/tools';
import type { ToolRegistry, SchemaValidator } from 'harness-one/tools';
import { createPipeline, createInjectionDetector, createRateLimiter, createContentFilter, createPIIDetector, runInput, runOutput } from 'harness-one/guardrails';
import type { GuardrailPipeline, Guardrail } from 'harness-one/guardrails';
import { createSessionManager, createInMemoryConversationStore } from 'harness-one/session';
import type { SessionManager, ConversationStore } from 'harness-one/session';
import { createInMemoryStore } from 'harness-one/memory';
import type { MemoryStore } from 'harness-one/memory';
import { createEvalRunner, createRelevanceScorer } from '@harness-one/devkit';
import type { EvalRunner } from '@harness-one/devkit';

import { createAnthropicAdapter } from '@harness-one/anthropic';
import type { AnthropicAdapterConfig } from '@harness-one/anthropic';
import { createOpenAIAdapter } from '@harness-one/openai';
import type { OpenAIAdapterConfig } from '@harness-one/openai';
import { createAjvValidator } from '@harness-one/ajv';
import type { AjvSchemaValidator } from '@harness-one/ajv';

// Optional integration packages — listed as optionalDependencies in package.json.
// Static imports work in the monorepo; end-users who don't install these will
// get a clear error when attempting to use the corresponding config options.
import { createLangfuseExporter, createLangfuseCostTracker } from '@harness-one/langfuse';
import { createRedisStore } from '@harness-one/redis';
import { registerTiktokenModels } from '@harness-one/tiktoken';

import type { LangfuseExporterConfig } from '@harness-one/langfuse';
import type { RedisStoreConfig } from '@harness-one/redis';

/** Shared configuration fields for all providers. */
interface HarnessConfigBase {
  /** Model name. */
  readonly model?: string;

  /** Langfuse client (optional -- enables tracing + prompt management). */
  readonly langfuse?: LangfuseExporterConfig['client'];
  /** Redis client (optional -- enables persistent memory). */
  readonly redis?: RedisStoreConfig['client'];

  /** Override: custom AgentAdapter. */
  readonly adapter?: AgentAdapter;
  /** Override: custom TraceExporter[]. */
  readonly exporters?: TraceExporter[];
  /** Override: custom MemoryStore. */
  readonly memoryStore?: MemoryStore;
  /** Override: custom SchemaValidator. */
  readonly schemaValidator?: SchemaValidator;
  /**
   * Tokenizer configuration.
   *
   * When set to `'tiktoken'`, the global tiktoken model registry is loaded
   * via `registerTiktokenModels()`, which registers BPE encoders for common
   * models (gpt-4, gpt-4o, gpt-4o-mini, gpt-3.5-turbo) into harness-one's
   * global tokenizer registry. This is the only value that triggers automatic
   * registration.
   *
   * Custom tokenizer objects or functions are stored but must be manually
   * integrated with the AgentLoop. They do not mutate global state.
   *
   * - `'tiktoken'` — registers tiktoken models globally (legacy behaviour).
   * - A function `(text: string) => number` — used as a custom token-counting
   *   function, avoiding global side-effects entirely.
   * - An object with `encode(text: string): { length: number }` — used directly
   *   as a tokenizer instance, avoiding global side-effects entirely.
   */
  readonly tokenizer?: 'tiktoken' | ((text: string) => number) | { encode(text: string): { length: number } };

  /** Agent loop config. */
  readonly maxIterations?: number;
  /** Maximum total tokens across all iterations. */
  readonly maxTotalTokens?: number;
  /** Maximum adapter retry attempts on retryable errors (default: 0 = no retries). */
  readonly maxAdapterRetries?: number;
  /** Base delay in ms for exponential backoff between retries (default: 1000). */
  readonly baseRetryDelayMs?: number;
  /** Error categories eligible for retry (default: ['ADAPTER_RATE_LIMIT']). */
  readonly retryableErrors?: readonly string[];

  /** Guardrail config. */
  readonly guardrails?: {
    readonly injection?: boolean | { sensitivity?: 'low' | 'medium' | 'high' };
    readonly rateLimit?: { max: number; windowMs: number };
    readonly contentFilter?: { blocked?: string[] };
    readonly pii?: boolean | { types?: Array<'email' | 'phone' | 'ssn' | 'creditCard' | 'apiKey' | 'ipv4' | 'privateKey'> };
  };

  /** Cost budget. */
  readonly budget?: number;
  /** Model pricing configuration. */
  readonly pricing?: ModelPricing[];
  /**
   * Custom logger. When omitted, `createLogger()` is called with defaults.
   * Supply a logger to route harness-level warnings (no-budget, default
   * session, conversation-append failures) into your observability stack.
   */
  readonly logger?: Logger;
}

/** Configuration for creating a full Harness instance with Anthropic. */
export interface AnthropicHarnessConfig extends HarnessConfigBase {
  readonly provider: 'anthropic';
  /** Anthropic client instance. */
  readonly client: AnthropicAdapterConfig['client'];
}

/** Configuration for creating a full Harness instance with OpenAI. */
export interface OpenAIHarnessConfig extends HarnessConfigBase {
  readonly provider: 'openai';
  /** OpenAI client instance. */
  readonly client: OpenAIAdapterConfig['client'];
}

/**
 * Configuration for creating a full Harness instance with a pre-built adapter.
 *
 * This is the preferred pattern: construct your adapter externally and inject it
 * directly, avoiding hard-coded provider imports inside createHarness.
 *
 * @example
 * ```ts
 * import { createAnthropicAdapter } from '@harness-one/anthropic';
 *
 * const adapter = createAnthropicAdapter({ client, model: 'claude-sonnet-4-20250514' });
 * const harness = createHarness({ adapter });
 * ```
 */
export interface AdapterHarnessConfig extends HarnessConfigBase {
  readonly adapter: AgentAdapter;
  /** Provider and client are not required when adapter is injected directly. */
  readonly provider?: undefined;
  readonly client?: undefined;
}

/**
 * Configuration for creating a full Harness instance.
 *
 * Preferred: use {@link AdapterHarnessConfig} and inject a pre-built adapter
 * directly. Provider-based configs ({@link AnthropicHarnessConfig},
 * {@link OpenAIHarnessConfig}) are still supported for convenience.
 */
export type HarnessConfig = AdapterHarnessConfig | AnthropicHarnessConfig | OpenAIHarnessConfig;

/**
 * Tokenizer shape accepted by {@link HarnessConfigBase.tokenizer} and exposed
 * on the returned {@link Harness} instance.  Excludes the `'tiktoken'` string
 * sentinel, since that triggers global registration and is not stored.
 */
export type Tokenizer =
  | ((text: string) => number)
  | { encode(text: string): { length: number } };

/** A fully-wired harness instance. */
export interface Harness {
  readonly loop: AgentLoop;
  readonly tools: ToolRegistry;
  readonly guardrails: GuardrailPipeline;
  readonly traces: TraceManager;
  readonly costs: CostTracker;
  readonly sessions: SessionManager;
  readonly memory: MemoryStore;
  readonly prompts: PromptBuilder;
  readonly eval: EvalRunner;
  readonly logger: Logger;
  readonly conversations: ConversationStore;
  readonly middleware: MiddlewareChain;
  /**
   * SPEC-009: Custom tokenizer provided via `config.tokenizer` (function or
   * object form).  Stored so downstream code — context packers, compactors,
   * custom AgentLoop adapters — can reach the tokenizer without re-reading
   * the config.  `undefined` when `tokenizer` was omitted or set to
   * `'tiktoken'` (the latter registers globally via `registerTiktokenModels()`
   * rather than being stored).
   */
  readonly tokenizer?: Tokenizer;

  /**
   * Run the agent loop with the full pipeline (guardrails, tracing,
   * cost tracking, and conversation persistence).
   *
   * @param messages - The initial conversation. Must include at least one
   *   user message for input guardrails to run.
   * @param options.sessionId - Session identifier for the conversation store.
   *   Defaults to `"default"`, which is unsafe for concurrent `run()` calls
   *   in multi-request servers — a warning is logged the first time
   *   `"default"` is used. Pass a per-request id (e.g., a user id) to isolate
   *   conversation histories.
   */
  run(messages: Message[], options?: { sessionId?: string }): AsyncGenerator<AgentEvent>;

  /**
   * ARCH-007: Optional eager initialization.
   *
   * Awaits `initialize()` on every configured trace exporter (if they
   * declare one) and warms the tokenizer when `config.tokenizer === 'tiktoken'`.
   * Idempotent — subsequent calls return the same resolved promise.
   *
   * Calling `run()` before `initialize()` still works: exporters initialize
   * lazily on first export and the tokenizer registers on first use. Eager
   * initialization is useful in fail-fast startup paths where connection /
   * registration failures should surface at boot, not mid-request.
   */
  initialize?(): Promise<void>;

  /** Shut down all services. */
  shutdown(): Promise<void>;

  /** Abort the running loop and shut down all services gracefully. */
  drain(timeoutMs?: number): Promise<void>;
}

/**
 * Create a fully-wired Harness instance.
 *
 * Every auto-configured component can be overridden by passing the
 * explicit config field.
 */
export function createHarness(config: HarnessConfig): Harness {
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
        throw new HarnessError(
          `Pricing for model "${p.model}" has non-finite or negative values`,
          HarnessErrorCode.CORE_INVALID_CONFIG,
          'All pricing values must be finite numbers >= 0',
        );
      }
    }
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

  // 6. Cost tracker
  const costs = config.langfuse
    ? createLangfuseCostTracker({ client: config.langfuse })
    : createCostTracker();

  if (config.pricing) {
    costs.setPricing(config.pricing);
  }
  if (config.budget !== undefined) {
    costs.setBudget(config.budget);
  }

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
  const loop = new AgentLoop({
    adapter,
    traceManager: traces,
    ...(config.maxIterations !== undefined && { maxIterations: config.maxIterations }),
    ...(config.maxTotalTokens !== undefined && { maxTotalTokens: config.maxTotalTokens }),
    ...(config.maxAdapterRetries !== undefined && { maxAdapterRetries: config.maxAdapterRetries }),
    ...(config.baseRetryDelayMs !== undefined && { baseRetryDelayMs: config.baseRetryDelayMs }),
    ...(config.retryableErrors !== undefined && { retryableErrors: config.retryableErrors }),
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
      'harness-one: harness.run() invoked without a sessionId. All messages are persisted ' +
      'to the "default" session; concurrent run() calls will interleave. Pass ' +
      'harness.run(messages, { sessionId }) in multi-request environments.',
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
        // Tokenizer warming: when the caller asked for the tiktoken preset,
        // `registerTiktokenModels()` already ran synchronously at factory
        // time, so nothing more is required. Explicit no-op here keeps the
        // extension point visible for future async tokenizer backends.
      })();
      return initializePromise;
    },

    async *run(
      messages: Message[],
      options?: { sessionId?: string },
    ): AsyncGenerator<AgentEvent> {
      const sessionId = options?.sessionId ?? 'default';
      if (sessionId === 'default') warnDefaultSessionOnce();

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
        // Run input guardrails on user messages before passing to agent loop
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
          try {
            await conversations.append(sessionId, msg);
          } catch (err) {
            logger.warn('Failed to persist message to conversation store', { error: err });
          }
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
              logger.warn('Failed to persist message to conversation store', { error: err });
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
              logger.warn('Failed to persist message to conversation store', { error: err });
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
          logger.warn('AgentLoop dispose error', { error: err });
        }

        // 2. Session manager (stops GC timer, clears session store).
        try {
          await Promise.resolve(sessions.dispose());
        } catch (err) {
          logger.warn('SessionManager dispose error', { error: err });
        }

        // 3. Middleware chain — drop references so closures can be GC'd.
        try {
          middleware.clear();
        } catch (err) {
          logger.warn('Middleware clear error', { error: err });
        }

        // 4. Trace manager — settles pendingExports, flushes, then races
        //    each exporter's shutdown() against a bounded per-exporter
        //    timeout (handled inside TraceManager.dispose()). Failures are
        //    reported via the configured onExportError / logger.warn.
        try {
          await traces.dispose();
        } catch (err) {
          logger.warn('TraceManager dispose error', { error: err });
        }
      })();
      return shutdownPromise;
    },

    /**
     * LM-002: Graceful drain — abort the loop, let in-flight work settle for
     * a brief window, then delegate to `shutdown()` while respecting the
     * caller's timeoutMs as a hard deadline for the whole operation.
     */
    async drain(timeoutMs = 30_000): Promise<void> {
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

// ---------------------------------------------------------------------------
// Internal factory helpers
// ---------------------------------------------------------------------------

function createAdapter(config: AnthropicHarnessConfig | OpenAIHarnessConfig): AgentAdapter {
  if (config.provider === 'anthropic') {
    return createAnthropicAdapter({
      client: config.client,
      ...(config.model !== undefined && { model: config.model }),
    });
  }
  if (config.provider === 'openai') {
    return createOpenAIAdapter({
      ...(config.client !== undefined && { client: config.client }),
      ...(config.model !== undefined && { model: config.model }),
    });
  }
  // Exhaustiveness check — TypeScript narrows config.provider to `never` here
  const _exhaustive: never = config;
  throw new HarnessError(`Unknown provider: ${(_exhaustive as AnthropicHarnessConfig | OpenAIHarnessConfig).provider}`, HarnessErrorCode.CORE_INVALID_CONFIG, 'Use one of: anthropic, openai');
}

function createExporters(config: HarnessConfig): TraceExporter[] {
  if (config.langfuse) {
    // Validate the client shape up front so misconfiguration fails fast at
    // harness construction rather than at flush time, when the user has
    // already started serving traffic. Langfuse clients expose `trace()`
    // and `event()` methods; a plain object or a Promise will silently swallow
    // exports until first flush.
    const client = config.langfuse as unknown as { trace?: unknown; event?: unknown };
    if (!client || typeof client !== 'object' || typeof client.trace !== 'function') {
      throw new HarnessError(
        'config.langfuse is not a valid Langfuse client (expected object with .trace() method). ' +
        'If you received a Promise, await it before passing to createHarness.',
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Construct the Langfuse client synchronously and pass the resolved instance',
      );
    }
    return [createLangfuseExporter({ client: config.langfuse })];
  }
  return [createConsoleExporter()];
}

function createMemory(config: HarnessConfig): MemoryStore {
  if (config.redis) {
    return createRedisStore({ client: config.redis });
  }
  return createInMemoryStore();
}

function createGuardrails(config: HarnessConfig): GuardrailPipeline {
  const entries: Array<{ name: string; guard: Guardrail; direction: 'input' | 'output' }> = [];

  if (config.guardrails?.injection) {
    const sensitivity = typeof config.guardrails.injection === 'object'
      ? config.guardrails.injection.sensitivity
      : undefined;
    const detector = createInjectionDetector(sensitivity !== undefined ? { sensitivity } : {});
    entries.push({
      name: detector.name,
      guard: detector.guard,
      direction: 'input',
    });
  }

  if (config.guardrails?.rateLimit) {
    const limiter = createRateLimiter(config.guardrails.rateLimit);
    entries.push({
      name: limiter.name,
      guard: limiter.guard,
      direction: 'input',
    });
  }

  if (config.guardrails?.contentFilter) {
    const filter = createContentFilter(config.guardrails.contentFilter);
    entries.push({
      name: filter.name,
      guard: filter.guard,
      direction: 'output',
    });
  }

  if (config.guardrails?.pii) {
    const piiConfig = typeof config.guardrails.pii === 'object' ? config.guardrails.pii : undefined;
    const detect = piiConfig?.types
      ? {
          email: piiConfig.types.includes('email'),
          phone: piiConfig.types.includes('phone'),
          ssn: piiConfig.types.includes('ssn'),
          creditCard: piiConfig.types.includes('creditCard'),
          apiKey: piiConfig.types.includes('apiKey'),
          ipAddress: piiConfig.types.includes('ipv4'),
          privateKey: piiConfig.types.includes('privateKey'),
        }
      : undefined;
    const detector = createPIIDetector(detect !== undefined ? { detect } : {});
    entries.push({
      name: detector.name,
      guard: detector.guard,
      direction: 'input',
    });
  }

  const input = entries
    .filter((g) => g.direction === 'input')
    .map((g) => ({ name: g.name, guard: g.guard }));
  const output = entries
    .filter((g) => g.direction === 'output')
    .map((g) => ({ name: g.name, guard: g.guard }));

  return createPipeline({ input, output });
}

// ---------------------------------------------------------------------------
// Environment configuration helper
// ---------------------------------------------------------------------------

export { createConfigFromEnv } from './env.js';

// ---------------------------------------------------------------------------
// T14 (Wave-5A): Fail-closed production entry
// ---------------------------------------------------------------------------

export { createSecurePreset } from './secure.js';
export type { SecurePresetGuardrailLevel, SecurePresetOptions, SecureHarness } from './secure.js';

// ---------------------------------------------------------------------------
// Graceful shutdown handler
// ---------------------------------------------------------------------------

export { createShutdownHandler } from './shutdown.js';
export type { ShutdownHandlerOptions } from './shutdown.js';

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

export { validateHarnessConfig } from './validate-config.js';
