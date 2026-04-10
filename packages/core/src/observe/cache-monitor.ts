/**
 * Cache hit-rate monitor for tracking KV-cache performance.
 *
 * @module
 */

import type { TokenUsage } from '../core/types.js';
import type { CacheMetrics, CacheMetricsBucket, CacheMonitor, CacheMonitorConfig } from './types.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawDataPoint {
  readonly timestamp: number;
  readonly hitRate: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a cache monitor instance for tracking KV-cache performance.
 */
export function createCacheMonitor(config?: CacheMonitorConfig): CacheMonitor {
  const maxRawPoints = (config?.maxBuckets ?? 100) * 10;
  const cacheReadPrice = config?.pricing?.cacheReadPer1kTokens ?? 0;
  const inputPrice = config?.pricing?.inputPer1kTokens ?? 0;

  // Raw data points for time-series and aggregate recomputation
  let rawPoints: RawDataPoint[] = [];

  function evictIfNeeded(): void {
    if (rawPoints.length <= maxRawPoints) return;
    const excess = rawPoints.length - maxRawPoints;
    rawPoints.splice(0, excess);
  }

  return {
    record(usage: TokenUsage, prefixMatchRatio?: number): void {
      const cacheRead = usage.cacheReadTokens ?? 0;
      const cacheWrite = usage.cacheWriteTokens ?? 0;
      const input = usage.inputTokens;

      let hitRate: number;
      if (prefixMatchRatio !== undefined) {
        hitRate = prefixMatchRatio;
      } else if (input > 0) {
        hitRate = cacheRead / input;
      } else {
        hitRate = 0;
      }

      rawPoints.push({
        timestamp: Date.now(),
        hitRate,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      });

      evictIfNeeded();
    },

    getMetrics(): CacheMetrics {
      // Recompute from raw data to avoid float drift from running subtraction
      const recomputedCalls = rawPoints.length;
      let recomputedHitRateSum = 0;
      let recomputedCacheRead = 0;
      let recomputedCacheWrite = 0;

      for (const point of rawPoints) {
        recomputedHitRateSum += point.hitRate;
        recomputedCacheRead += point.cacheReadTokens;
        recomputedCacheWrite += point.cacheWriteTokens;
      }

      const avgHitRate = recomputedCalls > 0 ? recomputedHitRateSum / recomputedCalls : 0;
      const estimatedSavings =
        recomputedCacheRead * (inputPrice - cacheReadPrice) / 1000;

      return {
        totalCalls: recomputedCalls,
        avgHitRate,
        totalCacheReadTokens: recomputedCacheRead,
        totalCacheWriteTokens: recomputedCacheWrite,
        estimatedSavings: Math.max(0, estimatedSavings),
      };
    },

    getTimeSeries(bucketMs = 60_000): readonly CacheMetricsBucket[] {
      if (rawPoints.length === 0) return [];

      const buckets = new Map<number, { calls: number; hitRateSum: number; cacheRead: number; cacheWrite: number }>();

      for (const point of rawPoints) {
        const bucketKey = Math.floor(point.timestamp / bucketMs) * bucketMs;
        let bucket = buckets.get(bucketKey);
        if (!bucket) {
          bucket = { calls: 0, hitRateSum: 0, cacheRead: 0, cacheWrite: 0 };
          buckets.set(bucketKey, bucket);
        }
        bucket.calls++;
        bucket.hitRateSum += point.hitRate;
        bucket.cacheRead += point.cacheReadTokens;
        bucket.cacheWrite += point.cacheWriteTokens;
      }

      const result: CacheMetricsBucket[] = [];
      const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);

      for (const key of sortedKeys) {
        const bucket = buckets.get(key)!;
        result.push({
          timestamp: key,
          calls: bucket.calls,
          avgHitRate: bucket.calls > 0 ? bucket.hitRateSum / bucket.calls : 0,
          cacheReadTokens: bucket.cacheRead,
          cacheWriteTokens: bucket.cacheWrite,
        });
      }

      return result;
    },

    reset(): void {
      rawPoints = [];
    },
  };
}
