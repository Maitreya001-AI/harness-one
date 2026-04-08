/**
 * In-memory retriever using cosine similarity for the RAG pipeline.
 *
 * @module
 */

import type { DocumentChunk, EmbeddingModel, Retriever, RetrievalResult } from './types.js';

/**
 * Compute cosine similarity between two vectors.
 *
 * Returns 0 for mismatched lengths or zero-magnitude vectors.
 */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Create an in-memory retriever that uses cosine similarity for ranking.
 *
 * Chunks must have embeddings attached (via the pipeline embed step) for
 * retrieval to work. Chunks without embeddings are silently skipped.
 *
 * @example
 * ```ts
 * const retriever = createInMemoryRetriever({ embedding: myEmbeddingModel });
 * await retriever.index(embeddedChunks);
 * const results = await retriever.retrieve('search query', { limit: 5 });
 * ```
 */
export function createInMemoryRetriever(config: {
  embedding: EmbeddingModel;
}): Retriever {
  const chunks: DocumentChunk[] = [];

  return Object.freeze({
    async index(newChunks: readonly DocumentChunk[]): Promise<void> {
      chunks.push(...newChunks);
    },

    async retrieve(
      query: string,
      options?: { limit?: number; minScore?: number },
    ): Promise<RetrievalResult[]> {
      const limit = options?.limit ?? 5;
      const minScore = options?.minScore ?? 0;

      // Embed the query
      const [queryEmbedding] = await config.embedding.embed([query]);

      // Score all chunks that have embeddings
      const scored: RetrievalResult[] = chunks
        .filter((c) => c.embedding && c.embedding.length > 0)
        .map((chunk) => ({
          chunk,
          score: cosineSimilarity(queryEmbedding, chunk.embedding!),
        }))
        .filter((r) => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return scored;
    },
  });
}
