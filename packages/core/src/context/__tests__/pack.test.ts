import { describe, it, expect, vi } from 'vitest';
import { packContext } from '../pack.js';
import { createBudget } from '../budget.js';
import type { Message } from '../../core/types.js';
import * as countTokensModule from '../count-tokens.js';

function msg(role: Message['role'], content: string): Message {
  return { role, content };
}

describe('packContext', () => {
  it('assembles HEAD + MID + TAIL when within budget', () => {
    const budget = createBudget({
      totalTokens: 100000,
      segments: [{ name: 'all', maxTokens: 100000 }],
    });
    const result = packContext({
      head: [msg('system', 'You are helpful')],
      mid: [msg('user', 'Hi'), msg('assistant', 'Hello')],
      tail: [msg('user', 'Bye')],
      budget,
    });

    expect(result.messages).toHaveLength(4);
    expect(result.truncated).toBe(false);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[3].content).toBe('Bye');
  });

  it('truncates MID from the front when over budget', () => {
    // Very tight budget
    const budget = createBudget({
      totalTokens: 30,
      segments: [{ name: 'all', maxTokens: 30 }],
    });
    const result = packContext({
      head: [msg('system', 'System prompt')],
      mid: [
        msg('user', 'Message one which is fairly long'),
        msg('assistant', 'Response one which is also long'),
        msg('user', 'Message two'),
        msg('assistant', 'Response two'),
      ],
      tail: [msg('user', 'Latest')],
      budget,
    });

    expect(result.truncated).toBe(true);
    // HEAD and TAIL always present
    expect(result.messages[0].content).toBe('System prompt');
    expect(result.messages[result.messages.length - 1].content).toBe('Latest');
    // MID should be shorter than original 4 messages
    expect(result.messages.length).toBeLessThan(6);
  });

  it('returns empty MID when budget only fits HEAD + TAIL', () => {
    const budget = createBudget({
      totalTokens: 15,
      segments: [{ name: 'all', maxTokens: 15 }],
    });
    const result = packContext({
      head: [msg('system', 'System')],
      mid: [msg('user', 'Long message'), msg('assistant', 'Long response')],
      tail: [msg('user', 'End')],
      budget,
    });

    expect(result.truncated).toBe(true);
    expect(result.usage.mid).toBe(0);
  });

  it('handles empty MID', () => {
    const budget = createBudget({
      totalTokens: 100000,
      segments: [{ name: 'all', maxTokens: 100000 }],
    });
    const result = packContext({
      head: [msg('system', 'System')],
      mid: [],
      tail: [msg('user', 'Hi')],
      budget,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.usage.mid).toBe(0);
  });

  describe('responseReserve reduces available budget', () => {
    it('subtracts responseReserve from totalBudget when packing', () => {
      // Without responseReserve: 100 tokens total, plenty of room for MID
      const budgetNoReserve = createBudget({
        totalTokens: 100,
        segments: [{ name: 'all', maxTokens: 100 }],
      });
      const layout = {
        head: [msg('system', 'System')],
        mid: [msg('user', 'Hello world'), msg('assistant', 'Hi there')],
        tail: [msg('user', 'Bye')],
      };
      const resultNoReserve = packContext({ ...layout, budget: budgetNoReserve });

      // With responseReserve: 100 tokens total but 80 reserved for response
      // This should leave only 20 tokens for context, forcing MID trimming
      const budgetWithReserve = createBudget({
        totalTokens: 100,
        segments: [{ name: 'all', maxTokens: 100 }],
        responseReserve: 80,
      });
      const resultWithReserve = packContext({ ...layout, budget: budgetWithReserve });

      // The reserved version should have fewer MID messages or be truncated
      // while the non-reserved version should fit everything
      expect(resultWithReserve.usage.mid).toBeLessThanOrEqual(resultNoReserve.usage.mid);
      // With such a large reserve, MID should be heavily trimmed or empty
      expect(resultWithReserve.truncated).toBe(true);
    });

    it('defaults responseReserve to 0 when not specified', () => {
      const budget = createBudget({
        totalTokens: 100000,
        segments: [{ name: 'all', maxTokens: 100000 }],
      });
      expect(budget.responseReserve).toBe(0);

      const result = packContext({
        head: [msg('system', 'S')],
        mid: [msg('user', 'Hi')],
        tail: [msg('user', 'Bye')],
        budget,
      });
      expect(result.truncated).toBe(false);
    });
  });

  describe('C3: O(N^2) token recounting fix — uses index-based trimming', () => {
    it('pre-computes per-message token counts and uses index-based trimming', () => {
      // The bug: mid.shift() + countTokens([removed]) in a loop is O(N^2) due to
      // array shifting. The fix should use index-based trimming.
      //
      // We verify: the total number of countTokens calls should be exactly N+3
      // (one per mid message for pre-computation + head + tail + initial mid total).
      // In the buggy code: it's 3 (head, mid, tail) + N (one per removed message).
      // With the fix using pre-computed map: it's 3 (head, tail, initial mid) + N (per-message).
      // The key difference is that with the fix, countTokens is NEVER called inside
      // the trimming loop because token counts are pre-computed.
      const midMessages = Array.from({ length: 20 }, (_, i) =>
        msg('user', `Message ${i} with some content`),
      );

      const budget = createBudget({
        totalTokens: 40, // Very small budget forcing heavy trimming
        segments: [{ name: 'all', maxTokens: 40 }],
      });

      const spy = vi.spyOn(countTokensModule, 'countTokens');

      const result = packContext({
        head: [msg('system', 'S')],
        mid: midMessages,
        tail: [msg('user', 'T')],
        budget,
      });

      // Key assertion: countTokens should only be called for head and tail arrays,
      // NOT inside the trimming loop. The fixed version uses countMessageTokens
      // for per-message pre-computation, so countTokens is only called twice
      // (once for head, once for tail).
      //
      // In the buggy version: countTokens is called 3 times for initial counts
      // (head, mid, tail) + N times for each removed message in the trim loop.
      // With 20 mid messages and a tiny budget, that's ~22 total calls.
      //
      // In the fixed version: countTokens is called only 2 times (head + tail).
      // Per-message counts are done via countMessageTokens (not spied here).
      const totalCountTokensCalls = spy.mock.calls.length;

      // Fixed: exactly 2 calls (head + tail). No mid array or trimming calls.
      // Buggy: 3 + ~18 = ~21 calls
      expect(totalCountTokensCalls).toBe(2);

      // Verify correctness is maintained
      expect(result.truncated).toBe(true);
      expect(result.messages[0].content).toBe('S');
      expect(result.messages[result.messages.length - 1].content).toBe('T');

      spy.mockRestore();
    });
  });

  describe('midBudgetExhausted signaling', () => {
    it('returns midBudgetExhausted=false when MID has budget', () => {
      const budget = createBudget({
        totalTokens: 100000,
        segments: [{ name: 'all', maxTokens: 100000 }],
      });
      const result = packContext({
        head: [msg('system', 'System')],
        mid: [msg('user', 'Hello')],
        tail: [msg('user', 'Bye')],
        budget,
      });
      expect(result.midBudgetExhausted).toBe(false);
    });

    it('returns midBudgetExhausted=true when HEAD+TAIL consume entire budget', () => {
      const budget = createBudget({
        totalTokens: 10,
        segments: [{ name: 'all', maxTokens: 10 }],
      });
      const result = packContext({
        head: [msg('system', 'A very long system prompt that uses many tokens')],
        mid: [msg('user', 'Mid message')],
        tail: [msg('user', 'A fairly long tail message as well')],
        budget,
      });
      expect(result.midBudgetExhausted).toBe(true);
      expect(result.usage.mid).toBe(0);
    });

    it('returns midBudgetExhausted=true when responseReserve exhausts mid budget', () => {
      const budget = createBudget({
        totalTokens: 100,
        segments: [{ name: 'all', maxTokens: 100 }],
        responseReserve: 95,
      });
      const result = packContext({
        head: [msg('system', 'System prompt here')],
        mid: [msg('user', 'Mid')],
        tail: [msg('user', 'End')],
        budget,
      });
      // With 95 reserve, only 5 tokens for everything. HEAD+TAIL will exceed.
      expect(result.midBudgetExhausted).toBe(true);
    });

    it('returns midBudgetExhausted=false even when MID is truncated but has some budget', () => {
      const budget = createBudget({
        totalTokens: 30,
        segments: [{ name: 'all', maxTokens: 30 }],
      });
      const result = packContext({
        head: [msg('system', 'System')],
        mid: [
          msg('user', 'Long message one'),
          msg('assistant', 'Long response one'),
          msg('user', 'Short'),
        ],
        tail: [msg('user', 'End')],
        budget,
      });
      // MID may be truncated but midBudget is not zero
      expect(result.truncated).toBe(true);
      expect(result.midBudgetExhausted).toBe(false);
    });
  });

  describe('H6: midBudget can be negative', () => {
    it('clamps midBudget to 0 when HEAD+TAIL exceed total budget', () => {
      // HEAD + TAIL > totalTokens
      const budget = createBudget({
        totalTokens: 10,
        segments: [{ name: 'all', maxTokens: 10 }],
      });

      // These HEAD+TAIL alone will exceed the 10-token budget
      const result = packContext({
        head: [msg('system', 'A very long system prompt that uses many tokens')],
        mid: [msg('user', 'Mid message 1'), msg('assistant', 'Mid message 2')],
        tail: [msg('user', 'A fairly long tail message as well')],
        budget,
      });

      // The result should still succeed (not hang/crash)
      // MID should be empty because there's no room
      expect(result.usage.mid).toBe(0);
      expect(result.truncated).toBe(true);
      // HEAD and TAIL still included
      expect(result.messages[0].content).toBe(
        'A very long system prompt that uses many tokens',
      );
      expect(result.messages[result.messages.length - 1].content).toBe(
        'A fairly long tail message as well',
      );
    });
  });
});
