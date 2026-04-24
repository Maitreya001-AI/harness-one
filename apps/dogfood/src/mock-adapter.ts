import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
} from 'harness-one/core';

import type { DuplicateCandidate } from './types.js';

export interface MockAdapterOptions {
  /** Hard-coded triage verdict to return as the final assistant JSON. */
  readonly verdict: {
    readonly suggestedLabels: readonly string[];
    readonly duplicates: readonly DuplicateCandidate[];
    readonly reproSteps: readonly string[];
    readonly rationale: string;
  };
  /** Optional per-call token counts so the report captures a realistic number. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * Deterministic {@link AgentAdapter} for CI / dry-run / tests.
 *
 * Returns the canned verdict as a single assistant message — no tool
 * calls, no streaming segmentation. That lets us exercise the triage →
 * parse → render → post pipeline end-to-end without the uncertainty of a
 * live model.
 */
export function createMockAdapter(options: MockAdapterOptions): AgentAdapter {
  const content = JSON.stringify(options.verdict);
  const inputTokens = options.inputTokens ?? 42;
  const outputTokens = options.outputTokens ?? Math.max(1, Math.round(content.length / 4));
  const usage = { inputTokens, outputTokens };

  const response: ChatResponse = {
    message: { role: 'assistant', content },
    usage,
  };

  return {
    name: 'dogfood:mock',
    async chat(_params: ChatParams): Promise<ChatResponse> {
      return response;
    },
    async *stream(_params: ChatParams): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: content };
      yield { type: 'done', usage };
    },
  };
}
