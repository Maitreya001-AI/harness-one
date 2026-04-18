/**
 * Example: `createResilientLoop` — outer retry wrapper (Ralph Wiggum Loop).
 *
 * When the inner AgentLoop terminates with a retryable done-reason
 * (`max_iterations`, `token_budget`, or `error`), the resilient wrapper:
 *
 *   1. Calls your `onRetry` callback with a snapshot of progress.
 *   2. Lets you compress / summarize the conversation.
 *   3. Re-enters a fresh inner AgentLoop with the summary prepended.
 *
 * End-state: the conversation restart happens automatically, so a single
 * transient budget overflow doesn't drop the user's task.
 *
 * Not retried: `end_turn` (normal completion) and `aborted` (user signal).
 */
import { createResilientLoop, createMockAdapter } from 'harness-one/advanced';
import type { Message } from 'harness-one/core';

async function main(): Promise<void> {
  // A mock adapter that always returns the same content — for the demo.
  // In production, wire a real adapter (anthropic / openai / fallback).
  const adapter = createMockAdapter({
    responses: [{ content: 'progress made…' }, { content: 'final answer.' }],
  });

  const resilient = createResilientLoop({
    loopConfig: {
      adapter,
      // A tight budget so the first attempt actually trips token_budget
      // and gives us something to observe.
      maxIterations: 2,
      maxTotalTokens: 100,
    },
    maxOuterRetries: 2,
    onRetry: async ({ attempt, reason, conversationSoFar }) => {
      console.log(
        `[resilient] attempt ${attempt} failed with reason=${reason}, ` +
        `conversation length=${conversationSoFar.length}`,
      );
      // In real code: ask an LLM to summarize `conversationSoFar`, cap at
      // N tokens, and return the summary. Here we just concatenate titles.
      const summary =
        `Previous attempt terminated with ${reason}. ` +
        `Steps completed: ${conversationSoFar.length}. Resume succinctly.`;
      return {
        summary,
        // Optional: inject additional scaffolding messages into the retry.
        additionalMessages: [
          { role: 'system', content: 'Retry mode: be concise, skip recap.' },
        ],
      };
    },
  });

  const messages: Message[] = [
    { role: 'system', content: 'You are a planner.' },
    { role: 'user', content: 'Draft a project plan.' },
  ];

  for await (const event of resilient.run(messages)) {
    if (event.type === 'text_delta') process.stdout.write(event.text);
    if (event.type === 'done') {
      console.log(`\nOuter done: ${event.reason}`);
      break;
    }
  }

  // You can abort from outside — aborts whichever inner AgentLoop is live
  // and stops the outer retry ladder from starting another attempt.
  resilient.abort();
}

main().catch(console.error);
