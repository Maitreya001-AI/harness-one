/**
 * Types for the RAG (Retrieval-Augmented Generation) pipeline.
 *
 * @module
 */

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
}
