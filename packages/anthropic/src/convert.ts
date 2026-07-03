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
import type {
  ContentBlock,
  ImageBlock,
  Message,
  ResponseFormat,
  TokenUsage,
  ToolSchema,
} from 'harness-one/core';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import { categorizeAdapterError } from 'harness-one/advanced';
import { safeWarn, type Logger } from 'harness-one/observe';

import type { AnthropicMalformedToolUsePolicy } from './adapter.js';
import { isWarnActive } from './adapter.js';

/**
 * Element type of an Anthropic message `content` array. Provider block params
 * for thinking / redacted_thinking / url-image / cache_control postdate the
 * `>=0.30` SDK peer floor, so RFC-0001 content blocks are built structurally
 * and cast to this element type at push time — the same structural-widening
 * strategy used for `cache_control` elsewhere in this file. The Anthropic API
 * accepts the shapes at runtime.
 */
type AnthropicContentPart = Exclude<Anthropic.MessageParam['content'], string>[number];

/** Element type of an Anthropic `tool_result` block's array `content`. */
type AnthropicToolResultContentPart = Exclude<
  NonNullable<Anthropic.ToolResultBlockParam['content']>,
  string
>[number];

/**
 * Allow-list of `LLMConfig.extra` keys that are safe to forward verbatim
 * to the Anthropic Messages API. Any key outside this set is filtered
 * out (with a single `safeWarn` emission) in non-strict mode, or
 * rejected with `HarnessError(HarnessErrorCode.ADAPTER_INVALID_EXTRA)`
 * when `strictExtraAllowList: true`.
 *
 * Rationale: without the allow-list, `extra` would spread into the
 * request body unchecked, which makes it trivial for callers (or
 * upstream preset chains) to leak vendor keys, arbitrary fields, or
 * typos to the provider.
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
 * Filter `extra` against the Anthropic allow-list.
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
 * Resolve a raw `tc.arguments` string into the Record that Anthropic
 * expects as `tool_use.input`. Applies `onMalformedToolUse` policy:
 * - `'warn'` (default): warn + substitute `{}`.
 * - `'throw'`: raise a typed `HarnessError(ADAPTER_ERROR)` with the raw
 *   argument string preserved for operators.
 * - custom callback: receives `(raw, err)` and can return a replacement
 *   object or `null` to fall back to `{}`.
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
  // The default 'warn' path uses a head-only preview (truncation
  // ellipsis at 200 chars). The 'throw' path uses a head+tail preview
  // for arguments longer than 400 chars so error messages surface
  // tail-region corruption (e.g. a malformed closing brace). Below 400
  // chars we keep the single head-only form — there's no tail worth
  // reporting separately.
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
    // Distinguish `undefined` (defer to default throw policy) from
    // `null` (explicit empty-object request).
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

  // Default 'warn' policy.
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

/**
 * Convert a harness-one {@link ImageBlock} to an Anthropic image content block.
 * `base64` sources map to `{ type: 'base64', media_type, data }`; `url`
 * sources map to `{ type: 'url', url }` (url image sources postdate the SDK
 * peer floor, hence the structural build + widening cast).
 */
export function toAnthropicImageBlock(block: ImageBlock): AnthropicContentPart {
  if (block.source.kind === 'base64') {
    return {
      type: 'image',
      source: { type: 'base64', media_type: block.source.mediaType, data: block.source.data },
    } as AnthropicContentPart;
  }
  return {
    type: 'image',
    source: { type: 'url', url: block.source.url },
  } as AnthropicContentPart;
}

/**
 * Project a harness-one block list onto Anthropic `tool_result` content parts
 * (text + image only). Thinking / redacted blocks have no place in a tool
 * result and are dropped.
 */
function blocksToToolResultContent(
  blocks: readonly ContentBlock[],
): AnthropicToolResultContentPart[] {
  const parts: AnthropicToolResultContentPart[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text } as AnthropicToolResultContentPart);
    } else if (block.type === 'image') {
      parts.push(toAnthropicImageBlock(block) as unknown as AnthropicToolResultContentPart);
    }
  }
  return parts;
}

/**
 * Replay a harness-one assistant block onto its Anthropic content-block param.
 * Thinking / redacted_thinking blocks MUST round-trip verbatim (signatures
 * intact) or Anthropic rejects a subsequent tool-bearing turn.
 */
function assistantBlockToParam(block: ContentBlock): AnthropicContentPart | undefined {
  switch (block.type) {
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        ...(block.signature !== undefined && { signature: block.signature }),
      } as AnthropicContentPart;
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data } as AnthropicContentPart;
    case 'text':
      return { type: 'text', text: block.text } as AnthropicContentPart;
    case 'image':
      return toAnthropicImageBlock(block);
    default:
      return undefined;
  }
}

/** Convert a harness-one Message to the Anthropic message format. */
export function toAnthropicMessage(
  msg: Message,
  logger: Pick<Logger, 'warn' | 'error'>,
  malformedPolicy: AnthropicMalformedToolUsePolicy,
): Anthropic.MessageParam {
  if (msg.role === 'tool' && msg.toolCallId) {
    // Tool results carrying images (RFC-0001) become a mixed text+image
    // content array; otherwise keep the plain string projection (unchanged).
    const toolBlocks = msg.blocks;
    const content =
      toolBlocks && toolBlocks.some((b) => b.type === 'image')
        ? blocksToToolResultContent(toolBlocks)
        : msg.content;
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content,
        },
      ],
    };
  }

  // Assistant messages with full-fidelity blocks (RFC-0001): replay the blocks
  // verbatim (thinking first, signatures intact), THEN the tool_use blocks from
  // toolCalls. Anthropic requires thinking to precede tool_use.
  if (msg.role === 'assistant' && msg.blocks && msg.blocks.length > 0) {
    const content: AnthropicContentPart[] = [];
    for (const block of msg.blocks) {
      const param = assistantBlockToParam(block);
      if (param !== undefined) content.push(param);
    }
    for (const tc of msg.toolCalls ?? []) {
      const input = resolveToolUseInput(tc, malformedPolicy, logger);
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input } as AnthropicContentPart);
    }
    return { role: 'assistant', content };
  }

  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    const content: (Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam)[] = [];
    if (msg.content) {
      content.push({ type: 'text', text: msg.content });
    }
    for (const tc of msg.toolCalls) {
      // Narrow to object shape — silently casting a string to Record<string, unknown>
      // would hide LLM output corruption. When JSON is invalid or not an object,
      // apply the configured `onMalformedToolUse` policy.
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

  // User messages with blocks (RFC-0001): interleave text + image content
  // parts in declared order. Falls back to the string projection when no
  // mappable part is produced.
  if (msg.role === 'user' && msg.blocks && msg.blocks.length > 0) {
    const content: AnthropicContentPart[] = [];
    for (const block of msg.blocks) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text } as AnthropicContentPart);
      } else if (block.type === 'image') {
        content.push(toAnthropicImageBlock(block));
      }
    }
    if (content.length > 0) {
      return { role: 'user', content };
    }
  }

  return {
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
  };
}

/**
 * Known JsonSchema keys that this adapter projects onto Anthropic's
 * `Tool.InputSchema`. Any key on `ToolSchema['parameters']` that is not in
 * this set is silently dropped today; we warn once per unique key to surface
 * the drop to operators without flooding logs.
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
 * Module-scoped, size-capped set of schema keys for which we have already
 * emitted a warn. Capped at 64 distinct keys — beyond that we stop growing
 * to avoid unbounded memory growth on malicious or buggy callers.
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

  // Warn once per distinct unknown key. Bound the warned-set at 64 entries
  // to avoid leaking under attacker-controlled schema keys.
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

/**
 * Parse Anthropic's response content blocks into a harness-one Message.
 *
 * Text blocks project onto `content` (the canonical text projection).
 * `tool_use` blocks project onto `toolCalls`. Extended-thinking blocks
 * (`thinking` / `redacted_thinking`, RFC-0001) — which the SDK's block union
 * gained after the `>=0.30` peer floor, hence the structural duck-typing —
 * populate `message.blocks`: reasoning blocks first (order preserved), then a
 * single text block with the concatenated text. `content` stays equal to
 * `blocksText(blocks)`, satisfying the projection invariant.
 */
export function toHarnessMessage(response: Anthropic.Message): Message {
  const textParts: string[] = [];
  const toolCalls: { id: string; name: string; arguments: string }[] = [];
  const reasoningBlocks: ContentBlock[] = [];

  for (const block of response.content) {
    // Duck-type `type` so `thinking` / `redacted_thinking` compile against the
    // peer-floor SDK types (which predate those response-block variants).
    const b = block as unknown as {
      type: string;
      thinking?: unknown;
      signature?: unknown;
      data?: unknown;
    };
    if (b.type === 'text') {
      textParts.push((block as Anthropic.TextBlock).text);
    } else if (b.type === 'tool_use') {
      const tu = block as Anthropic.ToolUseBlock;
      toolCalls.push({
        id: tu.id,
        name: tu.name,
        arguments: JSON.stringify(tu.input),
      });
    } else if (b.type === 'thinking') {
      const thinking = typeof b.thinking === 'string' ? b.thinking : '';
      const signature = typeof b.signature === 'string' ? b.signature : undefined;
      reasoningBlocks.push({
        type: 'thinking',
        thinking,
        ...(signature !== undefined && { signature }),
      });
    } else if (b.type === 'redacted_thinking') {
      const data = typeof b.data === 'string' ? b.data : '';
      reasoningBlocks.push({ type: 'redacted_thinking', data });
    }
  }

  const content = textParts.join('');

  // Only attach `blocks` when reasoning content exists — a plain text/tool
  // response keeps the historical block-free shape. Reasoning blocks precede
  // the single text block so a verbatim replay on the next request is valid.
  let blocks: ContentBlock[] | undefined;
  if (reasoningBlocks.length > 0) {
    blocks = [...reasoningBlocks];
    if (content.length > 0) blocks.push({ type: 'text', text: content });
  }

  return {
    role: 'assistant',
    content,
    ...(blocks !== undefined && { blocks }),
    ...(toolCalls.length > 0 && { toolCalls }),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// responseFormat (provider-spec.md §"responseFormat handling")
//
// Anthropic has no native JSON mode, so `json_object` / `json_schema` are
// implemented by appending a system-level instruction. `text` is a no-op.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build the system-level instruction that implements a `ResponseFormat`.
 *
 * - `undefined` / `text` → `undefined` (no instruction; caller leaves the
 *   system prompt untouched).
 * - `json_object` → a short "respond with a single JSON object" hint.
 * - `json_schema` → the same hint plus the JSON schema serialized inline, so
 *   the model can conform to the requested shape even though Anthropic cannot
 *   enforce it natively.
 */
export function buildResponseFormatInstruction(
  responseFormat: ResponseFormat | undefined,
): string | undefined {
  if (responseFormat === undefined || responseFormat.type === 'text') return undefined;
  if (responseFormat.type === 'json_object') {
    return 'Respond with a single JSON object.';
  }
  // json_schema — Anthropic has no strict-schema mode, so fall through to
  // json_object semantics with the schema embedded in the instruction.
  return (
    'Respond with a single JSON object. The JSON MUST conform to the following ' +
    `JSON schema:\n${JSON.stringify(responseFormat.schema)}`
  );
}

/**
 * Fold a `ResponseFormat` instruction into the extracted system prompt.
 *
 * Composes with an existing system message (from {@link extractSystem}) by
 * appending the instruction after a blank line. When there is no base system
 * message the instruction becomes the system prompt on its own.
 */
export function applyResponseFormat(
  system: string | undefined,
  responseFormat: ResponseFormat | undefined,
): string | undefined {
  const instruction = buildResponseFormatInstruction(responseFormat);
  if (instruction === undefined) return system;
  if (system === undefined || system.length === 0) return instruction;
  return `${system}\n\n${instruction}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Extended thinking (adapter-specific, opt-in — RFC-0001)
//
// A first-class `thinking` option requests Anthropic extended thinking via
// `thinking: { type: 'enabled', budget_tokens }` (the request param postdates
// the >=0.30 peer floor, so it is returned as a widened Record and spread at
// the call boundary). Anthropic requires max_tokens > budget_tokens and that
// temperature be left at its default; the former is validated cheaply here,
// the latter is documented (over-validation is a worse trade-off than a clear
// provider error).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build the `thinking` request fragment for extended thinking, validating the
 * `max_tokens > budget_tokens` constraint against the per-request `maxTokens`.
 *
 * @param budgetTokens - configured thinking budget (adapter option).
 * @param requestMaxTokens - `config.maxTokens` for this call, if set.
 * @returns `{ thinking: { type: 'enabled', budget_tokens } }` to spread into
 *   the request, or `undefined` when thinking is disabled.
 * @throws HarnessError(CORE_INVALID_CONFIG) when `requestMaxTokens` is set and
 *   not greater than `budgetTokens`.
 */
export function buildThinkingRequest(
  budgetTokens: number | undefined,
  requestMaxTokens: number | undefined,
): Record<string, unknown> | undefined {
  if (budgetTokens === undefined) return undefined;
  if (requestMaxTokens !== undefined && requestMaxTokens <= budgetTokens) {
    throw new HarnessError(
      `Anthropic extended thinking requires maxTokens (${requestMaxTokens}) to be greater than thinking budgetTokens (${budgetTokens})`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      `Increase config.maxTokens above ${budgetTokens}, or lower the thinking budgetTokens below maxTokens.`,
    );
  }
  return { thinking: { type: 'enabled', budget_tokens: budgetTokens } };
}

// ───────────────────────────────────────────────────────────────────────────
// Prompt caching (adapter-specific, opt-in — see provider-spec.md)
//
// Anthropic activates prompt caching only when a request carries a
// `cache_control: { type: 'ephemeral' }` breakpoint. The pinned SDK's
// block-param types (`@anthropic-ai/sdk` >= 0.30.0, the declared peer floor)
// predate `cache_control` on the *stable* Messages API, so we attach the
// marker structurally and widen back to the SDK type at the call boundary —
// the Anthropic API accepts it at runtime. At most two breakpoints are ever
// emitted (system + last message), well under Anthropic's 4-breakpoint cap.
// ───────────────────────────────────────────────────────────────────────────

/** The ephemeral cache-control breakpoint marker. */
const EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' as const };

/**
 * Build the `system` request parameter, optionally marking it cacheable.
 *
 * - `system === undefined` → `undefined` (no system field emitted).
 * - `cacheSystem === false` → the plain string (unchanged behaviour).
 * - `cacheSystem === true` → a single-element content-block array whose block
 *   carries `cache_control: { type: 'ephemeral' }`. With one block, "the last
 *   system block" is that block, so the whole system prompt becomes a cache
 *   prefix.
 */
export function buildSystemParam(
  system: string | undefined,
  cacheSystem: boolean,
): string | Anthropic.TextBlockParam[] | undefined {
  if (system === undefined) return undefined;
  if (!cacheSystem) return system;
  const block = { type: 'text', text: system, cache_control: EPHEMERAL_CACHE_CONTROL };
  return [block as Anthropic.TextBlockParam];
}

/**
 * Return a copy of `msg` with a `cache_control` breakpoint on its final
 * *cacheable* content block. Setting the breakpoint on the last block of the
 * last message makes the entire conversation prefix cacheable in an agent loop.
 *
 * String content is promoted to a single cacheable text block. For array
 * content the marker is attached to the last block that can legally carry it:
 * Anthropic rejects `cache_control` on `thinking` / `redacted_thinking`
 * blocks, so those are skipped. If every block is a thinking block (nothing
 * cacheable), the message is returned unchanged. Empty-array content is
 * likewise returned unchanged.
 */
export function withLastMessageCacheControl(
  msg: Anthropic.MessageParam,
): Anthropic.MessageParam {
  if (typeof msg.content === 'string') {
    const block = {
      type: 'text',
      text: msg.content,
      cache_control: EPHEMERAL_CACHE_CONTROL,
    };
    return { role: msg.role, content: [block as Anthropic.TextBlockParam] };
  }
  if (msg.content.length === 0) return msg;
  const blocks = msg.content.slice();
  // Walk back past thinking / redacted_thinking blocks — Anthropic rejects
  // cache_control on them — to the last block that can carry the breakpoint.
  let idx = blocks.length - 1;
  while (idx >= 0) {
    const t = (blocks[idx] as { type?: unknown }).type;
    if (t !== 'thinking' && t !== 'redacted_thinking') break;
    idx--;
  }
  if (idx < 0) return msg; // nothing cacheable (all thinking blocks)
  blocks[idx] = {
    ...blocks[idx],
    cache_control: EPHEMERAL_CACHE_CONTROL,
  } as (typeof blocks)[number];
  return { role: msg.role, content: blocks };
}

// ───────────────────────────────────────────────────────────────────────────
// Error normalization (provider-spec.md §"Error mapping")
//
// Raw SDK / network errors are translated into typed `HarnessError`s so
// `AgentLoop.categorizeAdapterError()` can make retry decisions. The SDK
// import in this package is deliberately type-only, so we never `instanceof`
// the SDK's `APIError`; status/code/name are read structurally (duck-typed).
// Message-based classification reuses core's `categorizeAdapterError` rather
// than re-deriving the same regexes here.
// ───────────────────────────────────────────────────────────────────────────

/** Read a numeric `status` off an unknown throwable (SDK `APIError.status`). */
function readErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * True when a throwable represents an aborted request: an external
 * `AbortSignal` fired, or the SDK/runtime surfaced an abort error. Kept
 * identical to the adapter's pre-existing stream abort detection so abort
 * semantics do not change.
 */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'APIUserAbortError') return true;
    const code = (err as { code?: unknown }).code;
    if (code === 'ABORT_ERR') return true;
  }
  return false;
}

/** Map an HTTP status code to a harness error code per the spec table. */
function statusToErrorCode(status: number): HarnessErrorCode {
  if (status === 401 || status === 403) return HarnessErrorCode.ADAPTER_AUTH;
  if (status === 429) return HarnessErrorCode.ADAPTER_RATE_LIMIT;
  if (status === 408) return HarnessErrorCode.ADAPTER_NETWORK; // request timeout
  if (status >= 500) return HarnessErrorCode.ADAPTER_UNAVAILABLE;
  // Other 4xx — invalid request. Keep on the generic ADAPTER_ERROR branch;
  // callers that need finer 4xx handling can inspect `cause`.
  return HarnessErrorCode.ADAPTER_ERROR;
}

/**
 * Low-level connection signals that core's message classifier does not
 * recognise (it keys on `network` / `fetch` / `timeout`, not errno codes or
 * the SDK's connection-error class names). Restricted to unambiguous
 * connection tokens so 5xx-shaped messages still reach `categorizeAdapterError`
 * and classify as `ADAPTER_UNAVAILABLE` (which outranks network in the retry
 * policy).
 */
const CONNECTION_HINT_RE =
  /econnreset|econnrefused|etimedout|epipe|enotfound|eai_again|socket hang up|apiconnection|connection error/i;

/** Actionable remediation hint per error category (lint-error-messages gate). */
function suggestionForCode(code: HarnessErrorCode): string {
  switch (code) {
    case HarnessErrorCode.ADAPTER_AUTH:
      return 'Verify the Anthropic API key is set and valid (check ANTHROPIC_API_KEY); rotate it if it was revoked.';
    case HarnessErrorCode.ADAPTER_RATE_LIMIT:
      return 'Back off and retry with exponential delay, or request a higher rate limit from Anthropic.';
    case HarnessErrorCode.ADAPTER_UNAVAILABLE:
      return 'Retry after a short delay — the provider is temporarily unavailable. Check status.anthropic.com.';
    case HarnessErrorCode.ADAPTER_NETWORK:
      return 'Check network connectivity and retry — the request did not reach the provider.';
    case HarnessErrorCode.ADAPTER_PARSE:
      return 'Retry the request — the provider returned an unparseable response body.';
    default:
      return 'Inspect the error cause and retry if the failure is transient.';
  }
}

/**
 * Normalize a raw Anthropic SDK / network error into a typed
 * `HarnessError` per docs/provider-spec.md's "Error mapping" table.
 *
 * Precedence:
 *   1. Already a `HarnessError` (empty-content guard, strict-extra throw) →
 *      returned unchanged.
 *   2. HTTP `status` present → mapped by {@link statusToErrorCode}.
 *   3. Connection/errno hint → `ADAPTER_NETWORK`.
 *   4. Non-`Error` throwable → `ADAPTER_UNKNOWN`.
 *   5. Otherwise → core's message-based `categorizeAdapterError`.
 *
 * The original throwable is always preserved as `cause`. Abort errors are the
 * caller's responsibility (see {@link isAbortError}) and MUST NOT be routed
 * here — abort keeps its existing semantics.
 */
export function normalizeAnthropicError(err: unknown, label: 'chat' | 'stream'): HarnessError {
  if (err instanceof HarnessError) return err;

  const cause = err instanceof Error ? err : undefined;
  const rawMessage = err instanceof Error ? err.message : String(err);

  let code: HarnessErrorCode;
  const status = readErrorStatus(err);
  if (status !== undefined) {
    code = statusToErrorCode(status);
  } else if (
    err instanceof Error &&
    CONNECTION_HINT_RE.test(
      `${err.name} ${err.message} ${String((err as { code?: unknown }).code ?? '')}`,
    )
  ) {
    code = HarnessErrorCode.ADAPTER_NETWORK;
  } else if (!(err instanceof Error)) {
    // Fully unknown throwable (thrown string, plain object, …).
    code = HarnessErrorCode.ADAPTER_UNKNOWN;
  } else {
    // Reuse core's classifier for anything with a readable message.
    code = categorizeAdapterError(err);
  }

  return new HarnessError(
    `[harness-one/anthropic] ${label}() request to the Anthropic API failed (${code}): ${rawMessage}`,
    code,
    suggestionForCode(code),
    cause,
  );
}
