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
  EmbedOptions,
  EmbeddingModel,
  IndexOptions,
  RetrieveOptions,
  Retriever,
  RAGPipelineConfig,
  RAGPipeline,
  IngestMetrics,
} from './types.js';

// Loaders
export { createTextLoader, createDocumentArrayLoader } from './loaders.js';

// Chunking
export {
  createBasicFixedSizeChunking,
  createBasicParagraphChunking,
  createBasicSlidingWindowChunking,
} from './chunking.js';

// Retriever
export { createInMemoryRetriever } from './retriever.js';

// Conformance kits
export {
  runRetrieverConformance,
  runRetrieverTenantScopingConformance,
  runEmbeddingModelConformance,
  runChunkingStrategyConformance,
} from './conformance.js';
export type {
  RAGConformanceRunner,
  TenantScopingRetrieverAdapter,
} from './conformance.js';

// Pipeline
export { createRAGPipeline } from './pipeline.js';
