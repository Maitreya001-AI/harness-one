/**
 * Conversion helpers for the Anthropic adapter.
 *
 * Extracted from `index.ts` (review refactor): all pure translation between
 * harness-one domain types (`Message`, `ToolSchema`, `TokenUsage`) and the
 * Anthropic SDK wire shapes lives here. The factory in `./adapter.ts` composes
 * these helpers; `./index.ts` is a thin barrel exposing only the public
 * surface.
 *
 * Nothing in this file is re-exported from `index.ts` except the
 * `_resetWarnedUnknownSchemaKeysForTesting` hatch (see below).
 *
 * @module
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Message, TokenUsage, ToolSchema } from 'harness-one/core';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import { safeWarn, type Logger } from 'harness-one/observe';

import type { AnthropicMalformedToolUsePolicy } from './adapter.js';
import { isWarnActive } from './adapter.js';

/**
 * T05 (Wave-5A): Allow-list of `LLMConfig.extra` keys that are safe to forward
 * verbatim to the Anthropic Messages API. Any key outside this set is filtered
 * out (with a single `safeWarn` emission) in non-strict mode, or rejected with
 * a `HarnessError(HarnessErrorCode.ADAPTER_INVALID_EXTRA)` when `strictExtraAllowList: true`.
 *
 * Rationale: prior to T05, `extra` was spread into the request body unchecked,
 * which made it trivial for callers (or upstream preset chains) to leak vendor
 * keys, arbitrary fields, or typos to the provider. The allow-list is the
 * minimum viable surface to keep SPEC-005 forwarding useful without the
 * shotgun risk.
 */
export const ANTHROPIC_EXTRA_ALLOW_LIST = new Set<string>([
  'temperature',
  'top_k',
  'top_p',
  'stop_sequences',
  'thinking',
  'metadata',
  'system',
]);

/**
 * T05 (Wave-5A): Filter `extra` against the Anthropic allow-list.
 *
 * - Returns `undefined` when the input is `undefined` (pure pass-through,
 *   zero side effects).
 * - Returns the filtered subset plus a single `safeWarn` emission when keys
 *   are rejected and `strict === false`.
 * - Throws `HarnessError(HarnessErrorCode.ADAPTER_INVALID_EXTRA)` when keys are rejected
 *   and `strict === true`.
 *
 * The `logger` parameter is structurally compatible with `safeWarn`'s
 * `Logger | undefined` signature at runtime (only `.warn` is invoked); we
 * widen via a single cast at the call site to avoid forcing adapter callers
 * to supply a full `Logger` when they only care about `warn`/`error`.
 */
export function filterExtra(
  extra: Readonly<Record<string, unknown>> | undefined,
  strict: boolean,
  logger: Pick<Logger, 'warn' | 'error'> | undefined,
): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const filtered: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(extra)) {
    if (ANTHROPIC_EXTRA_ALLOW_LIST.has(k)) {
      filtered[k] = v;
    } else {
      rejected.push(k);
    }
  }
  if (rejected.length === 0) return filtered;
  if (strict) {
    throw new HarnessError(
      `Anthropic adapter: extra contains keys outside the allow-list: ${rejected.join(', ')}`,
      HarnessErrorCode.ADAPTER_INVALID_EXTRA,
      'Remove the listed keys from LLMConfig.extra, or set strictExtraAllowList=false to filter-and-warn instead of throwing.',
    );
  }
  // `safeWarn` accepts `Logger | undefined`; our adapter type is a narrower
  // `Pick<Logger, 'warn' | 'error'>`. At runtime `safeWarn` only invokes
  // `target.warn(msg, meta)`, so the cast is sound.
  safeWarn(logger as Logger | undefined, 'anthropic adapter: extra keys filtered', { rejected });
  return filtered;
}

/**
 * P1-3 (Wave-12): resolve a raw `tc.arguments` string into the Record that
 * Anthropic expects as `tool_use.input`. Applies `onMalformedToolUse` policy:
 * - `'warn'` (default) mirrors the pre-Wave-12 behavior: warn + substitute `{}`.
 * - `'throw'` raises a typed `HarnessError(ADAPTER_ERROR)` with the raw
 *   argument string preserved for operators.
 * - custom callback receives `(raw, err)` and can return a replacement object
 *   or `null` to fall back to `{}`.
 *
 * The returned object carries the raw string on a non-enumerable
 * `__rawArguments` slot so observability layers can recover the pre-parse
 * payload without changing the JSON serialized to the provider.
 */
export function resolveToolUseInput(
  tc: { readonly id: string; readonly name: string; readonly arguments: string },
  policy: AnthropicMalformedToolUsePolicy,
  logger: Pick<Logger, 'warn' | 'error'>,
): Record<string, unknown> {
  // Happy path: parseable JSON object.
  let parsed: unknown;
  let parseErr: Error | undefined;
  try {
    parsed = JSON.parse(tc.arguments);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    parseErr = new SyntaxError(
      `tool_use input for "${tc.name}" was not a JSON object (got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed})`,
    );
  } catch (err) {
    parseErr = err instanceof Error ? err : new Error(String(err));
  }

  // Malformed path — apply policy.
  //
  // Wave-13 H-1: the default 'warn' path still uses a head-only preview
  // (truncation ellipsis at 200 chars). But the 'throw' path now uses a
  // head+tail preview for arguments longer than 400 chars so error messages
  // surface tail-region corruption (e.g. a malformed closing brace) that was
  // previously invisible. Below 400 chars we keep the single head-only form —
  // there's no tail worth reporting separately.
  const raw = tc.arguments;
  const warnPreview = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
  const throwPreview =
    raw.length > 400
      ? `${raw.slice(0, 200)} ... ${raw.slice(-200)}`
      : raw;

  if (policy === 'throw') {
    throw new HarnessError(
      `[harness-one/anthropic] tool_use input for "${tc.name}" was not valid JSON and onMalformedToolUse='throw'. ` +
      `Raw (length=${raw.length}, head+tail preview): ${throwPreview}`,
      HarnessErrorCode.ADAPTER_ERROR,
      'Set onMalformedToolUse to \'warn\' to fall back to {} or supply a callback to produce a replacement object.',
      parseErr,
    );
  }

  if (typeof policy === 'function') {
    const replacement = policy(tc.arguments, parseErr);
    // Wave-13 H-2: distinguish `undefined` (defer to default throw policy)
    // from `null` (explicit empty-object request).
    if (replacement === undefined) {
      throw new HarnessError(
        `[harness-one/anthropic] onMalformedToolUse callback returned undefined for "${tc.name}"; ` +
        `deferring to default 'throw' policy. Return null to request the empty-object fallback, ` +
        `or an object to supply a custom replacement. Raw (length=${tc.arguments.length}, head+tail preview): ${throwPreview}`,
        HarnessErrorCode.ADAPTER_ERROR,
        'Return an object or null from onMalformedToolUse. undefined now means "defer to default" (throw).',
        parseErr,
      );
    }
    const resolved: Record<string, unknown> =
      replacement !== null && typeof replacement === 'object' && !Array.isArray(replacement)
        ? (replacement as Record<string, unknown>)
        : {};
    // Preserve raw for observability without bloating provider payload.
    Object.defineProperty(resolved, '__rawArguments', {
      value: tc.arguments,
      enumerable: false,
      writable: false,
      configurable: true,
    });
    return resolved;
  }

  // Default 'warn' policy — backwards compatible with Wave-5F.
  if (isWarnActive(logger)) {
    const msg =
      parsed !== undefined && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        ? `[harness-one/anthropic] tool_use input for "${tc.name}" was not a JSON object (got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}); substituting empty object.`
        : `[harness-one/anthropic] tool_use input for "${tc.name}" was not valid JSON; substituting empty object. ` +
          `Parse error: ${parseErr.message}. Raw (first 200 chars): ${warnPreview}`;
    // Preserve the historical single-argument shape so existing callers
    // matching on `.calls[0][0]` remain green.
    logger.warn(msg);
  }

  const fallback: Record<string, unknown> = {};
  Object.defineProperty(fallback, '__rawArguments', {
    value: tc.arguments,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return fallback;
}

/** Convert a harness-one Message to the Anthropic message format. */
export function toAnthropicMessage(
  msg: Message,
  logger: Pick<Logger, 'warn' | 'error'>,
  malformedPolicy: AnthropicMalformedToolUsePolicy,
): Anthropic.MessageParam {
  if (msg.role === 'tool' && msg.toolCallId) {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.content,
        },
      ],
    };
  }

  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    const content: (Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam)[] = [];
    if (msg.content) {
      content.push({ type: 'text', text: msg.content });
    }
    for (const tc of msg.toolCalls) {
      // Narrow to object shape — silently casting a string to Record<string, unknown>
      // would hide LLM output corruption. When JSON is invalid or not an object,
      // apply the configured `onMalformedToolUse` policy (P1-3).
      const input = resolveToolUseInput(tc, malformedPolicy, logger);
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input,
      });
    }
    return { role: 'assistant', content };
  }

  return {
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
  };
}

/**
 * P2-19: known JsonSchema keys that this adapter projects onto
 * Anthropic's `Tool.InputSchema`. Any key on `ToolSchema['parameters']` that
 * is not in this set is silently dropped today; we warn once per unique key
 * to surface the drop to operators without flooding logs.
 */
const _KNOWN_SCHEMA_KEYS: ReadonlySet<string> = new Set<string>([
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
 * P2-19: module-scoped, size-capped set of schema keys for which we have
 * already emitted a warn. Capped at 64 distinct keys — beyond that we stop
 * growing to avoid unbounded memory growth on malicious or buggy callers.
 */
const _WARNED_UNKNOWN_SCHEMA_KEYS: Set<string> = new Set<string>();
const _MAX_WARNED_UNKNOWN_SCHEMA_KEYS = 64;

/** @internal — exposed only for unit tests; not part of the public API. */
export function _resetWarnedUnknownSchemaKeysForTesting(): void {
  _WARNED_UNKNOWN_SCHEMA_KEYS.clear();
}

/**
 * Convert a harness-one JsonSchema to Anthropic's Tool.InputSchema.
 *
 * Anthropic expects `{ type: 'object'; properties?: unknown; [k: string]: unknown }`.
 * Rather than casting with `as Anthropic.Tool.InputSchema`, we explicitly map
 * the known JsonSchema fields to produce a conforming object.
 *
 * @internal — this is an adapter-internal projection helper. Consumers should
 * author schemas against `ToolSchema` directly; Anthropic-specific shape is a
 * deliberately unexported concern.
 */
export function toAnthropicInputSchema(
  schema: ToolSchema['parameters'],
  logger?: Pick<Logger, 'warn' | 'error'>,
): Anthropic.Tool.InputSchema {
  const result: Record<string, unknown> = { type: schema.type as 'object' };
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

  // P2-19: warn once per distinct unknown key. Bound the warned-set at 64
  // entries to avoid leaking under attacker-controlled schema keys.
  const dropped: string[] = [];
  for (const key of Object.keys(schema as unknown as Record<string, unknown>)) {
    if (_KNOWN_SCHEMA_KEYS.has(key)) continue;
    if (_WARNED_UNKNOWN_SCHEMA_KEYS.has(key)) continue;
    if (_WARNED_UNKNOWN_SCHEMA_KEYS.size >= _MAX_WARNED_UNKNOWN_SCHEMA_KEYS) break;
    _WARNED_UNKNOWN_SCHEMA_KEYS.add(key);
    dropped.push(key);
  }
  if (dropped.length > 0 && logger && isWarnActive(logger)) {
    logger.warn(
      `[harness-one/anthropic] toAnthropicInputSchema dropped unknown schema keys: ${dropped.join(', ')}`,
      { dropped },
    );
  }

  return result as Anthropic.Tool.InputSchema;
}

/** Convert a harness-one ToolSchema to Anthropic's tool format. */
export function toAnthropicTool(
  tool: ToolSchema,
  logger?: Pick<Logger, 'warn' | 'error'>,
): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: toAnthropicInputSchema(tool.parameters, logger),
  };
}

/** Extract the system prompt from the message array. */
export function extractSystem(messages: readonly Message[]): {
  system: string | undefined;
  rest: Message[];
} {
  const system = messages.find((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  return { system: system?.content, rest };
}

/**
 * Map Anthropic's usage response to harness-one's TokenUsage.
 *
 * Anthropic's Usage type may include cache_read_input_tokens and
 * cache_creation_input_tokens fields that are not in the base type definition.
 * We safely extract them using 'in' checks instead of a double assertion.
 */
export function toTokenUsage(usage: Anthropic.Usage): TokenUsage {
  const cacheRead = 'cache_read_input_tokens' in usage
    && typeof usage.cache_read_input_tokens === 'number'
    ? usage.cache_read_input_tokens : 0;
  const cacheCreate = 'cache_creation_input_tokens' in usage
    && typeof usage.cache_creation_input_tokens === 'number'
    ? usage.cache_creation_input_tokens : 0;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheCreate,
  };
}

/** Parse Anthropic's response content blocks into a harness-one Message. */
export function toHarnessMessage(response: Anthropic.Message): Message {
  const textParts: string[] = [];
  const toolCalls: { id: string; name: string; arguments: string }[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      });
    }
  }

  return {
    role: 'assistant',
    content: textParts.join(''),
    ...(toolCalls.length > 0 && { toolCalls }),
  };
}
