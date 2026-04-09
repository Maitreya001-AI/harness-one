/**
 * RAG pipeline: orchestrates load -> chunk -> embed -> index -> query.
 *
 * @module
 */

import type { Document, DocumentChunk, RAGPipeline, RAGPipelineConfig } from './types.js';
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

  async function chunkAndIndex(documents: Document[]): Promise<number> {
    // Chunk each document (or treat as single chunks if no chunking strategy)
    let chunks: DocumentChunk[];
    if (config.chunking) {
      chunks = [];
      for (const doc of documents) {
        chunks.push(...config.chunking.chunk(doc));
      }
    } else {
      chunks = documents.map((doc, i) => ({
        id: `chunk-${i}`,
        content: doc.content,
        metadata: doc.metadata ?? {},
        documentId: doc.id ?? `doc-${i}`,
        index: i,
      }));
    }

    // Embed all chunks
    const texts = chunks.map((c) => c.content);
    const embeddings = await config.embedding.embed(texts);

    if (embeddings.length !== chunks.length) {
      throw new HarnessError(
        `Embedding model returned ${embeddings.length} embeddings for ${chunks.length} chunks`,
        'RAG_EMBEDDING_MISMATCH',
        'Ensure the embedding model returns one embedding per input text',
      );
    }

    // Attach embeddings to chunks
    const embeddedChunks: DocumentChunk[] = chunks.map((chunk, i) => ({
      ...chunk,
      embedding: embeddings[i],
    }));

    // Index for retrieval
    await config.retriever.index(embeddedChunks);
    allChunks.push(...embeddedChunks);

    return embeddedChunks.length;
  }

  return Object.freeze({
    async ingest() {
      if (!config.loader) {
        throw new HarnessError(
          'No loader configured — use ingestDocuments() for pre-loaded documents',
          'RAG_NO_LOADER',
          'Provide a loader in the pipeline config or use ingestDocuments() instead',
        );
      }

      // 1. Load documents
      const documents = await config.loader.load();

      // 2-5. Chunk, embed, index
      const chunkCount = await chunkAndIndex(documents);

      return { documents: documents.length, chunks: chunkCount };
    },

    async ingestDocuments(documents: Document[]): Promise<number> {
      return chunkAndIndex(documents);
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
