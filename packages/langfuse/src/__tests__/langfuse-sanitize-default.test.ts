/**
 * langfuseExporter — sanitize default-on.
 *
 * When `LangfuseExporterConfig.sanitize` is NOT provided, exportSpan MUST
 * scrub sensitive attribute keys (api_key, token, password, authorization,
 * cookie, …) using a built-in default redactor. Explicit `sanitize: fn`
 * continues to override.
 *
 * Unlike logger / trace-manager, the exporter has NO opt-out:
 * callers can only replace the sanitize function, never disable it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLangfuseExporter } from '../index.js';
import type { LangfuseExporterConfig } from '../index.js';
import type { Span } from 'harness-one/observe';

function createMockLangfuse() {
  const generationFn = vi.fn();
  const spanFn = vi.fn();
  const updateFn = vi.fn();
  const eventFn = vi.fn();

  const mockTraceObj = {
    generation: generationFn,
    span: spanFn,
    update: updateFn,
    event: eventFn,
  };

  const traceFn = vi.fn().mockReturnValue(mockTraceObj);
  const flushAsyncFn = vi.fn().mockResolvedValue(undefined);
  const getPromptFn = vi.fn();

  return {
    client: {
      trace: traceFn,
      flushAsync: flushAsyncFn,
      getPrompt: getPromptFn,
    } as unknown as LangfuseExporterConfig['client'],
    mocks: {
      trace: traceFn,
      generation: generationFn,
      span: spanFn,
      update: updateFn,
      event: eventFn,
      flushAsync: flushAsyncFn,
      getPrompt: getPromptFn,
    },
  };
}

describe('langfuse exporter default sanitize', () => {
  let mock: ReturnType<typeof createMockLangfuse>;

  beforeEach(() => {
    mock = createMockLangfuse();
  });

  it('redacts sensitive keys by default when no sanitize hook is provided', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-secret',
      traceId: 'trace-1',
      name: 'call',
      startTime: 1000,
      endTime: 2000,
      attributes: {
        api_key: 'sk-1234567890',
        authorization: 'Bearer abc',
        normalField: 'visible',
      },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);

    expect(mock.mocks.span).toHaveBeenCalledTimes(1);
    const call = mock.mocks.span.mock.calls[0][0];
    expect(call.metadata.api_key).toBe('[REDACTED]');
    expect(call.metadata.authorization).toBe('[REDACTED]');
    // Non-sensitive keys pass through untouched.
    expect(call.metadata.normalField).toBe('visible');
  });

  it('redacts nested sensitive keys by default', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-nested',
      traceId: 'trace-1',
      name: 'call',
      startTime: 1000,
      endTime: 2000,
      attributes: {
        request: { headers: { authorization: 'Bearer xyz' }, path: '/v1/x' },
      },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);

    const call = mock.mocks.span.mock.calls[0][0];
    const request = call.metadata.request as {
      headers: { authorization: string };
      path: string;
    };
    expect(request.headers.authorization).toBe('[REDACTED]');
    expect(request.path).toBe('/v1/x');
  });

  it('drops prototype-polluting keys by default', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    // Build an attributes object with a real own `__proto__` property so the
    // default sanitize path is forced to drop it (using a bare object literal
    // would set the prototype instead of creating an own key).
    const attributes: Record<string, unknown> = { safe: 'ok' };
    Object.defineProperty(attributes, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(attributes, 'constructor', {
      value: 'evil',
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const span: Span = {
      id: 'span-proto',
      traceId: 'trace-1',
      name: 'call',
      startTime: 1000,
      endTime: 2000,
      attributes,
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);

    const call = mock.mocks.span.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(call.metadata, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(call.metadata, 'constructor')).toBe(false);
    expect(call.metadata.safe).toBe('ok');
  });

  it('applies default sanitize to generation spans as well', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-gen-secret',
      traceId: 'trace-1',
      name: 'llm',
      startTime: 1000,
      endTime: 2000,
      attributes: {
        model: 'claude-3',
        inputTokens: 10,
        outputTokens: 5,
        apiKey: 'sk-should-hide',
      },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);

    expect(mock.mocks.generation).toHaveBeenCalledTimes(1);
    const call = mock.mocks.generation.mock.calls[0][0];
    expect(call.metadata.apiKey).toBe('[REDACTED]');
    expect(call.model).toBe('claude-3');
  });

  it('explicit sanitize fn overrides the default (caller has full control)', async () => {
    const customSanitize = vi.fn((attrs: Record<string, unknown>) => ({
      ...attrs,
      // Custom redacts nothing and keeps api_key visible. Proves we do NOT
      // compose default + custom — explicit wins entirely.
      marker: 'custom-ran',
    }));
    const exporter = createLangfuseExporter({
      client: mock.client,
      sanitize: customSanitize,
    });
    const span: Span = {
      id: 'span-override',
      traceId: 'trace-1',
      name: 'call',
      startTime: 1000,
      endTime: 2000,
      attributes: { api_key: 'sk-visible-to-custom' },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);

    expect(customSanitize).toHaveBeenCalledTimes(1);
    expect(customSanitize).toHaveBeenCalledWith(span.attributes);

    const call = mock.mocks.span.mock.calls[0][0];
    // Custom returned api_key untouched, so it is NOT redacted.
    expect(call.metadata.api_key).toBe('sk-visible-to-custom');
    expect(call.metadata.marker).toBe('custom-ran');
  });

  it('does not mutate the caller-provided attributes object', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const attrs: Record<string, unknown> = {
      api_key: 'sk-original',
      normal: 'x',
    };
    const snapshot = { ...attrs };

    const span: Span = {
      id: 'span-immut',
      traceId: 'trace-1',
      name: 'call',
      startTime: 1000,
      endTime: 2000,
      attributes: attrs,
      events: [],
      status: 'completed',
    };
    await exporter.exportSpan(span);

    expect(attrs).toEqual(snapshot);
  });
});
