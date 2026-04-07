import { describe, it, expect } from 'vitest';
import { countTokens, registerTokenizer } from '../count-tokens.js';

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
});
