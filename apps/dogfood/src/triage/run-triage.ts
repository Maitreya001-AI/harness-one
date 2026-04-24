import type { AgentEvent, Message } from 'harness-one/core';

import type { TriageVerdict } from '../types.js';
import { buildSystemPrompt, buildUserTurn } from './prompt.js';
import { parseVerdict, VerdictParseError } from './parse-verdict.js';

/**
 * Minimal shape of the harness surface this module consumes, so tests can
 * pass in a hand-rolled stub without importing the full preset. Kept
 * structurally compatible with `SecureHarness` from `@harness-one/preset`.
 */
export interface TriageHarness {
  run(
    messages: Message[],
    options?: { sessionId?: string },
  ): AsyncGenerator<AgentEvent>;
  readonly costs: {
    getTotalCost(): number;
  };
}

export interface IssueInput {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

export interface TriageResult {
  readonly verdict: TriageVerdict;
  readonly costUsd: number;
  readonly assistantMessage: string;
  readonly iterations: number;
}

/**
 * Run the triage loop against a harness and return a validated verdict.
 *
 * Throws {@link VerdictParseError} if the model's final text can't be parsed
 * into a `TriageVerdict`. The caller decides whether to post a fallback
 * comment or skip the comment entirely.
 *
 * Note: tool registration happens *outside* this function. Wire
 * `search_recent_issues` on the harness before calling `runTriage` so the
 * agent can reach out for duplicate detection. Tests inject a stub harness
 * and skip the tool path entirely.
 */
export async function runTriage(
  harness: TriageHarness,
  issue: IssueInput,
): Promise<TriageResult> {
  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserTurn(issue) },
  ];

  let assistantMessage = '';
  let iterations = 0;
  let done = false;

  for await (const event of harness.run(messages, { sessionId: `triage-${issue.number}` })) {
    switch (event.type) {
      case 'iteration_start':
        iterations += 1;
        break;
      case 'text_delta':
        assistantMessage += event.text;
        break;
      case 'message':
        if (event.message.role === 'assistant' && event.message.content) {
          assistantMessage = event.message.content;
        }
        break;
      case 'done':
        done = true;
        break;
      case 'error': {
        const err = event.error;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`harness yielded error event: ${msg}`);
      }
      default:
        break;
    }
    if (done) break;
  }

  if (!done) {
    throw new Error('harness stream ended before emitting a done event');
  }

  const verdict = parseVerdict(assistantMessage);

  return {
    verdict,
    costUsd: harness.costs.getTotalCost(),
    assistantMessage,
    iterations,
  };
}

export { VerdictParseError };
