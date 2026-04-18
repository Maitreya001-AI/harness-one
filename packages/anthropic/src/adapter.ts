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
} from './convert.js';

/**
 * Policy for how the adapter reacts when an assistant `toolCalls[].arguments`
 * string is not parseable as a JSON object (Wave-12 P1-3, Wave-13 H-2).
 *
 * - `'warn'` (default, backwards compatible): emit `logger.warn(...)`, substitute
 *   an empty object, continue. Preserves Wave-5F behavior.
 * - `'throw'`: throw `HarnessError(ADAPTER_ERROR)` with the raw argument string
 *   preserved on the error's `context` via its message (Wave-13 H-1: uses a
 *   head+tail preview for payloads over 400 chars). Fail fast for operators
 *   who would rather observe malformed LLM output than mask it.
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
 * Wave-13 H-2: before this wave the contract did not distinguish `null` from
 * `undefined`; both fell through to `{}`. Callers who wanted fail-fast
 * semantics from a custom callback had to throw themselves. The new
 * `undefined` → default-throw path closes that gap without breaking
 * callers who already return `null`.
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
   * even when the loop-level {@link StreamAggregator} would catch the same
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
}

/**
 * Create an AgentAdapter backed by the Anthropic SDK.
 *
 * Supports chat(), stream(), and full tool_use handling.
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

  return {
    name: `anthropic:${model}`,
    async chat(params: ChatParams): Promise<ChatResponse> {
      const { system, rest } = extractSystem(params.messages);

      // Filter `extra` against Anthropic allow-list BEFORE spreading. Under
      // strict mode this throws before any network call.
      const safeExtra = filterExtra(params.config?.extra, strictExtra, config.logger);

      const response = await client.messages.create({
        model,
        max_tokens: params.config?.maxTokens ?? 4096,
        ...(system !== undefined && { system }),
        messages: rest.map((m) => toAnthropicMessage(m, logger, malformedPolicy)),
        ...(params.tools && { tools: params.tools.map((t) => toAnthropicTool(t, logger)) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.stopSequences !== undefined && { stop_sequences: params.config.stopSequences as string[] }),
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
    },

    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const { system, rest } = extractSystem(params.messages);

      const safeExtra = filterExtra(params.config?.extra, strictExtra, config.logger);

      const stream = client.messages.stream({
        model,
        max_tokens: params.config?.maxTokens ?? 4096,
        ...(system !== undefined && { system }),
        messages: rest.map((m) => toAnthropicMessage(m, logger, malformedPolicy)),
        ...(params.tools && { tools: params.tools.map((t) => toAnthropicTool(t, logger)) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.stopSequences !== undefined && { stop_sequences: params.config.stopSequences as string[] }),
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
          const block = event.content_block;
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
            currentToolId = undefined;
            currentToolName = undefined;
            currentToolLimitExceeded = false;
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            yield { type: 'text_delta', text: delta.text };
          } else if (delta.type === 'input_json_delta') {
            if (currentToolLimitExceeded) continue;
            if (currentToolArgBytes + delta.partial_json.length > maxToolArgBytes) {
              currentToolLimitExceeded = true;
              continue;
            }
            currentToolArgBytes += delta.partial_json.length;
            yield {
              type: 'tool_call_delta',
              toolCall: {
                ...(currentToolId !== undefined && { id: currentToolId }),
                ...(currentToolName !== undefined && { name: currentToolName }),
                arguments: delta.partial_json,
              },
            };
          }
        } else if (event.type === 'message_delta') {
          // finalMessage() below provides the complete, accurate usage data
          // in a single done event; we don't yield anything here.
        }
      }

      let finalMsg: Anthropic.Message;
      try {
        finalMsg = await stream.finalMessage();
      } catch (err) {
        // Two legitimate cases:
        //  1. Caller aborted via an external AbortSignal — emit a terminal
        //     zero-usage done chunk so downstream iteration terminates cleanly.
        //  2. Anything else is a real provider-side failure (network blip,
        //     500, malformed final message, etc.) and MUST propagate as a
        //     typed HarnessError with `cause` preserved.
        const isAbort =
          params.signal?.aborted === true ||
          (err instanceof Error &&
            (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR'));
        if (isAbort) {
          yield {
            type: 'done',
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
          return;
        }
        throw new HarnessError(
          'Anthropic stream failed before finalMessage() resolved',
          HarnessErrorCode.ADAPTER_ERROR,
          'The provider stream ended abnormally. Check network connectivity and provider status; retry if transient.',
          err instanceof Error ? err : undefined,
        );
      }
      yield { type: 'done', usage: toTokenUsage(finalMsg.usage) };
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
