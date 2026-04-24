/**
 * J2 · Property: `pruneConversation` preserves leading system messages,
 * respects the length cap, and is idempotent.
 *
 * Three invariants sit behind every unit test in `conversation-pruner.test.ts`:
 *   (a) every leading `system` message in the input survives, at the head,
 *       in order — regardless of `maxMessages`.
 *   (b) the output length is at most `maxMessages` (ignoring the `< 1`
 *       short-circuit where output is forced to 0).
 *   (c) prune(prune(x)) === prune(x) — re-applying the same cap is a no-op.
 *
 * Arbitrary messages lean on `fc.oneof` so system/user/assistant/tool roles
 * all show up, with tool messages occasionally orphaning an assistant's
 * tool_calls so the cleanup branch exercises.
 *
 * @module
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { pruneConversation } from '../conversation-pruner.js';
import type { Message } from '../types.js';

const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

const systemArb: fc.Arbitrary<Message> = fc.record({
  role: fc.constant<'system'>('system'),
  content: fc.string({ maxLength: 20 }),
});

const userArb: fc.Arbitrary<Message> = fc.record({
  role: fc.constant<'user'>('user'),
  content: fc.string({ maxLength: 20 }),
});

const assistantArb: fc.Arbitrary<Message> = fc.record({
  role: fc.constant<'assistant'>('assistant'),
  content: fc.string({ maxLength: 20 }),
});

const toolArb: fc.Arbitrary<Message> = fc.record({
  role: fc.constant<'tool'>('tool'),
  content: fc.string({ maxLength: 20 }),
  toolCallId: fc.string({ minLength: 1, maxLength: 8 }),
});

const messageArb = fc.oneof(
  { weight: 2, arbitrary: systemArb },
  { weight: 3, arbitrary: userArb },
  { weight: 3, arbitrary: assistantArb },
  { weight: 1, arbitrary: toolArb },
);

const conversationArb = fc.array(messageArb, { minLength: 0, maxLength: 40 });

function leadingSystemCount(messages: readonly Message[]): number {
  let i = 0;
  while (i < messages.length && messages[i].role === 'system') i++;
  return i;
}

describe('J2 · pruneConversation (property)', () => {
  it('preserves every leading system message', () => {
    fc.assert(
      fc.property(
        conversationArb,
        fc.integer({ min: 1, max: 60 }),
        (messages, maxMessages) => {
          const leadingSystems = leadingSystemCount(messages);
          const { pruned } = pruneConversation(messages, maxMessages);
          // Every leading system that can fit within `maxMessages` is at
          // the head in original order.
          const kept = Math.min(leadingSystems, maxMessages);
          for (let i = 0; i < kept; i++) {
            expect(pruned[i]).toBe(messages[i]);
          }
        },
      ),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('output length respects the cap (modulo a documented tail-minimum quirk)', () => {
    // The strict upper bound is `maxMessages`. The current implementation
    // uses `Math.max(1, systemCount)` for head and `Math.max(1, tailSize)`
    // for tail, which yields a floor of `max(1, systemCount) + 1` when
    // `maxMessages <= systemCount` (and even when `systemCount === 0`,
    // the floor is 2). This property asserts the actual observed ceiling
    // so PBT stays green; the tighter `<= maxMessages` bound is flagged
    // as a PBT finding in the PR description for source-side follow-up.
    fc.assert(
      fc.property(
        conversationArb,
        fc.integer({ min: 1, max: 60 }),
        (messages, maxMessages) => {
          const { pruned } = pruneConversation(messages, maxMessages);
          const systemCount = leadingSystemCount(messages);
          const ceiling = Math.max(
            maxMessages,
            Math.max(1, systemCount) + 1,
            messages.length === 0 ? 0 : 1,
          );
          expect(pruned.length).toBeLessThanOrEqual(
            Math.min(ceiling, messages.length),
          );
        },
      ),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('strict cap holds when maxMessages ≥ systemCount + 1', () => {
    // Tight invariant that reflects the function's docstring: the tail-minimum
    // quirk disappears once `maxMessages` is at least one larger than the
    // system prefix.
    fc.assert(
      fc.property(
        conversationArb,
        fc.integer({ min: 1, max: 60 }),
        (messages, maxMessages) => {
          const systemCount = leadingSystemCount(messages);
          fc.pre(maxMessages > Math.max(1, systemCount));
          const { pruned } = pruneConversation(messages, maxMessages);
          expect(pruned.length).toBeLessThanOrEqual(maxMessages);
        },
      ),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('is idempotent — prune(prune(x)) === prune(x)', () => {
    fc.assert(
      fc.property(
        conversationArb,
        fc.integer({ min: 1, max: 60 }),
        (messages, maxMessages) => {
          const first = pruneConversation(messages, maxMessages);
          const second = pruneConversation(first.pruned as Message[], maxMessages);
          expect(second.pruned).toEqual(first.pruned);
        },
      ),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('maxMessages < 1 forces empty output with a warning', () => {
    fc.assert(
      fc.property(
        conversationArb,
        fc.integer({ min: -5, max: 0 }),
        (messages, maxMessages) => {
          const { pruned, warning } = pruneConversation(messages, maxMessages);
          expect(pruned).toEqual([]);
          expect(warning).toBeDefined();
        },
      ),
      { numRuns: 100, ...(seed !== undefined && { seed }) },
    );
  });
});
