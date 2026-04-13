/**
 * RAG (Retrieval-Augmented Generation) module — document loading,
 * chunking, embedding, retrieval, and pipeline orchestration.
 *
 * @module
 */

// Types
export type {
  Document,
  DocumentChunk,
  RetrievalResult,
  DocumentLoader,
  ChunkingStrategy,
  EmbeddingModel,
  Retriever,
  RAGPipelineConfig,
  RAGPipeline,
  IngestMetrics,
} from './types.js';

// Loaders
export { createTextLoader, createDocumentArrayLoader } from './loaders.js';

// Chunking
export {
  createFixedSizeChunking,
  createParagraphChunking,
  createSlidingWindowChunking,
} from './chunking.js';

// Retriever
export { createInMemoryRetriever } from './retriever.js';

// Pipeline
export { createRAGPipeline } from './pipeline.js';
