# Retriever Specification

This document is the canonical contract for `Retriever` implementations
consumed through `harness-one/rag`. It exists so future packages such as
`@harness-one/pinecone` or `@harness-one/pgvector` can target one stable
surface instead of reverse-engineering the in-memory retriever.

## Interface

```ts
import type {
  DocumentChunk,
  IndexOptions,
  RetrievalResult,
  Retriever,
  RetrieveOptions,
} from 'harness-one/rag';

interface Retriever {
  index(chunks: readonly DocumentChunk[], options?: IndexOptions): Promise<void>;
  retrieve(query: string, options?: RetrieveOptions): Promise<RetrievalResult[]>;
  clear?(): void | Promise<void>;
}
```

### `IndexOptions`

| Field | Type | Required? | Meaning |
|---|---|---|---|
| `signal` | `AbortSignal` | no | Abort in-flight indexing promptly. An already-aborted signal MUST reject immediately. |

### `RetrieveOptions`

| Field | Type | Required? | Meaning |
|---|---|---|---|
| `limit` | `number` | no | Max number of returned results. |
| `minScore` | `number` | no | Filter out results below this score. |
| `filter` | `Record<string, unknown>` | no | Metadata filter. The common denominator contract is a plain object. |
| `signal` | `AbortSignal` | no | Abort promptly. An already-aborted signal MUST reject immediately. |
| `tenantId` | `string` | no | Cache partition key for multi-tenant retrievers. |
| `scope` | `string` | no | Alternative partition key name when `tenantId` is not the natural label. |

## Required behavior

- `index([])` MUST succeed and resolve.
- `retrieve(query, options)` MUST return results sorted by descending `score`.
- `limit` MUST cap the returned result count.
- `minScore` MUST guarantee every returned result has `score >= minScore`.
- Chunks without usable embeddings MUST be skipped instead of crashing the retriever.
- `signal` MUST be honored on both `index()` and `retrieve()`. The recommended error is `HarnessErrorCode.CORE_ABORTED`.
- Metadata filtering MUST accept a plain-object filter. Richer backend-native grammars are allowed, but the README MUST document them explicitly.

## Clear semantics

`clear()` is optional at the type level but strongly recommended for any
mutable retriever. The in-memory retriever implements it and the
conformance kit will exercise it when present.

If your backend does not support destructive clearing in production, expose
`clear()` only in tests or on ephemeral implementations.

## Repeated ids

`DocumentChunk.id` is a stable identifier for callers, but the base contract
does not hard-code overwrite vs. append vs. ignore semantics for repeated
`index()` calls. Your implementation MUST document which behavior it chose.

The built-in in-memory retriever is append-only: indexing the same id twice
stores two entries.

## Error mapping

| Condition | Recommended `HarnessErrorCode` |
|---|---|
| Aborted signal | `CORE_ABORTED` |
| Query too long / payload too large | `RAG_QUERY_TOO_LONG` or `ADAPTER_PAYLOAD_OVERSIZED` |
| Query/document embedding dimensions differ | `RAG_EMBEDDING_MISMATCH` |
| Upstream auth failure | `ADAPTER_AUTH` |
| Upstream rate limit | `ADAPTER_RATE_LIMIT` |
| Upstream network / timeout | `ADAPTER_NETWORK` or `ADAPTER_UNAVAILABLE` |
| Backend-specific unknown failure | `ADAPTER_ERROR` or namespaced custom code |

## Conformance

Every retriever package should run:

```ts
import { runRetrieverConformance } from 'harness-one/rag';
```

The factory passed to the kit should use deterministic test doubles or a
stable local backend so the suite can validate score ordering, limit, and
filter behavior against a known fixture corpus.

## PR checklist

- [ ] `index()` and `retrieve()` implement all required fields
- [ ] `AbortSignal` is forwarded and covered by tests
- [ ] `runRetrieverConformance(runner, factory)` passes
- [ ] README documents repeated-id behavior
- [ ] README documents supported filter syntax
- [ ] Errors are mapped to `HarnessError` / `HarnessErrorCode`
- [ ] Package declares the correct `harness-one` peer dependency
- [ ] Documentation includes a minimal runnable example
