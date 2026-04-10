/**
 * RAG pipeline: orchestrates load -> chunk -> embed -> index -> query.
 *
 * @module
 */

import type { Document, DocumentChunk, RAGPipeline, RAGPipelineConfig } from './types.js';
import { HarnessError } from '../core/errors.js';

/** Fix 18: Result of an ingest operation with capacity signaling. */
export interface IngestResult {
  readonly ingested: number;
  readonly dropped: number;
  readonly atCapacity: boolean;
}

/**
 * Create a RAG pipeline that wires together a loader, chunking strategy,
 * embedding model, and retriever.
 *
 * Deduplication is content-based (exact string match). Paraphrased or reformatted
 * chunks are treated as unique. For semantic deduplication, implement a custom
 * dedup function using embedding similarity. (Fix 17)
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

  /**
   * Fix 22: Optionally validate the embedding function with a probe text
   * before indexing to catch misconfigured models early.
   */
  async function validateEmbeddingIfEnabled(): Promise<void> {
    if (!config.validateEmbedding) return;
    try {
      const probeResult = await config.embedding.embed(['test']);
      if (!probeResult || probeResult.length !== 1) {
        throw new HarnessError(
          'Embedding validation failed: probe did not return exactly 1 embedding',
          'RAG_EMBEDDING_VALIDATION',
          'Ensure the embedding model returns one embedding per input text',
        );
      }
      const embedding = probeResult[0];
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new HarnessError(
          'Embedding validation failed: probe returned empty or non-array embedding',
          'RAG_EMBEDDING_VALIDATION',
          'Ensure the embedding model returns a valid number array',
        );
      }
      for (const val of embedding) {
        if (typeof val !== 'number' || Number.isNaN(val)) {
          throw new HarnessError(
            'Embedding validation failed: probe returned non-numeric values',
            'RAG_EMBEDDING_VALIDATION',
            'Ensure the embedding model returns valid numbers',
          );
        }
      }
    } catch (err: unknown) {
      if (err instanceof HarnessError) throw err;
      throw new HarnessError(
        `Embedding validation failed: ${err instanceof Error ? err.message : String(err)}`,
        'RAG_EMBEDDING_VALIDATION',
        'Check that the embedding model is properly configured',
      );
    }
  }

  async function chunkAndIndex(documents: Document[]): Promise<number> {
    // Fix 22: Validate embedding before indexing if enabled
    await validateEmbeddingIfEnabled();

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

    /**
     * Deduplicate: filter out chunks whose content is already indexed.
     *
     * Fix 17 (JSDoc): Deduplication is content-based (exact string match).
     * Paraphrased or reformatted chunks are treated as unique. For semantic
     * deduplication, implement a custom dedup function using embedding similarity.
     */
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

    // Fix 18: Capacity check with explicit signaling
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
          message: `Pipeline capacity exceeded: only ${remaining} of ${chunks.length} chunks will be added (${chunks.length - remaining} dropped, maxChunks: ${config.maxChunks})`,
          type: 'capacity',
        });
        chunks = chunks.slice(0, remaining);
      }
    }

    if (chunks.length === 0) {
      return 0;
    }

    // Fix 19: Batched ingestion with checkpoints
    const BATCH_SIZE = 100;
    let totalIngested = 0;
    const failedChunks: string[] = [];

    for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, chunks.length);
      const batch = chunks.slice(batchStart, batchEnd);

      try {
        // Embed batch
        const texts = batch.map((c) => c.content);
        const embeddings = await config.embedding.embed(texts);

        if (embeddings.length !== batch.length) {
          throw new HarnessError(
            `Embedding model returned ${embeddings.length} embeddings for ${batch.length} chunks`,
            'RAG_EMBEDDING_MISMATCH',
            'Ensure the embedding model returns one embedding per input text',
          );
        }

        // Attach embeddings to chunks
        const embeddedChunks: DocumentChunk[] = batch.map((chunk, i) => ({
          ...chunk,
          embedding: embeddings[i],
        }));

        // Index for retrieval (checkpoint: this batch is now committed)
        await config.retriever.index(embeddedChunks);

        // Commit content hashes only after successful embedding+indexing
        for (const chunk of embeddedChunks) {
          contentHashes.add(chunk.content);
        }
        allChunks.push(...embeddedChunks);
        totalIngested += embeddedChunks.length;
      } catch (err: unknown) {
        // Fix 19: Record which chunks failed but keep successfully indexed ones
        for (const chunk of batch) {
          failedChunks.push(chunk.id);
        }
        // If it's the first batch and it fails, throw
        if (totalIngested === 0 && batchStart === 0) {
          throw err;
        }
        // Otherwise, continue with remaining batches
      }
    }

    return totalIngested;
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
      const results = await config.retriever.retrieve(text, options);
      // Estimate token count using content length / 4 heuristic (no external tokenizer dependency)
      return results.map((r) => ({
        ...r,
        tokens: Math.ceil(r.chunk.content.length / 4),
      }));
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
