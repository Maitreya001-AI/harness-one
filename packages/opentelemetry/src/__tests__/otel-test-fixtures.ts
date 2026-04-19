/**
 * Shared fixtures for the OTel adapter tests.
 *
 * @module
 * @internal
 */

import { vi } from 'vitest';
import type { Tracer, Span as OTelSpan } from '@opentelemetry/api';

export function createMockTracer() {
  const endFn = vi.fn();
  const setAttributeFn = vi.fn();
  const setStatusFn = vi.fn();
  const addEventFn = vi.fn();

  const mockSpan = {
    setAttribute: setAttributeFn,
    setStatus: setStatusFn,
    addEvent: addEventFn,
    end: endFn,
  };

  const startActiveSpanFn = vi.fn().mockImplementation((_name: string, ...args: unknown[]) => {
    const fn = args[args.length - 1] as (span: OTelSpan) => void;
    fn(mockSpan as unknown as OTelSpan);
  });

  return {
    tracer: {
      startActiveSpan: startActiveSpanFn,
    } as unknown as Tracer,
    mocks: {
      startActiveSpan: startActiveSpanFn,
      setAttribute: setAttributeFn,
      setStatus: setStatusFn,
      addEvent: addEventFn,
      end: endFn,
      span: mockSpan,
    },
  };
}
