/**
 * Shared fixtures for the AgentLoop integration tests.
 *
 * This module owns the mock adapters + event helpers that the thematic
 * sibling test files all rely on, so the split adds no duplicated
 * boilerplate. Every helper here has `test` in its path so it is dropped
 * from the published build.
 *
 * @module
 * @internal
 */

import type {
  AgentAdapter,
  ChatResponse,
} from '../types.js';
import type { AgentEvent } from '../events.js';

/** Collect every event yielded by the loop's async generator. */
export async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/**
 * Build a mock adapter that serves the supplied responses in order. Throws
 * if called more times than there are responses so tests that accidentally
 * loop forever surface the problem loudly.
 */
export function createMockAdapter(responses: ChatResponse[]): AgentAdapter {
  let callIndex = 0;
  return {
    async chat() {
      const response = responses[callIndex];
      if (!response) throw new Error('No more mock responses');
      callIndex++;
      return response;
    },
  };
}

/** Canonical usage snippet — 10 input / 5 output tokens. */
export const USAGE = { inputTokens: 10, outputTokens: 5 } as const;
