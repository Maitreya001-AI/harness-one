---
"@harness-one/anthropic": minor
---

Anthropic adapter: error normalization, `responseFormat` support, and opt-in
prompt caching.

- **Error normalization.** `chat()` and `stream()` (setup, iteration, and
  `finalMessage()`) now wrap raw SDK / network errors in typed `HarnessError`s
  per the provider-spec "Error mapping" table: 401/403 → `ADAPTER_AUTH`,
  429 → `ADAPTER_RATE_LIMIT`, 5xx → `ADAPTER_UNAVAILABLE`, timeout/ECONNRESET/
  network → `ADAPTER_NETWORK`, other 4xx → `ADAPTER_ERROR`, non-`Error`
  throwables → `ADAPTER_UNKNOWN`. HTTP status is read structurally (the SDK
  import stays type-only); message-based classification reuses core's
  `categorizeAdapterError`. The original error is always preserved as `cause`.
  Abort semantics are unchanged — `chat()` rethrows the raw abort error and
  `stream()` yields a terminal zero-usage `done` chunk.

- **`responseFormat` support.** `ChatParams.responseFormat` is now honoured.
  Anthropic has no native JSON mode, so `json_object` appends a
  "Respond with a single JSON object." system instruction and `json_schema`
  additionally embeds the serialized schema; both compose with an existing
  system message and apply on the streaming path. `text` is a no-op.

- **Prompt-cache write path.** New opt-in `promptCaching?: { system?: boolean;
  lastMessage?: boolean }` factory option emits `cache_control: { type:
  'ephemeral' }` breakpoints so `cacheReadTokens` / `cacheWriteTokens` become
  non-zero. Default is off (undefined) — no behaviour change. At most two
  breakpoints are set (well under Anthropic's cap of four).

- **Content blocks: extended thinking + images (RFC-0001).** The adapter now
  round-trips `Message.blocks`:
  - Response `thinking` / `redacted_thinking` blocks parse into
    `Message.blocks` (reasoning first, then the text block) with `content`
    kept as the text projection; assistant `blocks` replay **verbatim**
    (signatures intact, thinking before `tool_use`) so multi-turn extended-
    thinking tool loops work.
  - New opt-in `thinking?: { budgetTokens: number }` factory option requests
    Anthropic extended thinking (`thinking: { type: 'enabled', budget_tokens }`)
    on chat() and stream(); throws `HarnessError(CORE_INVALID_CONFIG)` when a
    per-call `maxTokens` is set and not greater than `budgetTokens`.
  - Streaming emits `thinking_delta` chunks (incremental reasoning, trailing
    `signature`, and `redactedData` for redacted blocks).
  - `ImageBlock`s in user messages and tool results map to native Anthropic
    image content (base64 + url sources); tool-result images become a mixed
    text+image `tool_result` array.
  - When `promptCaching.lastMessage` meets thinking, the cache breakpoint is
    placed on the last non-thinking block (Anthropic rejects `cache_control`
    on thinking blocks).

  Purely additive: messages without `blocks` and adapters without the
  `thinking` option are unaffected.
