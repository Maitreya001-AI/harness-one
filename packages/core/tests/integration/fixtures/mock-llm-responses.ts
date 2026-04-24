/**
 * Shared LLM response fixtures for Track D cross-subsystem integration tests.
 *
 * Each helper returns a minimal `ChatResponse` shape the mock adapter can
 * replay. Kept deliberately small — tests that need bespoke sequences build
 * inline, fixtures exist only to avoid copy-pasting the top-of-file
 * `toolCalls`/`usage` envelope in every scenario.
 */

import type { AssistantMessage, ChatResponse, TokenUsage } from '../../../src/core/types.js';

export const DEFAULT_USAGE: TokenUsage = { inputTokens: 12, outputTokens: 7 };

export function textResponse(
  content: string,
  usage: TokenUsage = DEFAULT_USAGE,
): ChatResponse {
  return { message: { role: 'assistant', content }, usage };
}

export function toolCallResponse(
  toolCalls: AssistantMessage['toolCalls'],
  usage: TokenUsage = DEFAULT_USAGE,
): ChatResponse {
  return {
    message: { role: 'assistant', content: '', toolCalls },
    usage,
  };
}
