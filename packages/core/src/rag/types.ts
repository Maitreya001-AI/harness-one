/**
 * Types for the RAG (Retrieval-Augmented Generation) pipeline.
 *
 * @module
 */

import type { InstrumentationPort } from '../observe/instrumentation-port.js';

/** A document to be processed by the RAG pipeline. */
export interface Document {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
  readonly source?: string;
}

/** A chunk of a document after splitting. */
export interface DocumentChunk {
  readonly id: string;
  readonly documentId: string;
  readonly content: string;
  readonly index: number;
  readonly metadata?: Record<string, unknown>;
  /** Embedding vector, populated after embedding step. */
  readonly embedding?: readonly number[];
}

/** Result of a retrieval query. */
export interface RetrievalResult {
  readonly chunk: DocumentChunk;
  readonly score: number;
  /** Estimated token count for this result's content. Populated by the pipeline using content.length / 4 heuristic. */
  readonly tokens?: number;
}

/** Interface for loading documents from various sources. */
export interface DocumentLoader {
  load(): Promise<Document[]>;
}

/** Interface for splitting documents into chunks. */
export interface ChunkingStrategy {
  readonly name: string;
  chunk(document: Document): DocumentChunk[];
}

/** Interface for generating embeddings for text. */
export interface EmbeddingModel {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  readonly dimensions: number;
}

/** Interface for retrieving relevant chunks given a query. */
export interface Retriever {
  /** Index chunks for later retrieval. */
  index(chunks: readonly DocumentChunk[]): Promise<void>;
  /** Retrieve the most relevant chunks for a query. */
  retrieve(query: string, options?: { limit?: number; minScore?: number }): Promise<RetrievalResult[]>;
}

/** Configuration for a RAG pipeline. */
export interface RAGPipelineConfig {
  readonly loader?: DocumentLoader;
  readonly chunking?: ChunkingStrategy;
  readonly embedding: EmbeddingModel;
  readonly retriever: Retriever;
  /** Maximum number of chunks the pipeline will store. When exceeded, new chunks are not added and a warning is emitted. */
  readonly maxChunks?: number;
  /** Called when the pipeline encounters a non-fatal issue (e.g., duplicate chunks, capacity exceeded). */
  readonly onWarning?: (warning: { message: string; type: 'duplicate' | 'capacity' }) => void;
  /**
   * When true, embed a test string during ingest() and verify the result is a valid number array.
   * This catches misconfigured embedding models early before processing the full batch.
   */
  readonly validateEmbedding?: boolean;
  /**
   * OBS-006 / ARCH-012: Optional instrumentation. When provided, ingest() /
   * ingestDocuments() produce a parent span per ingest invocation and a
   * child span per chunk. Failures (validation / embedding / indexing) set
   * `status='error'` on the child span and record an `error.reason`
   * attribute. Omit to disable tracing.
   *
   * Accepts any object satisfying {@link InstrumentationPort} — the
   * harness-one `TraceManager` is structurally compatible, so existing code
   * passing `traceManager: createTraceManager(...)` keeps working unchanged.
   */
  readonly traceManager?: InstrumentationPort;
  /** Optional AbortSignal to cancel in-progress ingest operations. */
  readonly signal?: AbortSignal;
}

/**
 * OBS-006: Aggregate ingestion metrics returned by `getIngestMetrics()`.
 *
 * Tracked by the pipeline as chunks attempt embedding + indexing. The
 * `byFailureReason` map counts per-cause failure buckets (e.g.
 * `embedding_mismatch`, `batch_error`, `embedding_validation`).
 */
export interface IngestMetrics {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly byFailureReason: Record<string, number>;
}

/** A fully-wired RAG pipeline. */
export interface RAGPipeline {
  /** Ingest documents: load -> chunk -> embed -> index. */
  ingest(): Promise<{ documents: number; chunks: number }>;
  /** Ingest pre-loaded documents directly (skips loader). */
  ingestDocuments(documents: Document[]): Promise<number>;
  /** Query: embed query -> retrieve relevant chunks. */
  query(text: string, options?: { limit?: number; minScore?: number }): Promise<RetrievalResult[]>;
  /** Get all indexed chunks. */
  getChunks(): DocumentChunk[];
  /** Clear all indexed chunks. */
  clear(): void;
  /**
   * OBS-006: Returns a snapshot of ingestion metrics. Always available;
   * when no TraceManager is wired, the counts still accrue across
   * `ingest()` / `ingestDocuments()` calls so consumers can alert on them.
   */
  getIngestMetrics(): IngestMetrics;
}
