# Chunking Strategy Specification

This document is the canonical contract for `ChunkingStrategy`
implementations consumed through `harness-one/rag`. It exists so
domain-specific chunkers — sentence splitters, code-block splitters,
markdown-aware chunkers, or token-budget chunkers — can target one
stable surface instead of reverse-engineering the built-in strategies.

## Interface

```ts
import type {
  ChunkingStrategy,
  Document,
  DocumentChunk,
} from 'harness-one/rag';

interface ChunkingStrategy {
  readonly name: string;
  chunk(document: Document): DocumentChunk[];
}
```

### `Document`

| Field | Type | Required? | Meaning |
|---|---|---|---|
| `id` | `string` | yes | Stable document identifier. Propagates to every emitted chunk via `documentId`. |
| `content` | `string` | yes | Full document text. Implementations MUST tolerate empty strings. |
| `metadata` | `Record<string, unknown>` | no | Free-form document metadata. Strategies SHOULD copy these entries onto each chunk. |
| `source` | `string` | no | Optional provenance label. Not automatically copied onto chunks; if filtering by source matters, write it into `metadata`. |

### `DocumentChunk`

| Field | Type | Required? | Meaning |
|---|---|---|---|
| `id` | `string` | yes | Stable chunk identifier. MUST be unique within the emitted array for a single `chunk()` call. |
| `documentId` | `string` | yes | MUST equal the source `Document.id`. |
| `content` | `string` | yes | Non-empty chunk body. MUST have `length > 0`. |
| `index` | `number` | yes | Zero-based position within the emitted array. `chunks[i].index === i`. |
| `metadata` | `Record<string, unknown>` | no | Per-chunk metadata. When the source `Document.metadata` is present, strategies SHOULD include its entries here. |
| `embedding` | `readonly number[]` | no | Not populated by chunking strategies — the pipeline fills it during the embed stage. Strategies MUST NOT attempt to embed content themselves. |

## Required behavior

- `chunk({ id, content: '' })` MUST return `[]`. Empty input MUST NOT
  throw and MUST NOT emit zero-length chunks.
- Every emitted chunk MUST have `chunk.content.length > 0`. Whitespace-only
  segments SHOULD be dropped. If the document is non-empty but contains
  only whitespace, the strategy MAY return `[]`.
- `chunk.documentId === document.id` for every emitted chunk.
- `chunks[i].index === i`. The returned array MUST be ordered by
  position-in-document and the `index` field MUST match array position.
- `chunks[i].id` MUST be unique within the emitted array. A stable
  `${document.id}_chunk_${i}` naming scheme is recommended but not
  required — any deterministic scheme works.
- When `document.metadata` is provided, each emitted chunk SHOULD
  carry a copy of those entries on `chunk.metadata` so downstream
  metadata filtering works without callers re-attaching them.
- `chunk()` is synchronous. Strategies that need I/O (tokenizer
  warm-up, grammar models) MUST complete that work at construction
  time rather than per-call.

## Purity and determinism

- `chunk(document)` SHOULD be deterministic for a given input: calling
  it twice with the same `document` SHOULD return equivalent chunk
  arrays (same lengths, same ids). This is what makes the RAG
  pipeline's content-hash dedup and re-index flows safe.
- `chunk()` MUST NOT mutate the input `document` or any of its nested
  objects. Treat inputs as readonly even when the TypeScript types
  permit writes.

## Character boundaries

Splitting arbitrary text at arbitrary positions is not free. Implementations
MUST NOT:

- split a UTF-16 surrogate pair (i.e. produce a chunk whose first or
  last code unit is a lone surrogate),
- split in the middle of a multi-code-point grapheme where doing so
  would corrupt the rendered character (e.g. ZWJ emoji sequences).

Implementations SHOULD avoid splitting mid-word for Latin scripts when
the configured chunk size allows a small backward adjustment to a
word boundary. CJK characters (Han, Hangul, Kana) are self-delimiting
and MAY be split at any character boundary between them.

The built-in `createBasicFixedSizeChunking` and
`createBasicSlidingWindowChunking` implement these rules via
`findWordBoundary`; consult `packages/core/src/rag/chunking.ts` for
the reference behavior.

## Error mapping

Chunking is an offline, CPU-only operation — most strategies should never
throw. The recommended discipline is:

| Condition | Recommended `HarnessErrorCode` |
|---|---|
| Invalid configuration (non-positive size, overlap ≥ size, etc.) at factory time | `RAG_INVALID_CONFIG` |
| Input document exceeds an implementation-specific maximum | `RAG_QUERY_TOO_LONG` or a namespaced custom code |
| Unknown failure inside a tokenizer/parser dependency | `ADAPTER_ERROR` or a namespaced custom code |

Throw at **factory** time whenever the configuration is statically
known to be wrong. Throwing from inside `chunk()` per-call turns every
document into a failure and is almost always the wrong behavior.

## Conformance

Every chunking strategy package should run:

```ts
import { runChunkingStrategyConformance } from 'harness-one/rag';

runChunkingStrategyConformance(
  { describe, it, expect },
  () => createMyChunkingStrategy({ /* config */ }),
);
```

The conformance kit verifies:

- `chunk({ content: '' })` returns `[]` without throwing.
- For a non-empty document the strategy emits at least one chunk.
- Every emitted chunk has `documentId === document.id`, matching
  `index`, a non-empty `content`, a string `id`, and inherits the
  source `metadata` entries.

It intentionally does **not** pin a specific chunk size, overlap, or
boundary algorithm — those are implementation decisions. Extend the
conformance suite with strategy-specific tests for any guarantees
your documentation makes beyond the base contract (for example,
"paragraphs are never split" or "output respects a hard token
budget").

## PR checklist

- [ ] `chunk({ id, content: '' })` returns `[]` without throwing
- [ ] Every emitted chunk has non-empty `content`, correct `documentId`,
      and `index === arrayPosition`
- [ ] Document `metadata` is copied onto chunks when present
- [ ] Boundary behavior (word / grapheme / surrogate) is safe against
      multi-byte text — add CJK and emoji fixtures
- [ ] `runChunkingStrategyConformance(runner, factory)` passes
- [ ] Factory-time configuration is validated and throws
      `RAG_INVALID_CONFIG` with actionable messages
- [ ] README documents the overlap / window / boundary contract so
      adapter users can predict chunk layout
- [ ] README includes a minimal runnable example
- [ ] `harness-one` peer dependency is declared correctly
