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

  // Running aggregates
  let totalCalls = 0;
  let hitRateSum = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  // Raw data points for time-series
  let rawPoints: RawDataPoint[] = [];

  function evictIfNeeded(): void {
    if (rawPoints.length <= maxRawPoints) return;

    // Remove oldest points beyond limit, correcting aggregates
    const excess = rawPoints.length - maxRawPoints;
    const evicted = rawPoints.splice(0, excess);

    for (const point of evicted) {
      hitRateSum -= point.hitRate;
      totalCacheRead -= point.cacheReadTokens;
      totalCacheWrite -= point.cacheWriteTokens;
      totalCalls--;
    }
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

      totalCalls++;
      hitRateSum += hitRate;
      totalCacheRead += cacheRead;
      totalCacheWrite += cacheWrite;

      rawPoints.push({
        timestamp: Date.now(),
        hitRate,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      });

      evictIfNeeded();
    },

    getMetrics(): CacheMetrics {
      const avgHitRate = totalCalls > 0 ? hitRateSum / totalCalls : 0;
      const estimatedSavings =
        totalCacheRead * (inputPrice - cacheReadPrice) / 1000;

      return {
        totalCalls,
        avgHitRate,
        totalCacheReadTokens: totalCacheRead,
        totalCacheWriteTokens: totalCacheWrite,
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
      totalCalls = 0;
      hitRateSum = 0;
      totalCacheRead = 0;
      totalCacheWrite = 0;
      rawPoints = [];
    },
  };
}
