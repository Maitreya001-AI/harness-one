/**
 * Template for the 'rag' module scaffold.
 *
 * Emitted into the user's project by `harness-one init --modules rag`.
 * Subpath literals in this template MUST match exports in the core package's
 * package.json (enforced by packages/cli/src/__tests__/templates-subpaths.test.ts).
 *
 * @module
 */

export const template = `import {
  createRAGPipeline,
  createTextLoader,
  createDocumentArrayLoader,
  createFixedSizeChunking,
  createParagraphChunking,
  createInMemoryRetriever,
} from 'harness-one/rag';
import type { EmbeddingModel } from 'harness-one/rag';

// 1. Bring your own embedding model (wrap any provider SDK)
const embedding: EmbeddingModel = {
  dimensions: 1536,
  async embed(texts) {
    // Replace with your real embedding call (OpenAI, Cohere, etc.)
    return texts.map(() => new Array(1536).fill(0).map(() => Math.random()));
  },
};

// 2. Assemble the pipeline: loader -> chunking -> embedding -> retriever
const pipeline = createRAGPipeline({
  loader: createTextLoader([
    'Retrieval-Augmented Generation combines retrieval with generation.',
    'It grounds LLM answers in your documents.',
  ]),
  chunking: createFixedSizeChunking({ chunkSize: 200, overlap: 20 }),
  embedding,
  retriever: createInMemoryRetriever({ embedding }),
  maxChunks: 10_000,
  validateEmbedding: true,
  onWarning: (w) => console.warn('[rag]', w.type, w.message),
});

// 3. Ingest documents (load -> chunk -> embed -> index)
const { documents, chunks } = await pipeline.ingest();
console.log(\`Ingested \${chunks} chunks from \${documents} documents\`);

// 4. Query and surface relevant chunks with scores
const results = await pipeline.query('what is RAG?', { limit: 3, minScore: 0.2 });
for (const r of results) {
  console.log(\`[score=\${r.score.toFixed(3)}] \${r.chunk.content.slice(0, 80)}...\`);
}

// 5. Observability: per-chunk ingestion metrics
const metrics = pipeline.getIngestMetrics();
console.log('Ingest metrics:', metrics);

// 6. Ingest pre-loaded documents bypassing the loader
await pipeline.ingestDocuments([
  { id: 'doc-custom', content: 'Additional knowledge.', metadata: { source: 'api' } },
]);

// 7. Alternate chunking + custom loader
const paragraphPipeline = createRAGPipeline({
  loader: createDocumentArrayLoader([
    { id: 'multi', content: 'Paragraph one.\\n\\nParagraph two.' },
  ]),
  chunking: createParagraphChunking(),
  embedding,
  retriever: createInMemoryRetriever({ embedding }),
});
await paragraphPipeline.ingest();
`;
