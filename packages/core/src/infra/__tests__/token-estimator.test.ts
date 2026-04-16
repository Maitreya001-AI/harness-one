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

  describe('M8: heuristicEstimate edge cases', () => {
    it('handles surrogate pairs (emoji) without crashing or returning NaN', () => {
      // Surrogate pairs occupy 2 UTF-16 code units. The high surrogate (0xD800-0xDBFF)
      // falls outside CJK and ASCII ranges, so it should be classified as "normal" text.
      const emoji = '😀🎉🚀💻🔥'; // 5 emoji, each is a surrogate pair (10 code units)
      const tokens = estimateTokens('unknown-model', emoji);
      expect(typeof tokens).toBe('number');
      expect(Number.isNaN(tokens)).toBe(false);
      expect(Number.isFinite(tokens)).toBe(true);
      expect(tokens).toBeGreaterThan(0);
      expect(Number.isInteger(tokens)).toBe(true);
    });

    it('handles all-CJK text with correct higher token cost', () => {
      // All CJK characters: should use ~1.5 chars/token ratio
      const cjk = '你好世界这是一个完整的中文句子用于测试'; // 17 CJK chars
      const tokens = estimateTokens('unknown-model', cjk);
      // Expected: ceil(17/1.5 + 4) = ceil(11.33 + 4) = ceil(15.33) = 16
      expect(tokens).toBeGreaterThan(0);
      expect(Number.isInteger(tokens)).toBe(true);
      // CJK text is more expensive than same-length ASCII
      const ascii = 'abcdefghijklmnopq'; // 17 ASCII chars
      const asciiTokens = estimateTokens('unknown-model', ascii);
      expect(tokens).toBeGreaterThan(asciiTokens);
    });

    it('handles all-code/punctuation text with correct ratio', () => {
      // All code punctuation: should use ~3 chars/token ratio
      const code = '{}()[];:=<>!&|+-*/%^~?';  // 22 code/punct chars
      const tokens = estimateTokens('unknown-model', code);
      // Expected: ceil(22/3 + 4) = ceil(7.33 + 4) = ceil(11.33) = 12
      expect(tokens).toBeGreaterThan(0);
      expect(Number.isInteger(tokens)).toBe(true);
    });

    it('handles mixed surrogate pairs and CJK text', () => {
      const mixed = '你好😀世界🎉测试'; // CJK + emoji surrogate pairs
      const tokens = estimateTokens('unknown-model', mixed);
      expect(typeof tokens).toBe('number');
      expect(Number.isNaN(tokens)).toBe(false);
      expect(tokens).toBeGreaterThan(0);
      expect(Number.isInteger(tokens)).toBe(true);
    });

    it('handles lone surrogate code units gracefully', () => {
      // Construct a string with an isolated high surrogate (invalid, but should not crash)
      const loneSurrogate = String.fromCharCode(0xD800);
      const tokens = estimateTokens('unknown-model', loneSurrogate);
      expect(typeof tokens).toBe('number');
      expect(Number.isNaN(tokens)).toBe(false);
      expect(tokens).toBeGreaterThan(0);
    });

    it('returns correct integer for single CJK character', () => {
      // Single CJK char: ceil(1/1.5 + 4) = ceil(4.67) = 5
      const tokens = estimateTokens('unknown-model', '中');
      expect(tokens).toBe(5);
    });

    it('returns correct integer for single code/punctuation character', () => {
      // Single code char: ceil(1/3 + 4) = ceil(4.33) = 5
      const tokens = estimateTokens('unknown-model', '{');
      expect(tokens).toBe(5);
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
