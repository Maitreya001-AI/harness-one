/**
 * @harness-one/openai — adapter factory.
 *
 * Owns `OpenAIAdapterConfig`, the `createOpenAIAdapter` factory and the
 * per-instance / legacy-global zero-usage warn-once bookkeeping. Composes the
 * conversion helpers from `./convert.js` and (transitively) consumes the
 * provider registry exposed by `./providers.js`.
 *
 * @module
 */

import OpenAI from 'openai';
import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
  Message,
} from 'harness-one/core';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import type { Logger } from 'harness-one/observe';
import { createDefaultLogger, isWarnActive } from 'harness-one/observe';
import { MAX_TOOL_ARG_BYTES, MAX_TOOL_CALLS } from 'harness-one/advanced';

import {
  filterExtra,
  toHarnessMessage,
  toOpenAIMessage,
  toOpenAIParameters,
  toOpenAITool,
  toTokenUsage,
  _resetConvertWarnState,
} from './convert.js';

/** Configuration for the OpenAI adapter. */
export interface OpenAIAdapterConfig {
  /** A pre-configured OpenAI client instance. Takes precedence over apiKey/baseURL. */
  readonly client?: OpenAI;
  /** API key. Defaults to OPENAI_API_KEY env var. Used when client is not provided. */
  readonly apiKey?: string;
  /** Base URL for OpenAI-compatible APIs (e.g. Groq, DeepSeek). Used when client is not provided. */
  readonly baseURL?: string;
  /** Default HTTP headers. Used when client is not provided. */
  readonly defaultHeaders?: Record<string, string>;
  /** Model name. Defaults to 'gpt-4o'. */
  readonly model?: string;
  /**
   * Maximum number of retries for transient errors (429, 5xx).
   * Passed to the OpenAI SDK client at creation time. Defaults to 2 (SDK default).
   */
  readonly maxRetries?: number;
  /**
   * Optional logger used for non-fatal adapter warnings (e.g. missing token
   * usage in a stream chunk, malformed tool arguments). Defaults to the
   * global `console` if not provided. Library code SHOULD NOT write directly
   * to `console` — accept a logger so hosts can route/silence warnings.
   */
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
  /**
   * When true, any key in `LLMConfig.extra` that is not in the adapter's
   * allow-list raises `HarnessError { code: HarnessErrorCode.ADAPTER_INVALID_EXTRA }` instead
   * of being silently filtered-with-warn. Intended for prod builds that want
   * provider-parameter drift to fail loudly in CI. Defaults to `false`.
   */
  readonly strictExtraAllowList?: boolean;
  /**
   * Optional token counting function. When provided, `countTokens()` delegates
   * to this function instead of the built-in heuristic. Useful for injecting
   * a tiktoken-based counter without coupling the adapter to the tokenizer package.
   */
  readonly countTokens?: (text: string) => number;
  /**
   * Per-stream safety caps enforced inside the adapter's stream pump.
   * Unbounded tool-call count or argument size is a memory-exhaustion vector
   * for long-running streams. Defaults match the shared
   * `harness-one/advanced` constants (`MAX_TOOL_ARG_BYTES` / `MAX_TOOL_CALLS`)
   * so `createAgentLoop({ limits: { maxToolArgBytes } })` and the adapter
   * see the same budget out of the box. Override per-factory when running
   * on constrained hosts.
   */
  readonly streamLimits?: {
    readonly maxToolCalls?: number;
    readonly maxToolArgBytes?: number;
  };
}

/**
 * Wave-13 G-1 (P0-3): per-instance zero-usage warn-once dedupe.
 *
 * Prior to Wave-13 this was a single module-scoped `Set` shared by every
 * adapter instance in the process. In multi-tenant deployments that meant
 * tenant A's warning silenced tenant B's alert for the same model name — an
 * observability hole that made cost-tracking drift between tenants invisible.
 *
 * The factory below creates a fresh bounded LRU set per `createOpenAIAdapter`
 * call, sized at `_ZERO_USAGE_WARN_CAP` (1000 — larger than before because the
 * dedupe is no longer shared, so per-instance models accumulate more slowly).
 */
const _ZERO_USAGE_WARN_CAP = 1_000;

interface InstanceWarnedState {
  has(model: string): boolean;
  record(model: string): void;
}

function createInstanceWarnedState(cap = _ZERO_USAGE_WARN_CAP): InstanceWarnedState {
  const warned = new Set<string>();
  return {
    has(model: string): boolean {
      return warned.has(model);
    },
    record(model: string): void {
      if (warned.has(model)) return;
      if (warned.size >= cap) {
        // LRU behavior: evict oldest insertion when at capacity.
        const oldest = warned.values().next().value;
        if (oldest !== undefined) warned.delete(oldest);
      }
      warned.add(model);
    },
  };
}

/**
 * Wave-12 P0-2: guarded narrow on the OpenAI SDK stream's private
 * `controller` field.
 *
 * The SDK exposes its underlying `AbortController`-like object via a
 * `controller` property on the stream instance. Reaching for it used to be
 * done with a pair of `as unknown as T` casts, which silently type-launders
 * any shape the SDK might ship in a future minor — a refactor that could
 * turn into a runtime `TypeError` on the very next `.abort()` call.
 *
 * This helper instead probes the runtime shape step-by-step and returns
 * `undefined` whenever the expected structure isn't present. No raw
 * `as unknown as T` is used in the cleanup path.
 */
function getStreamController(s: unknown): { abort?: () => void } | undefined {
  if (typeof s !== 'object' || s === null) return undefined;
  const c = (s as Record<string, unknown>).controller;
  if (typeof c !== 'object' || c === null) return undefined;
  return c as { abort?: () => void };
}

/**
 * Create an AgentAdapter backed by the OpenAI SDK.
 *
 * Supports chat(), stream(), and tool_calls handling.
 */
export function createOpenAIAdapter(config: OpenAIAdapterConfig): AgentAdapter {
  const client: OpenAI = config.client ?? new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: config.defaultHeaders,
    maxRetries: config.maxRetries,
  });
  const model = config.model ?? 'gpt-4o';
  const strictExtra = config.strictExtraAllowList === true;
  // Wave-5F T12: delegate default logger to core's redaction-enabled
  // singleton instead of a hand-rolled console.warn/error fallback.
  const logger: Pick<Logger, 'warn' | 'error'> = config.logger ?? createDefaultLogger();
  const tokenizer = config.countTokens;
  const maxToolCalls = config.streamLimits?.maxToolCalls ?? MAX_TOOL_CALLS;
  const maxToolArgBytes = config.streamLimits?.maxToolArgBytes ?? MAX_TOOL_ARG_BYTES;
  // Wave-13 G-1 (P0-3): per-instance zero-usage warned-models LRU. Scoped
  // to this adapter instance so a single tenant's "rare model" warn does
  // not silence every other tenant's first-touch alert for the same model.
  const zeroUsageWarned = createInstanceWarnedState();

  return {
    name: `openai:${model}`,
    async chat(params: ChatParams): Promise<ChatResponse> {
      const response = await client.chat.completions.create({
        model,
        messages: params.messages.map(toOpenAIMessage),
        ...(params.tools && { tools: params.tools.map((t) => toOpenAITool(t, logger)) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.maxTokens !== undefined && { max_tokens: params.config.maxTokens }),
        ...(params.config?.stopSequences !== undefined && { stop: params.config.stopSequences as string[] }),
        ...(params.responseFormat?.type === 'json_object' && { response_format: { type: 'json_object' as const } }),
        ...(params.responseFormat?.type === 'json_schema' && {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: 'response',
              schema: toOpenAIParameters(params.responseFormat.schema, logger),
              ...(params.responseFormat.strict !== undefined && { strict: params.responseFormat.strict }),
            },
          },
        }),
        // Spec: LLMConfig.extra MUST be forwarded to the provider. Merge LAST
        // so caller-supplied unknown keys win over base params (per provider-spec.md).
        // T06: filtered against OPENAI_EXTRA_ALLOW_LIST; unknown keys are
        // dropped-with-warn, or raise ADAPTER_INVALID_EXTRA under strictExtra.
        ...filterExtra(params.config?.extra, strictExtra, logger),
      }, { signal: params.signal });

      const choice = response.choices[0];
      if (!choice) {
        throw new HarnessError('OpenAI returned no choices', HarnessErrorCode.ADAPTER_ERROR, 'Check if the model and API key are valid');
      }

      // SPEC-015: warn once per model when non-stream usage data is missing.
      // Wave-13 G-1: dedupe is scoped to this adapter instance via
      // `zeroUsageWarned`, not to the whole module.
      const usage = response.usage;
      const missingInput = usage?.prompt_tokens === undefined || usage?.prompt_tokens === null;
      const missingOutput = usage?.completion_tokens === undefined || usage?.completion_tokens === null;
      if ((missingInput || missingOutput) && !zeroUsageWarned.has(model)) {
        // Guard the warn metadata behind the shared `isWarnActive()` probe
        // exposed by `harness-one/observe` so both adapters treat
        // level-aware loggers consistently.
        if (isWarnActive(logger)) {
          zeroUsageWarned.record(model);
          logger.warn(
            `[harness-one/openai] chat() response for model "${model}" had missing prompt/completion token counts — cost tracking will under-report. (This warning is emitted once per model per adapter instance.)`,
          );
        }
      }

      return {
        message: toHarnessMessage(choice),
        usage: toTokenUsage(usage),
      };
    },

    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const stream = await client.chat.completions.create({
        model,
        messages: params.messages.map(toOpenAIMessage),
        ...(params.tools && { tools: params.tools.map((t) => toOpenAITool(t, logger)) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.maxTokens !== undefined && { max_tokens: params.config.maxTokens }),
        ...(params.config?.stopSequences !== undefined && { stop: params.config.stopSequences as string[] }),
        ...(params.responseFormat?.type === 'json_object' && { response_format: { type: 'json_object' as const } }),
        ...(params.responseFormat?.type === 'json_schema' && {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: 'response',
              schema: toOpenAIParameters(params.responseFormat.schema, logger),
              ...(params.responseFormat.strict !== undefined && { strict: params.responseFormat.strict }),
            },
          },
        }),
        stream: true,
        stream_options: { include_usage: true },
        // Spec: LLMConfig.extra MUST be forwarded to the provider. Merge LAST
        // so caller-supplied unknown keys win over base params.
        // T06: filtered against OPENAI_EXTRA_ALLOW_LIST; unknown keys are
        // dropped-with-warn, or raise ADAPTER_INVALID_EXTRA under strictExtra.
        ...filterExtra(params.config?.extra, strictExtra, logger),
      }, { signal: params.signal });

      const toolCallAccum = new Map<
        string,
        { id: string; name: string; arguments: string }
      >();
      // Secondary map: index -> ID, so continuation chunks without an id field
      // can be resolved to the correct accumulator entry via their positional index.
      const indexToId = new Map<number, string>();

      try {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            yield { type: 'text_delta', text: delta.content };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              // Determine the lookup key: prefer tc.id, fall back to index-to-ID map,
              // and finally generate a fallback ID from the index.
              const id = tc.id ?? indexToId.get(tc.index) ?? `tool_${tc.index}`;

              // Skip new tool calls beyond the safety limit
              if (toolCallAccum.size >= maxToolCalls && !toolCallAccum.has(id)) {
                continue;
              }

              let accum = toolCallAccum.get(id);
              if (!accum) {
                accum = { id, name: '', arguments: '' };
                toolCallAccum.set(id, accum);
              }
              // Update the index-to-ID mapping whenever we see an id for an index
              if (tc.id) {
                indexToId.set(tc.index, tc.id);
                accum.id = tc.id;
              }
              if (tc.function?.name) accum.name = tc.function.name;
              if (tc.function?.arguments) {
                // Skip arguments that would exceed the size limit
                if (accum.arguments.length + tc.function.arguments.length > maxToolArgBytes) {
                  continue;
                }
                accum.arguments += tc.function.arguments;
              }

              yield {
                type: 'tool_call_delta',
                toolCall: {
                  ...(accum.id ? { id: accum.id } : {}),
                  ...(accum.name ? { name: accum.name } : {}),
                  ...(tc.function?.arguments !== undefined && { arguments: tc.function.arguments }),
                },
              };
            }
          }

          // OpenAI sends usage data in the final stream chunk.
          // We emit 'done' and return immediately upon receiving it.
          // If OpenAI changes this behavior (e.g., sends usage before final chunk),
          // subsequent chunks would be silently dropped — review this logic if that happens.
          if (chunk.usage) {
            yield { type: 'done', usage: toTokenUsage(chunk.usage) };
            return; // usage chunk is the final event — don't emit another done
          }
        }

        // Only emit bare done if stream ended without a usage chunk.
        // OBS-011: Emit both a warning and a tagged event so cost tracking can
        // detect this condition. Ensure stream_options.include_usage is set to
        // true in the request to guarantee usage data in the final chunk.
        logger.warn(
          '[harness-one/openai] Stream ended without usage data — token counts will be zero. ' +
          'Ensure stream_options.include_usage is true. This affects cost tracking and budget enforcement.',
        );
        yield {
          type: 'done' as const,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      } finally {
        // Ensure underlying stream resources are released on early consumer return.
        // The OpenAI SDK stream exposes a controller that can be aborted to free
        // the HTTP connection when the consumer breaks out of the async iterator.
        //
        // Wave-12 P0-2: replace the previous double-`as unknown as` casts with a
        // guarded narrow (`getStreamController`) so SDK drift — e.g. a rename,
        // removal, or type change of the private `controller` field — surfaces
        // as a safe no-op rather than a silent type-lie that would explode at
        // runtime the next time we dereference it.
        try {
          const ctrl = getStreamController(stream);
          if (ctrl && typeof ctrl.abort === 'function') {
            ctrl.abort();
          }
        } catch {
          // Stream controller cleanup failed — HTTP connection may linger until server timeout.
          // This is non-fatal; the GC will eventually collect the stream.
        }
      }
    },

    async countTokens(messages: readonly Message[]): Promise<number> {
      const text = messages.map((m) => m.content).join('');
      if (tokenizer) return tokenizer(text);
      // Heuristic: ~4 chars per token + small overhead per message for role/framing
      return Math.ceil(text.length / 4) + messages.length * 4;
    },
  };
}

/**
 * Test-only: reset the module-scoped "zero-usage warn once" dedupe sets.
 *
 * Library consumers should NOT need to call this. It exists so unit tests can
 * exercise the one-time-warn behaviour across multiple `it()` cases without
 * leaking state between tests.
 *
 * Wave-12 extends this to also clear the `toOpenAIParameters` unknown-key
 * warn-once dedupe (P2-19) so schema-drift tests stay hermetic.
 *
 * @internal
 */
export function _resetOpenAIWarnState(): void {
  // Wave-13 G-1: per-instance warned state is no longer reachable from outside
  // the factory closure, so this helper only clears the module-scoped caches
  // that still exist (the unknown-schema-key dedupe in `convert.ts`). Tests
  // that need to re-exercise per-instance dedupe behaviour should create a
  // fresh adapter.
  _resetConvertWarnState();
}
