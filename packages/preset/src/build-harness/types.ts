/**
 * Public type surface for the preset package.
 *
 * Extracted from `../index.ts` so the giant `createHarness()` body can live in
 * its own module (`./run.ts`) without dragging the type declarations along.
 * Every symbol exported here is re-exported from `../index.ts`, so the
 * package's public API is unchanged.
 *
 * @module
 */

import type { AgentAdapter, Message, AgentEvent, MiddlewareChain, AgentLoop } from 'harness-one/core';
import type { TraceExporter, TraceManager, CostTracker, ModelPricing, Logger } from 'harness-one/observe';
import type { PromptBuilder } from 'harness-one/prompt';
import type { ToolRegistry, SchemaValidator } from 'harness-one/tools';
import type { GuardrailPipeline } from 'harness-one/guardrails';
import type { SessionManager, ConversationStore } from 'harness-one/session';
import type { MemoryStore } from 'harness-one/memory';
import type { EvalRunner } from '@harness-one/devkit';

import type { AnthropicAdapterConfig } from '@harness-one/anthropic';
import type { OpenAIAdapterConfig } from '@harness-one/openai';

import type { LangfuseExporterConfig } from '@harness-one/langfuse';
import type { RedisStoreConfig } from '@harness-one/redis';

/**
 * Default timeout (ms) applied to adapter calls when `HarnessConfigBase.adapterTimeoutMs`
 * is not provided. Wave-13 F-2: previously `createAgentLoop` received no
 * `adapterTimeoutMs`, so a hanging provider would stall requests until the
 * caller's AbortSignal fired (or forever). 60s is a conservative default that
 * errs on the side of letting slow-but-legitimate provider responses through
 * while still bounding the blast radius of a silent upstream hang.
 */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 60_000;

/**
 * Default timeout (ms) for {@link Harness.drain}.
 *
 * Wave-13 F-6: the `drain()` signature previously hid its default in the
 * implementation; callers who wanted to log or compare the value had to know
 * the magic number. Exporting it removes that footgun and keeps the signature
 * honest.
 */
export const DRAIN_DEFAULT_TIMEOUT_MS = 30_000;

/** Shared configuration fields for all providers. */
export interface HarnessConfigBase {
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
  /**
   * Maximum time in milliseconds any single adapter call is allowed to run
   * before being aborted with `CORE_TIMEOUT`. Wave-13 F-2: defaults to
   * {@link DEFAULT_ADAPTER_TIMEOUT_MS} (60_000 ms) when omitted — the prior
   * behavior of "unlimited" silently cascaded provider hangs into caller
   * latency budgets. Set explicitly (including to a very large value) to
   * override; do not pass `0` — that disables the timeout in the underlying
   * AgentLoop and restores the pre-Wave-13 unbounded behavior.
   */
  readonly adapterTimeoutMs?: number;

  /**
   * Guardrail config.
   *
   * P1-14 (Wave-12): all nested option bags and arrays are deeply `readonly` so
   * the shape matches the runtime contract (config is consumed immutably).
   * Attempting `config.guardrails.rateLimit.max = 0` or
   * `config.guardrails.contentFilter.blocked.push(...)` is a TypeScript
   * error, preventing accidental post-construction mutation that would
   * otherwise bypass the integer / shape validation performed by
   * `createHarness()`.
   */
  readonly guardrails?: {
    readonly injection?: boolean | { readonly sensitivity?: 'low' | 'medium' | 'high' };
    readonly rateLimit?: { readonly max: number; readonly windowMs: number };
    readonly contentFilter?: { readonly blocked?: readonly string[] };
    readonly pii?:
      | boolean
      | {
          readonly types?: readonly (
            | 'email'
            | 'phone'
            | 'ssn'
            | 'creditCard'
            | 'apiKey'
            | 'ipv4'
            | 'privateKey'
          )[];
        };
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
  /**
   * Wave-13 F-4: optional discriminator tag for the {@link HarnessConfig}
   * union. When set to `'anthropic'`, a TypeScript `switch` over `type`
   * narrows the config cleanly instead of relying on the `provider` field
   * alone. Kept optional to preserve backwards compatibility with callers
   * who only set `provider`.
   */
  readonly type?: 'anthropic';
  readonly provider: 'anthropic';
  /** Anthropic client instance. */
  readonly client: AnthropicAdapterConfig['client'];
}

/** Configuration for creating a full Harness instance with OpenAI. */
export interface OpenAIHarnessConfig extends HarnessConfigBase {
  /**
   * Wave-13 F-4: optional discriminator tag for the {@link HarnessConfig}
   * union. When set to `'openai'`, narrowing works via the `type` field. See
   * {@link AnthropicHarnessConfig.type}.
   */
  readonly type?: 'openai';
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
 *
 * @internal
 *
 * P2-17 (Wave-12): `AdapterHarnessConfig` ships in the public barrel so the
 * {@link HarnessConfig} union resolves cleanly, but the interface itself is
 * considered internal — it exposes the {@link AgentAdapter} type directly and
 * couples callers to a type that is subject to change. Prefer the
 * `{ adapter }` literal form shown above; api-extractor will mark this shape
 * as `@internal` in the report.
 */
export interface AdapterHarnessConfig extends HarnessConfigBase {
  /**
   * Wave-13 F-4: optional discriminator tag for the {@link HarnessConfig}
   * union. When set to `'adapter'`, narrowing works via the `type` field.
   */
  readonly type?: 'adapter';
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
   *   When omitted an auto-generated id of the form `session_<uuid>` is used
   *   — see `options.onSessionId` to recover it. A warning is logged the
   *   first time an auto-generated id is used; pass a per-request id
   *   (e.g., a user id) to isolate conversation histories and enable resume.
   * @param options.onSessionId - Optional callback invoked synchronously,
   *   before the first event is yielded, with the effective session id
   *   (either the caller-provided value or the auto-generated id). P1-20
   *   (Wave-12): without this hook callers had no way to observe the
   *   auto-generated id and therefore could not resume the conversation
   *   on a subsequent call.  The callback is invoked exactly once per
   *   `run()` invocation; any exception it throws is logged and swallowed
   *   so the loop is not interrupted.
   */
  run(
    messages: Message[],
    options?: {
      sessionId?: string;
      onSessionId?: (sessionId: string) => void;
    },
  ): AsyncGenerator<AgentEvent>;

  /**
   * Eagerly warm trace exporters and tokenizer.
   *
   * Optional; calling {@link Harness.run} before `initialize()` works
   * (exporters initialize lazily on first export, and the tokenizer
   * registers on first use). Useful for fail-fast startup where
   * connection / registration failures should surface at boot rather
   * than mid-request.
   *
   * Idempotent: concurrent and repeat calls share a single in-flight
   * promise via an internal latch, so exporters are only warmed once.
   *
   * Implementation details (ARCH-007): awaits `TraceManager.initialize()`,
   * which fans out to every exporter that declares an `initialize()`
   * hook; additionally forces the tiktoken WASM module to load when
   * `config.tokenizer === 'tiktoken'` by encoding a dummy string. Failures
   * at this step are non-fatal — the per-exporter `isHealthy` gate still
   * governs subsequent exports.
   *
   * @returns A promise that resolves once all exporters and the tokenizer
   *   have been warmed (or resolved to "warmed in the background" with a
   *   logged warning on failure).
   */
  initialize?(): Promise<void>;

  /**
   * Shut down all services.
   *
   * Wave-13 F-1: explicitly required on the public interface (not duck-typed
   * on the factory return). Every implementation of {@link Harness} MUST
   * provide a resource-releasing `shutdown()` so callers can write defensive
   * signal handlers that work across Harness variants.
   */
  shutdown(): Promise<void>;

  /**
   * Abort the running loop and shut down all services gracefully.
   *
   * Wave-13 F-6: when omitted, falls back to {@link DRAIN_DEFAULT_TIMEOUT_MS}
   * (30_000 ms). The default is exported alongside this interface so callers
   * can reference it without repeating the literal.
   */
  drain(timeoutMs?: number): Promise<void>;
}
