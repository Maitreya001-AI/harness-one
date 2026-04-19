/**
 * Langfuse exporter — hardening tests.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createLangfuseExporter,
} from '../index.js';
import type { LangfuseExporterConfig } from '../index.js';
import type { Trace, Span } from 'harness-one/observe';

describe('Langfuse exporter — hardening', () => {
  it('flush() awaits client.flushAsync() (no fire-and-forget)', async () => {
    // Build a client whose flushAsync resolves only when we release a deferred.
    // If `flush()` were still fire-and-forget, it would return before the
    // client actually drained, and our observed ordering would be inverted.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const flushAsyncFn = vi.fn().mockImplementation(() => gate);
    const client = { trace: vi.fn(), flushAsync: flushAsyncFn } as unknown as LangfuseExporterConfig['client'];

    const exporter = createLangfuseExporter({ client });
    let flushResolved = false;
    const flushPromise = exporter.flush().then(() => { flushResolved = true; });

    // Give the microtask queue a tick so any non-awaited promises would settle.
    await new Promise((r) => setTimeout(r, 5));
    expect(flushResolved).toBe(false); // flush() must still be waiting

    release();
    await flushPromise;
    expect(flushResolved).toBe(true);
    expect(flushAsyncFn).toHaveBeenCalledTimes(1);
  });

  it('flush() surfaces rejection so callers cannot miss failures', async () => {
    const flushAsyncFn = vi.fn().mockRejectedValue(new Error('upstream 500'));
    const client = { trace: vi.fn(), flushAsync: flushAsyncFn } as unknown as LangfuseExporterConfig['client'];
    const exporter = createLangfuseExporter({ client });
    await expect(exporter.flush()).rejects.toThrow('upstream 500');
  });

  it('tags offending span with exporter_error before re-throwing', async () => {
    // Use a client whose span() throws on invocation.
    const throwingSpan = vi.fn(() => { throw new Error('serialization fail'); });
    const mockTraceObj = {
      generation: vi.fn(),
      span: throwingSpan,
      update: vi.fn(),
      event: vi.fn(),
    };
    const traceFn = vi.fn().mockReturnValue(mockTraceObj);
    const flushAsyncFn = vi.fn().mockResolvedValue(undefined);
    const client = { trace: traceFn, flushAsync: flushAsyncFn } as unknown as LangfuseExporterConfig['client'];

    const events: Array<{ spanId: string; name: string; attributes?: Record<string, unknown> }> = [];
    const instrumentation = {
      startSpan: vi.fn(() => 's'),
      endSpan: vi.fn(),
      addSpanEvent: (spanId: string, ev: { name: string; attributes?: Record<string, unknown> }) => {
        events.push({ spanId, ...ev });
      },
      setSpanAttributes: vi.fn(),
    };

    const exporter = createLangfuseExporter({ client, instrumentation });
    const span: Span = {
      id: 'span-err',
      traceId: 'trace-err',
      name: 'boom',
      startTime: 1,
      attributes: {},
      events: [],
      status: 'error',
    };

    await expect(exporter.exportSpan(span)).rejects.toThrow('serialization fail');
    // Event must carry exporter='langfuse' and error_code.
    expect(events).toHaveLength(1);
    expect(events[0].spanId).toBe('span-err');
    expect(events[0].name).toBe('exporter_error');
    expect(events[0].attributes).toEqual({ exporter: 'langfuse', error_code: 'unknown' });
  });

  it('preserves HarnessError.code when available on exporter_error', async () => {
    const { HarnessError, HarnessErrorCode } = await import('harness-one/core');
    const throwingUpdate = vi.fn(() => {
      throw new HarnessError('forced', HarnessErrorCode.ADAPTER_ERROR);
    });
    const mockTraceObj = {
      generation: vi.fn(),
      span: vi.fn(),
      update: throwingUpdate,
      event: vi.fn(),
    };
    const traceFn = vi.fn().mockReturnValue(mockTraceObj);
    const flushAsyncFn = vi.fn().mockResolvedValue(undefined);
    const client = { trace: traceFn, flushAsync: flushAsyncFn } as unknown as LangfuseExporterConfig['client'];
    const events: Array<Record<string, unknown>> = [];
    const instrumentation = {
      startSpan: vi.fn(() => 's'),
      endSpan: vi.fn(),
      addSpanEvent: (spanId: string, ev: { name: string; attributes?: Record<string, unknown> }) =>
        events.push({ spanId, ...ev }),
      setSpanAttributes: vi.fn(),
    };
    const exporter = createLangfuseExporter({ client, instrumentation });
    const trace: Trace = {
      id: 'trace-forced',
      name: 't',
      startTime: 1,
      metadata: {},
      spans: [],
      status: 'completed',
    };
    await expect(exporter.exportTrace(trace)).rejects.toBeInstanceOf(HarnessError);
    expect(events[0].attributes).toMatchObject({
      exporter: 'langfuse',
      error_code: HarnessErrorCode.ADAPTER_ERROR,
    });
  });

  it('falls back cleanly when instrumentation.addSpanEvent throws', async () => {
    const throwingSpan = vi.fn(() => { throw new Error('x'); });
    const mockTraceObj = {
      generation: vi.fn(), span: throwingSpan, update: vi.fn(), event: vi.fn(),
    };
    const client = {
      trace: vi.fn().mockReturnValue(mockTraceObj),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    } as unknown as LangfuseExporterConfig['client'];
    const instrumentation = {
      startSpan: vi.fn(() => 's'),
      endSpan: vi.fn(),
      addSpanEvent: vi.fn(() => { throw new Error('span gone'); }),
      setSpanAttributes: vi.fn(),
    };
    const exporter = createLangfuseExporter({ client, instrumentation });
    const span: Span = {
      id: 's', traceId: 't', name: 'n', startTime: 0,
      attributes: {}, events: [], status: 'error',
    };
    // The original export error must still propagate (not the instrumentation one).
    await expect(exporter.exportSpan(span)).rejects.toThrow('x');
  });

  it('flush() rejection increments metrics counter and logs warn', async () => {
    const flushAsyncFn = vi.fn().mockRejectedValue(new Error('batch down'));
    const client = { trace: vi.fn(), flushAsync: flushAsyncFn } as unknown as LangfuseExporterConfig['client'];

    const counterAdd = vi.fn();
    const metrics = {
      counter: vi.fn().mockReturnValue({ add: counterAdd }),
      gauge: vi.fn().mockReturnValue({ record: vi.fn() }),
      histogram: vi.fn().mockReturnValue({ record: vi.fn() }),
    };
    const warn = vi.fn();
    const logger = { warn, error: vi.fn(), debug: vi.fn() };

    const exporter = createLangfuseExporter({ client, metrics, logger });
    await expect(exporter.flush()).rejects.toThrow('batch down');
    expect(metrics.counter).toHaveBeenCalledWith(
      'harness.langfuse.flush_failures',
      expect.any(Object),
    );
    expect(counterAdd).toHaveBeenCalledWith(1, { exporter: 'langfuse' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('flush failed'),
      expect.objectContaining({ error: 'batch down' }),
    );
  });

  it('does not emit counter on successful flush', async () => {
    const flushAsyncFn = vi.fn().mockResolvedValue(undefined);
    const client = { trace: vi.fn(), flushAsync: flushAsyncFn } as unknown as LangfuseExporterConfig['client'];
    const counterAdd = vi.fn();
    const metrics = {
      counter: vi.fn().mockReturnValue({ add: counterAdd }),
      gauge: vi.fn().mockReturnValue({ record: vi.fn() }),
      histogram: vi.fn().mockReturnValue({ record: vi.fn() }),
    };
    const exporter = createLangfuseExporter({ client, metrics });
    await exporter.flush();
    expect(counterAdd).not.toHaveBeenCalled();
  });
});
