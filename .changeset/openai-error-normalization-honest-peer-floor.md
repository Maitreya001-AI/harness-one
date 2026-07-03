---
"@harness-one/openai": minor
---

Normalize OpenAI SDK errors and raise the peer floor to an honest minimum.

**Peer floor raised: `openai` `>=4.0.0` → `>=4.67.0` (user-visible).** The
adapter uses `stream_options: { include_usage: true }` and reads
`usage.prompt_tokens_details.cached_tokens`. Neither exists in `openai@4.0.0`:
`stream_options` (`ChatCompletionStreamOptions`) was added in **openai@4.42.0**
and `CompletionUsage.prompt_tokens_details` (with `cached_tokens`) in
**openai@4.67.0**. On SDKs below the old floor, streaming usage silently
reported zeros (cost under-reporting) and cache-read tokens were absent. The new
floor `>=4.67.0` is the first release supporting **both** features. If you pin
an older `openai`, upgrade to `>=4.67.0`.

**Error normalization (C1b).** `chat()` and `stream()` now translate SDK errors
into typed `HarnessError`s per `docs/provider-spec.md`: `401 → ADAPTER_AUTH`,
`429 → ADAPTER_RATE_LIMIT`, `5xx → ADAPTER_UNAVAILABLE`, timeout/network →
`ADAPTER_NETWORK`, everything else → `ADAPTER_ERROR`, with the original error
preserved as `cause`. The SDK's error classes (`APIError`,
`APIConnectionError`) are used when available, with a structural fallback for
error-like shapes. Stream abort semantics now match the anthropic adapter: a
caller abort surfaces as a clean terminal zero-usage `done` chunk, while a real
mid-flight failure (previously uncaught — the stream body had a `try/finally`
with no `catch`) throws a typed `HarnessError`. On the non-stream path, a caller
abort propagates unchanged so the loop's `CORE_ABORTED` handling still applies.

The compat matrix now brackets the new floor (`openai@4.67.0` / `5.20.0` /
`latest`) and the compat fixture asserts the installed SDK satisfies the floor
and that streaming token usage is reported non-zero.

**Content blocks (RFC-0001).** `Message.blocks` is now honoured on the send
path: user **image blocks** map to OpenAI `image_url` content parts (base64 →
`data:` URL, `url` → direct); messages without an image block keep the
plain-string `content` path unchanged (perf + prompt-cache stability).
Non-representable blocks degrade gracefully with a once-per-instance warning:
assistant **thinking / redacted_thinking** blocks are dropped on send (the text
projection in `content` is preserved) and tool-result **image blocks** are
replaced with an `[image omitted: not representable in OpenAI tool results]`
text marker (OpenAI tool-role messages are text-only).
