/**
 * ARCH-012: InstrumentationPort structural compatibility tests.
 *
 * Confirms that:
 *  1. A concrete TraceManager satisfies InstrumentationPort by structural typing.
 *  2. A minimal hand-rolled implementation also satisfies the interface.
 *  3. Optional `startTrace`/`endTrace` are honoured by ports that omit them.
 */

import { describe, it, expect } from 'vitest';
import type { InstrumentationPort } from '../instrumentation-port.js';
import { createTraceManager } from '../trace-manager.js';

describe('InstrumentationPort (ARCH-012)', () => {
  it('TraceManager structurally satisfies InstrumentationPort', () => {
    const tm = createTraceManager();
    // Compile-time check + runtime assertion: assignment succeeds without
    // wrappers or adapters.
    const port: InstrumentationPort = tm;
    expect(typeof port.startSpan).toBe('function');
    expect(typeof port.endSpan).toBe('function');
    expect(typeof port.addSpanEvent).toBe('function');
    expect(typeof port.setSpanAttributes).toBe('function');
    expect(typeof port.startTrace).toBe('function');
    expect(typeof port.endTrace).toBe('function');
  });

  it('a custom InstrumentationPort can record spans without a TraceManager', () => {
    const calls: string[] = [];
    const port: InstrumentationPort = {
      startSpan: (traceId, name) => { calls.push(`startSpan:${traceId}:${name}`); return 'sid'; },
      endSpan: (id, status) => { calls.push(`endSpan:${id}:${status ?? ''}`); },
      addSpanEvent: (id, ev) => { calls.push(`event:${id}:${ev.name}`); },
      setSpanAttributes: (id, attrs) => { calls.push(`attrs:${id}:${Object.keys(attrs).join(',')}`); },
    };
    const sid = port.startSpan('t1', 'work');
    port.setSpanAttributes(sid, { foo: 'bar' });
    port.addSpanEvent(sid, { name: 'tick' });
    port.endSpan(sid, 'completed');
    expect(calls).toEqual([
      'startSpan:t1:work',
      'attrs:sid:foo',
      'event:sid:tick',
      'endSpan:sid:completed',
    ]);
  });

  it('ports without startTrace/endTrace are valid', () => {
    // No optional methods at all — pure span-only port.
    const port: InstrumentationPort = {
      startSpan: () => 's',
      endSpan: () => undefined,
      addSpanEvent: () => undefined,
      setSpanAttributes: () => undefined,
    };
    expect(port.startTrace).toBeUndefined();
    expect(port.endTrace).toBeUndefined();
  });
});
