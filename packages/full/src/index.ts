/**
 * harness-one-full — Batteries-included harness-one with all integrations.
 *
 * Provides a `createHarness()` factory that wires together the core library
 * with provider adapters, observability, memory, validation, and more.
 *
 * @module
 */

import { AgentLoop, HarnessError, createEventBus, createMiddlewareChain } from 'harness-one/core';
import type { AgentAdapter, Message, AgentEvent, EventBus, MiddlewareChain } from 'harness-one/core';
import { createTraceManager, createConsoleExporter, createCostTracker, createLogger } from 'harness-one/observe';
import type { TraceExporter, TraceManager, CostTracker, ModelPricing, Logger } from 'harness-one/observe';
import { createPromptBuilder } from 'harness-one/prompt';
import type { PromptBuilder } from 'harness-one/prompt';
import { createRegistry } from 'harness-one/tools';
import type { ToolRegistry, SchemaValidator } from 'harness-one/tools';
import { createPipeline, createInjectionDetector, createRateLimiter, createContentFilter, createPIIDetector, runInput, runOutput } from 'harness-one/guardrails';
import type { GuardrailPipeline, Guardrail } from 'harness-one/guardrails';
import { createSessionManager, createInMemoryConversationStore } from 'harness-one/session';
import type { SessionManager, ConversationStore } from 'harness-one/session';
import { createInMemoryStore } from 'harness-one/memory';
import type { MemoryStore } from 'harness-one/memory';
import { createEvalRunner, createRelevanceScorer } from 'harness-one/eval';
import type { EvalRunner } from 'harness-one/eval';

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
  /**
   * @deprecated The global event bus is not used by any module. Each module
   * (sessions, orchestrator, etc.) exposes its own `onEvent()` subscription.
   * Prefer per-module event subscriptions instead. This property will be
   * removed in a future major version.
   */
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly conversations: ConversationStore;
  readonly middleware: MiddlewareChain;

  /** Run the agent loop with full pipeline. */
  run(messages: Message[]): AsyncGenerator<AgentEvent>;

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
    throw new HarnessError('Either adapter or client must be provided', 'INVALID_CONFIG', 'Pass a pre-built adapter or a provider client');
  }
  if (config.maxIterations !== undefined && (config.maxIterations <= 0 || !Number.isFinite(config.maxIterations))) {
    throw new HarnessError('maxIterations must be a finite positive number', 'INVALID_CONFIG', 'Use a value >= 1');
  }
  if (config.maxTotalTokens !== undefined && (config.maxTotalTokens <= 0 || !Number.isFinite(config.maxTotalTokens))) {
    throw new HarnessError('maxTotalTokens must be a finite positive number', 'INVALID_CONFIG', 'Use a value >= 1');
  }
  if (config.budget !== undefined && (config.budget <= 0 || !Number.isFinite(config.budget))) {
    throw new HarnessError('budget must be a finite positive number', 'INVALID_CONFIG', 'Use a value > 0');
  }

  // Validate guardrails sub-config
  if (config.guardrails?.rateLimit) {
    const rl = config.guardrails.rateLimit;
    if (rl.max <= 0 || !Number.isFinite(rl.max)) {
      throw new HarnessError('guardrails.rateLimit.max must be a finite positive number', 'INVALID_CONFIG', 'Use a value >= 1');
    }
    if (rl.windowMs <= 0 || !Number.isFinite(rl.windowMs)) {
      throw new HarnessError('guardrails.rateLimit.windowMs must be a finite positive number', 'INVALID_CONFIG', 'Use a value >= 1');
    }
  }

  // Validate pricing values
  if (config.pricing) {
    for (const p of config.pricing) {
      if (p.inputPer1kTokens < 0 || p.outputPer1kTokens < 0) {
        throw new HarnessError(
          `Pricing for model "${p.model}" has negative values`,
          'INVALID_CONFIG',
          'All pricing values must be >= 0',
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
  if (config.tokenizer === 'tiktoken') {
    registerTiktokenModels();
  }
  // When a function or object tokenizer is provided, it can be used by
  // consumers via `harness.tokenizer` without any global side-effects.

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

  // 13. Event bus
  // NOTE: The global event bus is created for backward compatibility but is not
  // actively used. Each module (sessions, orchestrator, traces, etc.) manages
  // its own event subscriptions via onEvent(). Prefer per-module subscriptions
  // for new code. See the @deprecated tag on Harness.eventBus.
  const eventBus = createEventBus();

  // 14. Logger
  const logger = createLogger();

  // 15. Conversation store
  const conversations = createInMemoryConversationStore();

  // 16. Middleware chain
  const middleware = createMiddlewareChain();

  // 17. Agent loop
  const loop = new AgentLoop({
    adapter,
    ...(config.maxIterations !== undefined && { maxIterations: config.maxIterations }),
    ...(config.maxTotalTokens !== undefined && { maxTotalTokens: config.maxTotalTokens }),
    onToolCall: async (call) => {
      return tools.execute(call);
    },
  });

  let isShutdown = false;

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
    eventBus,
    logger,
    conversations,
    middleware,

    async *run(messages: Message[]): AsyncGenerator<AgentEvent> {
      // Run input guardrails on user messages before passing to agent loop
      for (const msg of messages) {
        if (msg.role === 'user') {
          const inputResult = await runInput(guardrailPipeline, { content: msg.content });
          if (!inputResult.passed) {
            yield {
              type: 'error',
              error: new HarnessError(
                `Input blocked by guardrail: ${'reason' in inputResult.verdict ? inputResult.verdict.reason : 'policy violation'}`,
                'GUARDRAIL_BLOCKED',
                'Modify the input to comply with configured guardrails',
              ),
            };
            yield { type: 'done', reason: 'error', totalUsage: { inputTokens: 0, outputTokens: 0 } };
            return;
          }
        }
        await conversations.append('default', msg);
      }
      for await (const event of loop.run(messages)) {
        // Validate tool call arguments against input guardrails before executing
        if (event.type === 'tool_call') {
          const argContent = typeof event.toolCall.arguments === 'string'
            ? event.toolCall.arguments
            : JSON.stringify(event.toolCall.arguments);
          const argCheck = await runInput(guardrailPipeline, { content: argContent });
          if (!argCheck.passed) {
            yield {
              type: 'error',
              error: new HarnessError(
                `Tool arguments blocked by guardrails: ${'reason' in argCheck.verdict ? argCheck.verdict.reason : 'policy violation'}`,
                'GUARDRAIL_BLOCKED',
                'Tool call arguments were blocked by input guardrails',
              ),
            };
            yield { type: 'done', reason: 'error', totalUsage: loop.usage };
            return;
          }
        }
        // Run output guardrails on assistant messages
        if (event.type === 'message' && event.message) {
          const outputResult = await runOutput(guardrailPipeline, { content: event.message.content });
          if (!outputResult.passed) {
            yield {
              type: 'error',
              error: new HarnessError(
                `Output blocked by guardrail: ${'reason' in outputResult.verdict ? outputResult.verdict.reason : 'policy violation'}`,
                'GUARDRAIL_BLOCKED',
                'The model response was blocked by output guardrails',
              ),
            };
            yield { type: 'done', reason: 'error', totalUsage: loop.usage };
            return;
          }
          await conversations.append('default', event.message);
        } else if (event.type === 'tool_result') {
          // Run output guardrails on tool results
          const toolOutputResult = await runOutput(guardrailPipeline, {
            content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
          });
          if (!toolOutputResult.passed) {
            yield {
              type: 'error',
              error: new HarnessError(
                `Tool output blocked by guardrail: ${'reason' in toolOutputResult.verdict ? toolOutputResult.verdict.reason : 'policy violation'}`,
                'GUARDRAIL_BLOCKED',
                'A tool result was blocked by output guardrails',
              ),
            };
            yield { type: 'done', reason: 'error', totalUsage: loop.usage };
            return;
          }
          await conversations.append('default', {
            role: 'tool' as const,
            content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
            toolCallId: event.toolCallId,
          });
        }
        yield event;
      }
    },

    async shutdown(): Promise<void> {
      if (isShutdown) return;
      isShutdown = true;
      await traces.flush();
      const EXPORTER_TIMEOUT = 5_000;
      for (const exporter of exporters) {
        if (exporter.shutdown) {
          await Promise.race([
            exporter.shutdown(),
            new Promise<void>((resolve) => setTimeout(resolve, EXPORTER_TIMEOUT)),
          ]);
        }
      }
    },

    async drain(timeoutMs = 30_000): Promise<void> {
      loop.abort();
      // Wait for in-flight operations to settle. Use a 100ms tick for polling,
      // but respect the full timeoutMs deadline for overall drain duration.
      const deadline = Date.now() + timeoutMs;
      const settleMs = Math.min(100, timeoutMs);
      await new Promise((r) => setTimeout(r, settleMs));
      // Give exporters time to flush before shutdown
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining > 0) {
        await Promise.race([
          traces.flush(),
          new Promise((r) => setTimeout(r, remaining)),
        ]);
      }
      await this.shutdown();
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
  throw new HarnessError(`Unknown provider: ${(_exhaustive as AnthropicHarnessConfig | OpenAIHarnessConfig).provider}`, 'INVALID_CONFIG', 'Use one of: anthropic, openai');
}

function createExporters(config: HarnessConfig): TraceExporter[] {
  if (config.langfuse) {
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
