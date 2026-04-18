/**
 * Example: End-to-end RAG pipeline with custom EmbeddingModel + in-memory Retriever.
 *
 * Shows the 5 stages of `harness-one/rag`:
 *   load → chunk → embed → index → query
 *
 * Each stage is an independent interface you can swap:
 *   - `DocumentLoader`    — replace with S3/DB/API loader
 *   - `ChunkingStrategy`  — switch between fixed-size, paragraph, sliding-window
 *   - `EmbeddingModel`    — plug in OpenAI / Cohere / local model
 *   - `Retriever`         — plug in Pinecone / pgvector / Weaviate
 *
 * The built-in in-memory retriever is fine for small corpora (< 10k chunks);
 * swap to an external vector DB when you outgrow it.
 */
import {
  createTextLoader,
  createParagraphChunking,
  createInMemoryRetriever,
  createRAGPipeline,
} from 'harness-one/rag';
import type { EmbeddingModel } from 'harness-one/rag';

// ── Implement EmbeddingModel with a toy hash-based embedding ────────────────
// Real code wires this to OpenAI Embeddings, Cohere, Voyage, or a local model.
// The contract: `embed(texts)` returns a 2D number[][]; `dimensions` is constant.
const toyEmbedding: EmbeddingModel = {
  dimensions: 16,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array<number>(16).fill(0);
      for (let i = 0; i < t.length; i++) v[i % 16] += t.charCodeAt(i) / 1000;
      const mag = Math.hypot(...v) || 1;
      return v.map((x) => x / mag); // L2-normalize so cosine similarity behaves
    });
  },
};

async function main(): Promise<void> {
  const corpus = [
    'Harness engineering is the hard 30% that turns a prototype into a product.',
    'KV-cache stability means keeping the stable prefix unchanged across turns.',
    'Fail-closed guardrails prevent a single misconfiguration from leaking data.',
    'Token budgets should reserve space for the model response before packing.',
    'Context compression preserves failure traces so the agent can self-correct.',
  ];

  // ── Wire the pipeline ─────────────────────────────────────────────────────
  const pipeline = createRAGPipeline({
    loader: createTextLoader(corpus, { source: 'harness-docs' }),
    chunking: createParagraphChunking({ maxChunkSize: 500 }),
    embedding: toyEmbedding,
    retriever: createInMemoryRetriever({
      embedding: toyEmbedding,
      queryCacheSize: 128, // LRU cache for repeated queries
    }),
    maxChunks: 10_000,
    onWarning: ({ type, message }) => console.warn(`[rag:${type}]`, message),
  });

  // ── Full ingest: loader → chunking → embedding → indexing ────────────────
  const { documents, chunks } = await pipeline.ingest();
  console.log(`Ingested ${documents} docs, ${chunks} chunks`);

  // ── Query: embed(query) → cosine similarity → top-k with scores ──────────
  const hits = await pipeline.query('What is KV-cache stability?', {
    limit: 3,
    minScore: 0.1,
  });
  for (const { chunk, score, tokens } of hits) {
    console.log(
      `[${score.toFixed(3)}] ~${tokens} tokens: ${chunk.content.slice(0, 80)}`,
    );
  }

  // ── token-budgeted filter: don't inject more than 300 tokens of context ──
  let budget = 300;
  const injected = hits.filter((r) => {
    const t = r.tokens ?? 0;
    if (t > budget) return false;
    budget -= t;
    return true;
  });
  console.log(`Injecting ${injected.length} chunk(s), ${300 - budget} tokens`);

  // ── Metrics snapshot (OBS-006) — attempted / succeeded / failed counts ───
  console.log('Ingest metrics:', pipeline.getIngestMetrics());

  // Later, ingest additional docs without rebuilding the pipeline:
  const added = await pipeline.ingestDocuments([
    { id: 'extra-1', content: 'Progressive disclosure loads knowledge by level.' },
  ]);
  console.log(`Added ${added} more chunks`);
}

main().catch(console.error);
