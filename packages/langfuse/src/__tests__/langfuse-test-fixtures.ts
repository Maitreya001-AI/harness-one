/**
 * Shared fixtures for the Langfuse adapter test suites.
 *
 * The suite is split into three focused files (`cost-tracker.test.ts`,
 * `prompt-backend.test.ts`, `exporter.test.ts`); this module holds the
 * mock Langfuse client they all reach for, so the split adds no
 * duplicated setup.
 *
 * @module
 * @internal
 */

import { vi } from 'vitest';
import type { LangfuseExporterConfig } from '../index.js';

export interface MockLangfuse {
  readonly client: LangfuseExporterConfig['client'];
  readonly mocks: {
    trace: ReturnType<typeof vi.fn>;
    generation: ReturnType<typeof vi.fn>;
    span: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    event: ReturnType<typeof vi.fn>;
    flushAsync: ReturnType<typeof vi.fn>;
    getPrompt: ReturnType<typeof vi.fn>;
  };
}

/**
 * Build a Langfuse client whose trace/generation/span/event methods are
 * `vi.fn()` spies. Returns both the client object (typed as the exporter
 * expects) and the spy handles so tests can assert calls.
 */
export function createMockLangfuse(): MockLangfuse {
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
