/**
 * RAG pipeline: orchestrates load -> chunk -> embed -> index -> query.
 *
 * @module
 */

import type { Document, DocumentChunk, IngestMetrics, RAGPipeline, RAGPipelineConfig } from './types.js';
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

  // OBS-006: aggregate ingestion metrics. Counts accrue across all
  // ingest() / ingestDocuments() calls; consumers read via getIngestMetrics().
  let attemptedCount = 0;
  let succeededCount = 0;
  let failedCount = 0;
  const failureReasons: Record<string, number> = {};

  function recordFailure(chunkCount: number, reason: string): void {
    failedCount += chunkCount;
    failureReasons[reason] = (failureReasons[reason] ?? 0) + chunkCount;
  }

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

  async function chunkAndIndex(documents: Document[], parentTraceId?: string): Promise<number> {
    const tm = config.traceManager;

    // Fix 22: Validate embedding before indexing if enabled
    try {
      await validateEmbeddingIfEnabled();
    } catch (err) {
      if (tm && parentTraceId) {
        const vSpan = tm.startSpan(parentTraceId, 'rag.validate_embedding');
        tm.setSpanAttributes(vSpan, {
          'error.reason': 'embedding_validation',
          'error.message': err instanceof Error ? err.message : String(err),
        });
        tm.endSpan(vSpan, 'error');
      }
      throw err;
    }

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

      // OBS-006: start one child span per chunk in the batch. These share the
      // batch outcome — on batch failure every chunk span is marked error with
      // the same reason attribute so consumers see per-chunk granularity.
      const chunkSpanIds: string[] = [];
      if (tm && parentTraceId) {
        for (const chunk of batch) {
          const sid = tm.startSpan(parentTraceId, 'rag.ingest_chunk');
          tm.setSpanAttributes(sid, {
            'chunk.id': chunk.id,
            'chunk.document_id': chunk.documentId,
            'chunk.content_length': chunk.content.length,
          });
          chunkSpanIds.push(sid);
        }
      }

      attemptedCount += batch.length;

      try {
        // Embed batch
        const texts = batch.map((c) => c.content);
        const embeddings = await config.embedding.embed(texts);

        if (embeddings.length !== batch.length) {
          const mismatchErr = new HarnessError(
            `Embedding model returned ${embeddings.length} embeddings for ${batch.length} chunks`,
            'RAG_EMBEDDING_MISMATCH',
            'Ensure the embedding model returns one embedding per input text',
          );
          // Mark each chunk span errored before throwing
          if (tm) {
            for (const sid of chunkSpanIds) {
              tm.setSpanAttributes(sid, {
                'error.reason': 'embedding_mismatch',
                'error.message': mismatchErr.message,
              });
              tm.endSpan(sid, 'error');
            }
          }
          recordFailure(batch.length, 'embedding_mismatch');
          throw mismatchErr;
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
        succeededCount += embeddedChunks.length;

        if (tm) {
          for (const sid of chunkSpanIds) {
            tm.endSpan(sid, 'completed');
          }
        }
      } catch (err: unknown) {
        // Fix 19: Record which chunks failed but keep successfully indexed ones
        for (const chunk of batch) {
          failedChunks.push(chunk.id);
        }

        // Choose a reason: if we already recorded embedding_mismatch above,
        // don't double-count. Detect via HarnessError code.
        const code = err instanceof HarnessError ? err.code : undefined;
        const alreadyCounted = code === 'RAG_EMBEDDING_MISMATCH';
        if (!alreadyCounted) {
          const reason = code ?? 'batch_error';
          recordFailure(batch.length, reason);
          if (tm) {
            for (const sid of chunkSpanIds) {
              tm.setSpanAttributes(sid, {
                'error.reason': reason,
                'error.message': err instanceof Error ? err.message : String(err),
              });
              tm.endSpan(sid, 'error');
            }
          }
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

      // OBS-006: root trace for the full ingest() invocation.
      const tm = config.traceManager;
      const traceId = tm ? tm.startTrace('rag.ingest') : undefined;

      try {
        // 1. Load documents
        const documents = await config.loader.load();

        // 2-5. Chunk, embed, index
        const chunkCount = await chunkAndIndex(documents, traceId);

        return { documents: documents.length, chunks: chunkCount };
      } finally {
        if (tm && traceId) tm.endTrace(traceId);
      }
    },

    async ingestDocuments(documents: Document[]): Promise<number> {
      const tm = config.traceManager;
      const traceId = tm ? tm.startTrace('rag.ingest_documents') : undefined;
      try {
        return await chunkAndIndex(documents, traceId);
      } finally {
        if (tm && traceId) tm.endTrace(traceId);
      }
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

    getIngestMetrics(): IngestMetrics {
      return {
        attempted: attemptedCount,
        succeeded: succeededCount,
        failed: failedCount,
        byFailureReason: { ...failureReasons },
      };
    },
  });
}
