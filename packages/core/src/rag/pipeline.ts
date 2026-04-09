/**
 * RAG pipeline: orchestrates load -> chunk -> embed -> index -> query.
 *
 * @module
 */

import type { DocumentChunk, RAGPipeline, RAGPipelineConfig } from './types.js';
import { HarnessError } from '../core/errors.js';

/**
 * Create a RAG pipeline that wires together a loader, chunking strategy,
 * embedding model, and retriever.
 *
 * @example
 * ```ts
 * const pipeline = createRAGPipeline({
 *   loader: createTextLoader(['Hello world']),
 *   chunking: createFixedSizeChunking({ chunkSize: 100 }),
 *   embedding: myEmbeddingModel,
 *   retriever: createInMemoryRetriever({ embedding: myEmbeddingModel }),
 * });
 * await pipeline.ingest();
 * const results = await pipeline.query('hello');
 * ```
 */
export function createRAGPipeline(config: RAGPipelineConfig): RAGPipeline {
  const allChunks: DocumentChunk[] = [];

  return Object.freeze({
    async ingest() {
      // 1. Load documents
      const documents = await config.loader.load();

      // 2. Chunk each document
      const chunks: DocumentChunk[] = [];
      for (const doc of documents) {
        chunks.push(...config.chunking.chunk(doc));
      }

      // 3. Embed all chunks
      const texts = chunks.map((c) => c.content);
      const embeddings = await config.embedding.embed(texts);

      if (embeddings.length !== chunks.length) {
        throw new HarnessError(
          `Embedding model returned ${embeddings.length} embeddings for ${chunks.length} chunks`,
          'RAG_EMBEDDING_MISMATCH',
          'Ensure the embedding model returns one embedding per input text',
        );
      }

      // 4. Attach embeddings to chunks
      const embeddedChunks: DocumentChunk[] = chunks.map((chunk, i) => ({
        ...chunk,
        embedding: embeddings[i],
      }));

      // 5. Index for retrieval
      await config.retriever.index(embeddedChunks);
      allChunks.push(...embeddedChunks);

      return { documents: documents.length, chunks: embeddedChunks.length };
    },

    async query(text: string, options?: { limit?: number; minScore?: number }) {
      return config.retriever.retrieve(text, options);
    },

    getChunks() {
      return [...allChunks];
    },

    clear() {
      allChunks.length = 0;
    },
  });
}
