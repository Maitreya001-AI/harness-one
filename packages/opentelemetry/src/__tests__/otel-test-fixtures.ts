/**
 * Shared fixtures for the OTel adapter tests.
 *
 * @module
 * @internal
 */

import { vi, type Mock } from 'vitest';
import type { Tracer, Span as OTelSpan } from '@opentelemetry/api';

// Explicit return-type annotation required under typescript@v6: the inferred
// type otherwise pierces into `@vitest/spy`'s internal `Procedure` symbol,
// which tsc 6 rejects as a non-portable inferred type (TS2883).
export interface MockTracer {
  tracer: Tracer;
  mocks: {
    startActiveSpan: Mock;
    setAttribute: Mock;
    setStatus: Mock;
    addEvent: Mock;
    end: Mock;
    span: {
      setAttribute: Mock;
      setStatus: Mock;
      addEvent: Mock;
      end: Mock;
    };
  };
}

export function createMockTracer(): MockTracer {
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
