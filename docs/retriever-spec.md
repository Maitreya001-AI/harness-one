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
| `tenantId` | `string` | no | Partition key for multi-tenant retrievers. When provided, retrieval MUST be scoped to chunks indexed under this tenant (see *Multi-tenant scoping* below). |
| `scope` | `string` | no | Alternative partition-key name when `tenantId` is not the natural label; semantics are identical. `tenantId` takes precedence when both are set. |

## Required behavior

- `index([])` MUST succeed and resolve.
- `retrieve(query, options)` MUST return results sorted by descending `score`.
- `limit` MUST cap the returned result count.
- `minScore` MUST guarantee every returned result has `score >= minScore`.
- Chunks without usable embeddings MUST be skipped instead of crashing the retriever.
- `signal` MUST be honored on both `index()` and `retrieve()`. The recommended error is `HarnessErrorCode.CORE_ABORTED`.
- Metadata filtering MUST accept a plain-object filter. Richer backend-native grammars are allowed, but the README MUST document them explicitly.

## Multi-tenant scoping

`tenantId` / `scope` on `RetrieveOptions` are **optional**. A retriever
has three valid stances:

1. **No tenancy support.** Treat `tenantId` / `scope` as opaque and
   return results from the full index. Document this in your README.
   The base `runRetrieverConformance` suite is sufficient.
2. **Cache partitioning only.** Use `tenantId` / `scope` to scope the
   query-embedding cache key so two tenants cannot observe each other's
   cached embeddings, but return results from a shared index. Document
   this explicitly — callers who need data isolation must NOT rely on
   it.
3. **Index-side isolation.** Associate each indexed chunk with a tenant
   label (via a backend-specific `indexForTenant(...)`, namespace, or
   collection) and ensure `retrieve({ tenantId })` never returns chunks
   indexed under a different tenant. This is the strongest contract and
   is what multi-tenant applications should target.

Retrievers taking stance (3) MUST run
`runRetrieverTenantScopingConformance(runner, factory)` in addition to
the base kit. The kit seeds two tenant partitions, issues queries
scoped to each, and asserts cross-tenant leakage is impossible. It
also exercises `scope` as an alternative label and verifies cached
embeddings do not bypass the scope boundary.

The built-in `createInMemoryRetriever()` is a stance (3) implementation:
`retriever.indexScoped(chunks, tenantId)` associates chunks with a
tenant, and the per-tenant query cache prevents cross-tenant embedding
reuse.

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
- [ ] If the retriever claims tenant isolation, `runRetrieverTenantScopingConformance(runner, factory)` also passes
- [ ] README documents repeated-id behavior
- [ ] README documents the tenancy stance (none / cache-only / index-isolated)
- [ ] README documents supported filter syntax
- [ ] Errors are mapped to `HarnessError` / `HarnessErrorCode`
- [ ] Package declares the correct `harness-one` peer dependency
- [ ] Documentation includes a minimal runnable example
