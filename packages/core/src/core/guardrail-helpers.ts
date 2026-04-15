/**
 * Guardrail helpers — small pure utilities lifted out of `AgentLoop` so the
 * orchestration code and the new `IterationRunner` can share them without a
 * dependency back into the loop class.
 *
 * Wave-5B Step 3: extracted from the `AgentLoop.findLatestUserMessage` and
 * `AgentLoop.pickBlockingGuardName` static methods (former L1104-L1125 of
 * `agent-loop.ts`). Behaviour preserved verbatim — the move is a pure
 * relocation. See `docs/forge-fix/wave-5/wave-5b-adr-v2.md` §6 / §7 Step 3.
 *
 * @module
 */

import type { Message } from './types.js';
import type { PipelineResult } from '../guardrails/types.js';

/**
 * T10 (Wave-5A): walk the conversation from the tail until we find a
 * user-role message. Returns its `content` string, or `undefined` when no
 * user message exists (e.g., a pure system-only seed — callers should skip
 * the input pipeline rather than running it on empty content).
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
 * T10 (Wave-5A): derive a human-readable guard name from a blocking
 * `PipelineResult`. Prefer the last event (the guard that actually blocked);
 * fall back to a direction-qualified sentinel so logs and events always
 * carry something renderable.
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
