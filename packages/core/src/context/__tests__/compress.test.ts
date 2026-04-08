import { describe, it, expect, vi } from 'vitest';
import { compress } from '../compress.js';
import type { Message } from '../../core/types.js';
import { estimateTokens } from '../../_internal/token-estimator.js';

function msg(role: Message['role'], content: string, meta?: Message['meta']): Message {
  return { role, content, meta };
}

describe('compress', () => {
  const messages: Message[] = [
    msg('user', 'First'),
    msg('assistant', 'Response 1'),
    msg('user', 'Second'),
    msg('assistant', 'Response 2'),
    msg('user', 'Third'),
    msg('assistant', 'Response 3'),
  ];

  describe('truncate strategy', () => {
    it('keeps last messages fitting within token budget', async () => {
      // Each msg is ~6-7 tokens. Budget of 20 tokens should fit ~3 messages.
      const result = await compress(messages, { strategy: 'truncate', budget: 20 });
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.length).toBeLessThan(6);
      expect(result[result.length - 1].content).toBe('Response 3');
    });

    it('returns all when budget exceeds total tokens', async () => {
      const result = await compress(messages, { strategy: 'truncate', budget: 500 });
      expect(result).toHaveLength(6);
    });

    it('preserves specified messages', async () => {
      const result = await compress(messages, {
        strategy: 'truncate',
        budget: 13,
        preserve: (m) => m.content === 'First',
      });
      expect(result.some((m) => m.content === 'First')).toBe(true);
    });
  });

  describe('sliding-window strategy', () => {
    it('keeps last windowSize messages within token budget', async () => {
      // Budget of 500 is large enough for any window; windowSize=2 limits it
      const result = await compress(messages, {
        strategy: 'sliding-window',
        budget: 500,
        windowSize: 2,
      });
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('Third');
      expect(result[1].content).toBe('Response 3');
    });

    it('preserves messages while applying window', async () => {
      const result = await compress(messages, {
        strategy: 'sliding-window',
        budget: 500,
        windowSize: 2,
        preserve: (m) => m.content === 'First',
      });
      expect(result.some((m) => m.content === 'First')).toBe(true);
      expect(result.length).toBe(3);
    });
  });

  describe('summarize strategy', () => {
    it('calls summarizer on dropped messages', async () => {
      // Budget of 14 tokens fits ~2 messages. The rest get summarized.
      const result = await compress(messages, {
        strategy: 'summarize',
        budget: 14,
        summarizer: async (msgs) => `Summarized ${msgs.length} messages`,
      });

      expect(result[0].content).toContain('Summary');
      // Summary should cover some messages
      expect(result[0].content).toMatch(/Summarized \d+ messages/);
      // Should have summary + kept messages
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('throws without summarizer callback', async () => {
      await expect(
        compress(messages, { strategy: 'summarize', budget: 14 }),
      ).rejects.toThrow('summarizer');
    });

    it('returns all when budget exceeds total tokens', async () => {
      const result = await compress(messages, {
        strategy: 'summarize',
        budget: 500,
        summarizer: async () => 'summary',
      });
      expect(result).toHaveLength(6);
    });
  });

  describe('preserve-failures strategy', () => {
    it('never drops messages with isFailureTrace', async () => {
      const msgsWithFailure: Message[] = [
        msg('user', 'First'),
        msg('assistant', 'Error trace', { isFailureTrace: true }),
        msg('user', 'Second'),
        msg('assistant', 'Response'),
        msg('user', 'Third'),
      ];
      // Budget of 15 tokens: failure trace (~7 tokens) + room for ~1 non-failure
      const result = await compress(msgsWithFailure, {
        strategy: 'preserve-failures',
        budget: 15,
      });

      expect(result.some((m) => m.content === 'Error trace')).toBe(true);
      expect(result.length).toBeLessThan(msgsWithFailure.length);
    });

    it('preserves order', async () => {
      const msgsWithFailure: Message[] = [
        msg('user', 'A'),
        msg('assistant', 'Fail', { isFailureTrace: true }),
        msg('user', 'B'),
        msg('assistant', 'C'),
      ];
      // Budget of 500 tokens: enough for all
      const result = await compress(msgsWithFailure, {
        strategy: 'preserve-failures',
        budget: 500,
      });
      // Failure always kept, plus non-failures that fit
      const contents = result.map((m) => m.content);
      for (let i = 0; i < contents.length - 1; i++) {
        const origIdxA = msgsWithFailure.findIndex((m) => m.content === contents[i]);
        const origIdxB = msgsWithFailure.findIndex((m) => m.content === contents[i + 1]);
        expect(origIdxA).toBeLessThan(origIdxB);
      }
    });
  });

  describe('summarize strategy with preserved messages', () => {
    it('preserves marked messages and summarizes the rest', async () => {
      const msgs: Message[] = [
        msg('system', 'System prompt'),
        msg('user', 'First question'),
        msg('assistant', 'First answer with lots of details'),
        msg('user', 'Second question'),
        msg('assistant', 'Second answer'),
        msg('user', 'Third'),
        msg('assistant', 'Third answer'),
      ];

      let summarizedMsgs: Message[] = [];
      const result = await compress(msgs, {
        strategy: 'summarize',
        budget: 14,
        preserve: (m) => m.role === 'system',
        summarizer: async (toSummarize) => {
          summarizedMsgs = toSummarize;
          return `Summarized ${toSummarize.length} messages`;
        },
      });

      // The system prompt should be preserved (moved to front)
      expect(result.some((m) => m.content === 'System prompt')).toBe(true);
      // There should be a summary message
      expect(result.some((m) => m.content.includes('Summary'))).toBe(true);
      // The system prompt should NOT have been summarized
      expect(summarizedMsgs.some((m) => m.content === 'System prompt')).toBe(false);
    });

    it('returns original messages when nothing needs summarizing after preserve', async () => {
      const msgs: Message[] = [
        msg('user', 'Short'),
        msg('assistant', 'Reply'),
      ];

      const result = await compress(msgs, {
        strategy: 'summarize',
        budget: 500, // large budget, nothing to summarize
        preserve: (m) => m.role === 'user',
        summarizer: async () => 'summary',
      });

      expect(result).toHaveLength(2);
    });
  });

  describe('summarize strategy: toSummarize is empty returns original messages', () => {
    it('returns original messages when all non-kept messages are preserved', async () => {
      // The summarize strategy works backwards from the end keeping messages
      // that fit in the budget. Messages that don't fit are either preserved
      // (if preserve returns true) or summarized. If ALL non-kept messages
      // are preserved, toSummarize is empty, and it returns [...messages].
      //
      // We need: total tokens > budget (so summarization is attempted),
      // but all messages not kept by the backward pass are preserved.
      const msgs: Message[] = [
        msg('user', 'A'.repeat(200)),       // ~54 tokens, won't fit in budget
        msg('user', 'B'.repeat(200)),       // ~54 tokens, won't fit in budget
        msg('assistant', 'C'),               // ~5 tokens, fits in budget (kept from end)
      ];

      const summarizerFn = vi.fn(async () => 'summary');
      const result = await compress(msgs, {
        strategy: 'summarize',
        budget: 10, // Only the last message 'C' fits
        preserve: () => true, // Preserve ALL messages that aren't kept
        summarizer: summarizerFn,
      });

      // The backward pass keeps 'C' (fits in 10 tokens).
      // 'A' and 'B' don't fit, but preserve returns true for both,
      // so they go to toKeep.unshift(), NOT toSummarize.
      // toSummarize is empty => returns [...messages]
      expect(result).toHaveLength(3);
      // Summarizer should NOT have been called since toSummarize is empty
      expect(summarizerFn).not.toHaveBeenCalled();
    });
  });

  describe('custom strategy', () => {
    it('accepts a CompressionStrategy object', async () => {
      const result = await compress(messages, {
        strategy: {
          name: 'custom',
          async compress(msgs) {
            return [msgs[msgs.length - 1]];
          },
        },
        budget: 1,
      });
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Response 3');
    });
  });

  describe('unknown strategy', () => {
    it('throws for unknown strategy name', async () => {
      await expect(
        compress(messages, { strategy: 'nonexistent', budget: 5 }),
      ).rejects.toThrow('Unknown compression strategy');
    });
  });

  describe('FIX-1: budget is token count, not message count', () => {
    // Create messages with known token sizes
    const longMessages: Message[] = [
      msg('user', 'A'.repeat(400)),       // ~104 tokens heuristic
      msg('assistant', 'B'.repeat(400)),   // ~104 tokens heuristic
      msg('user', 'C'.repeat(400)),        // ~104 tokens heuristic
      msg('assistant', 'D'.repeat(400)),   // ~104 tokens heuristic
      msg('user', 'E'.repeat(400)),        // ~104 tokens heuristic
    ];

    function totalTokens(msgs: Message[]): number {
      return msgs.reduce((sum, m) => sum + estimateTokens('default', m.content), 0);
    }

    it('truncate strategy respects token budget, not message count', async () => {
      const budget = 100; // tokens, not messages
      const result = await compress(longMessages, { strategy: 'truncate', budget });
      const resultTokens = totalTokens(result);
      // With a 100-token budget, we should NOT get all 5 messages
      expect(result.length).toBeLessThan(longMessages.length);
      expect(resultTokens).toBeLessThanOrEqual(budget);
    });

    it('sliding-window strategy respects token budget', async () => {
      const budget = 150;
      const result = await compress(longMessages, {
        strategy: 'sliding-window',
        budget,
        windowSize: 10, // large window, but token budget should limit
      });
      const resultTokens = totalTokens(result);
      expect(resultTokens).toBeLessThanOrEqual(budget);
    });

    it('summarize strategy uses token budget threshold', async () => {
      const budget = 150;
      let summarizedMsgs: Message[] = [];
      const result = await compress(longMessages, {
        strategy: 'summarize',
        budget,
        summarizer: async (msgs) => {
          summarizedMsgs = [...msgs];
          return 'Summary';
        },
      });
      // Should have summarized some messages because total tokens > budget
      expect(summarizedMsgs.length).toBeGreaterThan(0);
      expect(result[0].content).toContain('Summary');
    });

    it('preserve-failures strategy respects token budget', async () => {
      const msgsWithFailure: Message[] = [
        msg('user', 'A'.repeat(400)),
        msg('assistant', 'Fail trace', { isFailureTrace: true }),
        msg('user', 'B'.repeat(400)),
        msg('assistant', 'C'.repeat(400)),
        msg('user', 'D'.repeat(400)),
      ];
      const budget = 200;
      const result = await compress(msgsWithFailure, {
        strategy: 'preserve-failures',
        budget,
      });
      // Failure trace must always be preserved
      expect(result.some((m) => m.content === 'Fail trace')).toBe(true);
      // Non-failure messages should be limited by token budget
      const nonFailures = result.filter((m) => !m.meta?.isFailureTrace);
      const nonFailureTokens = totalTokens(nonFailures);
      const failureTokens = totalTokens(result.filter((m) => m.meta?.isFailureTrace));
      expect(nonFailureTokens + failureTokens).toBeLessThanOrEqual(budget + failureTokens);
    });
  });

  describe('FIX-6: throws HarnessError instead of plain Error', () => {
    it('throws HarnessError for unknown strategy', async () => {
      try {
        await compress(messages, { strategy: 'nonexistent', budget: 5 });
        expect.unreachable('should have thrown');
      } catch (e: unknown) {
        expect((e as { name: string }).name).toBe('HarnessError');
        expect((e as { code: string }).code).toBeDefined();
      }
    });

    it('throws HarnessError when summarizer missing', async () => {
      try {
        await compress(messages, { strategy: 'summarize', budget: 2 });
        expect.unreachable('should have thrown');
      } catch (e: unknown) {
        expect((e as { name: string }).name).toBe('HarnessError');
      }
    });
  });

  describe('C4: O(N^2) Array.includes in preserve-failures', () => {
    it('uses Set for keptNonFailures lookup — preserves correct messages with duplicated content', () => {
      // This test verifies the fix works correctly when messages have
      // the same content (which would be problematic with Set<string> but not Set<number>)
      const msgsWithFailure: Message[] = [
        msg('user', 'Hello'),
        msg('assistant', 'Fail', { isFailureTrace: true }),
        msg('user', 'Hello'),  // duplicate content
        msg('assistant', 'Response'),
        msg('user', 'Latest'),
      ];

      const result = compress(msgsWithFailure, {
        strategy: 'preserve-failures',
        budget: 500,
      });

      // All messages should be kept since budget is large
      return result.then((r) => {
        expect(r).toHaveLength(5);
        // Order should be preserved
        expect(r[0].content).toBe('Hello');
        expect(r[1].content).toBe('Fail');
        expect(r[2].content).toBe('Hello');
        expect(r[3].content).toBe('Response');
        expect(r[4].content).toBe('Latest');
      });
    });
  });

  describe('H5: reference equality comparison is fragile', () => {
    it('sliding-window works when messages are reconstructed (not same reference)', () => {
      // When messages are cloned/reconstructed, === fails.
      // This simulates a scenario where the messages array contains
      // structurally identical messages that won't be === to each other.
      const original: Message[] = [
        msg('user', 'First'),
        msg('assistant', 'Response 1'),
        msg('user', 'Second'),
        msg('assistant', 'Response 2'),
        msg('user', 'Third'),
        msg('assistant', 'Response 3'),
      ];

      // Clone messages so references differ from the ones stored internally
      const cloned = original.map((m) => ({ ...m }));

      return compress(cloned, {
        strategy: 'sliding-window',
        budget: 500,
        windowSize: 2,
      }).then((result) => {
        // Should keep last 2 non-preserved messages
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('Third');
        expect(result[1].content).toBe('Response 3');
      });
    });

    it('sliding-window with preserve works when messages are cloned', () => {
      const original: Message[] = [
        msg('user', 'First'),
        msg('assistant', 'Response 1'),
        msg('user', 'Second'),
        msg('assistant', 'Response 2'),
      ];

      const cloned = original.map((m) => ({ ...m }));

      return compress(cloned, {
        strategy: 'sliding-window',
        budget: 500,
        windowSize: 1,
        preserve: (m) => m.content === 'First',
      }).then((result) => {
        // Should have the preserved message + 1 windowed message
        expect(result.some((m) => m.content === 'First')).toBe(true);
        expect(result.some((m) => m.content === 'Response 2')).toBe(true);
      });
    });

    it('preserve-failures works when messages are cloned', () => {
      const original: Message[] = [
        msg('user', 'A'),
        msg('assistant', 'Fail', { isFailureTrace: true }),
        msg('user', 'B'),
        msg('assistant', 'C'),
      ];

      const cloned = original.map((m) => ({ ...m }));

      return compress(cloned, {
        strategy: 'preserve-failures',
        budget: 500,
      }).then((result) => {
        expect(result).toHaveLength(4);
        expect(result[0].content).toBe('A');
        expect(result[1].content).toBe('Fail');
        expect(result[2].content).toBe('B');
        expect(result[3].content).toBe('C');
      });
    });
  });
});
