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
import type { GuardrailPipeline } from 'harness-one/guardrails';
import { createSessionManager } from 'harness-one/session';
import type { SessionManager } from 'harness-one/session';
import { createInMemoryStore } from 'harness-one/memory';
import type { MemoryStore } from 'harness-one/memory';
import { createEvalRunner, createRelevanceScorer } from 'harness-one/eval';
import type { EvalRunner } from 'harness-one/eval';

import { createAnthropicAdapter } from '@harness-one/anthropic';
import { createOpenAIAdapter } from '@harness-one/openai';
import { createLangfuseExporter, createLangfusePromptBackend, createLangfuseCostTracker } from '@harness-one/langfuse';
import { createRedisStore } from '@harness-one/redis';
import { createAjvValidator } from '@harness-one/ajv';
import { registerTiktokenModels } from '@harness-one/tiktoken';

/** Configuration for creating a full Harness instance. */
export interface HarnessConfig {
  /** LLM provider -- 'anthropic' or 'openai'. */
  readonly provider: 'anthropic' | 'openai';
  /** Provider client instance. */
  readonly client: unknown;
  /** Model name. */
  readonly model?: string;

  /** Langfuse client (optional -- enables tracing + prompt management). */
  readonly langfuse?: unknown;
  /** Redis client (optional -- enables persistent memory). */
  readonly redis?: unknown;

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
}

/**
 * Create a fully-wired Harness instance.
 *
 * Every auto-configured component can be overridden by passing the
 * explicit config field.
 */
export function createHarness(config: HarnessConfig): Harness {
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
    ? createLangfuseCostTracker({ client: config.langfuse as any })
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
  };

  return harness;
}

// ---------------------------------------------------------------------------
// Internal factory helpers
// ---------------------------------------------------------------------------

function createAdapter(config: HarnessConfig): AgentAdapter {
  if (config.provider === 'anthropic') {
    return createAnthropicAdapter({
      client: config.client as any,
      model: config.model,
    });
  }
  if (config.provider === 'openai') {
    return createOpenAIAdapter({
      client: config.client as any,
      model: config.model,
    });
  }
  throw new HarnessError(`Unknown provider: ${config.provider}`, 'INVALID_CONFIG', 'Use one of: anthropic, openai');
}

function createExporters(config: HarnessConfig): TraceExporter[] {
  if (config.langfuse) {
    return [createLangfuseExporter({ client: config.langfuse as any })];
  }
  return [createConsoleExporter()];
}

function createMemory(config: HarnessConfig): MemoryStore {
  if (config.redis) {
    return createRedisStore({ client: config.redis as any });
  }
  return createInMemoryStore();
}

function createGuardrails(config: HarnessConfig): GuardrailPipeline {
  const guardrailFns: Array<{ name: string; fn: any; direction: 'input' | 'output' }> = [];

  if (config.guardrails?.injection) {
    const sensitivity = typeof config.guardrails.injection === 'object'
      ? config.guardrails.injection.sensitivity
      : undefined;
    guardrailFns.push({
      name: 'injection',
      fn: createInjectionDetector({ sensitivity }),
      direction: 'input',
    });
  }

  if (config.guardrails?.rateLimit) {
    guardrailFns.push({
      name: 'rate-limit',
      fn: createRateLimiter(config.guardrails.rateLimit),
      direction: 'input',
    });
  }

  if (config.guardrails?.contentFilter) {
    guardrailFns.push({
      name: 'content-filter',
      fn: createContentFilter(config.guardrails.contentFilter),
      direction: 'output',
    });
  }

  const input = guardrailFns
    .filter((g) => g.direction === 'input')
    .map((g) => ({ name: g.name, fn: g.fn }));
  const output = guardrailFns
    .filter((g) => g.direction === 'output')
    .map((g) => ({ name: g.name, fn: g.fn }));

  return createPipeline({ input, output });
}
