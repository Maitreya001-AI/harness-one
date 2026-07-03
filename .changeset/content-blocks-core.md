---
"harness-one": minor
---

Content blocks on `Message` (RFC-0001) — extended thinking and images
become representable without breaking the `content: string` surface:

- New `ContentBlock` union (`TextBlock` / `ThinkingBlock` /
  `RedactedThinkingBlock` / `ImageBlock`) and optional
  `Message.blocks?: readonly ContentBlock[]`. Invariant: when `blocks`
  is present, `content` equals the text projection (new `blocksText()`
  helper). Text-only consumers keep reading `content` unchanged.
- `StreamChunk` gains the `'thinking_delta'` variant
  (`thinking` / `signature` / `redactedData` fields); `AgentEvent`
  gains `{ type: 'thinking_delta'; thinking: string }` so UIs can render
  reasoning progress live.
- `StreamAggregator` accumulates thinking fragments into a single
  `ThinkingBlock` (last signature wins), turns each redacted payload
  into a `RedactedThinkingBlock`, counts both toward `maxStreamBytes`,
  and attaches `blocks` to the reconstructed assistant message.

Additive: existing `Message` literals stay valid; exhaustive switches
over `AgentEvent`/`StreamChunk` need a `thinking_delta` case. Provider
support ships in `@harness-one/anthropic` (parse/replay/thinking option)
and `@harness-one/openai` (image parts, graceful degrade). See
`docs/rfc/0001-content-blocks.md`.

Also: `createCircuitBreaker` / `CircuitOpenError` (+ config/state types)
are now exported from `harness-one/advanced` — previously the circuit
breaker was documented as a resilience mechanism but unreachable from any
public subpath (see `docs/guides/resilience.md`).
