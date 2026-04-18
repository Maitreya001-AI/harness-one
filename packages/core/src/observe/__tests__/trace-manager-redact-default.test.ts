/**
 * createTraceManager default redaction behaviour.
 *
 * Secure-by-default contract:
 *   - `redact` omitted (undefined) => DEFAULT_SECRET_PATTERN is active
 *   - `redact: false` => redaction is explicitly disabled
 *   - `redact: RedactConfig` => honor the object as-is
 */
import { describe, it, expect } from 'vitest';
import { createTraceManager } from '../trace-manager.js';
import type { TraceExporter } from '../types.js';

describe('T03 createTraceManager default redaction', () => {
  it('redacts secret keys by default when no redact option is provided', async () => {
    const exported: Record<string, unknown>[] = [];
    const exporter: TraceExporter = {
      name: 'capture',
      async exportTrace() {},
      async exportSpan(span) {
        exported.push({ ...span.attributes });
      },
      async flush() {},
    };
    // No `redact` option => secure-by-default: DEFAULT_SECRET_PATTERN active.
    const tm = createTraceManager({ exporters: [exporter] });
    const traceId = tm.startTrace('t');
    const spanId = tm.startSpan(traceId, 's');
    tm.setSpanAttributes(spanId, { api_key: 'sk-xyz', safe: 'ok' });
    tm.endSpan(spanId);
    await new Promise((r) => setTimeout(r, 10));

    expect(exported[0].api_key).toBe('[REDACTED]');
    expect(exported[0].safe).toBe('ok');
  });

  it('redacts trace userMetadata secret keys by default', () => {
    const tm = createTraceManager();
    const traceId = tm.startTrace('t', { authorization: 'Bearer xxx', env: 'prod' });
    const trace = tm.getTrace(traceId)!;
    expect(trace.userMetadata.authorization).toBe('[REDACTED]');
    expect(trace.userMetadata.env).toBe('prod');
  });

  it('redacts span-event attribute secrets by default', () => {
    const tm = createTraceManager();
    const traceId = tm.startTrace('t');
    const spanId = tm.startSpan(traceId, 's');
    tm.addSpanEvent(spanId, {
      name: 'evt',
      attributes: { password: 'hunter2', note: 'fine' },
    });
    const trace = tm.getTrace(traceId)!;
    expect(trace.spans[0].events[0].attributes!.password).toBe('[REDACTED]');
    expect(trace.spans[0].events[0].attributes!.note).toBe('fine');
  });

  it('disables redaction completely when redact: false is passed', async () => {
    const exported: Record<string, unknown>[] = [];
    const exporter: TraceExporter = {
      name: 'capture',
      async exportTrace() {},
      async exportSpan(span) {
        exported.push({ ...span.attributes });
      },
      async flush() {},
    };
    const tm = createTraceManager({ exporters: [exporter], redact: false });
    const traceId = tm.startTrace('t', { api_key: 'visible' });
    const spanId = tm.startSpan(traceId, 's');
    tm.setSpanAttributes(spanId, { api_key: 'sk-plain', secret: 'raw' });
    tm.endSpan(spanId);
    tm.endTrace(traceId);
    await new Promise((r) => setTimeout(r, 10));

    expect(exported[0].api_key).toBe('sk-plain');
    expect(exported[0].secret).toBe('raw');
    const trace = tm.getTrace(traceId)!;
    expect(trace.userMetadata.api_key).toBe('visible');
  });

  it('RedactConfig object with custom keys only', () => {
    const tm = createTraceManager({
      redact: { useDefaultPattern: false, extraKeys: ['x'] },
    });
    const traceId = tm.startTrace('t', { x: 'hide-me', api_key: 'leak' });
    const trace = tm.getTrace(traceId)!;
    // `x` is in extraKeys, so redacted.
    expect(trace.userMetadata.x).toBe('[REDACTED]');
    // `api_key` would match DEFAULT_SECRET_PATTERN, but useDefaultPattern=false.
    expect(trace.userMetadata.api_key).toBe('leak');
  });

  it('redact: {} still uses the default pattern', () => {
    const tm = createTraceManager({ redact: {} });
    const traceId = tm.startTrace('t', { token: 'secret123', ok: 'yep' });
    const trace = tm.getTrace(traceId)!;
    expect(trace.userMetadata.token).toBe('[REDACTED]');
    expect(trace.userMetadata.ok).toBe('yep');
  });
});
