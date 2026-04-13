# Provider Adapter Specification

This document is the canonical contract that every `AgentAdapter`
implementation must uphold. It exists because the Anthropic and OpenAI
adapters grew independently and drifted on fields like cache-token
reporting; a new provider author reading either implementation in
isolation cannot tell which behaviours are **required**, which are
**optional**, and which are **idiosyncratic**. This spec is the
resolver.

## Interface

```ts
import type { AgentAdapter } from 'harness-one/core';
```

Source: `packages/core/src/core/types.ts` → `AgentAdapter`.

```ts
interface AgentAdapter {
  readonly name?: string;                                // REQUIRED in practice
  chat(params: ChatParams): Promise<ChatResponse>;       // REQUIRED
  stream?(params: ChatParams): AsyncIterable<StreamChunk>; // OPTIONAL
  countTokens?(messages: readonly Message[]): Promise<number>; // OPTIONAL
}
```

## REQUIRED: `chat(params)`

### Input — `ChatParams`

| Field | Type | Required? | Meaning |
|---|---|---|---|
| `messages` | `readonly Message[]` | yes | Full conversation so far (system → user → assistant → tool). |
| `tools` | `readonly ToolSchema[]` | no | Tools to expose; omit if none. |
| `signal` | `AbortSignal` | no | Adapter MUST forward to the underlying SDK so `loop.abort()` propagates. |
| `config` | `LLMConfig` | no | Generation parameters — see below. |
| `responseFormat` | `ResponseFormat` | no | `text` / `json_object` / `json_schema`. |

### `LLMConfig` handling

- `temperature`, `topP`, `maxTokens`, `stopSequences` — forward to provider
  using their native field names. Adapters SHOULD omit rather than pass
  `undefined` (strict SDK validation may reject).
- `extra` — free-form `Record<string, unknown>`; merge into the provider
  request without interpretation. An adapter MUST NOT drop unknown keys
  silently; if it cannot accept `extra`, throw at construction.

### `responseFormat` handling

- `text` — default; no special handling.
- `json_object` — request JSON mode if the provider supports it; otherwise
  append a system-level hint like `"Respond with a single JSON object."`
- `json_schema` — request strict JSON with schema if supported; otherwise
  fall through to `json_object` + schema in the system prompt.

### Output — `ChatResponse`

```ts
interface ChatResponse {
  readonly message: Message;       // assistant message, may include toolCalls
  readonly usage: TokenUsage;
  readonly raw?: unknown;          // provider-native response for debugging
}
```

`message` MUST be a valid `Message` per `core/types.ts`. If the provider
requests tool calls, the returned message has `role: 'assistant'` and
`toolCalls: ReadonlyArray<ToolCallRequest>`. Each `ToolCallRequest.arguments`
is a **JSON string** (not a parsed object) — adapters are responsible for
serializing the provider's native argument representation into JSON.

### `TokenUsage` reporting

```ts
interface TokenUsage {
  readonly inputTokens: number;        // REQUIRED — zero if truly unknown
  readonly outputTokens: number;       // REQUIRED — zero if truly unknown
  readonly cacheReadTokens?: number;   // OPTIONAL — prompt-cache hits
  readonly cacheWriteTokens?: number;  // OPTIONAL — prompt-cache writes
}
```

Rules:

- Both `inputTokens` and `outputTokens` MUST be finite non-negative
  numbers. Providers that don't return usage should estimate from the
  token-estimator registry rather than report `NaN`.
- Cache tokens SHOULD be reported when the provider exposes them.
  OpenAI's `prompt_tokens_details.cached_tokens` maps to `cacheReadTokens`.
  Anthropic's `cache_read_input_tokens` maps to `cacheReadTokens` and
  `cache_creation_input_tokens` maps to `cacheWriteTokens`.
- Zero-token fallbacks MUST emit a one-time `console.warn` — they
  indicate an adapter bug or an API change.

## `name` convention

The adapter's `name` is used as the `adapter` attribute on iteration
spans (see `AgentLoop`'s span enrichment). Format:

```
<provider>:<model>
```

Examples: `anthropic:claude-sonnet-4`, `openai:gpt-4o`.

This allows trace backends to slice latency/error rate by the specific
model variant.

## OPTIONAL: `stream(params)`

Yields `StreamChunk`s as the provider emits them. The real shape (see
`packages/core/src/core/types.ts` → `StreamChunk`) is a flat interface
discriminated by `type`; the three variants adapters actually emit are:

```ts
// Shape accepted by the harness — only the fields relevant to `type` are set.
type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; toolCall: Partial<ToolCallRequest> }
  | { type: 'done'; usage: TokenUsage };
```

Rules:

- The **final** chunk MUST be `{ type: 'done', usage }`. `done` carries
  usage only — the assistant `Message` (including accumulated `toolCalls`)
  is reconstructed by the caller from the preceding `text_delta` and
  `tool_call_delta` chunks. Do NOT attach a `message` field here.
- `text_delta.text` is the incremental text fragment (not a full running
  buffer); the caller concatenates.
- `tool_call_delta.toolCall` is `Partial<ToolCallRequest>` — `id`,
  `name`, and `arguments` may each be absent or partial across chunks.
  Adapters MUST NOT cast partial argument JSON as a parsed object. See
  the `anthropic/tool_use input` guard in
  `packages/anthropic/src/index.ts`: on JSON-parse failure, substitute
  `{}` and log, never `as Record`.
- Adapters MUST propagate `params.signal` to the streaming SDK so that
  `loop.abort()` cancels the in-flight stream promptly.

## OPTIONAL: `countTokens(messages)`

Returns an accurate provider-side token count. When omitted, the
harness falls back to the heuristic in
`packages/core/src/_internal/token-estimator.ts`. Implement this only
if the provider has an official tokenizer (e.g., `tiktoken` for OpenAI);
a wrong answer is worse than the heuristic's deliberate approximation.

## Error mapping

Adapters SHOULD translate provider-native errors into the harness's
error taxonomy so `AgentLoop.categorizeAdapterError()` can make retry
decisions:

| Condition | Harness category |
|---|---|
| HTTP 401 / invalid key | `ADAPTER_AUTH` |
| HTTP 429 | `ADAPTER_RATE_LIMIT` |
| HTTP 5xx / network failure | `ADAPTER_NETWORK` |
| Timeout / `ECONNRESET` | `ADAPTER_NETWORK` |
| Invalid request / 4xx | `ADAPTER_BAD_REQUEST` |
| Server JSON parse failure | `PROVIDER_ERROR` |

Wrap errors in `HarnessError(message, code, suggestion?, cause?)` — see
`packages/core/src/core/errors.ts`. The human-readable `message` is the
first argument, followed by the programmatic `code`. Preserve the
original error as `cause` so operators can debug.

## Conformance checklist

Copy this list into your adapter PR description:

- [ ] `name` field present and follows `<provider>:<model>` convention
- [ ] `chat()` returns valid `Message` + `TokenUsage`
- [ ] `TokenUsage.inputTokens` / `outputTokens` never `NaN` or negative
- [ ] Cache tokens reported when provider exposes them
- [ ] `params.signal` forwarded on both `chat()` and `stream()`
- [ ] Tool-call argument JSON validated as an object before cast
      (substitute `{}` on failure, log once)
- [ ] Unknown `LLMConfig.extra` keys passed through
- [ ] Provider errors mapped to `HarnessError` with appropriate code
- [ ] Adapter test suite exercises both `chat()` and `stream()` paths
      with valid + invalid tool-call JSON + signal-abort scenarios

## Reference implementations

- `packages/anthropic/src/index.ts` — streaming, cache tokens, strict
  tool-input narrowing.
- `packages/openai/src/index.ts` — streaming, JSON mode, strict schema
  response format, stop sequences.
