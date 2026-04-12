/**
 * Example: Cache Monitor for KV-cache hit rate tracking
 *
 * Tracks cache hit rates and estimated cost savings from KV-cache usage.
 * Useful for optimizing prompt design to maximize cache utilization.
 */
import { createCacheMonitor } from 'harness-one/observe';

async function main() {
  const monitor = createCacheMonitor({
    // Cost per 1k tokens for cache read vs. fresh input
    cacheReadPricePer1k: 0.0003,
    inputPricePer1k: 0.003,
  });

  // Record cache events from multiple agent iterations
  monitor.record({
    inputTokens: 1000,
    cacheReadTokens: 800,   // 800 tokens served from cache
    cacheWriteTokens: 200,  // 200 tokens written to cache
  });

  monitor.record({
    inputTokens: 1200,
    cacheReadTokens: 1000,
    cacheWriteTokens: 200,
  });

  monitor.record({
    inputTokens: 500,
    cacheReadTokens: 0,     // Cache miss
    cacheWriteTokens: 500,
  });

  // Get cache analytics
  const stats = monitor.stats();
  console.log(`Total input tokens: ${stats.totalInputTokens}`);
  console.log(`Cache hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
  console.log(`Estimated savings: $${stats.estimatedSavings.toFixed(4)}`);
  console.log(`Total records: ${stats.recordCount}`);
}

main().catch(console.error);
