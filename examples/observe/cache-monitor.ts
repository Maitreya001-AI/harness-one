/**
 * Example: Cache Monitor for KV-cache hit rate tracking
 *
 * Tracks cache hit rates and estimated cost savings from KV-cache usage.
 * Useful for optimizing prompt design to maximize cache utilization.
 */
import { createCacheMonitor } from 'harness-one/observe';

async function main() {
  const monitor = createCacheMonitor({
    // Pricing is supplied via the `pricing` sub-bag.
    pricing: {
      cacheReadPer1kTokens: 0.0003,
      inputPer1kTokens: 0.003,
    },
  });

  // Record cache events from multiple agent iterations. `record` consumes a
  // TokenUsage shape — outputTokens is required so we include it even when
  // the adapter returned none.
  monitor.record({
    inputTokens: 1000,
    outputTokens: 0,
    cacheReadTokens: 800, // 800 tokens served from cache
    cacheWriteTokens: 200, // 200 tokens written to cache
  });

  monitor.record({
    inputTokens: 1200,
    outputTokens: 0,
    cacheReadTokens: 1000,
    cacheWriteTokens: 200,
  });

  monitor.record({
    inputTokens: 500,
    outputTokens: 0,
    cacheReadTokens: 0, // Cache miss
    cacheWriteTokens: 500,
  });

  // Get cache analytics
  const stats = monitor.getMetrics();
  console.log(`Total calls: ${stats.totalCalls}`);
  console.log(`Avg hit rate: ${(stats.avgHitRate * 100).toFixed(1)}%`);
  console.log(`Estimated savings: $${stats.estimatedSavings.toFixed(4)}`);
  console.log(`Cache reads: ${stats.totalCacheReadTokens}`);
}

main().catch(console.error);
