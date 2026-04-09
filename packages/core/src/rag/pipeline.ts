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
  const contentHashes = new Set<string>();

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

    // Deduplicate: filter out chunks whose content is already indexed
    const uniqueChunks: DocumentChunk[] = [];
    const batchSeen = new Set<string>();
    for (const chunk of chunks) {
      if (contentHashes.has(chunk.content) || batchSeen.has(chunk.content)) {
        config.onWarning?.({
          message: `Duplicate chunk skipped: "${chunk.id}" (content already indexed)`,
          type: 'duplicate',
        });
        continue;
      }
      batchSeen.add(chunk.content);
      uniqueChunks.push(chunk);
    }
    chunks = uniqueChunks;

    // Capacity check: enforce maxChunks limit
    if (config.maxChunks !== undefined) {
      const remaining = config.maxChunks - allChunks.length;
      if (remaining <= 0) {
        config.onWarning?.({
          message: `Pipeline capacity reached (maxChunks: ${config.maxChunks}). No new chunks added.`,
          type: 'capacity',
        });
        return 0;
      }
      if (chunks.length > remaining) {
        config.onWarning?.({
          message: `Pipeline capacity exceeded: only ${remaining} of ${chunks.length} chunks will be added (maxChunks: ${config.maxChunks})`,
          type: 'capacity',
        });
        chunks = chunks.slice(0, remaining);
      }
    }

    if (chunks.length === 0) {
      return 0;
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

    // Commit content hashes only after successful embedding+indexing
    for (const chunk of embeddedChunks) {
      contentHashes.add(chunk.content);
    }
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
      contentHashes.clear();
    },
  });
}
