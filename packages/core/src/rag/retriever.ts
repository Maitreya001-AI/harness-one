/**
 * In-memory retriever using cosine similarity for the RAG pipeline.
 *
 * @module
 */

import type { DocumentChunk, EmbeddingModel, Retriever, RetrievalResult } from './types.js';

/** Extended retrieval result that includes skipped chunk tracking (Fix 15). */
export interface ExtendedRetrievalResult {
  readonly results: RetrievalResult[];
  /** Number of chunks skipped due to missing or zero-magnitude embeddings. */
  readonly skippedChunks: number;
}

/**
 * Create an in-memory retriever that uses cosine similarity for ranking.
 *
 * Chunks must have embeddings attached (via the pipeline embed step) for
 * retrieval to work. Chunks without embeddings are tracked via `skippedChunks`
 * in the extended result (Fix 15).
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
  queryCacheSize?: number;
  /** Fix 16: Optional cache version string. Include in cache key to invalidate stale entries when embedding model changes. */
  cacheVersion?: string;
}): Retriever & { retrieveExtended(query: string, options?: { limit?: number; minScore?: number }): Promise<ExtendedRetrievalResult> } {
  const chunks: DocumentChunk[] = [];
  /** Pre-computed normalized embeddings, parallel to chunks array. undefined for chunks without embeddings. */
  const normalizedEmbeddings: (readonly number[] | undefined)[] = [];

  // LRU cache for query embeddings to avoid redundant API calls for repeated queries.
  const queryCacheMax = config.queryCacheSize ?? 64;
  const queryEmbeddingCache = new Map<string, readonly number[]>();
  // Fix 16: Cache version for invalidation
  const cacheVersion = config.cacheVersion ?? '';

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

  // Fix 16: Build cache key including version
  function buildCacheKey(query: string): string {
    return cacheVersion ? `${cacheVersion}:${query}` : query;
  }

  async function getQueryEmbedding(query: string): Promise<readonly number[]> {
    const cacheKey = buildCacheKey(query);
    const cached = queryEmbeddingCache.get(cacheKey);
    if (cached) {
      // LRU touch: move to end
      queryEmbeddingCache.delete(cacheKey);
      queryEmbeddingCache.set(cacheKey, cached);
      return cached;
    }

    const [embedding] = await config.embedding.embed([query]);
    // Insert into LRU cache
    queryEmbeddingCache.set(cacheKey, embedding);
    if (queryEmbeddingCache.size > queryCacheMax) {
      // Evict oldest (first key in Map insertion order)
      const oldest = queryEmbeddingCache.keys().next().value;
      if (oldest !== undefined) queryEmbeddingCache.delete(oldest);
    }
    return embedding;
  }

  function scoreChunks(normalizedQuery: readonly number[] | undefined, minScore: number): { scored: RetrievalResult[]; skippedChunks: number } {
    let skippedChunks = 0;
    const scored: RetrievalResult[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const normEmb = normalizedEmbeddings[i];
      if (!normEmb) {
        // Fix 15: Track skipped chunks
        if (chunk.embedding && chunk.embedding.length > 0) {
          // Has embedding but zero-magnitude
          skippedChunks++;
          if (0 >= minScore) {
            scored.push({ chunk, score: 0 });
          }
        } else if (!chunk.embedding || chunk.embedding.length === 0) {
          // No embedding at all
          skippedChunks++;
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

    return { scored, skippedChunks };
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

      const queryEmbedding = await getQueryEmbedding(query);
      const normalizedQuery = normalizeVector(queryEmbedding);
      const { scored } = scoreChunks(normalizedQuery, minScore);

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },

    /** Fix 15: Extended retrieve that includes skippedChunks count. */
    async retrieveExtended(
      query: string,
      options?: { limit?: number; minScore?: number },
    ): Promise<ExtendedRetrievalResult> {
      const limit = options?.limit ?? 5;
      const minScore = options?.minScore ?? 0;

      const queryEmbedding = await getQueryEmbedding(query);
      const normalizedQuery = normalizeVector(queryEmbedding);
      const { scored, skippedChunks } = scoreChunks(normalizedQuery, minScore);

      scored.sort((a, b) => b.score - a.score);
      return {
        results: scored.slice(0, limit),
        skippedChunks,
      };
    },
  });
}
