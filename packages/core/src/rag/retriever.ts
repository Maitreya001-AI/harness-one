/**
 * In-memory retriever using cosine similarity for the RAG pipeline.
 *
 * @module
 */

import type { DocumentChunk, EmbeddingModel, Retriever, RetrievalResult } from './types.js';
import { HarnessError } from '../core/errors.js';
import { createLazyAsync, type LazyAsync } from '../_internal/lazy-async.js';

/** Extended retrieval result that includes skipped chunk tracking (Fix 15). */
export interface ExtendedRetrievalResult {
  readonly results: RetrievalResult[];
  /** Number of chunks skipped due to missing or zero-magnitude embeddings. */
  readonly skippedChunks: number;
}

/**
 * SEC-010: Per-call options for retrieve(). Callers that serve multiple
 * tenants MUST supply `tenantId` or `scope` so the query-embedding cache
 * never returns an embedding cached under a different tenant/scope.
 */
export interface RetrieveOptions {
  readonly limit?: number;
  readonly minScore?: number;
  /** SEC-010: Per-tenant cache partition key. */
  readonly tenantId?: string;
  /** SEC-010: Alternative name for partition key (e.g. workspace/org scope). */
  readonly scope?: string;
}

/** Default maximum query length (characters) accepted by retrieve(). */
const DEFAULT_MAX_QUERY_LENGTH = 16_384;

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
  /**
   * SEC-010: Maximum query length (in characters) accepted by retrieve().
   * Queries longer than this limit are rejected with a HarnessError to
   * prevent DoS / accidental embedding-cost blow-ups. Default: 16_384.
   */
  maxQueryLength?: number;
}): Retriever & { retrieveExtended(query: string, options?: RetrieveOptions): Promise<ExtendedRetrievalResult> } {
  const chunks: DocumentChunk[] = [];
  /** Pre-computed normalized embeddings, parallel to chunks array. undefined for chunks without embeddings. */
  const normalizedEmbeddings: (readonly number[] | undefined)[] = [];

  // LRU cache for query embeddings to avoid redundant API calls for repeated queries.
  const queryCacheMax = config.queryCacheSize ?? 64;
  const queryEmbeddingCache = new Map<string, readonly number[]>();
  // A1-8 (Wave 4b): per-cache-key in-flight lazy handles. When two concurrent
  // `retrieve()` calls observe a cache miss for the same key, the previous
  // implementation issued two embed() calls because the "miss detection ->
  // await embed -> set cache" sequence races across the await. `createLazyAsync`
  // stores the in-flight promise synchronously, so the second caller joins the
  // first's promise instead of kicking a duplicate. On rejection the lazy
  // entry clears itself (and we remove our map slot) so the next caller retries.
  const inflightEmbeds = new Map<string, LazyAsync<readonly number[]>>();
  // Fix 16: Cache version for invalidation
  const cacheVersion = config.cacheVersion ?? '';
  // SEC-010: Maximum query length (reject longer queries)
  const maxQueryLength = config.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH;

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

  // Fix 16 + SEC-010: Build cache key including version and tenant/scope.
  // Unique escaping ('|' between segments + 't='/'s=' labels) prevents
  // collisions across distinct (tenant, query) pairs.
  function buildCacheKey(query: string, tenant?: string, scope?: string): string {
    const parts: string[] = [];
    if (cacheVersion) parts.push(`v=${cacheVersion}`);
    if (tenant !== undefined) parts.push(`t=${tenant}`);
    if (scope !== undefined) parts.push(`s=${scope}`);
    parts.push(`q=${query}`);
    return parts.join('|');
  }

  function enforceQueryLength(query: string): void {
    if (query.length > maxQueryLength) {
      throw new HarnessError(
        `Query length ${query.length} exceeds maxQueryLength ${maxQueryLength}`,
        'RAG_QUERY_TOO_LONG',
        `Shorten the query below ${maxQueryLength} characters or raise maxQueryLength`,
      );
    }
  }

  async function getQueryEmbedding(query: string, tenant?: string, scope?: string): Promise<readonly number[]> {
    const cacheKey = buildCacheKey(query, tenant, scope);
    const cached = queryEmbeddingCache.get(cacheKey);
    if (cached) {
      // LRU touch: move to end
      queryEmbeddingCache.delete(cacheKey);
      queryEmbeddingCache.set(cacheKey, cached);
      return cached;
    }

    // A1-8 (Wave 4b): share one embed() call across concurrent cache misses.
    // If another caller has already kicked off the embed for this key, join
    // that in-flight promise instead of starting a duplicate.
    let lazy = inflightEmbeds.get(cacheKey);
    if (!lazy) {
      lazy = createLazyAsync(async () => {
        const [embedding] = await config.embedding.embed([query]);
        return embedding;
      });
      inflightEmbeds.set(cacheKey, lazy);
    }
    let embedding: readonly number[];
    try {
      embedding = await lazy.get();
    } catch (err) {
      // Evict the lazy entry on rejection so the next caller retries from
      // scratch (createLazyAsync already cleared its internal promise cache).
      if (inflightEmbeds.get(cacheKey) === lazy) {
        inflightEmbeds.delete(cacheKey);
      }
      throw err;
    }
    // Happy path: remove the inflight slot once the promise settles. We
    // intentionally keep the slot until AFTER the await so that a concurrent
    // caller entering getQueryEmbedding during the same microtask joins the
    // SAME lazy instead of re-creating one.
    if (inflightEmbeds.get(cacheKey) === lazy) {
      inflightEmbeds.delete(cacheKey);
    }

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
      options?: RetrieveOptions,
    ): Promise<RetrievalResult[]> {
      // SEC-010: Reject oversized queries before touching the cache or the
      // embedding model.
      enforceQueryLength(query);

      const limit = options?.limit ?? 5;
      const minScore = options?.minScore ?? 0;

      const queryEmbedding = await getQueryEmbedding(query, options?.tenantId, options?.scope);
      const normalizedQuery = normalizeVector(queryEmbedding);
      const { scored } = scoreChunks(normalizedQuery, minScore);

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },

    /** Fix 15: Extended retrieve that includes skippedChunks count. */
    async retrieveExtended(
      query: string,
      options?: RetrieveOptions,
    ): Promise<ExtendedRetrievalResult> {
      // SEC-010: Same length guard as retrieve().
      enforceQueryLength(query);

      const limit = options?.limit ?? 5;
      const minScore = options?.minScore ?? 0;

      const queryEmbedding = await getQueryEmbedding(query, options?.tenantId, options?.scope);
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
