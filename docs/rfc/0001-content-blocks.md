# RFC-0001: Content blocks on `Message` (thinking / image round-trip)

- Status: Accepted (implemented in the same change series)
- Date: 2026-07-03
- Related: ADR-0001 (explicit loop), ADR-0011 (MCP position), `docs/provider-spec.md`

## Summary

Add an optional, additive `blocks?: readonly ContentBlock[]` field to
`Message`, a `thinking_delta` stream chunk/event, and provider round-trip
support — so extended-thinking tool loops and image-bearing messages become
representable without breaking the existing `content: string` surface.

## Motivation

`Message.content` is a plain `string`. Three provider capabilities that are
table stakes for 2026 agent harnesses cannot round-trip through that model:

1. **Extended thinking + tool use.** Anthropic requires assistant
   `thinking` / `redacted_thinking` blocks (with their signatures) to be
   replayed **verbatim** in the next request when the assistant message
   also carries tool calls. A string cannot carry them, so enabling
   thinking via `LLMConfig.extra` today silently breaks multi-turn tool
   loops.
2. **Image content.** User messages and tool results (e.g. screenshot
   tools — standard in coding agents) cannot carry images.
3. **Future block-shaped content** (citations, server-side tool results)
   has no representation at all.

Every current-generation abstraction (Anthropic/OpenAI native messages,
Vercel AI SDK v5 parts, Claude Agent SDK, OpenAI Agents SDK) is
block-based. Staying string-only is the classic lowest-common-denominator
adapter trap: the interface freezes at the 2023 intersection of providers.

## Design

### Core types (`harness-one/core`)

```ts
export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}
export interface ThinkingBlock {
  readonly type: 'thinking';
  readonly thinking: string;
  /** Provider integrity signature — MUST be replayed verbatim. */
  readonly signature?: string;
}
export interface RedactedThinkingBlock {
  readonly type: 'redacted_thinking';
  /** Opaque provider payload — MUST be replayed verbatim. */
  readonly data: string;
}
export interface ImageBlock {
  readonly type: 'image';
  readonly source:
    | { readonly kind: 'base64'; readonly mediaType: ImageMediaType; readonly data: string }
    | { readonly kind: 'url'; readonly url: string };
}
export type ContentBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ImageBlock;
```

`BaseMessage` gains `readonly blocks?: readonly ContentBlock[]`.

**Invariant (text projection):** when `blocks` is present, `content` MUST
equal the concatenation of the `text` fields of its `TextBlock`s. `content`
stays the canonical *text projection*; block-aware consumers (adapters)
read `blocks`, text-only consumers (guardrails, token estimator, compress,
pruner, redact) keep reading `content` unchanged. A `blocksText()` helper
enforces/derives the projection.

### Streaming

- `StreamChunk.type` gains `'thinking_delta'` with a `thinking?: string`
  fragment field and an optional trailing `signature?: string`.
- `AgentEvent` gains `{ type: 'thinking_delta'; thinking: string }` so UIs
  can render reasoning progress live.
- `StreamAggregator` accumulates thinking fragments into a single
  `ThinkingBlock` (last-received `signature` wins) placed before the text
  block on the reconstructed assistant message. Thinking bytes count
  toward `maxStreamBytes`.

### Provider mapping

- `@harness-one/anthropic`: parses `thinking` / `redacted_thinking` /
  `text` response blocks into `Message.blocks`; replays assistant `blocks`
  verbatim on the next request (thinking first, signatures intact); maps
  `ImageBlock` in user messages and tool results to native image content;
  streams `thinking_delta`. A first-class `thinking` adapter option
  requests extended thinking (budget tokens) instead of the `extra`
  side-channel.
- `@harness-one/openai`: maps `ImageBlock` in user messages to
  `image_url` content parts (base64 → data URL). Thinking blocks are not
  transportable over the public API — dropped on send with a one-time
  warn (documented). Tool-result images degrade to an `[image omitted]`
  text marker (documented).

## Alternatives considered

1. **`content: string | ContentBlock[]` union** — maximal fidelity but
   breaks every `msg.content.length`-style consumer in and out of tree;
   pre-1.0 or not, the migration surface (guardrails, compress, redact,
   estimator, session serialization, all app code) is disproportionate.
   The additive field + projection invariant delivers the same round-trip
   fidelity at a fraction of the blast radius. Revisit the full union at
   1.0 (tracked as an open question below).
2. **Provider-opaque passthrough (`meta.raw`)** — no typed contract;
   adapters can't compose (thinking from one provider leaking into
   another's request); rejected.
3. **Do nothing (status quo)** — leaves extended thinking + multimodal
   unusable; rejected by review finding P0.

## Migration / compatibility

- Purely additive: `blocks` is optional; all existing `Message` literals
  remain valid. `StreamChunk`/`AgentEvent` union widening only affects
  exhaustive `switch`es (add a `thinking_delta` case).
- Session/memory serialization: `blocks` is plain JSON — persists
  transparently. Restored thinking blocks replay correctly because
  signatures ride along.
- Guardrails do NOT scan thinking blocks in this iteration (they scan the
  text projection). Flagged as an explicit non-goal here; follow-up if
  thinking-content policy scanning is needed.

## Open questions

- Full `content` union at 1.0 (drop the projection invariant)?
- Multiple thinking blocks per streamed message (aggregator currently
  coalesces into one)?
- Citations / server-tool blocks — schema TBD when a second provider
  ships a comparable shape.
