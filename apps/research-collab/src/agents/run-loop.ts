/**
 * Shared helper for driving an agent's harness loop and capturing the final
 * assistant text.
 *
 * Three of the agents (Researcher, Specialist, Coordinator) follow the same
 * basic shape: hand the harness a fresh `[system, user]` message pair and
 * accumulate the assistant text + iteration count from the event stream. The
 * only difference is what they parse out of the final text.
 */

import type { AgentEvent, Message } from 'harness-one/core';

/** Subset of harness surface this helper consumes — keeps tests trivial. */
export interface RunnableHarness {
  run(messages: Message[], options?: { sessionId?: string }): AsyncGenerator<AgentEvent>;
}

export interface RunLoopOptions {
  readonly system: string;
  readonly user: string;
  readonly sessionId: string;
  /** Fires for each tool call observed in the stream — used by Specialist URL tracking. */
  readonly onEvent?: (event: AgentEvent) => void;
}

export interface RunLoopResult {
  readonly assistantMessage: string;
  readonly iterations: number;
}

/**
 * Stream events from a harness, capturing the final assistant message.
 *
 * Behaviour mirrors dogfood's `runTriage`:
 * - `iteration_start` increments the counter
 * - `text_delta` appends to the running assistant text
 * - `message` (assistant role) replaces the assistant text with the final body
 * - `done` ends the stream
 * - `error` throws so the caller can classify
 *
 * `guardrail_blocked` events do not throw on their own — the AgentLoop emits
 * a follow-up `error` (see iteration-coordinator) which this helper rethrows.
 */
export async function runHarnessLoop(
  harness: RunnableHarness,
  options: RunLoopOptions,
): Promise<RunLoopResult> {
  const messages: Message[] = [
    { role: 'system', content: options.system },
    { role: 'user', content: options.user },
  ];

  let assistantMessage = '';
  let iterations = 0;
  let done = false;

  for await (const event of harness.run(messages, { sessionId: options.sessionId })) {
    options.onEvent?.(event);
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

  return { assistantMessage, iterations };
}
