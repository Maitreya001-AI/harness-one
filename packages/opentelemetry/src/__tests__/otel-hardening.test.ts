/**
 * OTel exporter hardening tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOTelExporter } from '../index.js';
import { createMockTracer } from './otel-test-fixtures.js';

describe('OTel exporter — hardening', () => {
  let mock: ReturnType<typeof createMockTracer>;
  beforeEach(() => { mock = createMockTracer(); });

  it('createOTelExporter return type exposes getDroppedAttributeMetrics', () => {
    const exporter = createOTelExporter({ tracer: mock.tracer });
    // The named interface guarantees this method is callable without an
    // intersection-type cast — regression guard for the anonymous-type fix.
    expect(typeof exporter.getDroppedAttributeMetrics).toBe('function');
    const m = exporter.getDroppedAttributeMetrics();
    expect(m).toEqual({ droppedAttributes: 0, droppedEventAttributes: 0 });
  });

  it('emits parent_fallback counter + debug log when parent resolved via evicted cache', async () => {
    const counterAdd = vi.fn();
    const metricsCounter = vi.fn().mockReturnValue({ add: counterAdd });
    const metrics = {
      counter: metricsCounter,
      gauge: vi.fn().mockReturnValue({ record: vi.fn() }),
      histogram: vi.fn().mockReturnValue({ record: vi.fn() }),
    };
    const debug = vi.fn();
    const logger = { warn: vi.fn(), debug };

    // Keep spanMap tiny so the parent gets evicted to evictedParents before
    // the child is exported.
    const exporter = createOTelExporter({
      tracer: mock.tracer,
      maxSpans: 1,
      maxEvictedParents: 10,
      metrics,
      logger,
    });

    await exporter.exportSpan({
      id: 'p', traceId: 't', name: 'parent',
      startTime: 0, endTime: 1, attributes: {}, events: [], status: 'completed',
    });
    // Export a second unrelated span to force eviction of 'p' from spanMap.
    await exporter.exportSpan({
      id: 'other', traceId: 't', name: 'other',
      startTime: 2, endTime: 3, attributes: {}, events: [], status: 'completed',
    });

    // Now a child referencing parent 'p' — must be found via evictedParents.
    await exporter.exportSpan({
      id: 'c', traceId: 't', parentId: 'p', name: 'child',
      startTime: 4, endTime: 5, attributes: {}, events: [], status: 'completed',
    });

    expect(metricsCounter).toHaveBeenCalledWith(
      'harness.otel.parent_fallback',
      expect.any(Object),
    );
    expect(counterAdd).toHaveBeenCalledWith(1, {
      exporter: 'opentelemetry',
      source: 'evicted_parents_cache',
    });
    expect(debug).toHaveBeenCalledWith(
      'otel parent fallback',
      expect.objectContaining({
        parent_id: 'p',
        source: 'evicted_parents_cache',
        child_id: 'c',
      }),
    );
  });

  it('no counter emitted when parent is live in spanMap', async () => {
    const counterAdd = vi.fn();
    const metrics = {
      counter: vi.fn().mockReturnValue({ add: counterAdd }),
      gauge: vi.fn().mockReturnValue({ record: vi.fn() }),
      histogram: vi.fn().mockReturnValue({ record: vi.fn() }),
    };
    const exporter = createOTelExporter({
      tracer: mock.tracer,
      maxSpans: 1000,
      metrics,
    });
    await exporter.exportSpan({
      id: 'p', traceId: 't', name: 'parent',
      startTime: 0, endTime: 1, attributes: {}, events: [], status: 'completed',
    });
    await exporter.exportSpan({
      id: 'c', traceId: 't', parentId: 'p', name: 'child',
      startTime: 2, endTime: 3, attributes: {}, events: [], status: 'completed',
    });
    expect(counterAdd).not.toHaveBeenCalled();
  });
});
