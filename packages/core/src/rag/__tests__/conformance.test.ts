import { describe, expect, it } from 'vitest';
import {
  runChunkingStrategyConformance,
  runEmbeddingModelConformance,
  runRetrieverConformance,
} from '../conformance.js';
import { createBasicFixedSizeChunking } from '../chunking.js';
import { createInMemoryRetriever } from '../retriever.js';
import { AbortedError } from '../../core/errors.js';
import type { EmbedOptions, EmbeddingModel } from '../types.js';

function createDeterministicEmbeddingModel(): EmbeddingModel {
  const lookup: Record<string, readonly number[]> = {
    alpha: [1, 0, 0],
    beta: [0.8, 0.2, 0],
    gamma: [0, 1, 0],
    duplicate: [1, 0, 0],
    '': [1, 0, 0],
  };

  return {
    dimensions: 3,
    maxBatchSize: 2,
    async embed(texts: readonly string[], options?: EmbedOptions) {
      if (options?.signal?.aborted) {
        throw new AbortedError();
      }
      return texts.map((text) => lookup[text] ?? [1, 0, 0]);
    },
  };
}

runRetrieverConformance(
  { describe, it, expect },
  () => createInMemoryRetriever({ embedding: createDeterministicEmbeddingModel() }),
);

runEmbeddingModelConformance(
  { describe, it, expect },
  () => createDeterministicEmbeddingModel(),
);

runChunkingStrategyConformance(
  { describe, it, expect },
  () => createBasicFixedSizeChunking({ chunkSize: 8 }),
);
