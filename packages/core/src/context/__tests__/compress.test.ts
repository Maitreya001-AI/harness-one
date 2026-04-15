import { describe, it, expect, vi } from 'vitest';
import { compress, compactIfNeeded, createAdapterSummarizer } from '../compress.js';
import type { Message, AgentAdapter, ChatResponse } from '../../core/types.js';
import { estimateTokens } from '../../infra/token-estimator.js';

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
      expect(result.messages.length).toBeGreaterThanOrEqual(2);
      expect(result.messages.length).toBeLessThan(6);
      expect(result.messages[result.messages.length - 1].content).toBe('Response 3');
    });

    it('returns all when budget exceeds total tokens', async () => {
      const result = await compress(messages, { strategy: 'truncate', budget: 500 });
      expect(result.messages).toHaveLength(6);
      expect(result.compressed).toBe(true);
    });

    it('preserves specified messages', async () => {
      const result = await compress(messages, {
        strategy: 'truncate',
        budget: 13,
        preserve: (m) => m.content === 'First',
      });
      expect(result.messages.some((m) => m.content === 'First')).toBe(true);
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
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content).toBe('Third');
      expect(result.messages[1].content).toBe('Response 3');
    });

    it('preserves messages while applying window', async () => {
      const result = await compress(messages, {
        strategy: 'sliding-window',
        budget: 500,
        windowSize: 2,
        preserve: (m) => m.content === 'First',
      });
      expect(result.messages.some((m) => m.content === 'First')).toBe(true);
      expect(result.messages.length).toBe(3);
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

      expect(result.messages[0].content).toContain('Summary');
      // Summary should cover some messages
      expect(result.messages[0].content).toMatch(/Summarized \d+ messages/);
      // Should have summary + kept messages
      expect(result.messages.length).toBeGreaterThanOrEqual(2);
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
      expect(result.messages).toHaveLength(6);
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

      expect(result.messages.some((m) => m.content === 'Error trace')).toBe(true);
      expect(result.messages.length).toBeLessThan(msgsWithFailure.length);
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
      const contents = result.messages.map((m) => m.content);
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
      expect(result.messages.some((m) => m.content === 'System prompt')).toBe(true);
      // There should be a summary message
      expect(result.messages.some((m) => m.content.includes('Summary'))).toBe(true);
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

      expect(result.messages).toHaveLength(2);
    });
  });

  describe('CQ-013: summarize truncates when toSummarize is empty but total exceeds budget', () => {
    it('applies truncate fallback instead of overshooting budget when all preserved', async () => {
      // All non-kept messages are preserved → toSummarize is empty.
      // Previously the strategy returned [...messages], blowing past budget.
      // Fix: apply truncate-pass keeping most recent messages fitting budget.
      const msgs: Message[] = [
        msg('user', 'A'.repeat(200)),       // ~54 tokens
        msg('user', 'B'.repeat(200)),       // ~54 tokens
        msg('assistant', 'Last'),            // small, fits
      ];

      const result = await compress(msgs, {
        strategy: 'summarize',
        budget: 10,
        preserve: () => true,
        summarizer: async () => 'summary',
      });

      // CQ-013: result should be truncated (not all 3 messages) and fit budget
      expect(result.compressed).toBe(true);
      // Still preserves most recent content
      const contents = result.messages.map((m) => m.content);
      expect(contents).toContain('Last');
      // finalTokens ≤ budget
      expect(result.finalTokens).toBeLessThanOrEqual(10);
      // Flags truncation in result
      expect((result as unknown as { truncated?: boolean }).truncated).toBe(true);
    });
  });

  describe('CQ-014: onError callback + fallbackReason in result', () => {
    it('invokes onError when summarizer throws and reports fallbackReason', async () => {
      const msgs: Message[] = [
        msg('user', 'First long A'.repeat(50)),
        msg('assistant', 'Second long B'.repeat(50)),
        msg('user', 'Third'),
      ];

      const seen: { err: unknown; reason: string }[] = [];
      const result = await compress(msgs, {
        strategy: 'summarize',
        budget: 14,
        summarizer: async () => { throw new Error('LLM API 500'); },
        onError: (err, reason) => { seen.push({ err, reason }); },
      } as unknown as import('../compress.js').CompressOptions);

      expect(seen).toHaveLength(1);
      expect((seen[0].err as Error).message).toBe('LLM API 500');
      expect(seen[0].reason).toMatch(/summari[sz]er.*fail/i);
      // fallbackReason is surfaced on the result
      expect((result as unknown as { fallbackReason?: string }).fallbackReason).toBeDefined();
      expect((result as unknown as { fallbackReason?: string }).fallbackReason).toMatch(/summari[sz]er.*fail/i);
    });

    it('works without onError (no throw) and still exposes fallbackReason', async () => {
      const msgs: Message[] = [
        msg('user', 'A'.repeat(200)),
        msg('assistant', 'B'.repeat(200)),
        msg('user', 'Third'),
      ];
      const result = await compress(msgs, {
        strategy: 'summarize',
        budget: 14,
        summarizer: async () => { throw new Error('boom'); },
      });
      expect((result as unknown as { fallbackReason?: string }).fallbackReason).toMatch(/summari[sz]er/i);
    });
  });

  describe('summarize strategy: toSummarize is empty applies truncate fallback (CQ-013)', () => {
    it('truncates to fit budget when all non-kept messages are preserved', async () => {
      // The summarize strategy works backwards from the end keeping messages
      // that fit in the budget. When preserve returns true for EVERYTHING,
      // toSummarize is empty. Before CQ-013, the strategy returned
      // [...messages] (overshooting budget). After CQ-013, it applies a
      // truncate-pass keeping most recent messages fitting budget.
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

      // CQ-013: result fits budget via truncate fallback
      expect(result.finalTokens).toBeLessThanOrEqual(10);
      // Summarizer should NOT have been called since toSummarize is empty
      expect(summarizerFn).not.toHaveBeenCalled();
    });
  });

  describe('FIX: summarizer failure fallback', () => {
    it('falls back to keeping recent messages when summarizer throws', async () => {
      const msgs: Message[] = [
        msg('user', 'First question'),
        msg('assistant', 'First answer with lots of extra detail to fill tokens'),
        msg('user', 'Second question'),
        msg('assistant', 'Second answer'),
        msg('user', 'Third'),
        msg('assistant', 'Third answer'),
      ];

      const result = await compress(msgs, {
        strategy: 'summarize',
        budget: 14,
        summarizer: async () => { throw new Error('LLM API error'); },
      });

      // Should not crash — fallback returns the most recent half of messages
      expect(result.messages.length).toBeGreaterThanOrEqual(1);
      expect(result.messages.length).toBeLessThanOrEqual(msgs.length);
      // The last message should always be preserved
      expect(result.messages[result.messages.length - 1].content).toBe('Third answer');
    });

    it('fallback returns at least 1 message even for small arrays', async () => {
      const msgs: Message[] = [
        msg('user', 'Only message'),
      ];

      const result = await compress(msgs, {
        strategy: 'summarize',
        budget: 1,
        summarizer: async () => { throw new Error('fail'); },
      });

      expect(result.messages.length).toBeGreaterThanOrEqual(1);
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
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('Response 3');
    });
  });

  describe('unknown strategy', () => {
    it('throws for unknown strategy name', async () => {
      await expect(
        compress(messages, { strategy: 'nonexistent', budget: 5 }),
      ).rejects.toThrow('Unknown compression strategy');
    });
  });

  describe('CompressResult: compression failure signaling', () => {
    it('returns compressed=true and finalTokens when compression fits within budget', async () => {
      const result = await compress(messages, { strategy: 'truncate', budget: 500 });
      expect(result.compressed).toBe(true);
      expect(result.originalTokens).toBeGreaterThan(0);
      expect(result.finalTokens).toBeLessThanOrEqual(500);
      expect(result.messages).toHaveLength(6);
    });

    it('returns compressed=false when strategy output still exceeds budget', async () => {
      // Use a tiny budget with preserve-failures where failure messages exceed budget
      const bigFailure: Message[] = [
        msg('assistant', 'A'.repeat(400), { isFailureTrace: true }),
        msg('user', 'Short'),
      ];
      const result = await compress(bigFailure, {
        strategy: 'preserve-failures',
        budget: 5, // way too small for the failure trace
      });
      expect(result.compressed).toBe(false);
      expect(result.finalTokens).toBeGreaterThan(5);
    });

    it('returns compressed=true when strategy output fits within budget', async () => {
      const result = await compress(messages, { strategy: 'truncate', budget: 500 });
      expect(result.compressed).toBe(true);
      expect(result.finalTokens).toBeLessThanOrEqual(500);
    });

    it('originalTokens reflects the input messages token count', async () => {
      const result = await compress(messages, { strategy: 'truncate', budget: 500 });
      const expectedTokens = messages.reduce(
        (sum, m) => sum + estimateTokens('default', m.content),
        0,
      );
      expect(result.originalTokens).toBe(expectedTokens);
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
      // With a 100-token budget, we should NOT get all 5 messages
      expect(result.messages.length).toBeLessThan(longMessages.length);
      // Note: when every individual message exceeds the budget, the safety net
      // preserves the last message (Issue 4 fix), so finalTokens may exceed budget.
      // The important invariant is that we don't return all messages.
      expect(result.messages.length).toBeGreaterThanOrEqual(1);
    });

    it('sliding-window strategy respects token budget', async () => {
      const budget = 150;
      const result = await compress(longMessages, {
        strategy: 'sliding-window',
        budget,
        windowSize: 10, // large window, but token budget should limit
      });
      const resultTokens = totalTokens(result.messages);
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
      expect(result.messages[0].content).toContain('Summary');
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
      expect(result.messages.some((m) => m.content === 'Fail trace')).toBe(true);
      // Non-failure messages should be limited by token budget
      const nonFailures = result.messages.filter((m) => !m.meta?.isFailureTrace);
      const nonFailureTokens = totalTokens(nonFailures);
      const failureTokens = totalTokens(result.messages.filter((m) => m.meta?.isFailureTrace));
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
        expect(r.messages).toHaveLength(5);
        // Order should be preserved
        expect(r.messages[0].content).toBe('Hello');
        expect(r.messages[1].content).toBe('Fail');
        expect(r.messages[2].content).toBe('Hello');
        expect(r.messages[3].content).toBe('Response');
        expect(r.messages[4].content).toBe('Latest');
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
        expect(result.messages).toHaveLength(2);
        expect(result.messages[0].content).toBe('Third');
        expect(result.messages[1].content).toBe('Response 3');
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
        expect(result.messages.some((m) => m.content === 'First')).toBe(true);
        expect(result.messages.some((m) => m.content === 'Response 2')).toBe(true);
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
        expect(result.messages).toHaveLength(4);
        expect(result.messages[0].content).toBe('A');
        expect(result.messages[1].content).toBe('Fail');
        expect(result.messages[2].content).toBe('B');
        expect(result.messages[3].content).toBe('C');
      });
    });
  });
});

describe('compactIfNeeded', () => {
  function msg(role: Message['role'], content: string, meta?: Message['meta']): Message {
    return { role, content, meta };
  }

  const messages: Message[] = [
    msg('user', 'Hello world'),
    msg('assistant', 'Hi there, how can I help you today?'),
    msg('user', 'Tell me about TypeScript'),
    msg('assistant', 'TypeScript is a typed superset of JavaScript'),
  ];

  it('returns messages unchanged when under threshold (75% budget)', async () => {
    // Use a very large budget so tokens are well under 75%
    const result = await compactIfNeeded(messages, {
      budget: 10000,
      strategy: 'truncate',
    });
    expect(result).toHaveLength(messages.length);
    expect(result.map((m) => m.content)).toEqual(messages.map((m) => m.content));
  });

  it('compresses messages when over threshold', async () => {
    // Use a tiny budget so tokens exceed 75%
    const result = await compactIfNeeded(messages, {
      budget: 10,
      strategy: 'truncate',
    });
    expect(result.length).toBeLessThan(messages.length);
  });

  it('respects custom threshold', async () => {
    // With default threshold 0.75, budget 10000 would NOT trigger compression.
    // With threshold 0.5, trigger is at 50% of budget.
    // countTokens returns 60, budget is 100, so triggerAt = 50. 60 > 50 → compress.
    // Use a small budget so truncate actually removes messages.
    const result = await compactIfNeeded(messages, {
      budget: 10,
      threshold: 0.5,
      strategy: 'truncate',
      countTokens: () => 6, // 6 > 10*0.5=5, should trigger compression
    });
    // Budget of 10 tokens with truncate strategy should reduce messages
    expect(result.length).toBeLessThan(messages.length);
  });

  it('uses custom countTokens function', async () => {
    const mockCounter = vi.fn(() => 5); // returns 5, well under any budget
    const result = await compactIfNeeded(messages, {
      budget: 10000,
      strategy: 'truncate',
      countTokens: mockCounter,
    });
    expect(mockCounter).toHaveBeenCalledWith(messages);
    expect(result).toHaveLength(messages.length);
  });

  it('passes preserve predicate to compress', async () => {
    const systemMsg = msg('system', 'You are a helpful assistant');
    const testMessages = [systemMsg, ...messages];

    const result = await compactIfNeeded(testMessages, {
      budget: 10,
      strategy: 'truncate',
      preserve: (m) => m.role === 'system',
    });
    // System message should be preserved even after compression
    expect(result.some((m) => m.content === 'You are a helpful assistant')).toBe(true);
  });

  it('returns empty array for empty messages', async () => {
    const result = await compactIfNeeded([], {
      budget: 100,
      strategy: 'truncate',
    });
    expect(result).toHaveLength(0);
  });
});

describe('Issue 4: oversized single message handling in truncate', () => {
  function msg(role: Message['role'], content: string): Message {
    return { role, content };
  }

  it('returns last message when all messages individually exceed the token budget', async () => {
    // Each message is ~104 tokens; budget is only 10
    const messages: Message[] = [
      msg('user', 'A'.repeat(400)),
      msg('assistant', 'B'.repeat(400)),
      msg('user', 'C'.repeat(400)),
    ];
    const result = await compress(messages, { strategy: 'truncate', budget: 10 });
    // Safety net: must never return empty
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    // Must return the LAST message (most recent context preserved)
    expect(result.messages[result.messages.length - 1].content).toBe('C'.repeat(400));
  });

  it('returns last message for a single oversized message', async () => {
    const messages: Message[] = [
      msg('user', 'A'.repeat(400)), // ~104 tokens
    ];
    const result = await compress(messages, { strategy: 'truncate', budget: 5 });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('A'.repeat(400));
  });

  it('does not activate safety net when at least one message fits in budget', async () => {
    const messages: Message[] = [
      msg('user', 'A'.repeat(400)), // big: ~104 tokens
      msg('assistant', 'Short reply'),  // small: fits in budget
    ];
    const result = await compress(messages, { strategy: 'truncate', budget: 20 });
    // At least the small message fits; safety net should NOT duplicate the last message
    expect(result.messages.some((m) => m.content === 'Short reply')).toBe(true);
    // Should not have duplicated the last message
    const lastCount = result.messages.filter((m) => m.content === 'Short reply').length;
    expect(lastCount).toBe(1);
  });

  it('empty messages array returns empty result (no safety net needed)', async () => {
    const result = await compress([], { strategy: 'truncate', budget: 10 });
    expect(result.messages).toHaveLength(0);
  });
});

describe('Issue 5: sliding-window compression uses 2 Sets instead of 4 data structures', () => {
  function msg(role: Message['role'], content: string): Message {
    return { role, content };
  }

  it('produces correct results with consolidated Set approach', async () => {
    const messages: Message[] = [
      msg('user', 'First'),
      msg('assistant', 'Response 1'),
      msg('user', 'Second'),
      msg('assistant', 'Response 2'),
      msg('user', 'Third'),
      msg('assistant', 'Response 3'),
    ];
    const result = await compress(messages, {
      strategy: 'sliding-window',
      budget: 500,
      windowSize: 2,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toBe('Third');
    expect(result.messages[1].content).toBe('Response 3');
  });

  it('preserves messages outside the window correctly with consolidated sets', async () => {
    const messages: Message[] = [
      msg('user', 'Preserved'),
      msg('assistant', 'A'),
      msg('user', 'B'),
      msg('assistant', 'C'),
      msg('user', 'D'),
    ];
    const result = await compress(messages, {
      strategy: 'sliding-window',
      budget: 500,
      windowSize: 2,
      preserve: (m) => m.content === 'Preserved',
    });
    // Preserved message + last 2 windowed messages
    expect(result.messages.some((m) => m.content === 'Preserved')).toBe(true);
    expect(result.messages.some((m) => m.content === 'C')).toBe(true);
    expect(result.messages.some((m) => m.content === 'D')).toBe(true);
    // Total: 3 messages
    expect(result.messages.length).toBe(3);
  });

  it('maintains original message order after consolidation', async () => {
    const messages: Message[] = [
      msg('user', 'msg-0'),
      msg('assistant', 'msg-1'),
      msg('user', 'msg-2'),
      msg('assistant', 'msg-3'),
      msg('user', 'msg-4'),
    ];
    const result = await compress(messages, {
      strategy: 'sliding-window',
      budget: 500,
      windowSize: 3,
    });
    // Verify order is preserved
    const contents = result.messages.map((m) => m.content);
    for (let i = 0; i < contents.length - 1; i++) {
      const idxA = messages.findIndex((m) => m.content === contents[i]);
      const idxB = messages.findIndex((m) => m.content === contents[i + 1]);
      expect(idxA).toBeLessThan(idxB);
    }
  });

  it('handles window larger than message count gracefully', async () => {
    const messages: Message[] = [
      msg('user', 'Only message'),
    ];
    const result = await compress(messages, {
      strategy: 'sliding-window',
      budget: 500,
      windowSize: 100,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('Only message');
  });
});

describe('createAdapterSummarizer', () => {
  function msg(role: Message['role'], content: string): Message {
    return { role, content };
  }

  function createMockAdapter(responseContent: string): AgentAdapter {
    return {
      chat: vi.fn(async (): Promise<ChatResponse> => ({
        message: { role: 'assistant', content: responseContent },
        usage: { inputTokens: 10, outputTokens: 5 },
      })),
    };
  }

  it('creates a summarizer function that calls adapter.chat', async () => {
    const adapter = createMockAdapter('This is the summary');
    const summarizer = createAdapterSummarizer(adapter);

    const messages: Message[] = [
      msg('user', 'Hello'),
      msg('assistant', 'Hi there'),
    ];

    const result = await summarizer(messages);

    expect(adapter.chat).toHaveBeenCalledOnce();
    expect(result).toBe('This is the summary');
  });

  it('returns the summary content from the adapter response', async () => {
    const expectedSummary = 'User greeted the assistant. Assistant responded with a greeting.';
    const adapter = createMockAdapter(expectedSummary);
    const summarizer = createAdapterSummarizer(adapter);

    const messages: Message[] = [
      msg('user', 'Good morning'),
      msg('assistant', 'Good morning! How can I help?'),
    ];

    const result = await summarizer(messages);
    expect(result).toBe(expectedSummary);
  });

  it('formats messages correctly for the summary prompt', async () => {
    const adapter = createMockAdapter('summary');
    const summarizer = createAdapterSummarizer(adapter);

    const messages: Message[] = [
      msg('user', 'What is TypeScript?'),
      msg('assistant', 'TypeScript is a typed superset of JavaScript.'),
      msg('user', 'Thanks!'),
    ];

    await summarizer(messages);

    const chatCall = vi.mocked(adapter.chat).mock.calls[0][0];
    expect(chatCall.messages).toHaveLength(2);

    // First message should be a system prompt instructing summarization
    expect(chatCall.messages[0].role).toBe('system');
    expect(chatCall.messages[0].content).toContain('Summarize');

    // Second message should contain the formatted conversation
    expect(chatCall.messages[1].role).toBe('user');
    expect(chatCall.messages[1].content).toContain('[user]: What is TypeScript?');
    expect(chatCall.messages[1].content).toContain('[assistant]: TypeScript is a typed superset of JavaScript.');
    expect(chatCall.messages[1].content).toContain('[user]: Thanks!');
  });

  it('works as a summarizer callback for the summarize compression strategy', async () => {
    const adapter = createMockAdapter('Earlier, the user asked about TypeScript.');
    const summarizer = createAdapterSummarizer(adapter);

    const messages: Message[] = [
      msg('user', 'What is TypeScript?'),
      msg('assistant', 'TypeScript is a typed superset of JavaScript that adds static types.'),
      msg('user', 'Can you give an example?'),
      msg('assistant', 'Sure: let x: number = 5;'),
      msg('user', 'Thanks'),
      msg('assistant', 'You are welcome!'),
    ];

    const result = await compress(messages, {
      strategy: 'summarize',
      budget: 14,
      summarizer,
    });

    // The first message should be a summary
    expect(result.messages[0].content).toContain('Summary');
    expect(result.messages[0].content).toContain('Earlier, the user asked about TypeScript.');
    // adapter.chat should have been called
    expect(adapter.chat).toHaveBeenCalled();
  });

  it('handles empty message arrays', async () => {
    const adapter = createMockAdapter('No conversation to summarize.');
    const summarizer = createAdapterSummarizer(adapter);

    const result = await summarizer([]);

    expect(adapter.chat).toHaveBeenCalledOnce();
    expect(result).toBe('No conversation to summarize.');

    // The user message content should be empty since no messages to format
    const chatCall = vi.mocked(adapter.chat).mock.calls[0][0];
    expect(chatCall.messages[1].role).toBe('user');
    expect(chatCall.messages[1].content).toBe('');
  });

  it('handles single message', async () => {
    const adapter = createMockAdapter('User said hello.');
    const summarizer = createAdapterSummarizer(adapter);

    const messages: Message[] = [msg('user', 'Hello')];
    const result = await summarizer(messages);

    expect(result).toBe('User said hello.');
    const chatCall = vi.mocked(adapter.chat).mock.calls[0][0];
    expect(chatCall.messages[1].content).toBe('[user]: Hello');
  });

  it('propagates adapter errors', async () => {
    const adapter: AgentAdapter = {
      chat: vi.fn(async () => { throw new Error('LLM API error'); }),
    };
    const summarizer = createAdapterSummarizer(adapter);

    await expect(summarizer([msg('user', 'test')])).rejects.toThrow('LLM API error');
  });
});
