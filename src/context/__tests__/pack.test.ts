import { describe, it, expect } from 'vitest';
import { packContext } from '../pack.js';
import { createBudget } from '../budget.js';
import type { Message } from '../../core/types.js';

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
});
