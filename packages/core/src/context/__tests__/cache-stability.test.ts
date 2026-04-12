import { describe, it, expect } from 'vitest';
import { analyzeCacheStability } from '../cache-stability.js';
import type { Message } from '../../core/types.js';

function msg(role: Message['role'], content: string): Message {
  return { role, content };
}

describe('analyzeCacheStability', () => {
  it('returns perfect match for identical arrays', () => {
    const msgs = [msg('system', 'Sys'), msg('user', 'Hi')];
    const report = analyzeCacheStability(msgs, msgs);

    expect(report.prefixMatchRatio).toBe(1);
    expect(report.firstDivergenceIndex).toBe(-1);
    expect(report.stablePrefixTokens).toBeGreaterThan(0);
    expect(report.recommendations).toHaveLength(0);
  });

  it('detects divergence at a specific index', () => {
    const v1 = [msg('system', 'Sys'), msg('user', 'Hello')];
    const v2 = [msg('system', 'Sys'), msg('user', 'Hi there')];

    const report = analyzeCacheStability(v1, v2);
    expect(report.firstDivergenceIndex).toBe(1);
    expect(report.prefixMatchRatio).toBe(0.5);
    expect(report.stablePrefixTokens).toBeGreaterThan(0);
  });

  it('detects divergence at index 0 and recommends fixing system prompts', () => {
    const v1 = [msg('system', 'Version A')];
    const v2 = [msg('system', 'Version B')];

    const report = analyzeCacheStability(v1, v2);
    expect(report.firstDivergenceIndex).toBe(0);
    expect(report.stablePrefixTokens).toBe(0);
    expect(report.recommendations.some((r) => r.includes('system prompts'))).toBe(true);
  });

  it('handles different length arrays', () => {
    const v1 = [msg('system', 'Sys'), msg('user', 'Hi')];
    const v2 = [msg('system', 'Sys'), msg('user', 'Hi'), msg('assistant', 'Hello')];

    const report = analyzeCacheStability(v1, v2);
    expect(report.firstDivergenceIndex).toBe(2); // diverges at the extra message
    expect(report.prefixMatchRatio).toBeCloseTo(2 / 3, 2);
  });

  it('handles empty arrays', () => {
    const report = analyzeCacheStability([], []);
    expect(report.prefixMatchRatio).toBe(1);
    expect(report.firstDivergenceIndex).toBe(-1);
    expect(report.stablePrefixTokens).toBe(0);
  });

  it('handles one empty array', () => {
    const report = analyzeCacheStability([], [msg('user', 'Hi')]);
    expect(report.firstDivergenceIndex).toBe(0);
    expect(report.prefixMatchRatio).toBe(0);
  });

  it('generates recommendation for moderate stability', () => {
    const base = [msg('system', 'Sys'), msg('user', 'A'), msg('assistant', 'B')];
    const v2 = [msg('system', 'Sys'), msg('user', 'A'), msg('assistant', 'C'), msg('user', 'D')];

    const report = analyzeCacheStability(base, v2);
    expect(report.prefixMatchRatio).toBe(0.5);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });

  describe('tool message comparison (toolCallId field)', () => {
    it('considers tool messages equal when all fields match including toolCallId', () => {
      const v1: Message[] = [
        { role: 'tool', content: 'result', toolCallId: 'tc1' },
      ];
      const v2: Message[] = [
        { role: 'tool', content: 'result', toolCallId: 'tc1' },
      ];
      const report = analyzeCacheStability(v1, v2);
      expect(report.firstDivergenceIndex).toBe(-1);
      expect(report.prefixMatchRatio).toBe(1);
    });

    it('detects divergence when tool messages have different toolCallId', () => {
      const v1: Message[] = [
        { role: 'tool', content: 'result', toolCallId: 'tc1' },
      ];
      const v2: Message[] = [
        { role: 'tool', content: 'result', toolCallId: 'tc2' },
      ];
      const report = analyzeCacheStability(v1, v2);
      expect(report.firstDivergenceIndex).toBe(0);
    });
  });

  describe('assistant message with undefined vs defined toolCalls', () => {
    it('considers assistant messages equal when both have undefined toolCalls', () => {
      const v1: Message[] = [
        { role: 'assistant', content: 'Hello' },
      ];
      const v2: Message[] = [
        { role: 'assistant', content: 'Hello' },
      ];
      const report = analyzeCacheStability(v1, v2);
      expect(report.firstDivergenceIndex).toBe(-1);
    });

    it('detects divergence when one assistant message has toolCalls and other does not', () => {
      const v1: Message[] = [
        { role: 'assistant', content: 'Hello', toolCalls: [{ id: 'tc1', name: 'search', arguments: '{}' }] },
      ];
      const v2: Message[] = [
        { role: 'assistant', content: 'Hello' },
      ];
      const report = analyzeCacheStability(v1, v2);
      expect(report.firstDivergenceIndex).toBe(0);
    });
  });

  describe('name field comparison in messagesEqual', () => {
    it('detects divergence when name fields differ', () => {
      const v1: Message[] = [
        { role: 'user', content: 'Hello', name: 'alice' },
      ];
      const v2: Message[] = [
        { role: 'user', content: 'Hello', name: 'bob' },
      ];
      const report = analyzeCacheStability(v1, v2);
      expect(report.firstDivergenceIndex).toBe(0);
    });
  });

  describe('moderate stability recommendation', () => {
    it('generates HEAD/MID/TAIL layout recommendation when ratio is between 0.5 and 0.8', () => {
      // Need prefix match ratio between 0.5 and 0.8
      // 4 messages, diverge at index 3 => ratio = 3/5 = 0.6
      const v1: Message[] = [
        msg('system', 'Sys'),
        msg('user', 'A'),
        msg('assistant', 'B'),
        msg('user', 'C'),
      ];
      const v2: Message[] = [
        msg('system', 'Sys'),
        msg('user', 'A'),
        msg('assistant', 'B'),
        msg('user', 'D'),
        msg('assistant', 'E'),
      ];

      const report = analyzeCacheStability(v1, v2);
      expect(report.prefixMatchRatio).toBeGreaterThanOrEqual(0.5);
      expect(report.prefixMatchRatio).toBeLessThan(0.8);
      expect(report.recommendations.some(r => r.includes('HEAD/MID/TAIL'))).toBe(true);
    });
  });

  describe('contentOverlapRatio', () => {
    it('returns 1 for identical arrays', () => {
      const msgs = [msg('system', 'Sys'), msg('user', 'Hi')];
      const report = analyzeCacheStability(msgs, msgs);
      expect(report.contentOverlapRatio).toBe(1);
    });

    it('returns 1 for empty arrays', () => {
      const report = analyzeCacheStability([], []);
      expect(report.contentOverlapRatio).toBe(1);
    });

    it('returns 0 for completely different arrays', () => {
      const v1 = [msg('user', 'Hello')];
      const v2 = [msg('user', 'Goodbye')];
      const report = analyzeCacheStability(v1, v2);
      expect(report.contentOverlapRatio).toBe(0);
    });

    it('returns correct ratio for partial overlap', () => {
      const v1 = [msg('system', 'Sys'), msg('user', 'Hello')];
      const v2 = [msg('system', 'Sys'), msg('user', 'Goodbye')];
      const report = analyzeCacheStability(v1, v2);
      // 1 shared message out of max(2, 2) = 2 => 0.5
      expect(report.contentOverlapRatio).toBe(0.5);
    });

    it('detects overlap regardless of position (reordered messages)', () => {
      const v1 = [msg('user', 'A'), msg('assistant', 'B')];
      const v2 = [msg('assistant', 'B'), msg('user', 'A')];
      const report = analyzeCacheStability(v1, v2);
      // Both messages are shared, just in different order
      expect(report.contentOverlapRatio).toBe(1);
      // But prefix match should detect divergence at index 0
      expect(report.prefixMatchRatio).toBe(0);
    });

    it('handles different length arrays', () => {
      const v1 = [msg('system', 'Sys'), msg('user', 'A')];
      const v2 = [msg('system', 'Sys'), msg('user', 'A'), msg('assistant', 'B')];
      const report = analyzeCacheStability(v1, v2);
      // 2 shared out of max(2, 3) = 3 => 2/3
      expect(report.contentOverlapRatio).toBeCloseTo(2 / 3, 2);
    });
  });

  describe('FIX: messageKey handles non-string content', () => {
    it('computes correct contentOverlapRatio when content is an array (non-string)', () => {
      const v1: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] as unknown as string },
      ];
      const v2: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] as unknown as string },
      ];
      const report = analyzeCacheStability(v1, v2);
      // With the fix, non-string content is JSON.stringified so identical arrays match
      expect(report.contentOverlapRatio).toBe(1);
    });

    it('does not produce [object Object] for object content', () => {
      const v1: Message[] = [
        { role: 'user', content: { text: 'A' } as unknown as string },
      ];
      const v2: Message[] = [
        { role: 'user', content: { text: 'B' } as unknown as string },
      ];
      const report = analyzeCacheStability(v1, v2);
      // Without the fix, both would produce "user::[object Object]::" and overlap=1
      // With the fix, they produce different JSON strings and overlap=0
      expect(report.contentOverlapRatio).toBe(0);
    });
  });

  describe('H4: JSON.stringify comparison for toolCalls is unstable', () => {
    it('considers messages equal when toolCalls have same fields in different order', () => {
      // JSON.stringify is not order-stable. Two objects with same fields in different
      // order should be considered equal.
      const v1: Message[] = [
        {
          role: 'assistant',
          content: 'Calling tool',
          toolCalls: [{ id: 'tc1', name: 'search', arguments: '{"q":"hello"}' }],
        },
      ];
      const v2: Message[] = [
        {
          role: 'assistant',
          content: 'Calling tool',
          // Same toolCall data, but fields constructed in a potentially different order
          toolCalls: [
            Object.assign(
              Object.create(null),
              { arguments: '{"q":"hello"}', id: 'tc1', name: 'search' },
            ) as import('../../core/types.js').ToolCallRequest,
          ],
        },
      ];

      const report = analyzeCacheStability(v1, v2);
      // These should be considered identical — divergence at -1
      expect(report.firstDivergenceIndex).toBe(-1);
      expect(report.prefixMatchRatio).toBe(1);
    });

    it('detects actually different toolCalls', () => {
      const v1: Message[] = [
        {
          role: 'assistant',
          content: 'Calling tool',
          toolCalls: [{ id: 'tc1', name: 'search', arguments: '{"q":"hello"}' }],
        },
      ];
      const v2: Message[] = [
        {
          role: 'assistant',
          content: 'Calling tool',
          toolCalls: [{ id: 'tc2', name: 'search', arguments: '{"q":"hello"}' }],
        },
      ];

      const report = analyzeCacheStability(v1, v2);
      expect(report.firstDivergenceIndex).toBe(0);
    });
  });
});
