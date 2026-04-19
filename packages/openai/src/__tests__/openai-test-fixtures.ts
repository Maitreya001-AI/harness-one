/**
 * Shared fixtures for the OpenAI adapter tests.
 *
 * Owns the mock client that the focused suites reach for.
 *
 * @module
 * @internal
 */

import { vi } from 'vitest';
import type { OpenAIAdapterConfig } from '../index.js';

export interface MockOpenAI {
  readonly client: NonNullable<OpenAIAdapterConfig['client']>;
  readonly mocks: { create: ReturnType<typeof vi.fn> };
}

export function createMockOpenAIClient(): MockOpenAI {
  const createFn = vi.fn();
  return {
    client: {
      chat: {
        completions: {
          create: createFn,
        },
      },
    } as unknown as NonNullable<OpenAIAdapterConfig['client']>,
    mocks: { create: createFn },
  };
}
