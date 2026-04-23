/**
 * Conformance test suites for public RAG extension points.
 *
 * Adapter/package authors should run these kits against their own
 * implementations to prove they honor the published contract.
 *
 * @module
 */

import { HarnessErrorCode } from '../core/errors.js';
import type {
  ChunkingStrategy,
  Document,
  DocumentChunk,
  EmbeddingModel,
  Retriever,
} from './types.js';

/** Minimal test-runner shape accepted by the RAG conformance kits. */
export interface RAGConformanceRejectsMatcher {
  toMatchObject(expected: Record<string, unknown>): Promise<void>;
}

/** Minimal matcher shape used by the RAG conformance kits. */
export interface RAGConformanceMatchers {
  readonly rejects: RAGConformanceRejectsMatcher;
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
}

export interface RAGConformanceRunner {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => RAGConformanceMatchers;
}

const FIXTURE_CHUNKS: readonly DocumentChunk[] = Object.freeze([
  {
    id: 'alpha',
    documentId: 'doc-1',
    content: 'alpha',
    index: 0,
    metadata: { topic: 'animals', lang: 'en' },
    embedding: [1, 0, 0],
  },
  {
    id: 'beta',
    documentId: 'doc-1',
    content: 'beta',
    index: 1,
    metadata: { topic: 'animals', lang: 'en' },
    embedding: [0.8, 0.2, 0],
  },
  {
    id: 'gamma',
    documentId: 'doc-2',
    content: 'gamma',
    index: 2,
    metadata: { topic: 'science', lang: 'en' },
    embedding: [0, 1, 0],
  },
]);

function createAbortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

export function runRetrieverConformance(
  runner: RAGConformanceRunner,
  factory: () => Promise<Retriever> | Retriever,
): void {
  const { describe, it, expect } = runner;

  describe('Retriever conformance', () => {
    it('index([]) succeeds without throwing', async () => {
      const retriever = await factory();
      await retriever.index([]);
    });

    it('retrieve("", options) returns an array', async () => {
      const retriever = await factory();
      await retriever.index(FIXTURE_CHUNKS);
      const results = await retriever.retrieve('', { limit: 5, minScore: -1 });
      expect(Array.isArray(results)).toBe(true);
    });

    it('returns results sorted by descending score', async () => {
      const retriever = await factory();
      await retriever.index(FIXTURE_CHUNKS);
      const results = await retriever.retrieve('alpha', { limit: 10, minScore: -1 });
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('respects limit', async () => {
      const retriever = await factory();
      await retriever.index(FIXTURE_CHUNKS);
      const results = await retriever.retrieve('alpha', { limit: 1, minScore: -1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('respects minScore', async () => {
      const retriever = await factory();
      await retriever.index(FIXTURE_CHUNKS);
      const results = await retriever.retrieve('alpha', { minScore: 0.75, limit: 10 });
      for (const result of results) {
        expect(result.score).toBeGreaterThanOrEqual(0.75);
      }
    });

    it('supports shallow metadata filtering', async () => {
      const retriever = await factory();
      await retriever.index(FIXTURE_CHUNKS);
      const results = await retriever.retrieve('alpha', {
        limit: 10,
        minScore: -1,
        filter: { topic: 'animals' },
      });
      for (const result of results) {
        expect(result.chunk.metadata?.topic).toBe('animals');
      }
    });

    it('rejects already-aborted signals with CORE_ABORTED', async () => {
      const retriever = await factory();
      await retriever.index(FIXTURE_CHUNKS);
      await expect(
        retriever.retrieve('alpha', { signal: createAbortedSignal() }),
      ).rejects.toMatchObject({ code: HarnessErrorCode.CORE_ABORTED });
    });

    it('re-indexing the same id is stable across repeated reads', async () => {
      const retriever = await factory();
      const duplicate: DocumentChunk = {
        id: 'dup',
        documentId: 'doc-dup',
        content: 'duplicate',
        index: 0,
        embedding: [1, 0, 0],
      };
      await retriever.index([duplicate]);
      await retriever.index([duplicate]);
      const first = await retriever.retrieve('duplicate', { limit: 10, minScore: -1 });
      const second = await retriever.retrieve('duplicate', { limit: 10, minScore: -1 });
      expect(second).toEqual(first);
    });

    it('skips chunks without embeddings instead of crashing', async () => {
      const retriever = await factory();
      await retriever.index([
        ...FIXTURE_CHUNKS,
        {
          id: 'missing-embedding',
          documentId: 'doc-3',
          content: 'missing',
          index: 0,
        },
      ]);
      const results = await retriever.retrieve('alpha', { limit: 10, minScore: -1 });
      expect(results.some((result) => result.chunk.id === 'missing-embedding')).toBe(false);
    });

    it('clear() empties the index when implemented', async () => {
      const retriever = await factory();
      if (typeof retriever.clear !== 'function') return;
      await retriever.index(FIXTURE_CHUNKS);
      await retriever.clear();
      const results = await retriever.retrieve('alpha', { limit: 10, minScore: -1 });
      expect(results).toEqual([]);
    });
  });
}

export function runEmbeddingModelConformance(
  runner: RAGConformanceRunner,
  factory: () => Promise<EmbeddingModel> | EmbeddingModel,
): void {
  const { describe, it, expect } = runner;

  describe('EmbeddingModel conformance', () => {
    it('embed([]) returns []', async () => {
      const model = await factory();
      const results = await model.embed([]);
      expect(results).toEqual([]);
    });

    it('returns one embedding per input with declared dimensions', async () => {
      const model = await factory();
      const results = await model.embed(['alpha', 'beta']);
      expect(results.length).toBe(2);
      for (const embedding of results) {
        expect(embedding.length).toBe(model.dimensions);
        for (const value of embedding) {
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    });

    it('rejects an already-aborted signal with CORE_ABORTED', async () => {
      const model = await factory();
      await expect(
        model.embed(['alpha'], { signal: createAbortedSignal() }),
      ).rejects.toMatchObject({ code: HarnessErrorCode.CORE_ABORTED });
    });

    it('declares maxBatchSize as a positive integer when present', async () => {
      const model = await factory();
      if (model.maxBatchSize === undefined) return;
      expect(Number.isInteger(model.maxBatchSize)).toBe(true);
      expect(model.maxBatchSize).toBeGreaterThan(0);
    });
  });
}

export function runChunkingStrategyConformance(
  runner: RAGConformanceRunner,
  factory: () => Promise<ChunkingStrategy> | ChunkingStrategy,
): void {
  const { describe, it, expect } = runner;

  describe('ChunkingStrategy conformance', () => {
    it('returns [] for empty content', async () => {
      const strategy = await factory();
      const chunks = strategy.chunk({ id: 'doc-empty', content: '' });
      expect(chunks).toEqual([]);
    });

    it('produces indexed chunks bound to the source document', async () => {
      const strategy = await factory();
      const document: Document = {
        id: 'doc-1',
        content: 'alpha beta gamma delta',
        metadata: { lang: 'en' },
      };

      const chunks = strategy.chunk(document);
      expect(chunks.length).toBeGreaterThan(0);
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].documentId).toBe(document.id);
        expect(chunks[i].index).toBe(i);
        expect(chunks[i].content.length).toBeGreaterThan(0);
        expect(typeof chunks[i].id).toBe('string');
        expect(chunks[i].metadata?.lang).toBe('en');
      }
    });
  });
}
