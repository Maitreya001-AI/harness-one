/**
 * harness-one-full — Batteries-included harness-one with all integrations.
 *
 * Provides a `createHarness()` factory that wires together the core library
 * with provider adapters, observability, memory, validation, and more.
 *
 * @module
 */

import { AgentLoop, HarnessError } from 'harness-one/core';
import type { AgentAdapter, Message, AgentEvent } from 'harness-one/core';
import { createTraceManager, createConsoleExporter, createCostTracker } from 'harness-one/observe';
import type { TraceExporter, TraceManager, CostTracker, ModelPricing } from 'harness-one/observe';
import { createPromptBuilder } from 'harness-one/prompt';
import type { PromptBuilder } from 'harness-one/prompt';
import { createRegistry } from 'harness-one/tools';
import type { ToolRegistry, SchemaValidator } from 'harness-one/tools';
import { createPipeline, createInjectionDetector, createRateLimiter, createContentFilter } from 'harness-one/guardrails';
import type { GuardrailPipeline, Guardrail } from 'harness-one/guardrails';
import { createSessionManager } from 'harness-one/session';
import type { SessionManager } from 'harness-one/session';
import { createInMemoryStore } from 'harness-one/memory';
import type { MemoryStore } from 'harness-one/memory';
import { createEvalRunner, createRelevanceScorer } from 'harness-one/eval';
import type { EvalRunner } from 'harness-one/eval';

import { createAnthropicAdapter } from '@harness-one/anthropic';
import type { AnthropicAdapterConfig } from '@harness-one/anthropic';
import { createOpenAIAdapter } from '@harness-one/openai';
import type { OpenAIAdapterConfig } from '@harness-one/openai';
import { createLangfuseExporter, createLangfuseCostTracker } from '@harness-one/langfuse';
import type { LangfuseExporterConfig, LangfuseCostTrackerConfig } from '@harness-one/langfuse';
import { createRedisStore } from '@harness-one/redis';
import type { RedisStoreConfig } from '@harness-one/redis';
import { createAjvValidator } from '@harness-one/ajv';
import { registerTiktokenModels } from '@harness-one/tiktoken';

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
  /** Override: custom Tokenizer registration. */
  readonly tokenizer?: 'tiktoken' | { encode(text: string): { length: number } };

  /** Agent loop config. */
  readonly maxIterations?: number;
  /** Maximum total tokens across all iterations. */
  readonly maxTotalTokens?: number;

  /** Guardrail config. */
  readonly guardrails?: {
    readonly injection?: boolean | { sensitivity?: 'low' | 'medium' | 'high' };
    readonly rateLimit?: { max: number; windowMs: number };
    readonly contentFilter?: { blocked?: string[] };
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

/** Configuration for creating a full Harness instance (discriminated by provider). */
export type HarnessConfig = AnthropicHarnessConfig | OpenAIHarnessConfig;

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
  if (!config.adapter && !config.client) {
    throw new HarnessError('Either adapter or client must be provided', 'INVALID_CONFIG', 'Pass a provider client or a custom adapter');
  }
  if (config.maxIterations !== undefined && config.maxIterations <= 0) {
    throw new HarnessError('maxIterations must be positive', 'INVALID_CONFIG', 'Use a value >= 1');
  }
  if (config.maxTotalTokens !== undefined && config.maxTotalTokens <= 0) {
    throw new HarnessError('maxTotalTokens must be positive', 'INVALID_CONFIG', 'Use a value >= 1');
  }
  if (config.budget !== undefined && config.budget <= 0) {
    throw new HarnessError('budget must be positive', 'INVALID_CONFIG', 'Use a value > 0');
  }

  // 1. Adapter
  const adapter: AgentAdapter = config.adapter ?? createAdapter(config);

  // 2. Exporters
  const exporters: TraceExporter[] = config.exporters ?? createExporters(config);

  // 3. Memory store
  const memory: MemoryStore = config.memoryStore ?? createMemory(config);

  // 4. Schema validator
  const schemaValidator: SchemaValidator = config.schemaValidator
    ? config.schemaValidator
    : createAjvValidator();

  // 5. Tokenizer
  if (config.tokenizer === 'tiktoken') {
    registerTiktokenModels();
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

  // 13. Agent loop
  const loop = new AgentLoop({
    adapter,
    maxIterations: config.maxIterations,
    maxTotalTokens: config.maxTotalTokens,
    onToolCall: async (call) => {
      const parsed = {
        id: call.id,
        name: call.name,
        arguments: JSON.parse(call.arguments),
      };
      return tools.execute(parsed);
    },
  });

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

    run(messages: Message[]): AsyncGenerator<AgentEvent> {
      return loop.run(messages);
    },

    async shutdown(): Promise<void> {
      await traces.flush();
      for (const exporter of exporters) {
        if (exporter.shutdown) {
          await exporter.shutdown();
        }
      }
    },

    async drain(timeoutMs = 30_000): Promise<void> {
      loop.abort();
      const deadline = Date.now() + timeoutMs;
      // Poll until the loop's abort signal settles (short spin)
      while (Date.now() < deadline) {
        // Give pending microtasks a chance to complete
        await new Promise((r) => setTimeout(r, 50));
        break; // Single tick is sufficient after abort()
      }
      await this.shutdown();
    },
  };

  return harness;
}

// ---------------------------------------------------------------------------
// Internal factory helpers
// ---------------------------------------------------------------------------

function createAdapter(config: HarnessConfig): AgentAdapter {
  if (config.provider === 'anthropic') {
    return createAnthropicAdapter({
      client: config.client,
      model: config.model,
    });
  }
  if (config.provider === 'openai') {
    return createOpenAIAdapter({
      client: config.client,
      model: config.model,
    });
  }
  // Exhaustiveness check — TypeScript narrows config.provider to `never` here
  const _exhaustive: never = config;
  throw new HarnessError(`Unknown provider: ${(_exhaustive as HarnessConfig).provider}`, 'INVALID_CONFIG', 'Use one of: anthropic, openai');
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
    const detector = createInjectionDetector({ sensitivity });
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
