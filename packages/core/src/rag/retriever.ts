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
  /** Pre-computed normalized embeddings, parallel to chunks array. undefined for chunks without embeddings. */
  const normalizedEmbeddings: (readonly number[] | undefined)[] = [];

  function normalizeVector(embedding: readonly number[]): readonly number[] | undefined {
    if (embedding.length === 0) return undefined;
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    if (norm === 0) return undefined;
    return embedding.map((v) => v / norm);
  }

  function dotProduct(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }

  return Object.freeze({
    async index(newChunks: readonly DocumentChunk[]): Promise<void> {
      for (const chunk of newChunks) {
        chunks.push(chunk);
        if (chunk.embedding && chunk.embedding.length > 0) {
          normalizedEmbeddings.push(normalizeVector(chunk.embedding));
        } else {
          normalizedEmbeddings.push(undefined);
        }
      }
    },

    async retrieve(
      query: string,
      options?: { limit?: number; minScore?: number },
    ): Promise<RetrievalResult[]> {
      const limit = options?.limit ?? 5;
      const minScore = options?.minScore ?? 0;

      // Embed the query
      const [queryEmbedding] = await config.embedding.embed([query]);

      // Normalize the query embedding once
      const normalizedQuery = normalizeVector(queryEmbedding);

      // Score all chunks that have valid normalized embeddings
      const scored: RetrievalResult[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const normEmb = normalizedEmbeddings[i];
        if (!normEmb) {
          // Chunk has no embedding, empty embedding, or zero-magnitude embedding
          // Still include with score 0 if minScore allows
          if (chunk.embedding && chunk.embedding.length > 0 && 0 >= minScore) {
            scored.push({ chunk, score: 0 });
          }
          continue;
        }
        if (!normalizedQuery) {
          // Query embedding is zero-magnitude
          if (0 >= minScore) {
            scored.push({ chunk, score: 0 });
          }
          continue;
        }
        // Both normalized: cosine similarity = dot product of normalized vectors
        const score = dotProduct(normalizedQuery, normEmb);
        if (score >= minScore) {
          scored.push({ chunk, score });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },
  });
}
