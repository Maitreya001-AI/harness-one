/**
 * Component wiring for {@link buildHarness}.
 *
 * Extracted from `run.ts` so the factory can read as "validate config →
 * wire components → attach lifecycle methods" instead of 150 lines of
 * conditional-spread boilerplate. Every field flows through an
 * explicit `?? createX(config)` fallback so overriding a single
 * component is a one-line change.
 *
 * The output is a plain struct (no lifecycle methods); `run.ts` owns
 * `initialize` / `shutdown` / `drain` because those depend on the
 * `harness` object identity for latch state.
 *
 * @module
 */

import { createAgentLoop } from 'harness-one/core';
import type { AgentAdapter } from 'harness-one/core';
import { createMiddlewareChain } from 'harness-one/advanced';
import {
  createTraceManager,
  createCostTracker,
  createLogger,
} from 'harness-one/observe';
import type { TraceExporter, Logger, CostTracker, TraceManager } from 'harness-one/observe';
import { createPromptBuilder } from 'harness-one/prompt';
import type { PromptBuilder } from 'harness-one/prompt';
import { registerTokenizer, countTokens } from 'harness-one/context';
import { createRegistry } from 'harness-one/tools';
import type { SchemaValidator, ToolRegistry } from 'harness-one/tools';
import type { GuardrailPipeline } from 'harness-one/guardrails';
import { createSessionManager, createInMemoryConversationStore } from 'harness-one/session';
import type { SessionManager, ConversationStore } from 'harness-one/session';
import type { MemoryStore } from 'harness-one/memory';
import { createEvalRunner, createRelevanceScorer } from '@harness-one/devkit';
import type { EvalRunner } from '@harness-one/devkit';

import { createAjvValidator } from '@harness-one/ajv';
import type { AjvSchemaValidator } from '@harness-one/ajv';

import { createLangfuseCostTracker } from '@harness-one/langfuse';
import { registerTiktokenModels } from '@harness-one/tiktoken';

import type { AgentLoop } from 'harness-one/core';
import type { MiddlewareChain } from 'harness-one/advanced';

import {
  DEFAULT_ADAPTER_TIMEOUT_MS,
} from './types.js';
import type {
  AnthropicHarnessConfig,
  OpenAIHarnessConfig,
  HarnessConfig,
  Tokenizer,
} from './types.js';

import { createAdapter } from './adapter.js';
import { createExporters } from './exporters.js';
import { createMemory } from './memory.js';
import { createGuardrails } from './guardrails.js';

/**
 * Every component the preset harness instantiates. `buildHarness`
 * weaves the lifecycle methods on top.
 */
export interface WiredComponents {
  readonly adapter: AgentAdapter;
  readonly exporters: readonly TraceExporter[];
  readonly memory: MemoryStore;
  readonly schemaValidator: SchemaValidator | AjvSchemaValidator;
  readonly customTokenizer: Tokenizer | undefined;
  readonly costs: CostTracker;
  readonly traces: TraceManager;
  readonly tools: ToolRegistry;
  readonly guardrailPipeline: GuardrailPipeline;
  readonly sessions: SessionManager;
  readonly prompts: PromptBuilder;
  readonly evalRunner: EvalRunner;
  readonly logger: Logger;
  readonly conversations: ConversationStore;
  readonly middleware: MiddlewareChain;
  readonly loop: AgentLoop;
}

/**
 * Wire every component required by {@link buildHarness}. No side effects
 * beyond:
 *
 * - `registerTiktokenModels()` when `config.tokenizer === 'tiktoken'`.
 * - `registerTokenizer(config.model, ...)` when a custom tokenizer is
 *   supplied alongside a model name.
 * - A one-time `logger.warn` when a custom tokenizer is supplied without
 *   a model (otherwise the tokenizer is stored but never consulted).
 *
 * The returned `loop` has `adapterTimeoutMs` defaulted to
 * {@link DEFAULT_ADAPTER_TIMEOUT_MS}; caller-supplied `config.adapterTimeoutMs`
 * (including `0` for "disabled") takes precedence.
 */
export function wireComponents(config: HarnessConfig): WiredComponents {
  // 1. Adapter — prefer injected adapter; fall back to provider-based factory
  const adapter: AgentAdapter = config.adapter
    ?? createAdapter(config as AnthropicHarnessConfig | OpenAIHarnessConfig);

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
  } else if (
    typeof config.tokenizer === 'function'
    || (config.tokenizer && typeof config.tokenizer === 'object')
  ) {
    // SPEC-009: retain the custom tokenizer so it reaches consumers via
    // `harness.tokenizer`. Also register it under the configured model name
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
      // constructed at this point; fall back to the lazy default logger.
      (config.logger ?? createLogger()).warn(
        'harness-one: custom tokenizer supplied but config.model is not set; '
        + 'tokenizer will not be auto-registered. Pass config.model or call '
        + 'registerTokenizer() manually.',
      );
    }
  }

  // 6. Cost tracker — pass pricing/budget at factory time instead of mutating
  // post-construction. `createCostTracker({ pricing, budget })` is the only
  // supported initial-load path; `updatePricing()` / `updateBudget()` remain
  // for later mutation.
  const costs: CostTracker = config.langfuse
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

  // 15. Middleware chain
  const middleware = createMiddlewareChain();

  // 16. Agent loop — wire the shared traceManager so iteration/tool spans
  // appear alongside harness-level spans in a unified trace backend.
  // Wave-13 F-2: supply a default adapterTimeoutMs so provider hangs cannot
  // stall requests indefinitely. Caller-supplied value takes precedence;
  // passing `0` is forwarded verbatim (treated as "disabled").
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
    // `adapterTimeoutMs` is consumed by AdapterCaller; core's `AgentLoopConfig`
    // widens to accept it via the nested ResolvedAgentLoopConfig path.
    ...({ adapterTimeoutMs: effectiveAdapterTimeoutMs } as { readonly adapterTimeoutMs: number }),
    onToolCall: async (call) => tools.execute(call),
  });

  return {
    adapter,
    exporters,
    memory,
    schemaValidator,
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
  };
}

/**
 * Warm the tiktoken WASM by encoding an empty message so the first real
 * request doesn't pay a cold-start latency penalty. No-op for any other
 * tokenizer configuration.
 */
export function warmTiktokenIfNeeded(config: HarnessConfig): void {
  if (config.tokenizer !== 'tiktoken') return;
  try {
    const model = config.model ?? 'gpt-4';
    countTokens(model, [{ role: 'user', content: '' }]);
  } catch {
    /* noop: lazy loading will still work on first real call */
  }
}
