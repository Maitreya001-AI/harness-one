import { describe, it, expect, beforeEach } from 'vitest';
import { createRAGPipeline } from '../pipeline.js';
import { createTextLoader, createDocumentArrayLoader } from '../loaders.js';
import { createFixedSizeChunking, createParagraphChunking } from '../chunking.js';
import { createInMemoryRetriever } from '../retriever.js';
import { HarnessError } from '../../core/errors.js';
import type { Document, EmbeddingModel } from '../types.js';

// ---------------------------------------------------------------------------
// Mock embedding model
// ---------------------------------------------------------------------------

function createMockEmbeddingModel(dimensions = 4): EmbeddingModel {
  return {
    dimensions,
    async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      return texts.map((text) => {
        const vec = new Array<number>(dimensions).fill(0);
        for (let i = 0; i < text.length; i++) {
          vec[i % dimensions] += text.charCodeAt(i);
        }
        const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        return mag === 0 ? vec : vec.map((v) => v / mag);
      });
    },
  };
}

// ===========================================================================
// createRAGPipeline
// ===========================================================================

describe('createRAGPipeline', () => {
  let embedding: EmbeddingModel;

  beforeEach(() => {
    embedding = createMockEmbeddingModel(4);
  });

  // ---- Full pipeline (load -> chunk -> embed -> retrieve) ----

  describe('full pipeline flow', () => {
    it('load -> chunk -> embed -> retrieve produces scored results', async () => {
      const pipeline = createRAGPipeline({
        loader: createTextLoader(['The cat sat on the mat', 'Dogs play in the park']),
        chunking: createFixedSizeChunking({ chunkSize: 100 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      const ingestResult = await pipeline.ingest();
      expect(ingestResult.documents).toBe(2);
      expect(ingestResult.chunks).toBe(2);

      const results = await pipeline.query('cat');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('chunk');
      expect(results[0]).toHaveProperty('score');
    });

    it('works end-to-end with paragraph chunking', async () => {
      const pipeline = createRAGPipeline({
        loader: createTextLoader([
          'Introduction to RAG.\n\nRAG combines retrieval and generation.\n\nIt is powerful.',
        ]),
        chunking: createParagraphChunking(),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      const result = await pipeline.ingest();
      expect(result.documents).toBe(1);
      expect(result.chunks).toBe(3);

      const queryResults = await pipeline.query('retrieval', { limit: 3 });
      expect(queryResults).toHaveLength(3);
    });

    it('works with DocumentArrayLoader', async () => {
      const docs: Document[] = [
        { id: 'custom-1', content: 'Custom doc content', source: 'api' },
      ];

      const pipeline = createRAGPipeline({
        loader: createDocumentArrayLoader(docs),
        chunking: createFixedSizeChunking({ chunkSize: 100 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      const result = await pipeline.ingest();
      expect(result.documents).toBe(1);
      expect(pipeline.getChunks()[0].documentId).toBe('custom-1');
    });

    it('embeds all chunks and attaches embedding vectors', async () => {
      const pipeline = createRAGPipeline({
        loader: createTextLoader(['Hello world']),
        chunking: createFixedSizeChunking({ chunkSize: 5 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingest();
      const chunks = pipeline.getChunks();

      for (const chunk of chunks) {
        expect(chunk.embedding).toBeDefined();
        expect(chunk.embedding!.length).toBe(4);
      }
    });

    it('query returns empty results before ingest', async () => {
      const pipeline = createRAGPipeline({
        loader: createTextLoader(['hello']),
        chunking: createFixedSizeChunking({ chunkSize: 100 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      const results = await pipeline.query('hello');
      expect(results).toEqual([]);
    });
  });

  // ---- ingestDocuments ----

  describe('ingestDocuments()', () => {
    it('ingests pre-loaded documents without a loader', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      const count = await pipeline.ingestDocuments([
        { id: 'doc-1', content: 'Hello world' },
        { id: 'doc-2', content: 'Another doc' },
      ]);

      expect(count).toBe(2);
      expect(pipeline.getChunks()).toHaveLength(2);
    });

    it('treats documents as single chunks when no chunking strategy', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingestDocuments([
        { id: 'doc-1', content: 'Long content that would be chunked' },
      ]);

      const chunks = pipeline.getChunks();
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('Long content that would be chunked');
    });

    it('uses chunking strategy when provided', async () => {
      const pipeline = createRAGPipeline({
        chunking: createFixedSizeChunking({ chunkSize: 5 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      const count = await pipeline.ingestDocuments([
        { id: 'doc-1', content: 'Hello world' }, // 11 chars -> 3 chunks at size 5
      ]);

      expect(count).toBeGreaterThan(1);
    });

    it('allows querying after ingestDocuments', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingestDocuments([
        { id: 'doc-1', content: 'The cat sat on the mat' },
      ]);

      const results = await pipeline.query('cat');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ---- ingest() errors ----

  describe('ingest() without loader', () => {
    it('throws HarnessError with RAG_NO_LOADER when no loader configured', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await expect(pipeline.ingest()).rejects.toThrow(HarnessError);
      await expect(pipeline.ingest()).rejects.toThrow('No loader configured');
    });
  });

  // ---- Embedding mismatch ----

  describe('embedding mismatch', () => {
    it('throws RAG_EMBEDDING_MISMATCH when embedding count differs from chunk count', async () => {
      const brokenEmbedding: EmbeddingModel = {
        dimensions: 4,
        async embed() {
          return [[1, 0, 0, 0]]; // Always returns 1 embedding
        },
      };

      const pipeline = createRAGPipeline({
        loader: createTextLoader(['Hello world', 'Another doc']),
        chunking: createFixedSizeChunking({ chunkSize: 100 }),
        embedding: brokenEmbedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await expect(pipeline.ingest()).rejects.toThrow(HarnessError);
      await expect(pipeline.ingest()).rejects.toThrow(/1 embeddings for 2 chunks/);
    });
  });

  // ---- Capacity limits (maxChunks) ----

  describe('maxChunks capacity', () => {
    it('limits total chunks to maxChunks', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        maxChunks: 2,
      });

      const count = await pipeline.ingestDocuments([
        { id: 'doc-1', content: 'alpha' },
        { id: 'doc-2', content: 'beta' },
        { id: 'doc-3', content: 'gamma' },
      ]);

      expect(count).toBe(2);
      expect(pipeline.getChunks()).toHaveLength(2);
    });

    it('returns 0 when capacity already reached', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        maxChunks: 1,
      });

      await pipeline.ingestDocuments([{ id: 'd1', content: 'first' }]);
      const count = await pipeline.ingestDocuments([{ id: 'd2', content: 'second' }]);

      expect(count).toBe(0);
      expect(pipeline.getChunks()).toHaveLength(1);
    });

    it('keeps first N chunks within the batch when exceeding capacity', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        maxChunks: 2,
      });

      await pipeline.ingestDocuments([
        { id: 'd1', content: 'alpha' },
        { id: 'd2', content: 'beta' },
        { id: 'd3', content: 'gamma' },
      ]);

      const chunks = pipeline.getChunks();
      expect(chunks[0].content).toBe('alpha');
      expect(chunks[1].content).toBe('beta');
    });
  });

  // ---- Warning callbacks ----

  describe('warning callbacks', () => {
    it('fires onWarning for capacity exceeded', async () => {
      const warnings: { message: string; type: string }[] = [];
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        maxChunks: 1,
        onWarning: (w) => warnings.push(w),
      });

      await pipeline.ingestDocuments([
        { id: 'd1', content: 'alpha' },
        { id: 'd2', content: 'beta' },
      ]);

      expect(warnings.length).toBeGreaterThanOrEqual(1);
      const capacityWarning = warnings.find((w) => w.type === 'capacity');
      expect(capacityWarning).toBeDefined();
      expect(capacityWarning!.message).toContain('capacity');
    });

    it('fires onWarning for capacity reached (no new chunks added)', async () => {
      const warnings: { message: string; type: string }[] = [];
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        maxChunks: 1,
        onWarning: (w) => warnings.push(w),
      });

      await pipeline.ingestDocuments([{ id: 'd1', content: 'alpha' }]);
      await pipeline.ingestDocuments([{ id: 'd2', content: 'beta' }]);

      const capacityWarnings = warnings.filter((w) => w.type === 'capacity');
      expect(capacityWarnings.length).toBeGreaterThanOrEqual(1);
    });

    it('fires onWarning for duplicate chunks', async () => {
      const warnings: { message: string; type: string }[] = [];
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        onWarning: (w) => warnings.push(w),
      });

      await pipeline.ingestDocuments([{ id: 'd1', content: 'duplicate' }]);
      await pipeline.ingestDocuments([{ id: 'd2', content: 'duplicate' }]);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe('duplicate');
      expect(warnings[0].message).toContain('Duplicate chunk skipped');
    });

    it('does not fire warnings when no issues', async () => {
      const warnings: { message: string; type: string }[] = [];
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        onWarning: (w) => warnings.push(w),
      });

      await pipeline.ingestDocuments([
        { id: 'd1', content: 'unique one' },
        { id: 'd2', content: 'unique two' },
      ]);

      expect(warnings).toHaveLength(0);
    });
  });

  // ---- Deduplication ----

  describe('deduplication', () => {
    it('skips duplicate content within a single ingest call', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      const count = await pipeline.ingestDocuments([
        { id: 'd1', content: 'same' },
        { id: 'd2', content: 'same' },
      ]);

      expect(count).toBe(1);
    });

    it('skips duplicate content across multiple ingest calls', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingestDocuments([{ id: 'd1', content: 'hello' }]);
      const count = await pipeline.ingestDocuments([{ id: 'd2', content: 'hello' }]);

      expect(count).toBe(0);
      expect(pipeline.getChunks()).toHaveLength(1);
    });

    it('allows same content after clear()', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingestDocuments([{ id: 'd1', content: 'repeated' }]);
      pipeline.clear();

      const count = await pipeline.ingestDocuments([{ id: 'd2', content: 'repeated' }]);
      expect(count).toBe(1);
    });
  });

  // ---- clear() ----

  describe('clear()', () => {
    it('removes all indexed chunks', async () => {
      const pipeline = createRAGPipeline({
        loader: createTextLoader(['hello']),
        chunking: createFixedSizeChunking({ chunkSize: 100 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingest();
      expect(pipeline.getChunks()).toHaveLength(1);

      pipeline.clear();
      expect(pipeline.getChunks()).toHaveLength(0);
    });

    it('allows re-ingestion from empty state after clear', async () => {
      const pipeline = createRAGPipeline({
        loader: createTextLoader(['doc one']),
        chunking: createFixedSizeChunking({ chunkSize: 100 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingest();
      pipeline.clear();
      await pipeline.ingest();

      expect(pipeline.getChunks()).toHaveLength(1);
    });
  });

  // ---- query() options ----

  describe('query() options passthrough', () => {
    it('passes limit option to retriever', async () => {
      const pipeline = createRAGPipeline({
        loader: createTextLoader(['aaa', 'bbb', 'ccc']),
        chunking: createFixedSizeChunking({ chunkSize: 100 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingest();
      const results = await pipeline.query('test', { limit: 1 });

      expect(results).toHaveLength(1);
    });

    it('passes minScore option to retriever', async () => {
      const pipeline = createRAGPipeline({
        loader: createTextLoader(['aaa', 'bbb']),
        chunking: createFixedSizeChunking({ chunkSize: 100 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingest();
      const results = await pipeline.query('test', { minScore: 0.99 });

      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.99);
      }
    });
  });

  // ---- Token estimation ----

  describe('token estimation', () => {
    it('query results include estimated token count (content.length / 4, rounded up)', async () => {
      const pipeline = createRAGPipeline({
        loader: createTextLoader(['Hello world!']), // 12 chars -> ceil(12/4) = 3 tokens
        chunking: createFixedSizeChunking({ chunkSize: 100 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingest();
      const results = await pipeline.query('hello');

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.tokens).toBeDefined();
        expect(r.tokens).toBe(Math.ceil(r.chunk.content.length / 4));
      }
    });

    it('token estimate is 1 for very short content', async () => {
      const pipeline = createRAGPipeline({
        loader: createTextLoader(['Hi']), // 2 chars -> ceil(2/4) = 1
        chunking: createFixedSizeChunking({ chunkSize: 100 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingest();
      const results = await pipeline.query('Hi');
      expect(results[0].tokens).toBe(1);
    });
  });

  // ---- frozen object ----

  it('returns a frozen pipeline object', () => {
    const pipeline = createRAGPipeline({
      embedding,
      retriever: createInMemoryRetriever({ embedding }),
    });

    expect(Object.isFrozen(pipeline)).toBe(true);
  });

  // ---- getChunks returns a copy ----

  it('getChunks returns a copy (not internal reference)', async () => {
    const pipeline = createRAGPipeline({
      embedding,
      retriever: createInMemoryRetriever({ embedding }),
    });

    await pipeline.ingestDocuments([{ id: 'd1', content: 'hello' }]);

    const chunks1 = pipeline.getChunks();
    const chunks2 = pipeline.getChunks();

    expect(chunks1).not.toBe(chunks2);
    expect(chunks1).toEqual(chunks2);
  });
});
