/**
 * Guardrail helpers — small pure utilities shared between `AgentLoop` and
 * `IterationRunner`. Kept in their own module so the runner doesn't need
 * a dependency back into the loop class.
 *
 * @module
 */

import type { Message } from './types.js';
import type { PipelineResult } from './guardrail-port.js';

/**
 * Walk the conversation from the tail until we find a user-role message.
 * Returns its `content` string, or `undefined` when no user message
 * exists (e.g., a pure system-only seed — callers should skip the input
 * pipeline rather than running it on empty content).
 *
 * @param messages - The conversation (read-only).
 * @returns The latest user message content, or `undefined` if none exists.
 */
export function findLatestUserMessage(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return m.content;
  }
  return undefined;
}

/**
 * Derive a human-readable guard name from a blocking `PipelineResult`.
 * Prefer the last event (the guard that actually blocked); fall back to
 * a direction-qualified sentinel so logs and events always carry
 * something renderable.
 *
 * @param result - The pipeline result whose blocking guard we want to name.
 * @param direction - Direction sentinel used in the fallback name.
 * @returns The blocking guard's name, or `<direction>-guardrail` when the
 *   blocking event cannot be located.
 */
export function pickBlockingGuardName(
  result: PipelineResult,
  direction: 'input' | 'output',
): string {
  const last = result.results[result.results.length - 1];
  if (last && last.verdict.action === 'block') return last.guardrail;
  return `${direction}-guardrail`;
}
