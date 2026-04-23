# Embedding Model Specification

This document defines the public contract for `EmbeddingModel`
implementations consumed by `harness-one/rag`.

## Interface

```ts
import type { EmbedOptions, EmbeddingModel } from 'harness-one/rag';

interface EmbeddingModel {
  readonly dimensions: number;
  readonly maxBatchSize?: number;
  embed(
    texts: readonly string[],
    options?: EmbedOptions,
  ): Promise<readonly (readonly number[])[]>;
}
```

### `EmbedOptions`

| Field | Type | Required? | Meaning |
|---|---|---|---|
| `signal` | `AbortSignal` | no | Abort in-flight embedding promptly. |

## Required behavior

- `embed([])` MUST resolve to `[]`.
- The returned array length MUST equal the input `texts.length`.
- Every vector element MUST be a finite number.
- Every vector length MUST equal `dimensions`.
- If `signal` is already aborted, the call SHOULD reject immediately with `HarnessErrorCode.CORE_ABORTED`.

## `dimensions`

`dimensions` is the declared output size for every produced vector. If the
implementation returns vectors of a different size, callers may reject with
`RAG_EMBEDDING_MISMATCH`.

Do not guess. If the upstream provider exposes model dimensions, surface the
real value.

## `maxBatchSize`

`maxBatchSize` is optional but important for production adapters:

- Set it when the provider has a hard request ceiling.
- Leave it undefined only when no authoritative limit exists.
- The value MUST be a positive integer.

`createRAGPipeline()` honors `maxBatchSize` during ingest batching, so
declaring it lets the pipeline stay within provider limits without
adapter-specific logic.

## Error mapping

| Condition | Recommended `HarnessErrorCode` |
|---|---|
| Aborted signal | `CORE_ABORTED` |
| Auth failure | `ADAPTER_AUTH` |
| Rate limit | `ADAPTER_RATE_LIMIT` |
| Timeout / network failure | `ADAPTER_NETWORK` or `ADAPTER_UNAVAILABLE` |
| Invalid provider config | `ADAPTER_INVALID_EXTRA` or `CORE_INVALID_CONFIG` |
| Returned vector count / shape mismatch | `RAG_EMBEDDING_MISMATCH` |
| Unknown provider failure | `ADAPTER_ERROR` |

## Conformance

Every embedding adapter package should run:

```ts
import { runEmbeddingModelConformance } from 'harness-one/rag';
```

The conformance kit checks empty input, vector cardinality, declared
dimensions, abort behavior, and `maxBatchSize` sanity.

## PR checklist

- [ ] `dimensions` matches actual returned vector length
- [ ] `maxBatchSize` is declared when the provider has a real limit
- [ ] `AbortSignal` is forwarded and covered by tests
- [ ] `runEmbeddingModelConformance(runner, factory)` passes
- [ ] Empty input is handled without a network call where practical
- [ ] Errors are mapped to `HarnessError` / `HarnessErrorCode`
- [ ] README includes a minimal runnable example
- [ ] `harness-one` peer dependency is declared correctly
