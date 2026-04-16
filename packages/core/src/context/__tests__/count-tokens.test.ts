import { describe, it, expect, vi } from 'vitest';
import { countTokens, registerTokenizer } from '../count-tokens.js';
import * as tokenEstimator from '../../infra/token-estimator.js';

describe('countTokens', () => {
  it('returns a positive number for messages with content', () => {
    const tokens = countTokens('test-model', [
      { role: 'user', content: 'Hello world' },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });

  it('sums tokens across multiple messages', () => {
    const single = countTokens('test-model', [{ role: 'user', content: 'Hello' }]);
    const double = countTokens('test-model', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hello' },
    ]);
    expect(double).toBe(single * 2);
  });

  it('returns 0 for empty messages array', () => {
    expect(countTokens('test-model', [])).toBe(0);
  });

  it('uses registered tokenizer', () => {
    registerTokenizer('count-test-model', {
      encode(text) {
        return { length: text.length }; // 1 token per char
      },
    });
    const tokens = countTokens('count-test-model', [
      { role: 'user', content: 'abc' },
    ]);
    expect(tokens).toBe(3);
  });

  describe('M2: undefined content returns valid number, not NaN', () => {
    it('returns a valid number for a message with undefined content', () => {
      const msg = { role: 'user' as const, content: undefined } as unknown as { role: 'user'; content: string };
      const tokens = countTokens('test-model', [msg]);
      expect(typeof tokens).toBe('number');
      expect(Number.isNaN(tokens)).toBe(false);
      expect(tokens).toBeGreaterThanOrEqual(0);
    });

    it('returns a valid number for a message with explicitly undefined content', () => {
      const msg = { role: 'assistant' as const, content: undefined } as unknown as { role: 'assistant'; content: string };
      const tokens = countTokens('test-model', [msg]);
      expect(Number.isFinite(tokens)).toBe(true);
    });

    it('treats undefined content the same as empty string content', () => {
      const undefinedMsg = { role: 'user' as const, content: undefined } as unknown as { role: 'user'; content: string };
      const emptyMsg = { role: 'user' as const, content: '' };
      const tokensUndefined = countTokens('test-model', [undefinedMsg]);
      const tokensEmpty = countTokens('test-model', [emptyMsg]);
      expect(tokensUndefined).toBe(tokensEmpty);
    });
  });

  describe('H7: token counting memoization', () => {
    it('caches token count for the same message object', () => {
      const spy = vi.spyOn(tokenEstimator, 'estimateTokens');

      const message = { role: 'user' as const, content: 'Hello world' };

      // Count tokens for the same message object twice
      const first = countTokens('memo-test', [message]);
      const second = countTokens('memo-test', [message]);

      expect(first).toBe(second);

      // With memoization, estimateTokens should only be called once for this message
      // (not twice — the second call should use the cached value)
      const callsForThisMessage = spy.mock.calls.filter(
        (call) => call[1] === 'Hello world',
      );
      expect(callsForThisMessage).toHaveLength(1);

      spy.mockRestore();
    });

    it('returns correct results for different messages', () => {
      const msg1 = { role: 'user' as const, content: 'Short' };
      const msg2 = { role: 'user' as const, content: 'A much longer message with more tokens' };

      const tokens1 = countTokens('memo-test', [msg1]);
      const tokens2 = countTokens('memo-test', [msg2]);

      // Different messages should return different token counts
      expect(tokens1).not.toBe(tokens2);
    });

    it('does not cache across different message objects with same content', () => {
      // WeakMap keyed by object identity, so two different objects with same content
      // should both work correctly (may or may not cache, but results must be correct)
      const msg1 = { role: 'user' as const, content: 'Same content' };
      const msg2 = { role: 'user' as const, content: 'Same content' };

      const tokens1 = countTokens('memo-test', [msg1]);
      const tokens2 = countTokens('memo-test', [msg2]);

      expect(tokens1).toBe(tokens2);
    });
  });
});
