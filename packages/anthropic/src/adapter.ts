/**
 * Anthropic adapter factory.
 *
 * This file owns the `createAnthropicAdapter` factory plus its config
 * interface. Pure conversion helpers (message / tool / schema / usage) live
 * in `./convert.ts`; `./index.ts` is a thin barrel exposing only the public
 * surface.
 *
 * @module
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
  Message,
} from 'harness-one/core';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import { createDefaultLogger, isWarnActive, type Logger } from 'harness-one/observe';
import { MAX_TOOL_ARG_BYTES, MAX_TOOL_CALLS } from 'harness-one/advanced';

// Re-export for backward compat — anthropic/convert.ts still imports from the
// adapter module. The canonical home is now `harness-one/observe`.
export { isWarnActive };

import {
  filterExtra,
  toAnthropicMessage,
  toAnthropicTool,
  extractSystem,
  toTokenUsage,
  toHarnessMessage,
  applyResponseFormat,
  buildSystemParam,
  buildThinkingRequest,
  withLastMessageCacheControl,
  isAbortError,
  normalizeAnthropicError,
} from './convert.js';

/**
 * A stream chunk that may additionally carry a redacted-thinking payload.
 * The public `StreamChunk` type predates the `redactedData` carrier field that
 * `StreamAggregator` already consumes (its `StreamAggregatorChunk.redactedData`)
 * — we attach it structurally and widen back to `StreamChunk` at the yield
 * boundary. See docs/provider-spec.md §"stream(params)" (`thinking_delta`).
 */
type ThinkingStreamChunk = StreamChunk & { readonly redactedData?: string };

/**
 * Policy for how the adapter reacts when an assistant `toolCalls[].arguments`
 * string is not parseable as a JSON object.
 *
 * - `'warn'` (default): emit `logger.warn(...)`, substitute an empty
 *   object, continue.
 * - `'throw'`: throw `HarnessError(ADAPTER_ERROR)` with the raw argument
 *   string preserved on the error's `context` via its message (head+tail
 *   preview for payloads over 400 chars). Fail fast for operators who
 *   would rather observe malformed LLM output than mask it.
 * - Custom callback: receive `(raw, err)` and return one of:
 *     * A `Record<string, unknown>` — used verbatim as the replacement
 *       `tool_use.input`.
 *     * `null` — explicitly requests the empty-object default (`{}`). Useful
 *       when the callback wants to suppress the throw for specific error
 *       shapes while still producing a sane payload for the provider.
 *     * `undefined` — defer to the default policy (throw
 *       `HarnessError(ADAPTER_ERROR)`). Treat `undefined` as "I couldn't
 *       decide; do what `'throw'` would have done". This mirrors the
 *       language-level convention that `undefined` returns mean "the function
 *       had nothing to say" — callers who do want the empty-object fallback
 *       MUST return `null` explicitly.
 *
 * Note: `null` and `undefined` mean different things. `null` requests
 * the empty-object default; `undefined` defers to the default throw
 * policy. Return `null` explicitly if you want the `{}` substitution.
 */
export type AnthropicMalformedToolUsePolicy =
  | 'warn'
  | 'throw'
  | ((raw: string, err: Error) => Record<string, unknown> | null | undefined);

/**
 * Shape that some Logger implementations optionally expose so adapters can
 * skip building warn-level metadata payloads when the configured level would
 * drop them anyway. We feature-detect this at runtime and never hard-require
 * it, to keep the `Pick<Logger, 'warn' | 'error'>` surface minimal for
 * consumers. Kept here for documentation purposes; the runtime probe lives in
 * `harness-one/observe`'s `isWarnActive`.
 */
export interface MaybeLevelAwareLogger {
  readonly isWarnEnabled?: () => boolean;
}

/**
 * Opt-in prompt-cache breakpoint placement for the Anthropic adapter.
 *
 * Anthropic activates prompt caching only when a request carries a
 * `cache_control: { type: 'ephemeral' }` breakpoint. This is an
 * adapter-specific extension (not part of the cross-provider `AgentAdapter`
 * contract) — leaving it `undefined` preserves the previous behaviour
 * (no caching, no request-shape change). See docs/provider-spec.md
 * §"Prompt caching (optional)".
 */
export interface AnthropicPromptCachingConfig {
  /**
   * When `true`, emit the system prompt as a content-block array with a
   * `cache_control` breakpoint on the last system block, making the system
   * prompt a reusable cache prefix.
   */
  readonly system?: boolean;
  /**
   * When `true`, set a `cache_control` breakpoint on the last content block of
   * the final message. In an agent loop this makes the entire growing
   * conversation prefix cacheable turn-over-turn.
   */
  readonly lastMessage?: boolean;
}

/**
 * Opt-in extended-thinking configuration (RFC-0001). When set, the adapter
 * requests Anthropic extended thinking
 * (`thinking: { type: 'enabled', budget_tokens }`) on every chat() /
 * stream() call, and parses the resulting `thinking` / `redacted_thinking`
 * response blocks into `Message.blocks`.
 *
 * Anthropic constraints (enforced/behavioural):
 * - `config.maxTokens` MUST be greater than `budgetTokens` (validated — a
 *   `HarnessError(CORE_INVALID_CONFIG)` is thrown before the request when a
 *   per-call `maxTokens` is set and not greater). When `maxTokens` is left
 *   unset the adapter default (4096) applies, so keep `budgetTokens` below it
 *   or set `maxTokens` explicitly.
 * - Temperature must be left at its default when thinking is enabled; the
 *   adapter forwards `config.temperature` as-is and lets the provider reject
 *   an incompatible value rather than silently dropping it.
 */
export interface AnthropicThinkingConfig {
  /** Token budget reserved for extended-thinking reasoning. */
  readonly budgetTokens: number;
}

/** Configuration for the Anthropic adapter. */
export interface AnthropicAdapterConfig {
  /** A pre-configured Anthropic client instance. */
  readonly client: Anthropic;
  /** Model name. Defaults to 'claude-sonnet-4-20250514'. */
  readonly model?: string;
  /**
   * Optional logger used for non-fatal adapter warnings (e.g. malformed
   * tool_use JSON from the model). Defaults to the harness-one default
   * logger if not provided. Library code SHOULD NOT write directly to
   * `console` — accept a logger so hosts can route/silence warnings.
   */
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
  /**
   * When `true`, unknown keys in `LLMConfig.extra` cause `chat()` / `stream()`
   * to throw `HarnessError(HarnessErrorCode.ADAPTER_INVALID_EXTRA)` before
   * contacting the provider. Defaults to `false` — unknown keys are silently
   * filtered and reported via a single `safeWarn` emission so the caller can
   * notice without breaking their pipeline.
   */
  readonly strictExtraAllowList?: boolean;
  /**
   * Policy for handling malformed / non-object tool_use input strings
   * returned by the LLM. Defaults to `'warn'` for backwards compatibility
   * (warn + substitute `{}`). Set to `'throw'` to fail fast, or provide a
   * callback to produce a custom replacement object.
   *
   * Callback return-value semantics:
   *   - `Record<string, unknown>` — used verbatim as the replacement input.
   *   - `null` — substitute empty object `{}` (previous behaviour).
   *   - `undefined` — defer to the default `'throw'` policy, as if the
   *     caller had configured `'throw'`. Use this to fail fast on specific
   *     cases without writing a throw inside the callback.
   *
   * See {@link AnthropicMalformedToolUsePolicy}.
   */
  readonly onMalformedToolUse?: AnthropicMalformedToolUsePolicy;
  /**
   * Optional token counting function. When provided, `countTokens()`
   * delegates to this function instead of the built-in heuristic. Useful for
   * injecting a tiktoken-based counter without coupling the adapter to the
   * tokenizer package.
   */
  readonly countTokens?: (text: string) => number;
  /**
   * Per-stream safety caps enforced inside the adapter's stream pump.
   * Unbounded tool-call count or argument size is a memory-exhaustion vector
   * for long-running streams, so the adapter keeps a pre-aggregation limit
   * even when the loop-level `StreamAggregator` would catch the same
   * condition later. Defaults match the `harness-one/advanced` shared
   * constants (`MAX_TOOL_ARG_BYTES` / `MAX_TOOL_CALLS`) so
   * `createAgentLoop({ limits: { maxToolArgBytes } })` and the adapter see
   * the same budget out of the box. Provide your own values to pre-truncate
   * earlier on constrained deployments.
   */
  readonly streamLimits?: {
    readonly maxToolCalls?: number;
    readonly maxToolArgBytes?: number;
  };
  /**
   * Opt-in prompt-cache breakpoint placement. Defaults to `undefined` (off) —
   * no `cache_control` markers are emitted and the request shape is unchanged.
   * Enable `system` and/or `lastMessage` to activate Anthropic prompt caching
   * so `TokenUsage.cacheReadTokens` / `cacheWriteTokens` become non-zero.
   * See {@link AnthropicPromptCachingConfig}.
   */
  readonly promptCaching?: AnthropicPromptCachingConfig;
  /**
   * Opt-in extended thinking (RFC-0001). Defaults to `undefined` (off) — no
   * `thinking` request param is sent and the request shape is unchanged.
   * See {@link AnthropicThinkingConfig}.
   */
  readonly thinking?: AnthropicThinkingConfig;
}

/**
 * Create an AgentAdapter backed by the Anthropic SDK.
 *
 * Supports chat(), stream(), and full tool_use handling.
 *
 * @example
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk';
 * import { createAnthropicAdapter } from '@harness-one/anthropic';
 * import { createAgentLoop } from 'harness-one';
 *
 * const adapter = createAnthropicAdapter({
 *   client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
 *   model: 'claude-sonnet-4-20250514',
 * });
 * const loop = createAgentLoop({ adapter, maxIterations: 10 });
 * ```
 */
export function createAnthropicAdapter(config: AnthropicAdapterConfig): AgentAdapter {
  const { client } = config;
  const model = config.model ?? 'claude-sonnet-4-20250514';
  const logger: Pick<Logger, 'warn' | 'error'> = config.logger ?? createDefaultLogger();
  const strictExtra = config.strictExtraAllowList ?? false;
  const tokenizer = config.countTokens;
  const malformedPolicy: AnthropicMalformedToolUsePolicy = config.onMalformedToolUse ?? 'warn';
  const maxToolCalls = config.streamLimits?.maxToolCalls ?? MAX_TOOL_CALLS;
  const maxToolArgBytes = config.streamLimits?.maxToolArgBytes ?? MAX_TOOL_ARG_BYTES;
  const cacheSystem = config.promptCaching?.system === true;
  const cacheLastMessage = config.promptCaching?.lastMessage === true;
  const thinkingBudget = config.thinking?.budgetTokens;

  /**
   * Convert harness-one messages to Anthropic message params, optionally
   * setting a `cache_control` breakpoint on the last content block of the
   * final message (opt-in via `promptCaching.lastMessage`).
   */
  const buildMessageParams = (rest: readonly Message[]): Anthropic.MessageParam[] => {
    const messages = rest.map((m) => toAnthropicMessage(m, logger, malformedPolicy));
    if (cacheLastMessage && messages.length > 0) {
      const lastIdx = messages.length - 1;
      messages[lastIdx] = withLastMessageCacheControl(messages[lastIdx]);
    }
    return messages;
  };

  return {
    name: `anthropic:${model}`,
    async chat(params: ChatParams): Promise<ChatResponse> {
      const { system, rest } = extractSystem(params.messages);

      // Fold responseFormat (json_object / json_schema) into the system prompt
      // — Anthropic has no native JSON mode. `text` / undefined is a no-op.
      const effectiveSystem = applyResponseFormat(system, params.responseFormat);
      // Optionally mark the system prompt as a cacheable prefix.
      const systemParam = buildSystemParam(effectiveSystem, cacheSystem);

      // Build the extended-thinking request fragment (validates maxTokens >
      // budgetTokens before any network call).
      const thinkingRequest = buildThinkingRequest(thinkingBudget, params.config?.maxTokens);

      // Filter `extra` against Anthropic allow-list BEFORE spreading. Under
      // strict mode this throws before any network call.
      const safeExtra = filterExtra(params.config?.extra, strictExtra, config.logger);

      try {
        const response = await client.messages.create({
          model,
          max_tokens: params.config?.maxTokens ?? 4096,
          ...(systemParam !== undefined && { system: systemParam }),
          messages: buildMessageParams(rest),
          ...(params.tools && { tools: params.tools.map((t) => toAnthropicTool(t, logger)) }),
          ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
          ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
          ...(params.config?.stopSequences !== undefined && { stop_sequences: params.config.stopSequences as string[] }),
          // Extended thinking (opt-in) — merged before extra so a caller can
          // still override via LLMConfig.extra if they must.
          ...(thinkingRequest ?? {}),
          // LLMConfig.extra MUST be forwarded to the provider. Merge LAST so
          // caller-supplied keys win over base params (per provider-spec.md).
          // Only allow-listed keys are forwarded.
          ...(safeExtra ?? {}),
        }, { signal: params.signal });

        if (!response.content || response.content.length === 0) {
          throw new HarnessError(
            'Anthropic API returned empty content',
            HarnessErrorCode.ADAPTER_ERROR,
            'Check if the model and API key are valid',
          );
        }

        return {
          message: toHarnessMessage(response),
          usage: toTokenUsage(response.usage),
        };
      } catch (err) {
        // Preserve abort semantics: rethrow the raw abort error unchanged so
        // `loop.abort()` keeps behaving exactly as before this wrapper existed.
        if (isAbortError(err, params.signal)) throw err;
        // Map every other provider / network error to a typed HarnessError
        // (spec §"Error mapping"). Already-normalized HarnessErrors — e.g. the
        // empty-content guard above or the strict-extra throw — pass through.
        throw normalizeAnthropicError(err, 'chat');
      }
    },

    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const { system, rest } = extractSystem(params.messages);

      // Same responseFormat + prompt-cache treatment as chat() (spec parity).
      const effectiveSystem = applyResponseFormat(system, params.responseFormat);
      const systemParam = buildSystemParam(effectiveSystem, cacheSystem);

      // Extended thinking (validates maxTokens > budgetTokens before network).
      const thinkingRequest = buildThinkingRequest(thinkingBudget, params.config?.maxTokens);

      const safeExtra = filterExtra(params.config?.extra, strictExtra, config.logger);

      // Terminal chunk emitted when the stream is aborted mid-flight, so
      // downstream iteration terminates cleanly instead of throwing.
      const abortDone: StreamChunk = {
        type: 'done',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };

      // Wrap the whole stream lifecycle — setup, iteration, and finalMessage()
      // — so raw SDK / network errors surface as typed HarnessErrors (spec
      // §"Error mapping") instead of propagating un-normalized. Abort at any
      // point yields a terminal zero-usage done chunk (unchanged semantics).
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: params.config?.maxTokens ?? 4096,
          ...(systemParam !== undefined && { system: systemParam }),
          messages: buildMessageParams(rest),
          ...(params.tools && { tools: params.tools.map((t) => toAnthropicTool(t, logger)) }),
          ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
          ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
          ...(params.config?.stopSequences !== undefined && { stop_sequences: params.config.stopSequences as string[] }),
          ...(thinkingRequest ?? {}),
          ...(safeExtra ?? {}),
        }, { signal: params.signal });

        let currentToolId: string | undefined;
        let currentToolName: string | undefined;

        // Safety limits to prevent OOM from malformed streams. Defaults to the
        // shared `MAX_TOOL_CALLS` / `MAX_TOOL_ARG_BYTES` constants (parity with
        // the OpenAI adapter and with core's StreamAggregator); callers can
        // tighten per-factory via `streamLimits` when running on constrained
        // hosts.
        let toolCallCount = 0;
        let currentToolArgBytes = 0;
        let currentToolLimitExceeded = false;

        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            // Duck-type the block: `thinking` / `redacted_thinking` postdate the
            // `>=0.30` SDK peer floor, so `content_block.type` may not include
            // them in the compiled union.
            const block = event.content_block as {
              type: string;
              id?: string;
              name?: string;
              data?: string;
            };
            if (block.type === 'tool_use') {
              toolCallCount++;
              currentToolArgBytes = 0;
              currentToolLimitExceeded = false;
              if (toolCallCount > maxToolCalls) {
                currentToolId = undefined;
                currentToolName = undefined;
                currentToolLimitExceeded = true;
              } else {
                currentToolId = block.id;
                currentToolName = block.name;
              }
            } else {
              // Any non-tool_use block (text / thinking / redacted_thinking)
              // ends the current tool-call accumulation.
              currentToolId = undefined;
              currentToolName = undefined;
              currentToolLimitExceeded = false;
              // Redacted-thinking payloads arrive whole in the start block's
              // `data`; forward as a single thinking_delta so the aggregator
              // reconstructs a RedactedThinkingBlock (replayed verbatim).
              if (block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data.length > 0) {
                yield { type: 'thinking_delta', redactedData: block.data } as ThinkingStreamChunk;
              }
            }
          } else if (event.type === 'content_block_delta') {
            // Duck-type the delta so thinking_delta / signature_delta compile
            // against the peer-floor SDK types.
            const delta = event.delta as {
              type: string;
              text?: string;
              partial_json?: string;
              thinking?: string;
              signature?: string;
            };
            if (delta.type === 'text_delta') {
              yield { type: 'text_delta', text: delta.text ?? '' };
            } else if (delta.type === 'thinking_delta') {
              // Incremental reasoning fragment.
              if (delta.thinking) yield { type: 'thinking_delta', thinking: delta.thinking };
            } else if (delta.type === 'signature_delta') {
              // Integrity signature for the current thinking block; the
              // aggregator keeps the last-received value.
              if (delta.signature) yield { type: 'thinking_delta', signature: delta.signature };
            } else if (delta.type === 'input_json_delta') {
              if (currentToolLimitExceeded) continue;
              const partialJson = delta.partial_json ?? '';
              if (currentToolArgBytes + partialJson.length > maxToolArgBytes) {
                currentToolLimitExceeded = true;
                continue;
              }
              currentToolArgBytes += partialJson.length;
              yield {
                type: 'tool_call_delta',
                toolCall: {
                  ...(currentToolId !== undefined && { id: currentToolId }),
                  ...(currentToolName !== undefined && { name: currentToolName }),
                  arguments: partialJson,
                },
              };
            }
          } else if (event.type === 'message_delta') {
            // finalMessage() below provides the complete, accurate usage data
            // in a single done event; we don't yield anything here.
          }
        }

        // finalMessage() aggregates the complete, accurate usage in one place.
        const finalMsg = await stream.finalMessage();
        yield { type: 'done', usage: toTokenUsage(finalMsg.usage) };
      } catch (err) {
        // Abort (external signal or SDK abort error) at setup, mid-stream, or
        // at finalMessage() → emit a terminal zero-usage done chunk so
        // downstream iteration terminates cleanly. The abort state, not the
        // in-flight error type, is authoritative here (parity with chat()).
        if (isAbortError(err, params.signal)) {
          yield abortDone;
          return;
        }
        // Any other failure is a real provider-side error and MUST propagate
        // as a typed HarnessError with `cause` preserved.
        throw normalizeAnthropicError(err, 'stream');
      }
    },

    async countTokens(messages: readonly Message[]): Promise<number> {
      const text = messages.map((m) => m.content).join('');
      if (tokenizer) return tokenizer(text);
      // Heuristic: ~4 chars per token + small overhead per message for
      // role/framing.
      return Math.ceil(text.length / 4) + messages.length * 4;
    },
  };
}
