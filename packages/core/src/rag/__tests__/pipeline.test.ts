import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRAGPipeline } from '../pipeline.js';
import { createTextLoader, createDocumentArrayLoader } from '../loaders.js';
import { createBasicFixedSizeChunking, createBasicParagraphChunking } from '../chunking.js';
import { createInMemoryRetriever } from '../retriever.js';
import { HarnessError } from '../../core/errors.js';
import { createTraceManager } from '../../observe/trace-manager.js';
import type { TraceExporter, Span, Trace } from '../../observe/types.js';
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
        chunking: createBasicFixedSizeChunking({ chunkSize: 100 }),
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
        chunking: createBasicParagraphChunking(),
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
        chunking: createBasicFixedSizeChunking({ chunkSize: 100 }),
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
        chunking: createBasicFixedSizeChunking({ chunkSize: 5 }),
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
        chunking: createBasicFixedSizeChunking({ chunkSize: 100 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      const results = await pipeline.query('hello');
      expect(results).toEqual([]);
    });

    it('passes filter through pipeline.query()', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingestDocuments([
        { id: 'doc-1', content: 'cats', metadata: { topic: 'animals' } },
        { id: 'doc-2', content: 'physics', metadata: { topic: 'science' } },
      ]);

      const results = await pipeline.query('cats', {
        limit: 10,
        minScore: -1,
        filter: { topic: 'animals' },
      });

      expect(results).toHaveLength(1);
      expect(results[0].chunk.metadata?.topic).toBe('animals');
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
        chunking: createBasicFixedSizeChunking({ chunkSize: 5 }),
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
        chunking: createBasicFixedSizeChunking({ chunkSize: 100 }),
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

  describe('embedding maxBatchSize', () => {
    it('splits ingest batches to honor embedding.maxBatchSize', async () => {
      const embed = vi.fn(async (texts: readonly string[]) =>
        texts.map(() => [1, 0, 0, 0] as const),
      );
      const boundedEmbedding: EmbeddingModel = {
        dimensions: 4,
        maxBatchSize: 2,
        embed,
      };

      const pipeline = createRAGPipeline({
        embedding: boundedEmbedding,
        retriever: createInMemoryRetriever({ embedding: boundedEmbedding }),
      });

      await pipeline.ingestDocuments([
        { id: 'd1', content: 'one' },
        { id: 'd2', content: 'two' },
        { id: 'd3', content: 'three' },
      ]);

      expect(embed).toHaveBeenCalledTimes(2);
      expect(embed.mock.calls[0][0]).toHaveLength(2);
      expect(embed.mock.calls[1][0]).toHaveLength(1);
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
        chunking: createBasicFixedSizeChunking({ chunkSize: 100 }),
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
        chunking: createBasicFixedSizeChunking({ chunkSize: 100 }),
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
        chunking: createBasicFixedSizeChunking({ chunkSize: 100 }),
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
        chunking: createBasicFixedSizeChunking({ chunkSize: 100 }),
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
        chunking: createBasicFixedSizeChunking({ chunkSize: 100 }),
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
        chunking: createBasicFixedSizeChunking({ chunkSize: 100 }),
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

  // ---- Fix 22: Embedding health check ----

  describe('embedding health check (Fix 22)', () => {
    it('validates embedding function when validateEmbedding is true', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        validateEmbedding: true,
      });

      const count = await pipeline.ingestDocuments([
        { id: 'd1', content: 'Hello world' },
      ]);
      expect(count).toBe(1);
    });

    it('throws when embedding model returns invalid results with validation enabled', async () => {
      const brokenEmbedding: EmbeddingModel = {
        dimensions: 4,
        async embed() {
          return []; // Returns nothing
        },
      };

      const pipeline = createRAGPipeline({
        embedding: brokenEmbedding,
        retriever: createInMemoryRetriever({ embedding }),
        validateEmbedding: true,
      });

      await expect(pipeline.ingestDocuments([
        { id: 'd1', content: 'Hello' },
      ])).rejects.toThrow(/Embedding validation failed/);
    });

    it('skips validation when validateEmbedding is false (default)', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      const count = await pipeline.ingestDocuments([
        { id: 'd1', content: 'Hello' },
      ]);
      expect(count).toBe(1);
    });
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

  // ---- OBS-006: Observability (TraceManager + getIngestMetrics) ----

  describe('OBS-006 ingestion observability', () => {
    // Collect every exported span so we can verify per-chunk child spans.
    function createCollectorExporter(): { exporter: TraceExporter; spans: Span[]; traces: Trace[] } {
      const spans: Span[] = [];
      const traces: Trace[] = [];
      const exporter: TraceExporter = {
        name: 'collector',
        async exportSpan(s) { spans.push(s); },
        async exportTrace(t) { traces.push(t); },
        async flush() {},
      };
      return { exporter, spans, traces };
    }

    it('getIngestMetrics returns zero counters by default', () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });
      expect(pipeline.getIngestMetrics()).toEqual({
        attempted: 0,
        succeeded: 0,
        failed: 0,
        byFailureReason: {},
      });
    });

    it('accrues succeeded counts across ingestDocuments calls', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingestDocuments([
        { id: 'd1', content: 'alpha' },
        { id: 'd2', content: 'beta' },
      ]);
      await pipeline.ingestDocuments([
        { id: 'd3', content: 'gamma' },
      ]);

      const metrics = pipeline.getIngestMetrics();
      expect(metrics.attempted).toBe(3);
      expect(metrics.succeeded).toBe(3);
      expect(metrics.failed).toBe(0);
      expect(metrics.byFailureReason).toEqual({});
    });

    it('returns a defensive copy of byFailureReason', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });
      const a = pipeline.getIngestMetrics().byFailureReason;
      // Attempt to mutate shouldn't leak into pipeline internals
      (a as Record<string, number>)['x'] = 99;
      expect(pipeline.getIngestMetrics().byFailureReason).toEqual({});
    });

    it('creates a child span per chunk during ingestDocuments', async () => {
      const { exporter, spans } = createCollectorExporter();
      const tm = createTraceManager({ exporters: [exporter] });

      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        traceManager: tm,
      });

      await pipeline.ingestDocuments([
        { id: 'd1', content: 'alpha' },
        { id: 'd2', content: 'beta' },
        { id: 'd3', content: 'gamma' },
      ]);
      await tm.flush();

      const chunkSpans = spans.filter((s) => s.name === 'rag.ingest_chunk');
      expect(chunkSpans).toHaveLength(3);
      for (const span of chunkSpans) {
        expect(span.status).toBe('completed');
        expect(span.attributes['chunk.id']).toBeDefined();
        expect(span.attributes['chunk.document_id']).toBeDefined();
      }
    });

    it('marks child spans with error.reason when embedding mismatch occurs', async () => {
      const { exporter, spans } = createCollectorExporter();
      const tm = createTraceManager({ exporters: [exporter] });

      const brokenEmbedding: EmbeddingModel = {
        dimensions: 4,
        async embed() {
          return [[1, 0, 0, 0]]; // Always 1 regardless of input count
        },
      };

      const pipeline = createRAGPipeline({
        embedding: brokenEmbedding,
        retriever: createInMemoryRetriever({ embedding }),
        traceManager: tm,
      });

      await expect(
        pipeline.ingestDocuments([
          { id: 'd1', content: 'alpha' },
          { id: 'd2', content: 'beta' },
        ]),
      ).rejects.toThrow(HarnessError);

      await tm.flush();

      const chunkSpans = spans.filter((s) => s.name === 'rag.ingest_chunk');
      expect(chunkSpans.length).toBeGreaterThan(0);
      for (const span of chunkSpans) {
        expect(span.status).toBe('error');
        expect(span.attributes['error.reason']).toBe('embedding_mismatch');
      }

      // Metrics should record the failure.
      const metrics = pipeline.getIngestMetrics();
      expect(metrics.failed).toBe(2);
      expect(metrics.succeeded).toBe(0);
      expect(metrics.byFailureReason.embedding_mismatch).toBe(2);
    });

    it('marks a span with error.reason=embedding_validation when validation fails', async () => {
      const { exporter, spans } = createCollectorExporter();
      const tm = createTraceManager({ exporters: [exporter] });

      const brokenEmbedding: EmbeddingModel = {
        dimensions: 4,
        async embed() {
          return []; // Invalid probe result
        },
      };

      const pipeline = createRAGPipeline({
        embedding: brokenEmbedding,
        retriever: createInMemoryRetriever({ embedding }),
        traceManager: tm,
        validateEmbedding: true,
      });

      await expect(
        pipeline.ingestDocuments([{ id: 'd1', content: 'alpha' }]),
      ).rejects.toThrow(/Embedding validation failed/);

      await tm.flush();

      const validationSpans = spans.filter((s) => s.name === 'rag.validate_embedding');
      expect(validationSpans).toHaveLength(1);
      expect(validationSpans[0].status).toBe('error');
      expect(validationSpans[0].attributes['error.reason']).toBe('embedding_validation');
    });

    it('records index() failure as batch_error with per-chunk error spans', async () => {
      const { exporter, spans } = createCollectorExporter();
      const tm = createTraceManager({ exporters: [exporter] });

      const brokenRetriever = {
        async index(): Promise<void> {
          throw new Error('index backend offline');
        },
        async retrieve() { return []; },
      };

      const pipeline = createRAGPipeline({
        embedding,
        retriever: brokenRetriever,
        traceManager: tm,
      });

      await expect(
        pipeline.ingestDocuments([{ id: 'd1', content: 'alpha' }]),
      ).rejects.toThrow(/index backend offline/);

      await tm.flush();

      const chunkSpans = spans.filter((s) => s.name === 'rag.ingest_chunk');
      expect(chunkSpans).toHaveLength(1);
      expect(chunkSpans[0].status).toBe('error');
      expect(chunkSpans[0].attributes['error.reason']).toBe('batch_error');

      const metrics = pipeline.getIngestMetrics();
      expect(metrics.failed).toBe(1);
      expect(metrics.byFailureReason.batch_error).toBe(1);
    });

    it('does not require a TraceManager to accrue metrics', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingestDocuments([{ id: 'd1', content: 'hello' }]);

      expect(pipeline.getIngestMetrics().succeeded).toBe(1);
      expect(pipeline.getIngestMetrics().attempted).toBe(1);
    });

    it('produces a parent rag.ingest trace when using ingest() with a loader', async () => {
      const { exporter, traces } = createCollectorExporter();
      const tm = createTraceManager({ exporters: [exporter] });
      const loaderSpy = vi.fn();

      const pipeline = createRAGPipeline({
        loader: {
          async load() {
            loaderSpy();
            return [{ id: 'd1', content: 'Hello' }];
          },
        },
        chunking: createBasicFixedSizeChunking({ chunkSize: 100 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        traceManager: tm,
      });

      await pipeline.ingest();
      await tm.flush();

      expect(loaderSpy).toHaveBeenCalled();
      // One parent trace per ingest() invocation
      const ingestTraces = traces.filter((t) => t.name === 'rag.ingest');
      expect(ingestTraces).toHaveLength(1);
      expect(ingestTraces[0].status).toBe('completed');
    });
  });

  // ---- Unicode normalization-aware deduplication ----
  describe('deduplication — Unicode normalization', () => {
    it('NFC and NFD forms of the same grapheme are treated as duplicates', async () => {
      // "café" as NFC is 4 code units (é is a single precomposed codepoint);
      // as NFD it decomposes to 5 code units (e + combining acute). Both
      // render identically — the dedup cache must treat them as one chunk.
      const composed = 'café'; // NFC
      const decomposed = 'cafe\u0301'; // NFD: e + U+0301 combining acute
      expect(composed).not.toBe(decomposed); // prove they differ byte-wise
      expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC'));

      const warnings: string[] = [];
      const pipeline = createRAGPipeline({
        loader: createDocumentArrayLoader([
          { id: 'd1', content: composed },
          { id: 'd2', content: decomposed },
        ]),
        chunking: createBasicFixedSizeChunking({ chunkSize: 1_000 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        onWarning: (w) => warnings.push(w.message),
      });

      const result = await pipeline.ingest();
      // One unique chunk admitted; the duplicate is skipped with a warning.
      expect(result.chunks).toBe(1);
      expect(
        warnings.some((m) => m.startsWith('Duplicate chunk skipped')),
      ).toBe(true);
    });
  });
});
