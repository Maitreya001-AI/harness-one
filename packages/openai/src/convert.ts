/**
 * The `@harness-one/openai` package — pure conversion helpers.
 *
 * This file owns the (mostly) stateless translation layer between harness-one
 * domain types (`Message`, `ToolSchema`, `TokenUsage`) and the OpenAI SDK wire
 * shapes, plus the `LLMConfig.extra` allow-list filter.
 *
 * Two small caches live here: the WeakMap-keyed `toOpenAIParameters` memo
 * and the bounded unknown-schema-key warn-once dedupe set. Both are
 * deliberately kept module-scoped: they're pure deduplication structures and
 * are reset by `_resetOpenAIWarnState()` in the adapter file via the internal
 * `_resetConvertWarnState()` helper exposed below.
 *
 * @module
 */

import type OpenAI from 'openai';
import type {
  Message,
  TokenUsage,
  ToolSchema,
} from 'harness-one/core';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import type { Logger } from 'harness-one/observe';
import { safeWarn } from 'harness-one/observe';

/**
 * Keys that `LLMConfig.extra` may carry into the OpenAI Chat Completions API.
 *
 * Only parameters that are (a) documented in the OpenAI Chat Completions spec
 * and (b) safe-by-default (no auth, no routing, no callback URLs) are listed.
 * Unknown keys are filtered with a single warn by default; pass
 * `strictExtraAllowList: true` to the adapter to turn the filter into a hard
 * `ADAPTER_INVALID_EXTRA` failure — useful for prod builds that want any
 * provider-drift to surface as a test/CI failure.
 *
 * This list mirrors the symmetry with the Anthropic adapter's filter and is
 * intentionally narrower than the OpenAI SDK surface: callers needing
 * provider-specific knobs beyond this list should open a PR to expand it
 * (preferred) or supply a pre-configured `client` that embeds the knob.
 */
const OPENAI_EXTRA_ALLOW_LIST: ReadonlySet<string> = new Set([
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'seed',
  'response_format',
  'user',
  'service_tier',
  'parallel_tool_calls',
]);

/**
 * Filter a caller-supplied `LLMConfig.extra` payload against the OpenAI
 * allow-list.
 *
 * Behaviour:
 *  - Undefined / empty input → returns `{}` with no warning.
 *  - All keys allow-listed → returns the payload verbatim, no warning.
 *  - Some unknown keys, `strict` = false → returns the filtered subset and
 *    emits a single warn listing the rejected keys.
 *  - Any unknown key, `strict` = true → throws `HarnessError` with code
 *    `ADAPTER_INVALID_EXTRA`; nothing is forwarded.
 *
 * Kept package-local (not reused from anthropic) so each adapter owns its own
 * allow-list surface and can evolve independently.
 */
export function filterExtra(
  extra: Readonly<Record<string, unknown>> | undefined,
  strict: boolean,
  logger: Pick<Logger, 'warn' | 'error'> | undefined,
): Record<string, unknown> {
  if (extra === undefined) return {};

  const accepted: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const key of Object.keys(extra)) {
    if (OPENAI_EXTRA_ALLOW_LIST.has(key)) {
      accepted[key] = extra[key];
    } else {
      rejected.push(key);
    }
  }

  if (rejected.length === 0) return accepted;

  if (strict) {
    throw new HarnessError(
      `OpenAI adapter: LLMConfig.extra contained keys not in the allow-list: ${rejected.join(', ')}`,
      HarnessErrorCode.ADAPTER_INVALID_EXTRA,
      'Remove the offending keys, add them to OPENAI_EXTRA_ALLOW_LIST via a PR, or disable strictExtraAllowList.',
    );
  }

  const msg = `[harness-one/openai] LLMConfig.extra contained keys not in the allow-list and was filtered: ${rejected.join(', ')}. Pass strictExtraAllowList: true to fail instead of filtering.`;
  const meta = { rejectedKeys: rejected };
  if (logger !== undefined) {
    // A caller-supplied logger (even the Pick<> narrow one used by this
    // adapter) routes the warn itself; we only fall back to `safeWarn`'s
    // default redaction-enabled logger when none is provided.
    logger.warn(msg, meta);
  } else {
    safeWarn(undefined, msg, meta);
  }
  return accepted;
}

/** Convert a harness-one Message to OpenAI's chat completion message format. */
export function toOpenAIMessage(
  msg: Message,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (msg.role === 'tool' && msg.toolCallId) {
    return {
      role: 'tool',
      tool_call_id: msg.toolCallId,
      content: msg.content,
    };
  }

  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: msg.content || '',
      tool_calls: msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      })),
    };
  }

  if (msg.role === 'system') {
    return { role: 'system', content: msg.content };
  }

  if (msg.role === 'assistant') {
    return { role: 'assistant', content: msg.content };
  }

  return { role: 'user', content: msg.content };
}

/**
 * Known keys on the harness-one JsonSchema subset that we forward to OpenAI.
 * Keys outside this set are dropped by `toOpenAIParameters` with a one-shot
 * warn per unknown key so schema drift is observable without spamming per
 * call-site.
 */
const _OPENAI_KNOWN_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'description',
  'default',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'additionalProperties',
  'oneOf',
  'anyOf',
  'allOf',
  'const',
  'format',
]);

/**
 * Module-scoped dedupe for unknown-schema-key warnings. Bounded FIFO at 256
 * entries so long-running servers with drifting schemas don't grow unbounded.
 */
const _unknownSchemaKeyWarned: Set<string> = new Set();
const _UNKNOWN_SCHEMA_KEY_WARN_CAP = 256;

/**
 * Module-scoped memoization for `toOpenAIParameters`.
 *
 * Consumers typically pass the same schema object through every adapter
 * invocation; WeakMap-keyed memoization makes subsequent calls O(1) and avoids
 * the allocation on every `chat()` / `stream()` request. The WeakMap ensures
 * entries are GC'd with the schema.
 */
const _parametersMemo: WeakMap<object, Record<string, unknown>> = new WeakMap();

/**
 * Convert a harness-one JsonSchema to OpenAI's FunctionParameters
 * (`Record<string, unknown>`).
 *
 * OpenAI expects `Record<string, unknown>` for tool parameters. Rather than
 * using a double assertion (`as unknown as Record<string, unknown>`) we
 * explicitly map the known JsonSchema fields to produce a clean record.
 *
 * Memoized via a WeakMap keyed on the schema object; identical schema
 * references resolve to the same output reference. Warn-once per unknown key
 * so silently-dropped schema drift becomes observable.
 *
 * @internal
 */
export function toOpenAIParameters(
  schema: ToolSchema['parameters'],
  logger?: Pick<Logger, 'warn' | 'error'>,
): Record<string, unknown> {
  // WeakMap keys must be objects; JsonSchema is always an object at runtime.
  const cached = _parametersMemo.get(schema as unknown as object);
  if (cached !== undefined) return cached;

  const result: Record<string, unknown> = { type: schema.type };
  if (schema.properties !== undefined) result.properties = schema.properties;
  if (schema.required !== undefined) result.required = schema.required;
  if (schema.items !== undefined) result.items = schema.items;
  if (schema.enum !== undefined) result.enum = schema.enum;
  if (schema.description !== undefined) result.description = schema.description;
  if (schema.default !== undefined) result.default = schema.default;
  if (schema.minimum !== undefined) result.minimum = schema.minimum;
  if (schema.maximum !== undefined) result.maximum = schema.maximum;
  if (schema.minLength !== undefined) result.minLength = schema.minLength;
  if (schema.maxLength !== undefined) result.maxLength = schema.maxLength;
  if (schema.pattern !== undefined) result.pattern = schema.pattern;
  if (schema.additionalProperties !== undefined) result.additionalProperties = schema.additionalProperties;
  if (schema.oneOf !== undefined) result.oneOf = schema.oneOf;
  if (schema.anyOf !== undefined) result.anyOf = schema.anyOf;
  if (schema.allOf !== undefined) result.allOf = schema.allOf;
  if (schema.const !== undefined) result.const = schema.const;
  if (schema.format !== undefined) result.format = schema.format;

  // Warn once per distinct unknown key. The cast to `Record<string, unknown>`
  // is safe — JsonSchema is a plain object; we only iterate its own keys.
  const dropped: string[] = [];
  for (const key of Object.keys(schema as unknown as Record<string, unknown>)) {
    if (!_OPENAI_KNOWN_SCHEMA_KEYS.has(key) && !_unknownSchemaKeyWarned.has(key)) {
      if (_unknownSchemaKeyWarned.size < _UNKNOWN_SCHEMA_KEY_WARN_CAP) {
        _unknownSchemaKeyWarned.add(key);
      }
      dropped.push(key);
    }
  }
  if (dropped.length > 0 && logger !== undefined) {
    logger.warn(
      `[harness-one/openai] toOpenAIParameters: dropped unknown schema key(s): ${dropped.join(', ')}. ` +
      'Only keys in the OpenAI adapter\'s known-schema set are forwarded; unknown keys are silently dropped. ' +
      '(Each distinct key warns at most once.)',
      { droppedKeys: dropped },
    );
  }

  _parametersMemo.set(schema as unknown as object, result);
  return result;
}

/**
 * Convert a harness-one ToolSchema to OpenAI's tool format.
 *
 * @internal
 */
export function toOpenAITool(
  tool: ToolSchema,
  logger?: Pick<Logger, 'warn' | 'error'>,
): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toOpenAIParameters(tool.parameters, logger),
    },
  };
}

/**
 * Map OpenAI's usage to harness-one's TokenUsage.
 *
 * OpenAI exposes prompt-cache hits via the optional
 * `usage.prompt_tokens_details.cached_tokens` field (the newer Responses /
 * Chat Completions API shape). When present, we surface it as
 * `cacheReadTokens` so cost tracking in the core reflects cached-read savings.
 */
export function toTokenUsage(
  usage: OpenAI.Completions.CompletionUsage | undefined,
): TokenUsage {
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;
  const base: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } = {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
  if (typeof cachedTokens === 'number') {
    base.cacheReadTokens = cachedTokens;
  }
  return base;
}

/** Parse an OpenAI response choice into a harness-one Message. */
export function toHarnessMessage(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice,
): Message {
  const msg = choice.message;
  // openai@v6 widened `tool_calls` to a union of function + custom tool calls
  // (https://github.com/openai/openai-node v6 changelog). harness-one only
  // models function tool calls, so narrow via `type === 'function'` and drop
  // any custom tool calls the model might return.
  const toolCalls = msg.tool_calls
    ?.filter((tc) => tc.type === 'function')
    .map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

  return {
    role: 'assistant',
    content: msg.content ?? '',
    ...(toolCalls && toolCalls.length > 0 && { toolCalls }),
  };
}

/**
 * Test-only internal helper: clear the unknown-schema-key warn-once dedupe
 * set. Exposed so `_resetOpenAIWarnState()` in `adapter.ts` can reach in and
 * clear this file's private state without widening its public API.
 *
 * @internal
 */
export function _resetConvertWarnState(): void {
  _unknownSchemaKeyWarned.clear();
}
