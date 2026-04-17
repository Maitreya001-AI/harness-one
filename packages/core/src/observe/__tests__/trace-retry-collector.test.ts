/**
 * Tests for `trace-retry-collector.ts` — round-3 extraction from trace-manager.
 */
import { describe, it, expect } from 'vitest';
import { createTraceRetryCollector } from '../trace-retry-collector.js';

describe('createTraceRetryCollector', () => {
  it('zero-initialises every counter', () => {
    const c = createTraceRetryCollector();
    expect(c.snapshot()).toEqual({
      totalRetries: 0,
      successAfterRetry: 0,
      failedAfterRetries: 0,
    });
  });

  it('counts retries + success outcome', () => {
    const c = createTraceRetryCollector();
    c.noteRetry('s1');
    c.noteRetry('s1');
    c.noteRetry('s2');
    expect(c.snapshot().totalRetries).toBe(3);
    c.noteSpanEnded('s1', 'completed');
    c.noteSpanEnded('s2', 'error');
    expect(c.snapshot().successAfterRetry).toBe(1);
    expect(c.snapshot().failedAfterRetries).toBe(1);
  });

  it('does not double-count a span that ends twice', () => {
    const c = createTraceRetryCollector();
    c.noteRetry('s1');
    c.noteSpanEnded('s1', 'completed');
    c.noteSpanEnded('s1', 'error'); // second end — already forgotten
    expect(c.snapshot().successAfterRetry).toBe(1);
    expect(c.snapshot().failedAfterRetries).toBe(0);
  });

  it('ignores end events for spans that never saw a retry', () => {
    const c = createTraceRetryCollector();
    c.noteSpanEnded('s1', 'completed');
    c.noteSpanEnded('s1', 'error');
    expect(c.snapshot()).toEqual({
      totalRetries: 0,
      successAfterRetry: 0,
      failedAfterRetries: 0,
    });
  });

  it('forget() drops a span without counting outcome', () => {
    const c = createTraceRetryCollector();
    c.noteRetry('s1');
    c.forget('s1');
    c.noteSpanEnded('s1', 'error'); // span already forgotten
    expect(c.snapshot().totalRetries).toBe(1);
    expect(c.snapshot().failedAfterRetries).toBe(0);
  });

  it('reset() zeroes everything', () => {
    const c = createTraceRetryCollector();
    c.noteRetry('s1');
    c.noteSpanEnded('s1', 'completed');
    c.reset();
    expect(c.snapshot()).toEqual({
      totalRetries: 0,
      successAfterRetry: 0,
      failedAfterRetries: 0,
    });
  });
});
