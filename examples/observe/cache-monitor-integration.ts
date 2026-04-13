/**
 * Example: CacheMonitor wired around a RAG query cache.
 *
 * Pattern: every time a user query is resolved through the RAG pipeline we
 * also observe the LLM-side KV-cache behaviour via a CacheMonitor. The
 * monitor gives us hit-rate + estimated cost savings alongside the RAG
 * retrieval metrics, so the operator sees both "did we retrieve the right
 * chunks" and "did the model reuse cached prefix tokens" in one dashboard.
 *
 * Real imports only — compiles against the workspace packages.
 */
import {
  createRAGPipeline,
  createInMemoryRetriever,
  createFixedSizeChunking,
  createDocumentArrayLoader,
} from 'harness-one/rag';
import type { EmbeddingModel } from 'harness-one/rag';
import { createCacheMonitor } from 'harness-one/observe';
import type { TokenUsage } from 'harness-one/core';

// A toy deterministic embedding model. Replace with your real embedder.
const embedding: EmbeddingModel = {
  async embed(texts) {
    return texts.map((t) => {
      // 4-dimensional fingerprint — good enough for a runnable example.
      const v = [0, 0, 0, 0];
      for (let i = 0; i < t.length; i++) v[i % 4] += t.charCodeAt(i);
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  },
  dimensions: 4,
};

async function main(): Promise<void> {
  // 1. Build a RAG pipeline over a small in-memory corpus.
  const pipeline = createRAGPipeline({
    loader: createDocumentArrayLoader([
      { id: 'a', content: 'Harness engineering is the discipline of building infrastructure around LLMs.' },
      { id: 'b', content: 'KV-cache reuses attention computation across prompt prefixes.' },
      { id: 'c', content: 'Anthropic prompt caching charges a lower rate for cache reads than full input.' },
    ]),
    chunking: createFixedSizeChunking({ chunkSize: 120, overlap: 0 }),
    embedding,
    retriever: createInMemoryRetriever({ embedding }),
  });
  await pipeline.ingest();

  // 2. Create a CacheMonitor. `pricing` is what gives you savings numbers.
  // Plug in the real per-model rates from your provider's pricing page.
  const cache = createCacheMonitor({
    pricing: {
      inputPer1kTokens: 3.0 / 1000,       // USD per token — fresh input
      cacheReadPer1kTokens: 0.30 / 1000,  // USD per token — cached read
    },
    maxBuckets: 100,
  });

  // 3. Run a few queries and record the *LLM* usage that accompanied each.
  //    In a real app you take `TokenUsage` from the AgentAdapter response
  //    (Anthropic exposes cache_read_input_tokens; OpenAI exposes
  //    prompt_tokens_details.cached_tokens). Here we simulate.
  const queries = [
    { q: 'What is harness engineering?',   usage: usage(1200, 0)     }, // cold: cache write
    { q: 'Explain KV-cache.',              usage: usage(1200, 1000)  }, // warm: most prefix cached
    { q: 'How does prompt caching price?', usage: usage(1300, 1100)  }, // warmer
    { q: 'What is harness engineering?',   usage: usage(1200, 1150)  }, // hit same prefix again
  ];

  for (const { q, usage: u } of queries) {
    const hits = await pipeline.query(q, { limit: 2 });
    cache.record(u);
    console.log(`[query] ${q}`);
    console.log(`  retrieved=${hits.length}  input=${u.inputTokens}  cacheRead=${u.cacheReadTokens}`);
  }

  // 4. Pull aggregate metrics. Use these for dashboards / alerts.
  const metrics = cache.getMetrics();
  console.log('\n[cache metrics]');
  console.log(`  totalCalls          = ${metrics.totalCalls}`);
  console.log(`  avgHitRate          = ${(metrics.avgHitRate * 100).toFixed(1)}%`);
  console.log(`  totalCacheReadTokens= ${metrics.totalCacheReadTokens}`);
  console.log(`  estimatedSavings    = $${metrics.estimatedSavings.toFixed(4)}`);

  // 5. Time series — one row per 60 s bucket by default. Send to Prometheus
  //    or your TSDB of choice.
  for (const bucket of cache.getTimeSeries(60_000)) {
    console.log(
      `[bucket ${new Date(bucket.timestamp).toISOString()}] ` +
      `calls=${bucket.calls} hitRate=${(bucket.avgHitRate * 100).toFixed(1)}%`,
    );
  }
}

function usage(input: number, cacheRead: number): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: 200,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheRead === 0 ? input : 0,
  };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
