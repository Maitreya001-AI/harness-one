/**
 * ARCH-009: setSpanAttributes lint-style warning for non-reserved keys.
 *
 * Reserved prefixes (`system.*`, `error.*`, `cost.*`, `user.*`,
 * `harness.*`, etc.) are silent. Other keys produce a one-time warning per
 * distinct key.
 */

import { describe, it, expect, vi } from 'vitest';
import { createTraceManager } from '../trace-manager.js';

function makeLogger() {
  return { warn: vi.fn() };
}

describe('SpanAttributes reserved-prefix lint (ARCH-009)', () => {
  it('warns once per non-reserved key when a logger is configured', () => {
    const logger = makeLogger();
    const tm = createTraceManager({ logger });
    const traceId = tm.startTrace('t');
    const spanId = tm.startSpan(traceId, 's');

    tm.setSpanAttributes(spanId, { unknownKey: 'x' });
    tm.setSpanAttributes(spanId, { unknownKey: 'y' });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('unknownKey');
    tm.endSpan(spanId);
    tm.endTrace(traceId);
  });

  it('reserved prefixes (system, error, cost, user, harness) are silent', () => {
    const logger = makeLogger();
    const tm = createTraceManager({ logger });
    const traceId = tm.startTrace('t');
    const spanId = tm.startSpan(traceId, 's');

    tm.setSpanAttributes(spanId, {
      'system.foo': 1,
      'error.code': 'X',
      'cost.usd': 0.01,
      'user.name': 'alice',
      'harness.span.kind': 'generation',
    });
    expect(logger.warn).not.toHaveBeenCalled();
    tm.endSpan(spanId);
    tm.endTrace(traceId);
  });

  it('historically-known bare keys (iteration, model, …) are silent', () => {
    const logger = makeLogger();
    const tm = createTraceManager({ logger });
    const traceId = tm.startTrace('t');
    const spanId = tm.startSpan(traceId, 's');

    tm.setSpanAttributes(spanId, {
      iteration: 1,
      model: 'gpt-4',
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 12,
    });
    expect(logger.warn).not.toHaveBeenCalled();
    tm.endSpan(spanId);
    tm.endTrace(traceId);
  });

  it('no logger configured ⇒ warning is silently suppressed (no console noise)', () => {
    // No logger; just ensure no throw.
    const tm = createTraceManager();
    const traceId = tm.startTrace('t');
    const spanId = tm.startSpan(traceId, 's');
    expect(() => tm.setSpanAttributes(spanId, { weird: 1 })).not.toThrow();
    tm.endSpan(spanId);
    tm.endTrace(traceId);
  });

  it('different unknown keys each produce one warning', () => {
    const logger = makeLogger();
    const tm = createTraceManager({ logger });
    const traceId = tm.startTrace('t');
    const spanId = tm.startSpan(traceId, 's');

    tm.setSpanAttributes(spanId, { foo: 1 });
    tm.setSpanAttributes(spanId, { bar: 2 });
    tm.setSpanAttributes(spanId, { foo: 3, bar: 4 }); // both already warned

    expect(logger.warn).toHaveBeenCalledTimes(2);
    tm.endSpan(spanId);
    tm.endTrace(traceId);
  });
});
