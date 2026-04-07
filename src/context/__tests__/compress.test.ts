import { describe, it, expect } from 'vitest';
import { compress } from '../compress.js';
import type { Message } from '../../core/types.js';

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
    it('keeps last N messages when budget is smaller than total', async () => {
      const result = await compress(messages, { strategy: 'truncate', budget: 3 });
      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('Response 2');
      expect(result[2].content).toBe('Response 3');
    });

    it('returns all when budget exceeds message count', async () => {
      const result = await compress(messages, { strategy: 'truncate', budget: 10 });
      expect(result).toHaveLength(6);
    });

    it('preserves specified messages', async () => {
      const result = await compress(messages, {
        strategy: 'truncate',
        budget: 2,
        preserve: (m) => m.content === 'First',
      });
      expect(result.some((m) => m.content === 'First')).toBe(true);
    });
  });

  describe('sliding-window strategy', () => {
    it('keeps last windowSize messages', async () => {
      const result = await compress(messages, {
        strategy: 'sliding-window',
        budget: 0,
        windowSize: 2,
      });
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('Third');
      expect(result[1].content).toBe('Response 3');
    });

    it('preserves messages while applying window', async () => {
      const result = await compress(messages, {
        strategy: 'sliding-window',
        budget: 0,
        windowSize: 2,
        preserve: (m) => m.content === 'First',
      });
      expect(result.some((m) => m.content === 'First')).toBe(true);
      expect(result.length).toBe(3);
    });
  });

  describe('summarize strategy', () => {
    it('calls summarizer on dropped messages', async () => {
      const result = await compress(messages, {
        strategy: 'summarize',
        budget: 2,
        summarizer: async (msgs) => `Summarized ${msgs.length} messages`,
      });

      expect(result[0].content).toContain('Summary');
      expect(result[0].content).toContain('4 messages');
      // Last 2 original messages + 1 summary
      expect(result).toHaveLength(3);
    });

    it('throws without summarizer callback', async () => {
      await expect(
        compress(messages, { strategy: 'summarize', budget: 2 }),
      ).rejects.toThrow('summarizer');
    });

    it('returns all when budget exceeds message count', async () => {
      const result = await compress(messages, {
        strategy: 'summarize',
        budget: 10,
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
      const result = await compress(msgsWithFailure, {
        strategy: 'preserve-failures',
        budget: 2,
      });

      expect(result.some((m) => m.content === 'Error trace')).toBe(true);
      // failure + 1 non-failure (budget 2 - 1 failure = 1 non-failure slot)
      expect(result.length).toBeLessThanOrEqual(3);
    });

    it('preserves order', async () => {
      const msgsWithFailure: Message[] = [
        msg('user', 'A'),
        msg('assistant', 'Fail', { isFailureTrace: true }),
        msg('user', 'B'),
        msg('assistant', 'C'),
      ];
      const result = await compress(msgsWithFailure, {
        strategy: 'preserve-failures',
        budget: 3,
      });
      // Failure always kept, plus 2 non-failures from the end
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
});
