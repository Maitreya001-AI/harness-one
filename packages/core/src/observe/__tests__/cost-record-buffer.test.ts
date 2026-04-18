/**
 * Direct tests for the bounded record buffer extracted from cost-tracker.ts
 * in Wave-21. The cost-tracker integration tests already cover the buffer's
 * happy path; this suite locks in the branded raw/effective index translation,
 * eviction-time index surgery, and bias compaction so a future change to one
 * cannot silently change the others.
 */
import { describe, it, expect } from 'vitest';
import { createCostRecordBuffer } from '../cost-record-buffer.js';
import type { TokenUsageRecord } from '../../core/pricing.js';

function record(traceId: string | undefined, model: string, cost = 1): TokenUsageRecord {
  return {
    ...(traceId !== undefined && { traceId }),
    model,
    inputTokens: 1,
    outputTokens: 1,
    estimatedCost: cost,
    timestamp: 0,
  };
}

describe('cost-record-buffer', () => {
  it('returns no eviction while under capacity', () => {
    const buffer = createCostRecordBuffer({ maxRecords: 3 });
    expect(buffer.push(record('t1', 'm'))).toBeUndefined();
    expect(buffer.push(record('t1', 'm'))).toBeUndefined();
    expect(buffer.size).toBe(2);
  });

  it('evicts the oldest record when overflowing capacity', () => {
    const buffer = createCostRecordBuffer({ maxRecords: 2 });
    buffer.push(record('t1', 'm', 1));
    buffer.push(record('t2', 'm', 2));
    const evicted = buffer.push(record('t3', 'm', 3));
    expect(evicted?.traceId).toBe('t1');
    expect(evicted?.estimatedCost).toBe(1);
    expect(buffer.size).toBe(2);
  });

  it('drops the trace-index head only for the evicted trace', () => {
    const buffer = createCostRecordBuffer({ maxRecords: 2 });
    buffer.push(record('keep', 'm'));
    buffer.push(record('evict', 'm'));
    const evicted = buffer.push(record('keep', 'm'));
    expect(evicted?.traceId).toBe('keep');
    // The remaining 'keep' record should still be reachable via the index.
    const handle = buffer.getLatestForTrace('keep');
    expect(handle).toBeDefined();
    expect(handle?.record.traceId).toBe('keep');
  });

  it('returns undefined for unknown traces', () => {
    const buffer = createCostRecordBuffer({ maxRecords: 5 });
    expect(buffer.getLatestForTrace('nope')).toBeUndefined();
  });

  it('returns the latest live record for a trace, not the oldest', () => {
    const buffer = createCostRecordBuffer({ maxRecords: 5 });
    buffer.push(record('t1', 'a', 1));
    buffer.push(record('t1', 'b', 2));
    const latest = buffer.getLatestForTrace('t1');
    expect(latest?.record.model).toBe('b');
  });

  it('replaces the live record in place via the handle', () => {
    const buffer = createCostRecordBuffer({ maxRecords: 5 });
    buffer.push(record('t1', 'm', 1));
    const handle = buffer.getLatestForTrace('t1');
    expect(handle).toBeDefined();
    handle!.replace({ ...handle!.record, estimatedCost: 99 });
    expect(buffer.getLatestForTrace('t1')?.record.estimatedCost).toBe(99);
  });

  it('compacts evictionBias back to 0 when fully drained', () => {
    const buffer = createCostRecordBuffer({ maxRecords: 1 });
    buffer.push(record('t1', 'm'));
    buffer.push(record('t2', 'm')); // evicts t1, bias = 1
    buffer.clear();
    // After clear, fresh inserts must work — exercises the post-clear code
    // path that depends on bias being reset to 0.
    expect(buffer.push(record('t3', 'm'))).toBeUndefined();
    expect(buffer.getLatestForTrace('t3')?.record.traceId).toBe('t3');
  });

  it('handles records without traceId without indexing them', () => {
    const buffer = createCostRecordBuffer({ maxRecords: 3 });
    buffer.push(record(undefined, 'm'));
    buffer.push(record(undefined, 'm'));
    expect(buffer.size).toBe(2);
    expect(buffer.getLatestForTrace('anything')).toBeUndefined();
  });

  it('clears all records and indices', () => {
    const buffer = createCostRecordBuffer({ maxRecords: 3 });
    buffer.push(record('t1', 'm'));
    buffer.push(record('t2', 'm'));
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.getLatestForTrace('t1')).toBeUndefined();
    expect(buffer.getLatestForTrace('t2')).toBeUndefined();
  });

  it('drops trace-index entries for evicted traces with a single record', () => {
    const buffer = createCostRecordBuffer({ maxRecords: 1 });
    buffer.push(record('only', 'm'));
    buffer.push(record('next', 'm'));
    // 'only' has been evicted; its index should be gone too.
    expect(buffer.getLatestForTrace('only')).toBeUndefined();
    expect(buffer.getLatestForTrace('next')?.record.traceId).toBe('next');
  });
});
