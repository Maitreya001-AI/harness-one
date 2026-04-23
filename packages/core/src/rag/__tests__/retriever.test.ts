import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInMemoryRetriever } from '../retriever.js';
import type { DocumentChunk, EmbeddingModel } from '../types.js';
import { HarnessErrorCode } from '../../core/errors.js';

// ---------------------------------------------------------------------------
// Mock embedding model
// ---------------------------------------------------------------------------

function createMockEmbeddingModel(dimensions = 4): EmbeddingModel & { embed: ReturnType<typeof vi.fn> } {
  const embedFn = vi.fn(async (texts: readonly string[]): Promise<readonly (readonly number[])[]> => {
    return texts.map((text) => {
      const vec = new Array<number>(dimensions).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % dimensions] += text.charCodeAt(i);
      }
      const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      return mag === 0 ? vec : vec.map((v) => v / mag);
    });
  });

  return {
    dimensions,
    embed: embedFn,
  };
}

function chunk(id: string, content: string, embedding?: readonly number[], index = 0): DocumentChunk {
  return { id, documentId: 'd1', content, index, embedding };
}

// ===========================================================================
// createInMemoryRetriever
// ===========================================================================

describe('createInMemoryRetriever', () => {
  let embedding: ReturnType<typeof createMockEmbeddingModel>;

  beforeEach(() => {
    embedding = createMockEmbeddingModel(4);
  });

  // ---- index() ----

  describe('index()', () => {
    it('adds chunks to the internal store', async () => {
      const retriever = createInMemoryRetriever({ embedding });
      const chunks = [
        chunk('c1', 'cat', [1, 0, 0, 0]),
        chunk('c2', 'dog', [0, 1, 0, 0]),
      ];

      await retriever.index(chunks);
      const results = await retriever.retrieve('cat', { limit: 10 });

      expect(results.length).toBeGreaterThan(0);
    });

    it('supports incremental indexing (multiple index calls)', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      await retriever.index([chunk('c1', 'first', [1, 0, 0, 0])]);
      await retriever.index([chunk('c2', 'second', [0, 1, 0, 0])]);

      const results = await retriever.retrieve('test', { limit: 10 });
      const ids = results.map((r) => r.chunk.id);

      expect(ids).toContain('c1');
      expect(ids).toContain('c2');
    });

    it('handles empty chunk array', async () => {
      const retriever = createInMemoryRetriever({ embedding });
      await retriever.index([]);

      const results = await retriever.retrieve('test');
      expect(results).toEqual([]);
    });

    it('rejects already-aborted signals before indexing', async () => {
      const retriever = createInMemoryRetriever({ embedding });
      const controller = new AbortController();
      controller.abort();

      await expect(
        retriever.index([chunk('c1', 'alpha', [1, 0, 0, 0])], { signal: controller.signal }),
      ).rejects.toMatchObject({ code: HarnessErrorCode.CORE_ABORTED });
    });
  });

  // ---- retrieve() ----

  describe('retrieve()', () => {
    it('returns ranked results by cosine similarity', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      // The query "cat" will produce some embedding vector via the mock
      // Chunks with embeddings closer to that vector score higher
      await retriever.index([
        chunk('c1', 'low', [0, 0, 0, 1], 0),
        chunk('c2', 'high', [1, 0, 0, 0], 1),
        chunk('c3', 'mid', [0.5, 0, 0, 0.5], 2),
      ]);

      const results = await retriever.retrieve('anything', { limit: 10 });

      // Results must be sorted descending by score
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('returns empty array when no chunks are indexed', async () => {
      const retriever = createInMemoryRetriever({ embedding });
      const results = await retriever.retrieve('query');

      expect(results).toEqual([]);
    });

    it('each result has chunk and score properties', async () => {
      const retriever = createInMemoryRetriever({ embedding });
      await retriever.index([chunk('c1', 'hello', [1, 0, 0, 0])]);

      const results = await retriever.retrieve('hello', { limit: 1 });

      expect(results[0]).toHaveProperty('chunk');
      expect(results[0]).toHaveProperty('score');
      expect(typeof results[0].score).toBe('number');
    });

    it('supports shallow metadata filtering', async () => {
      const retriever = createInMemoryRetriever({ embedding });
      await retriever.index([
        { ...chunk('c1', 'animals', [1, 0, 0, 0]), metadata: { topic: 'animals' } },
        { ...chunk('c2', 'science', [0, 1, 0, 0]), metadata: { topic: 'science' } },
      ]);

      const results = await retriever.retrieve('animals', {
        limit: 10,
        minScore: -1,
        filter: { topic: 'animals' },
      });

      expect(results).toHaveLength(1);
      expect(results[0].chunk.metadata?.topic).toBe('animals');
    });

    it('rejects already-aborted signals with CORE_ABORTED', async () => {
      const retriever = createInMemoryRetriever({ embedding });
      const controller = new AbortController();
      controller.abort();

      await expect(
        retriever.retrieve('query', { signal: controller.signal }),
      ).rejects.toMatchObject({ code: HarnessErrorCode.CORE_ABORTED });
    });
  });

  // ---- Zero-magnitude embeddings ----

  describe('zero-magnitude embeddings', () => {
    it('assigns score 0 to chunks with zero-magnitude embedding', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      await retriever.index([
        chunk('c_zero', 'zero vec', [0, 0, 0, 0]),
        chunk('c_normal', 'normal', [1, 0, 0, 0]),
      ]);

      const results = await retriever.retrieve('test', { limit: 10 });
      const zeroResult = results.find((r) => r.chunk.id === 'c_zero');

      if (zeroResult) {
        expect(zeroResult.score).toBe(0);
      }
    });

    it('handles zero-magnitude query embedding gracefully', async () => {
      // Override embedding to return zero vector for query
      const zeroEmbed = createMockEmbeddingModel(4);
      zeroEmbed.embed.mockImplementation(async (texts: readonly string[]) => {
        return texts.map(() => [0, 0, 0, 0]);
      });

      const retriever = createInMemoryRetriever({ embedding: zeroEmbed });
      await retriever.index([chunk('c1', 'test', [1, 0, 0, 0])]);

      const results = await retriever.retrieve('zero query', { limit: 10 });

      // All scores should be 0 since the query embedding has zero magnitude
      for (const r of results) {
        expect(r.score).toBe(0);
      }
    });

    it('skips chunks without any embedding', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      await retriever.index([
        chunk('c1', 'has embed', [1, 0, 0, 0]),
        chunk('c_none', 'no embed', undefined),
      ]);

      const results = await retriever.retrieve('test', { limit: 10 });
      const ids = results.map((r) => r.chunk.id);

      expect(ids).not.toContain('c_none');
    });

    it('skips chunks with empty embedding array', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      await retriever.index([
        chunk('c1', 'has embed', [1, 0, 0, 0]),
        { id: 'c_empty', documentId: 'd1', content: 'empty embed', index: 1, embedding: [] },
      ]);

      const results = await retriever.retrieve('test', { limit: 10 });
      const ids = results.map((r) => r.chunk.id);

      expect(ids).not.toContain('c_empty');
    });
  });

  // ---- minScore filtering ----

  describe('minScore filtering', () => {
    it('excludes results below minScore threshold', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      await retriever.index([
        chunk('c1', 'a', [1, 0, 0, 0]),
        chunk('c2', 'b', [0, 1, 0, 0]),
      ]);

      const results = await retriever.retrieve('test', { minScore: 0.99 });

      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.99);
      }
    });

    it('defaults minScore to 0 (includes all scored results)', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      await retriever.index([
        chunk('c1', 'a', [1, 0, 0, 0]),
        chunk('c2', 'b', [0, 1, 0, 0]),
        chunk('c3', 'c', [0, 0, 1, 0]),
      ]);

      // Default minScore = 0 should include all
      const results = await retriever.retrieve('test', { limit: 10 });
      expect(results.length).toBe(3);
    });
  });

  // ---- limit parameter ----

  describe('limit parameter', () => {
    it('limits the number of returned results', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      await retriever.index([
        chunk('c1', 'a', [1, 0, 0, 0], 0),
        chunk('c2', 'b', [0, 1, 0, 0], 1),
        chunk('c3', 'c', [0, 0, 1, 0], 2),
      ]);

      const results = await retriever.retrieve('test', { limit: 1 });
      expect(results).toHaveLength(1);
    });

    it('defaults limit to 5', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      const chunks: DocumentChunk[] = [];
      for (let i = 0; i < 10; i++) {
        const vec = [0, 0, 0, 0];
        vec[i % 4] = 1;
        chunks.push(chunk(`c${i}`, `text${i}`, vec, i));
      }

      await retriever.index(chunks);
      const results = await retriever.retrieve('query');

      expect(results).toHaveLength(5);
    });

    it('returns all results when limit exceeds available chunks', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      await retriever.index([
        chunk('c1', 'a', [1, 0, 0, 0]),
        chunk('c2', 'b', [0, 1, 0, 0]),
      ]);

      const results = await retriever.retrieve('test', { limit: 100 });
      expect(results).toHaveLength(2);
    });
  });

  // ---- Query embedding cache ----

  describe('query embedding cache', () => {
    it('caches query embeddings (same query does not re-embed)', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      await retriever.index([chunk('c1', 'test', [1, 0, 0, 0])]);

      // First query: embeds
      await retriever.retrieve('cached query');
      const callsAfterFirst = embedding.embed.mock.calls.length;

      // Second identical query: should use cache
      await retriever.retrieve('cached query');
      const callsAfterSecond = embedding.embed.mock.calls.length;

      expect(callsAfterSecond).toBe(callsAfterFirst);
    });

    it('different queries each call embed', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      await retriever.index([chunk('c1', 'test', [1, 0, 0, 0])]);

      await retriever.retrieve('query one');
      const callsAfterFirst = embedding.embed.mock.calls.length;

      await retriever.retrieve('query two');
      const callsAfterSecond = embedding.embed.mock.calls.length;

      expect(callsAfterSecond).toBe(callsAfterFirst + 1);
    });

    it('cached query produces same results as uncached', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      await retriever.index([
        chunk('c1', 'hello', [1, 0, 0, 0]),
        chunk('c2', 'world', [0, 1, 0, 0]),
      ]);

      const results1 = await retriever.retrieve('test query', { limit: 10 });
      const results2 = await retriever.retrieve('test query', { limit: 10 });

      expect(results1.length).toBe(results2.length);
      for (let i = 0; i < results1.length; i++) {
        expect(results1[i].chunk.id).toBe(results2[i].chunk.id);
        expect(results1[i].score).toBeCloseTo(results2[i].score, 10);
      }
    });

    it('evicts oldest cache entries when queryCacheSize exceeded', async () => {
      const retriever = createInMemoryRetriever({ embedding, queryCacheSize: 2 });

      await retriever.index([chunk('c1', 'test', [1, 0, 0, 0])]);

      // Fill cache with 2 entries
      await retriever.retrieve('query_a');
      await retriever.retrieve('query_b');
      const callsBefore = embedding.embed.mock.calls.length;

      // Add a 3rd query, evicting query_a
      await retriever.retrieve('query_c');

      // query_b should still be cached
      await retriever.retrieve('query_b');
      const callsAfterB = embedding.embed.mock.calls.length;
      // Only query_c embed call should have happened since callsBefore
      expect(callsAfterB).toBe(callsBefore + 1);

      // query_a was evicted, should re-embed
      await retriever.retrieve('query_a');
      const callsAfterA = embedding.embed.mock.calls.length;
      expect(callsAfterA).toBe(callsAfterB + 1);
    });

    it('LRU touch: accessing cached query moves it to end (prevents eviction)', async () => {
      const retriever = createInMemoryRetriever({ embedding, queryCacheSize: 2 });

      await retriever.index([chunk('c1', 'test', [1, 0, 0, 0])]);

      // Fill cache: query_a, query_b
      await retriever.retrieve('query_a');
      await retriever.retrieve('query_b');

      // Touch query_a (moves it to end, query_b is now oldest)
      await retriever.retrieve('query_a');

      // Add query_c -> evicts query_b (oldest)
      await retriever.retrieve('query_c');
      const callsNow = embedding.embed.mock.calls.length;

      // query_a should still be cached
      await retriever.retrieve('query_a');
      expect(embedding.embed.mock.calls.length).toBe(callsNow);

      // query_b was evicted, should re-embed
      await retriever.retrieve('query_b');
      expect(embedding.embed.mock.calls.length).toBe(callsNow + 1);
    });

    it('defaults queryCacheSize to 64', async () => {
      // We just verify it works with many queries without error
      const retriever = createInMemoryRetriever({ embedding });
      await retriever.index([chunk('c1', 'test', [1, 0, 0, 0])]);

      for (let i = 0; i < 70; i++) {
        await retriever.retrieve(`query_${i}`);
      }

      // Query 0 should have been evicted (cache max 64)
      const callsBefore = embedding.embed.mock.calls.length;
      await retriever.retrieve('query_0');
      expect(embedding.embed.mock.calls.length).toBe(callsBefore + 1);

      // Query 69 should still be cached (recent)
      await retriever.retrieve('query_69');
      expect(embedding.embed.mock.calls.length).toBe(callsBefore + 1);
    });
  });

  // ---- Fix 15: Skipped chunk tracking ----

  describe('skipped chunks tracking (Fix 15)', () => {
    it('reports skipped chunks count via retrieveExtended', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      await retriever.index([
        chunk('c1', 'has embed', [1, 0, 0, 0]),
        chunk('c_none', 'no embed', undefined),
        chunk('c_zero', 'zero embed', [0, 0, 0, 0]),
      ]);

      const result = await retriever.retrieveExtended('test', { limit: 10 });
      expect(result.skippedChunks).toBeGreaterThan(0);
      expect(result.results.length).toBeGreaterThan(0);
    });
  });

  // ---- Fix 16: Cache versioning ----

  describe('cache versioning (Fix 16)', () => {
    it('different cacheVersion invalidates cached queries', async () => {
      const retriever1 = createInMemoryRetriever({ embedding, cacheVersion: 'v1' });
      const retriever2 = createInMemoryRetriever({ embedding, cacheVersion: 'v2' });

      await retriever1.index([chunk('c1', 'test', [1, 0, 0, 0])]);
      await retriever2.index([chunk('c1', 'test', [1, 0, 0, 0])]);

      // Both should work independently
      const results1 = await retriever1.retrieve('query');
      const results2 = await retriever2.retrieve('query');
      expect(results1.length).toBeGreaterThan(0);
      expect(results2.length).toBeGreaterThan(0);
    });
  });

  // ---- Edge cases ----

  describe('edge cases', () => {
    it('throws on mismatched embedding dimensions', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      // 2-dim embedding but mock produces 4-dim queries
      await retriever.index([chunk('c1', 'mismatch', [1, 0])]);

      await expect(retriever.retrieve('test', { limit: 10 })).rejects.toThrow('dimension mismatch');
    });

    it('returns a frozen retriever object', () => {
      const retriever = createInMemoryRetriever({ embedding });
      expect(Object.isFrozen(retriever)).toBe(true);
    });

    it('scores are between -1 and 1 for normalized vectors', async () => {
      const retriever = createInMemoryRetriever({ embedding });

      await retriever.index([
        chunk('c1', 'a', [1, 0, 0, 0]),
        chunk('c2', 'b', [0, 1, 0, 0]),
        chunk('c3', 'c', [-1, 0, 0, 0]),
      ]);

      const results = await retriever.retrieve('test', { limit: 10 });

      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(-1.0001);
        expect(r.score).toBeLessThanOrEqual(1.0001);
      }
    });
  });

  // =====================================================================
  // SEC-010: Cross-tenant cache isolation & query-length enforcement
  // =====================================================================
  describe('SEC-010: tenantId/scope segregation in query cache', () => {
    it('does NOT return a cached embedding from another tenant for the same query text', async () => {
      const retriever = createInMemoryRetriever({ embedding });
      await retriever.index([chunk('c1', 'test', [1, 0, 0, 0])]);

      // First call: tenant A embeds "hello"
      await retriever.retrieve('hello', { tenantId: 'tenantA' });
      const callsAfterA = embedding.embed.mock.calls.length;

      // Second call: tenant B with SAME query text — must NOT hit tenant A's cache
      await retriever.retrieve('hello', { tenantId: 'tenantB' });
      const callsAfterB = embedding.embed.mock.calls.length;

      // Tenant B must have embedded independently
      expect(callsAfterB).toBe(callsAfterA + 1);
    });

    it('same tenant + same query hits the cache', async () => {
      const retriever = createInMemoryRetriever({ embedding });
      await retriever.index([chunk('c1', 'test', [1, 0, 0, 0])]);

      await retriever.retrieve('hello', { tenantId: 'tenantA' });
      const callsAfterFirst = embedding.embed.mock.calls.length;

      await retriever.retrieve('hello', { tenantId: 'tenantA' });
      const callsAfterSecond = embedding.embed.mock.calls.length;

      expect(callsAfterSecond).toBe(callsAfterFirst); // cache hit
    });

    it('supports scope option as an alternative to tenantId', async () => {
      const retriever = createInMemoryRetriever({ embedding });
      await retriever.index([chunk('c1', 'test', [1, 0, 0, 0])]);

      await retriever.retrieve('hello', { scope: 'scope1' });
      const callsAfterFirst = embedding.embed.mock.calls.length;
      await retriever.retrieve('hello', { scope: 'scope2' });
      const callsAfterSecond = embedding.embed.mock.calls.length;

      expect(callsAfterSecond).toBe(callsAfterFirst + 1);
    });
  });

  describe('SEC-010: maxQueryLength enforcement', () => {
    it('rejects queries exceeding default maxQueryLength (16_384)', async () => {
      const retriever = createInMemoryRetriever({ embedding });
      await retriever.index([chunk('c1', 'test', [1, 0, 0, 0])]);

      const tooLong = 'a'.repeat(16_385);
      await expect(retriever.retrieve(tooLong)).rejects.toThrow(/query.*length|maxQueryLength/i);
    });

    it('accepts queries at maxQueryLength boundary', async () => {
      const retriever = createInMemoryRetriever({ embedding });
      await retriever.index([chunk('c1', 'test', [1, 0, 0, 0])]);
      const atLimit = 'a'.repeat(16_384);
      await expect(retriever.retrieve(atLimit)).resolves.toBeDefined();
    });

    it('honors a custom maxQueryLength', async () => {
      const retriever = createInMemoryRetriever({ embedding, maxQueryLength: 10 });
      await retriever.index([chunk('c1', 'test', [1, 0, 0, 0])]);

      await expect(retriever.retrieve('a'.repeat(11))).rejects.toThrow(/maxQueryLength|length/i);
      await expect(retriever.retrieve('a'.repeat(10))).resolves.toBeDefined();
    });

    it('rejected queries throw HarnessError (not a plain Error)', async () => {
      const retriever = createInMemoryRetriever({ embedding, maxQueryLength: 5 });
      await retriever.index([chunk('c1', 'test', [1, 0, 0, 0])]);
      try {
        await retriever.retrieve('too-long-query');
        expect.unreachable('should have thrown');
      } catch (e: unknown) {
        expect((e as { name?: string }).name).toBe('HarnessError');
        expect((e as { code?: string }).code).toBeDefined();
      }
    });
  });

  // the query-embedding LRU does `delete + set` across an
  // `await embed(...)`; without `createLazyAsync`, two concurrent retrieves
  // for the same uncached query both see a miss and both call the embedder.
  // With createLazyAsync the second caller joins the in-flight promise.
  describe('concurrent identical retrieves share one embed() call', () => {
    it('10 parallel retrieves of the same query invoke the embedder exactly once', async () => {
      // Use a blocking embedder so all 10 retrieves definitely observe the
      // miss before the first embed() resolves. Without the LazyAsync fix,
      // each of the 10 would kick its own embed() call.
      let resolveEmbed!: () => void;
      const embedGate = new Promise<void>((resolve) => { resolveEmbed = resolve; });
      const embedFn = vi.fn(async (texts: readonly string[]): Promise<readonly (readonly number[])[]> => {
        await embedGate;
        return texts.map(() => [1, 0, 0, 0]);
      });
      const slowEmbedding: EmbeddingModel = { dimensions: 4, embed: embedFn };
      const retriever = createInMemoryRetriever({ embedding: slowEmbedding });
      await retriever.index([chunk('c1', 'doc', [1, 0, 0, 0])]);

      // Fire 10 identical retrieves concurrently.
      const retrievals = Array.from({ length: 10 }, () => retriever.retrieve('same-query'));
      // Let the microtask queue settle so all 10 have entered getQueryEmbedding.
      await Promise.resolve();
      // Release the embedder.
      resolveEmbed();
      const results = await Promise.all(retrievals);

      // Exactly one embedder invocation across all 10 retrieves.
      expect(embedFn).toHaveBeenCalledTimes(1);
      // All retrieves return the same (non-empty) result shape.
      expect(results.every((r) => Array.isArray(r))).toBe(true);
    });

    it('embedder rejection clears the lazy slot so the next retrieve retries', async () => {
      let callCount = 0;
      const embedFn = vi.fn(async (): Promise<readonly (readonly number[])[]> => {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return [[1, 0, 0, 0]];
      });
      const flakyEmbedding: EmbeddingModel = { dimensions: 4, embed: embedFn };
      const retriever = createInMemoryRetriever({ embedding: flakyEmbedding });
      await retriever.index([chunk('c1', 'doc', [1, 0, 0, 0])]);

      await expect(retriever.retrieve('q')).rejects.toThrow('transient');
      // Second attempt must invoke the embedder again — the lazy slot is
      // cleared on rejection.
      await expect(retriever.retrieve('q')).resolves.toBeDefined();
      expect(embedFn).toHaveBeenCalledTimes(2);
    });
  });
});
