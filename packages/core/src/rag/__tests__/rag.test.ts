import { describe, it, expect, beforeEach } from 'vitest';
import { createTextLoader, createDocumentArrayLoader } from '../loaders.js';
import {
  createFixedSizeChunking,
  createParagraphChunking,
  createSlidingWindowChunking,
} from '../chunking.js';
import { createInMemoryRetriever } from '../retriever.js';
import { createRAGPipeline } from '../pipeline.js';
import { HarnessError } from '../../core/errors.js';
import type { Document, DocumentChunk, EmbeddingModel } from '../types.js';

// ---------------------------------------------------------------------------
// Mock EmbeddingModel — returns deterministic embeddings based on char codes
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
        // Normalize so cosine similarity is meaningful
        const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        return mag === 0 ? vec : vec.map((v) => v / mag);
      });
    },
  };
}

// ===========================================================================
// Loaders
// ===========================================================================

describe('createTextLoader', () => {
  it('loads strings as documents with sequential ids', async () => {
    const loader = createTextLoader(['alpha', 'beta']);
    const docs = await loader.load();

    expect(docs).toHaveLength(2);
    expect(docs[0].id).toBe('doc_0');
    expect(docs[0].content).toBe('alpha');
    expect(docs[0].source).toBe('text');
    expect(docs[0].metadata).toEqual({});
    expect(docs[1].id).toBe('doc_1');
    expect(docs[1].content).toBe('beta');
  });

  it('uses custom source when provided', async () => {
    const loader = createTextLoader(['x'], { source: 'custom' });
    const docs = await loader.load();

    expect(docs[0].source).toBe('custom');
  });

  it('returns empty array for empty input', async () => {
    const loader = createTextLoader([]);
    const docs = await loader.load();

    expect(docs).toEqual([]);
  });
});

describe('createDocumentArrayLoader', () => {
  it('passes through documents as a copy', async () => {
    const original: Document[] = [
      { id: 'd1', content: 'hello', metadata: { a: 1 } },
      { id: 'd2', content: 'world' },
    ];
    const loader = createDocumentArrayLoader(original);
    const docs = await loader.load();

    expect(docs).toHaveLength(2);
    expect(docs[0]).toEqual(original[0]);
    expect(docs[1]).toEqual(original[1]);
    // Verify it's a copy, not the same reference
    expect(docs).not.toBe(original);
  });

  it('returns empty array for empty input', async () => {
    const loader = createDocumentArrayLoader([]);
    const docs = await loader.load();

    expect(docs).toEqual([]);
  });
});

// ===========================================================================
// Chunking — Fixed Size
// ===========================================================================

describe('createFixedSizeChunking', () => {
  it('splits content into correct number of chunks', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 5 });
    const doc: Document = { id: 'd1', content: 'abcdefghij' }; // 10 chars

    const chunks = chunking.chunk(doc);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe('abcde');
    expect(chunks[1].content).toBe('fghij');
  });

  it('generates correct ids and indices', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 5 });
    const doc: Document = { id: 'd1', content: 'abcdefghij' };

    const chunks = chunking.chunk(doc);

    expect(chunks[0].id).toBe('d1_chunk_0');
    expect(chunks[0].documentId).toBe('d1');
    expect(chunks[0].index).toBe(0);
    expect(chunks[1].id).toBe('d1_chunk_1');
    expect(chunks[1].index).toBe(1);
  });

  it('handles overlap correctly', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 6, overlap: 2 });
    // step = 6 - 2 = 4
    const doc: Document = { id: 'd1', content: 'abcdefghijkl' }; // 12 chars

    const chunks = chunking.chunk(doc);

    // start=0: abcdef, start=4: efghij, start=8: ijkl
    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('abcdef');
    expect(chunks[1].content).toBe('efghij');
    expect(chunks[2].content).toBe('ijkl');
  });

  it('returns single chunk when content is shorter than chunkSize', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 100 });
    const doc: Document = { id: 'd1', content: 'short' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('short');
  });

  it('returns empty array for empty content', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 10 });
    const doc: Document = { id: 'd1', content: '' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toEqual([]);
  });

  it('preserves document metadata in chunks', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 100 });
    const doc: Document = { id: 'd1', content: 'hello', metadata: { key: 'val' } };

    const chunks = chunking.chunk(doc);

    expect(chunks[0].metadata).toEqual({ key: 'val' });
  });

  it('has name "fixed-size"', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 10 });
    expect(chunking.name).toBe('fixed-size');
  });

  it('throws HarnessError for chunkSize <= 0', () => {
    expect(() => createFixedSizeChunking({ chunkSize: 0 })).toThrow(HarnessError);
    expect(() => createFixedSizeChunking({ chunkSize: -5 })).toThrow(HarnessError);
  });

  it('throws HarnessError for negative overlap', () => {
    expect(() => createFixedSizeChunking({ chunkSize: 10, overlap: -1 })).toThrow(HarnessError);
  });

  it('throws HarnessError when overlap >= chunkSize', () => {
    expect(() => createFixedSizeChunking({ chunkSize: 10, overlap: 10 })).toThrow(HarnessError);
    expect(() => createFixedSizeChunking({ chunkSize: 10, overlap: 15 })).toThrow(HarnessError);
  });

  it('includes error code RAG_INVALID_CONFIG', () => {
    try {
      createFixedSizeChunking({ chunkSize: 0 });
    } catch (e) {
      expect(e).toBeInstanceOf(HarnessError);
      expect((e as HarnessError).code).toBe('RAG_INVALID_CONFIG');
    }
  });

  it('handles content exactly equal to chunkSize', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 5 });
    const doc: Document = { id: 'd1', content: 'abcde' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('abcde');
  });
});

// ===========================================================================
// Chunking — Paragraph
// ===========================================================================

describe('createParagraphChunking', () => {
  it('splits on double newlines', () => {
    const chunking = createParagraphChunking();
    const doc: Document = { id: 'd1', content: 'Para one.\n\nPara two.\n\nPara three.' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('Para one.');
    expect(chunks[1].content).toBe('Para two.');
    expect(chunks[2].content).toBe('Para three.');
  });

  it('returns single chunk for single paragraph', () => {
    const chunking = createParagraphChunking();
    const doc: Document = { id: 'd1', content: 'Just one paragraph here.' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Just one paragraph here.');
  });

  it('respects maxChunkSize by sub-splitting long paragraphs', () => {
    const chunking = createParagraphChunking({ maxChunkSize: 10 });
    const doc: Document = { id: 'd1', content: 'This is a very long paragraph that exceeds max.' };

    const chunks = chunking.chunk(doc);

    // Each chunk content should be at most 10 chars
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(10);
    }
    // Reassembling should give the original trimmed content
    expect(chunks.map((c) => c.content).join('')).toBe(
      'This is a very long paragraph that exceeds max.',
    );
  });

  it('returns empty array for empty content', () => {
    const chunking = createParagraphChunking();
    const doc: Document = { id: 'd1', content: '' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toEqual([]);
  });

  it('returns empty array for whitespace-only content', () => {
    const chunking = createParagraphChunking();
    const doc: Document = { id: 'd1', content: '   \n\n   \n\n   ' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toEqual([]);
  });

  it('handles paragraphs separated by varied whitespace', () => {
    const chunking = createParagraphChunking();
    const doc: Document = { id: 'd1', content: 'A\n  \nB\n\t\nC' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('A');
    expect(chunks[1].content).toBe('B');
    expect(chunks[2].content).toBe('C');
  });

  it('has name "paragraph"', () => {
    const chunking = createParagraphChunking();
    expect(chunking.name).toBe('paragraph');
  });

  it('throws HarnessError for maxChunkSize <= 0', () => {
    expect(() => createParagraphChunking({ maxChunkSize: 0 })).toThrow(HarnessError);
    expect(() => createParagraphChunking({ maxChunkSize: -1 })).toThrow(HarnessError);
  });

  it('generates sequential ids', () => {
    const chunking = createParagraphChunking();
    const doc: Document = { id: 'd1', content: 'A\n\nB\n\nC' };

    const chunks = chunking.chunk(doc);

    expect(chunks[0].id).toBe('d1_chunk_0');
    expect(chunks[1].id).toBe('d1_chunk_1');
    expect(chunks[2].id).toBe('d1_chunk_2');
  });

  it('increments index across sub-split chunks', () => {
    const chunking = createParagraphChunking({ maxChunkSize: 5 });
    const doc: Document = { id: 'd1', content: 'ABCDEFGHIJ\n\nXY' };
    // First paragraph is 10 chars -> 2 sub-chunks (indices 0, 1)
    // Second paragraph is 2 chars -> 1 chunk (index 2)

    const chunks = chunking.chunk(doc);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].index).toBe(0);
    expect(chunks[1].index).toBe(1);
    expect(chunks[2].index).toBe(2);
  });
});

// ===========================================================================
// Chunking — Sliding Window
// ===========================================================================

describe('createSlidingWindowChunking', () => {
  it('produces overlapping windows with correct step', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 6, stepSize: 3 });
    // 'abcdefghijkl' = 12 chars
    // start=0: abcdef, start=3: defghi, start=6: ghijkl (reaches end, stop)
    const doc: Document = { id: 'd1', content: 'abcdefghijkl' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('abcdef');
    expect(chunks[1].content).toBe('defghi');
    expect(chunks[2].content).toBe('ghijkl');
  });

  it('produces trailing partial window when content does not align', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 6, stepSize: 4 });
    // 'abcdefghijklm' = 13 chars
    // start=0: abcdef, start=4: efghij, start=8: ijklm (partial, reaches end)
    const doc: Document = { id: 'd1', content: 'abcdefghijklm' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('abcdef');
    expect(chunks[1].content).toBe('efghij');
    expect(chunks[2].content).toBe('ijklm');
  });

  it('returns single chunk when content fits in one window', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 100, stepSize: 50 });
    const doc: Document = { id: 'd1', content: 'short' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('short');
  });

  it('returns empty array for empty content', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 10, stepSize: 5 });
    const doc: Document = { id: 'd1', content: '' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toEqual([]);
  });

  it('has name "sliding-window"', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 10, stepSize: 5 });
    expect(chunking.name).toBe('sliding-window');
  });

  it('throws HarnessError for windowSize <= 0', () => {
    expect(() => createSlidingWindowChunking({ windowSize: 0, stepSize: 5 })).toThrow(
      HarnessError,
    );
    expect(() => createSlidingWindowChunking({ windowSize: -1, stepSize: 5 })).toThrow(
      HarnessError,
    );
  });

  it('throws HarnessError for stepSize <= 0', () => {
    expect(() => createSlidingWindowChunking({ windowSize: 10, stepSize: 0 })).toThrow(
      HarnessError,
    );
    expect(() => createSlidingWindowChunking({ windowSize: 10, stepSize: -3 })).toThrow(
      HarnessError,
    );
  });

  it('generates correct ids and documentId', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 5, stepSize: 5 });
    const doc: Document = { id: 'myDoc', content: 'abcdefghij' };

    const chunks = chunking.chunk(doc);

    expect(chunks[0].id).toBe('myDoc_chunk_0');
    expect(chunks[0].documentId).toBe('myDoc');
    expect(chunks[1].id).toBe('myDoc_chunk_1');
  });

  it('handles non-overlapping windows (stepSize == windowSize)', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 5, stepSize: 5 });
    const doc: Document = { id: 'd1', content: 'abcdefghij' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe('abcde');
    expect(chunks[1].content).toBe('fghij');
  });

  it('handles stepSize larger than windowSize', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 3, stepSize: 5 });
    const doc: Document = { id: 'd1', content: 'abcdefghij' };

    const chunks = chunking.chunk(doc);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe('abc');
    expect(chunks[1].content).toBe('fgh');
  });
});

// ===========================================================================
// Retriever
// ===========================================================================

describe('createInMemoryRetriever', () => {
  let embedding: EmbeddingModel;

  beforeEach(() => {
    embedding = createMockEmbeddingModel(4);
  });

  it('indexes chunks and retrieves by similarity', async () => {
    const retriever = createInMemoryRetriever({ embedding });

    const chunks: DocumentChunk[] = [
      { id: 'c1', documentId: 'd1', content: 'cat', index: 0, embedding: [1, 0, 0, 0] },
      { id: 'c2', documentId: 'd1', content: 'dog', index: 1, embedding: [0, 1, 0, 0] },
      { id: 'c3', documentId: 'd1', content: 'fish', index: 2, embedding: [0, 0, 1, 0] },
    ];

    await retriever.index(chunks);

    // The mock embedding model will return some vector for "cat" query
    const results = await retriever.retrieve('cat', { limit: 3 });

    expect(results.length).toBeGreaterThan(0);
    // Each result should have chunk and score
    expect(results[0]).toHaveProperty('chunk');
    expect(results[0]).toHaveProperty('score');
    expect(typeof results[0].score).toBe('number');
  });

  it('respects limit option', async () => {
    const retriever = createInMemoryRetriever({ embedding });

    const chunks: DocumentChunk[] = [
      { id: 'c1', documentId: 'd1', content: 'a', index: 0, embedding: [1, 0, 0, 0] },
      { id: 'c2', documentId: 'd1', content: 'b', index: 1, embedding: [0, 1, 0, 0] },
      { id: 'c3', documentId: 'd1', content: 'c', index: 2, embedding: [0, 0, 1, 0] },
    ];

    await retriever.index(chunks);
    const results = await retriever.retrieve('test', { limit: 1 });

    expect(results).toHaveLength(1);
  });

  it('respects minScore option', async () => {
    const retriever = createInMemoryRetriever({ embedding });

    const chunks: DocumentChunk[] = [
      { id: 'c1', documentId: 'd1', content: 'a', index: 0, embedding: [1, 0, 0, 0] },
      { id: 'c2', documentId: 'd1', content: 'b', index: 1, embedding: [0, 1, 0, 0] },
    ];

    await retriever.index(chunks);
    // Very high minScore should filter out most/all results
    const results = await retriever.retrieve('test', { minScore: 0.99 });

    // Results may be empty or very few depending on similarity
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('returns empty array when no chunks are indexed', async () => {
    const retriever = createInMemoryRetriever({ embedding });
    const results = await retriever.retrieve('query');

    expect(results).toEqual([]);
  });

  it('skips chunks without embeddings', async () => {
    const retriever = createInMemoryRetriever({ embedding });

    const chunks: DocumentChunk[] = [
      { id: 'c1', documentId: 'd1', content: 'embedded', index: 0, embedding: [1, 0, 0, 0] },
      { id: 'c2', documentId: 'd1', content: 'no-embed', index: 1 }, // no embedding
      {
        id: 'c3',
        documentId: 'd1',
        content: 'empty-embed',
        index: 2,
        embedding: [],
      }, // empty embedding
    ];

    await retriever.index(chunks);
    const results = await retriever.retrieve('test', { limit: 10 });

    // Only 'c1' has a non-empty embedding
    const ids = results.map((r) => r.chunk.id);
    expect(ids).not.toContain('c2');
    expect(ids).not.toContain('c3');
  });

  it('sorts results by descending score', async () => {
    const retriever = createInMemoryRetriever({ embedding });

    // Use embeddings that produce known ordering with a specific query
    const chunks: DocumentChunk[] = [
      { id: 'c1', documentId: 'd1', content: 'low', index: 0, embedding: [0, 0, 0, 1] },
      { id: 'c2', documentId: 'd1', content: 'high', index: 1, embedding: [1, 0, 0, 0] },
      { id: 'c3', documentId: 'd1', content: 'mid', index: 2, embedding: [0.5, 0, 0, 0.5] },
    ];

    await retriever.index(chunks);
    const results = await retriever.retrieve('anything', { limit: 10 });

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('defaults limit to 5', async () => {
    const retriever = createInMemoryRetriever({ embedding });

    const chunks: DocumentChunk[] = [];
    for (let i = 0; i < 10; i++) {
      const vec = [0, 0, 0, 0];
      vec[i % 4] = 1;
      chunks.push({ id: `c${i}`, documentId: 'd1', content: `text${i}`, index: i, embedding: vec });
    }

    await retriever.index(chunks);
    const results = await retriever.retrieve('query');

    expect(results).toHaveLength(5);
  });

  it('handles chunks with zero-magnitude embeddings (returns score 0)', async () => {
    const retriever = createInMemoryRetriever({ embedding });

    const chunks: DocumentChunk[] = [
      { id: 'c1', documentId: 'd1', content: 'zero', index: 0, embedding: [0, 0, 0, 0] },
      { id: 'c2', documentId: 'd1', content: 'normal', index: 1, embedding: [1, 0, 0, 0] },
    ];

    await retriever.index(chunks);
    // With minScore default of 0, the zero-vector chunk gets score 0 and is included
    const results = await retriever.retrieve('test', { limit: 10 });

    const zeroChunk = results.find((r) => r.chunk.id === 'c1');
    if (zeroChunk) {
      expect(zeroChunk.score).toBe(0);
    }
    // Normal chunk should still appear
    const normalChunk = results.find((r) => r.chunk.id === 'c2');
    expect(normalChunk).toBeDefined();
  });

  it('handles mismatched embedding dimensions gracefully', async () => {
    // Create embedding model with 4 dimensions but index chunks with 2-dim embeddings
    const retriever = createInMemoryRetriever({ embedding });

    const chunks: DocumentChunk[] = [
      { id: 'c1', documentId: 'd1', content: 'mismatch', index: 0, embedding: [1, 0] },
    ];

    await retriever.index(chunks);
    // Query embedding will be 4-dim, chunk embedding is 2-dim -> cosine returns 0
    const results = await retriever.retrieve('test', { limit: 10 });

    // Mismatched lengths should produce score of 0
    const result = results.find((r) => r.chunk.id === 'c1');
    if (result) {
      expect(result.score).toBe(0);
    }
  });
});

// ===========================================================================
// Retriever — Vector Caching (Fix 4)
// ===========================================================================

describe('createInMemoryRetriever — vector caching', () => {
  let embedding: EmbeddingModel;

  beforeEach(() => {
    embedding = createMockEmbeddingModel(4);
  });

  it('produces same similarity results as before caching optimization', async () => {
    const retriever = createInMemoryRetriever({ embedding });

    const chunks: DocumentChunk[] = [
      { id: 'c1', documentId: 'd1', content: 'cat', index: 0, embedding: [1, 0, 0, 0] },
      { id: 'c2', documentId: 'd1', content: 'dog', index: 1, embedding: [0, 1, 0, 0] },
      { id: 'c3', documentId: 'd1', content: 'fish', index: 2, embedding: [0.5, 0.5, 0, 0] },
    ];

    await retriever.index(chunks);
    const results = await retriever.retrieve('test', { limit: 10 });

    // Results should be sorted by descending score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
    // All 3 chunks should appear
    expect(results).toHaveLength(3);
  });

  it('correctly handles unit vectors (pre-normalized inputs)', async () => {
    const retriever = createInMemoryRetriever({ embedding });

    // These are already unit vectors
    const chunks: DocumentChunk[] = [
      { id: 'c1', documentId: 'd1', content: 'a', index: 0, embedding: [1, 0, 0, 0] },
      { id: 'c2', documentId: 'd1', content: 'b', index: 1, embedding: [0, 1, 0, 0] },
    ];

    await retriever.index(chunks);
    const results = await retriever.retrieve('test', { limit: 10 });

    // Scores should be valid numbers between -1 and 1
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(-1);
      expect(r.score).toBeLessThanOrEqual(1.0001); // small epsilon for floating point
    }
  });

  it('handles zero-magnitude embeddings correctly with caching', async () => {
    const retriever = createInMemoryRetriever({ embedding });

    const chunks: DocumentChunk[] = [
      { id: 'c1', documentId: 'd1', content: 'zero', index: 0, embedding: [0, 0, 0, 0] },
      { id: 'c2', documentId: 'd1', content: 'normal', index: 1, embedding: [1, 0, 0, 0] },
    ];

    await retriever.index(chunks);
    const results = await retriever.retrieve('test', { limit: 10 });

    // Zero-magnitude chunk should get score 0
    const zeroChunk = results.find((r) => r.chunk.id === 'c1');
    if (zeroChunk) {
      expect(zeroChunk.score).toBe(0);
    }
    // Normal chunk should still have a non-zero score
    const normalChunk = results.find((r) => r.chunk.id === 'c2');
    expect(normalChunk).toBeDefined();
  });

  it('caching does not affect multiple retrieve calls', async () => {
    const retriever = createInMemoryRetriever({ embedding });

    const chunks: DocumentChunk[] = [
      { id: 'c1', documentId: 'd1', content: 'hello', index: 0, embedding: [1, 0, 0, 0] },
      { id: 'c2', documentId: 'd1', content: 'world', index: 1, embedding: [0, 1, 0, 0] },
    ];

    await retriever.index(chunks);

    const results1 = await retriever.retrieve('test', { limit: 10 });
    const results2 = await retriever.retrieve('test', { limit: 10 });

    // Same query should produce same results
    expect(results1.length).toBe(results2.length);
    for (let i = 0; i < results1.length; i++) {
      expect(results1[i].chunk.id).toBe(results2[i].chunk.id);
      expect(results1[i].score).toBeCloseTo(results2[i].score, 10);
    }
  });

  it('handles incremental indexing with caching', async () => {
    const retriever = createInMemoryRetriever({ embedding });

    await retriever.index([
      { id: 'c1', documentId: 'd1', content: 'first', index: 0, embedding: [1, 0, 0, 0] },
    ]);

    await retriever.index([
      { id: 'c2', documentId: 'd1', content: 'second', index: 1, embedding: [0, 1, 0, 0] },
    ]);

    const results = await retriever.retrieve('test', { limit: 10 });
    expect(results).toHaveLength(2);

    const ids = results.map((r) => r.chunk.id);
    expect(ids).toContain('c1');
    expect(ids).toContain('c2');
  });
});

// ===========================================================================
// Pipeline (integration)
// ===========================================================================

describe('createRAGPipeline', () => {
  let embedding: EmbeddingModel;

  beforeEach(() => {
    embedding = createMockEmbeddingModel(4);
  });

  it('ingest returns correct document and chunk counts', async () => {
    const pipeline = createRAGPipeline({
      loader: createTextLoader(['Hello world', 'Another doc']),
      chunking: createFixedSizeChunking({ chunkSize: 100 }),
      embedding,
      retriever: createInMemoryRetriever({ embedding }),
    });

    const result = await pipeline.ingest();

    expect(result.documents).toBe(2);
    expect(result.chunks).toBe(2); // each doc fits in one chunk
  });

  it('getChunks returns all indexed chunks with embeddings', async () => {
    const pipeline = createRAGPipeline({
      loader: createTextLoader(['Hello world']),
      chunking: createFixedSizeChunking({ chunkSize: 5 }),
      embedding,
      retriever: createInMemoryRetriever({ embedding }),
    });

    await pipeline.ingest();
    const chunks = pipeline.getChunks();

    expect(chunks.length).toBeGreaterThan(0);
    // Each chunk should have an embedding
    for (const chunk of chunks) {
      expect(chunk.embedding).toBeDefined();
      expect(chunk.embedding!.length).toBe(4);
    }
  });

  it('query returns scored results after ingest', async () => {
    const pipeline = createRAGPipeline({
      loader: createTextLoader(['The cat sat on the mat.', 'Dogs play in the park.']),
      chunking: createFixedSizeChunking({ chunkSize: 100 }),
      embedding,
      retriever: createInMemoryRetriever({ embedding }),
    });

    await pipeline.ingest();
    const results = await pipeline.query('cat');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('chunk');
    expect(results[0]).toHaveProperty('score');
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

  it('supports multiple ingest calls with different content', async () => {
    let callCount = 0;
    const pipeline = createRAGPipeline({
      loader: {
        async load() {
          callCount++;
          return [{ id: `doc-${callCount}`, content: `doc content ${callCount}` }];
        },
      },
      chunking: createFixedSizeChunking({ chunkSize: 100 }),
      embedding,
      retriever: createInMemoryRetriever({ embedding }),
    });

    const first = await pipeline.ingest();
    const second = await pipeline.ingest();

    expect(first.documents).toBe(1);
    expect(second.documents).toBe(1);
    // getChunks should accumulate
    expect(pipeline.getChunks()).toHaveLength(2);
  });

  it('deduplicates identical content across multiple ingest calls', async () => {
    const pipeline = createRAGPipeline({
      loader: createTextLoader(['first doc']),
      chunking: createFixedSizeChunking({ chunkSize: 100 }),
      embedding,
      retriever: createInMemoryRetriever({ embedding }),
    });

    const first = await pipeline.ingest();
    const second = await pipeline.ingest();

    expect(first.documents).toBe(1);
    expect(first.chunks).toBe(1);
    expect(second.documents).toBe(1);
    // Second ingest returns 0 chunks because content is duplicate
    expect(second.chunks).toBe(0);
    // Only 1 chunk stored due to deduplication
    expect(pipeline.getChunks()).toHaveLength(1);
  });

  it('query passes options through to retriever', async () => {
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

  it('full end-to-end with paragraph chunking', async () => {
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
    expect(result.chunks).toBe(3); // 3 paragraphs

    const queryResults = await pipeline.query('retrieval', { limit: 3 });
    expect(queryResults).toHaveLength(3);
    // Results should be sorted by descending score
    for (let i = 1; i < queryResults.length; i++) {
      expect(queryResults[i - 1].score).toBeGreaterThanOrEqual(queryResults[i].score);
    }
  });

  it('full end-to-end with sliding window chunking', async () => {
    const pipeline = createRAGPipeline({
      loader: createTextLoader(['abcdefghijklmnopqrstuvwxyz']),
      chunking: createSlidingWindowChunking({ windowSize: 10, stepSize: 5 }),
      embedding,
      retriever: createInMemoryRetriever({ embedding }),
    });

    const result = await pipeline.ingest();

    expect(result.documents).toBe(1);
    expect(result.chunks).toBeGreaterThan(1);

    const chunks = pipeline.getChunks();
    for (const chunk of chunks) {
      expect(chunk.embedding).toBeDefined();
    }
  });

  it('works with createDocumentArrayLoader', async () => {
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
    const chunks = pipeline.getChunks();
    expect(chunks[0].documentId).toBe('custom-1');
  });

  describe('ingestDocuments', () => {
    it('ingests pre-loaded documents without a loader', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      const docs: Document[] = [
        { id: 'doc-1', content: 'Hello world' },
        { id: 'doc-2', content: 'Another doc' },
      ];

      const chunkCount = await pipeline.ingestDocuments(docs);
      expect(chunkCount).toBe(2);

      const chunks = pipeline.getChunks();
      expect(chunks).toHaveLength(2);
      expect(chunks[0].content).toBe('Hello world');
      expect(chunks[1].content).toBe('Another doc');
    });

    it('uses chunking strategy when provided', async () => {
      const pipeline = createRAGPipeline({
        chunking: createFixedSizeChunking({ chunkSize: 5 }),
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      const docs: Document[] = [
        { id: 'doc-1', content: 'Hello world' }, // 11 chars -> 3 chunks at size 5
      ];

      const chunkCount = await pipeline.ingestDocuments(docs);
      expect(chunkCount).toBeGreaterThan(1);
    });

    it('treats each document as a single chunk when no chunking strategy', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      const docs: Document[] = [
        { id: 'doc-1', content: 'A long document that would normally be chunked' },
      ];

      const chunkCount = await pipeline.ingestDocuments(docs);
      expect(chunkCount).toBe(1);

      const chunks = pipeline.getChunks();
      expect(chunks[0].content).toBe('A long document that would normally be chunked');
      expect(chunks[0].documentId).toBe('doc-1');
    });

    it('allows querying after ingestDocuments', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingestDocuments([
        { id: 'doc-1', content: 'The cat sat on the mat' },
        { id: 'doc-2', content: 'Dogs play in the park' },
      ]);

      const results = await pipeline.query('cat');
      expect(results.length).toBeGreaterThan(0);
    });

    it('throws when ingest() called without a loader', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await expect(pipeline.ingest()).rejects.toThrow('No loader configured');
    });
  });

  it('throws RAG_EMBEDDING_MISMATCH when embedding count differs from chunk count', async () => {
    // Create a broken embedding model that returns fewer embeddings than inputs
    const brokenEmbedding: EmbeddingModel = {
      dimensions: 4,
      async embed(texts: readonly string[]) {
        // Return only one embedding regardless of input count
        return [[1, 0, 0, 0]];
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

  it('clear() removes all indexed chunks', async () => {
    const pipeline = createRAGPipeline({
      loader: createTextLoader(['Hello world']),
      chunking: createFixedSizeChunking({ chunkSize: 100 }),
      embedding,
      retriever: createInMemoryRetriever({ embedding }),
    });

    await pipeline.ingest();
    expect(pipeline.getChunks()).toHaveLength(1);

    pipeline.clear();
    expect(pipeline.getChunks()).toHaveLength(0);
  });

  it('clear() allows re-ingestion from empty state', async () => {
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

  // ==========================================================================
  // Fix 3: Deduplication
  // ==========================================================================

  describe('deduplication', () => {
    it('skips duplicate chunks within a single ingest call', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      // Two documents with identical content
      const docs: Document[] = [
        { id: 'doc-1', content: 'Same content' },
        { id: 'doc-2', content: 'Same content' },
      ];

      const chunkCount = await pipeline.ingestDocuments(docs);
      // Only 1 unique chunk should be added
      expect(chunkCount).toBe(1);
      expect(pipeline.getChunks()).toHaveLength(1);
    });

    it('skips duplicate chunks across multiple ingest calls', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingestDocuments([{ id: 'doc-1', content: 'hello world' }]);
      const secondCount = await pipeline.ingestDocuments([{ id: 'doc-2', content: 'hello world' }]);

      expect(secondCount).toBe(0);
      expect(pipeline.getChunks()).toHaveLength(1);
    });

    it('emits onWarning callback for duplicate chunks', async () => {
      const warnings: { message: string; type: string }[] = [];
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        onWarning: (w) => warnings.push(w),
      });

      await pipeline.ingestDocuments([{ id: 'doc-1', content: 'duplicate' }]);
      await pipeline.ingestDocuments([{ id: 'doc-2', content: 'duplicate' }]);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe('duplicate');
      expect(warnings[0].message).toContain('Duplicate chunk skipped');
    });

    it('allows same content after clear()', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingestDocuments([{ id: 'doc-1', content: 'repeated' }]);
      expect(pipeline.getChunks()).toHaveLength(1);

      pipeline.clear();

      const count = await pipeline.ingestDocuments([{ id: 'doc-2', content: 'repeated' }]);
      expect(count).toBe(1);
      expect(pipeline.getChunks()).toHaveLength(1);
    });

    it('does not deduplicate chunks with different content', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      await pipeline.ingestDocuments([
        { id: 'doc-1', content: 'unique one' },
        { id: 'doc-2', content: 'unique two' },
      ]);

      expect(pipeline.getChunks()).toHaveLength(2);
    });
  });

  // ==========================================================================
  // Fix 3: Capacity (maxChunks)
  // ==========================================================================

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
      expect(pipeline.getChunks()[0].content).toBe('alpha');
      expect(pipeline.getChunks()[1].content).toBe('beta');
    });

    it('emits capacity warning when maxChunks exceeded', async () => {
      const warnings: { message: string; type: string }[] = [];
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        maxChunks: 1,
        onWarning: (w) => warnings.push(w),
      });

      await pipeline.ingestDocuments([
        { id: 'doc-1', content: 'first' },
        { id: 'doc-2', content: 'second' },
      ]);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe('capacity');
      expect(warnings[0].message).toContain('maxChunks');
    });

    it('returns 0 when capacity is already full', async () => {
      const warnings: { message: string; type: string }[] = [];
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        maxChunks: 1,
        onWarning: (w) => warnings.push(w),
      });

      await pipeline.ingestDocuments([{ id: 'doc-1', content: 'first' }]);
      const count = await pipeline.ingestDocuments([{ id: 'doc-2', content: 'second' }]);

      expect(count).toBe(0);
      expect(pipeline.getChunks()).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe('capacity');
      expect(warnings[0].message).toContain('capacity reached');
    });

    it('maxChunks works across multiple ingest calls', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        maxChunks: 3,
      });

      await pipeline.ingestDocuments([
        { id: 'doc-1', content: 'one' },
        { id: 'doc-2', content: 'two' },
      ]);
      const count = await pipeline.ingestDocuments([
        { id: 'doc-3', content: 'three' },
        { id: 'doc-4', content: 'four' },
      ]);

      expect(count).toBe(1); // Only room for 1 more
      expect(pipeline.getChunks()).toHaveLength(3);
    });

    it('clear() resets capacity allowing new chunks', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
        maxChunks: 1,
      });

      await pipeline.ingestDocuments([{ id: 'doc-1', content: 'first' }]);
      pipeline.clear();
      const count = await pipeline.ingestDocuments([{ id: 'doc-2', content: 'second' }]);

      expect(count).toBe(1);
      expect(pipeline.getChunks()).toHaveLength(1);
    });

    it('pipeline works normally without maxChunks (no limit)', async () => {
      const pipeline = createRAGPipeline({
        embedding,
        retriever: createInMemoryRetriever({ embedding }),
      });

      // Should accept many chunks without issue
      const docs: Document[] = [];
      for (let i = 0; i < 50; i++) {
        docs.push({ id: `doc-${i}`, content: `content ${i}` });
      }
      const count = await pipeline.ingestDocuments(docs);
      expect(count).toBe(50);
      expect(pipeline.getChunks()).toHaveLength(50);
    });
  });
});
