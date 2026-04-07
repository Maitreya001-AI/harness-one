import { describe, it, expect } from 'vitest';
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
});
