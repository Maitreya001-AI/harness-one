import { describe, it, expect, beforeEach } from 'vitest';
import { estimateTokens, registerTokenizer } from '../token-estimator.js';
import type { Tokenizer } from '../token-estimator.js';

describe('token-estimator', () => {
  describe('estimateTokens (heuristic)', () => {
    it('estimates English text at ~4 chars per token + framing', () => {
      // "Hello world" = 11 chars → ~11/4 = ~2.75 + 4 framing = ~6-7
      const tokens = estimateTokens('unknown-model', 'Hello world');
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(20);
    });

    it('returns framing overhead for empty string', () => {
      const tokens = estimateTokens('unknown-model', '');
      expect(tokens).toBe(4); // framing only
    });

    it('handles CJK characters with higher token cost', () => {
      // 10 CJK chars → ~10/1.5 ≈ 6.67 + 4 framing ≈ 10-11
      const cjk = '你好世界测试文本信息数';
      const english = 'abcdefghij'; // 10 ASCII chars → ~10/4 = 2.5 + 4 ≈ 6-7
      const cjkTokens = estimateTokens('unknown-model', cjk);
      const engTokens = estimateTokens('unknown-model', english);
      expect(cjkTokens).toBeGreaterThan(engTokens);
    });

    it('handles code/punctuation with adjusted ratio', () => {
      const code = 'if(x){return y;}';
      const tokens = estimateTokens('unknown-model', code);
      expect(tokens).toBeGreaterThan(0);
    });

    it('returns integer values', () => {
      const tokens = estimateTokens('unknown-model', 'test string');
      expect(Number.isInteger(tokens)).toBe(true);
    });
  });

  describe('registerTokenizer', () => {
    const mockTokenizer: Tokenizer = {
      encode(text: string) {
        // Simple: 1 token per word
        return { length: text.split(/\s+/).filter(Boolean).length };
      },
    };

    beforeEach(() => {
      // Register fresh tokenizer for each test
      registerTokenizer('test-model', mockTokenizer);
    });

    it('uses registered tokenizer instead of heuristic', () => {
      const tokens = estimateTokens('test-model', 'one two three four five');
      expect(tokens).toBe(5);
    });

    it('falls back to heuristic for unregistered model', () => {
      const tokens = estimateTokens('other-model', 'one two three four five');
      // Heuristic result, not 5
      expect(tokens).not.toBe(5);
    });

    it('allows overwriting a tokenizer', () => {
      const newTokenizer: Tokenizer = {
        encode() {
          return { length: 42 };
        },
      };
      registerTokenizer('test-model', newTokenizer);
      expect(estimateTokens('test-model', 'anything')).toBe(42);
    });
  });
});
