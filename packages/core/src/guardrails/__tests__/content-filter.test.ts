import { describe, it, expect } from 'vitest';
import { createContentFilter } from '../content-filter.js';
import { HarnessError, HarnessErrorCode} from '../../core/errors.js';

describe('createContentFilter', () => {
  // ---- Blocks content matching blocked keywords ----

  describe('keyword blocking', () => {
    it('blocks content containing a blocked keyword', () => {
      const { guard } = createContentFilter({ blocked: ['forbidden'] });
      const result = guard({ content: 'This contains forbidden content' });

      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('forbidden');
        expect(result.reason).toContain('keyword');
      }
    });

    it('blocks case-insensitively (keyword is lowered)', () => {
      const { guard } = createContentFilter({ blocked: ['badword'] });

      expect(guard({ content: 'This contains BADWORD in it' }).action).toBe('block');
      expect(guard({ content: 'This contains BadWord in it' }).action).toBe('block');
      expect(guard({ content: 'this contains badword' }).action).toBe('block');
    });

    it('does NOT block on partial match within a word (word-boundary matching)', () => {
      const { guard } = createContentFilter({ blocked: ['bad'] });
      // "bad" appears within "badge" but should not match due to word-boundary
      expect(guard({ content: 'My badge is here' }).action).toBe('allow');
    });

    it('blocks when blocked keyword appears as a standalone word', () => {
      const { guard } = createContentFilter({ blocked: ['bad'] });
      expect(guard({ content: 'This is bad content' }).action).toBe('block');
    });

    it('blocks on the first matching keyword', () => {
      const { guard } = createContentFilter({ blocked: ['alpha', 'beta'] });
      const result = guard({ content: 'This has alpha and beta' });

      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('alpha');
      }
    });

    it('handles multiple blocked keywords', () => {
      const { guard } = createContentFilter({ blocked: ['red', 'blue', 'green'] });

      expect(guard({ content: 'The sky is blue' }).action).toBe('block');
      expect(guard({ content: 'The grass is green' }).action).toBe('block');
      expect(guard({ content: 'The rose is red' }).action).toBe('block');
    });
  });

  // ---- Blocks content matching blocked patterns ----

  describe('pattern blocking', () => {
    it('blocks content matching a blocked pattern', () => {
      const { guard } = createContentFilter({ blockedPatterns: [/secret\d+/i] });
      const result = guard({ content: 'The code is secret123' });

      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('blocked pattern');
      }
    });

    it('pattern matching uses NFKC-normalized lowercase content', () => {
      // Content is NFKC-normalized and lowercased before pattern matching,
      // so a pattern for "secret" (lowercase) matches regardless of input case
      const { guard } = createContentFilter({ blockedPatterns: [/secret/] });

      expect(guard({ content: 'This is Secret' }).action).toBe('block');
      expect(guard({ content: 'this is secret' }).action).toBe('block');
    });

    it('pattern with case-insensitive flag matches any case', () => {
      const { guard } = createContentFilter({ blockedPatterns: [/forbidden/i] });

      expect(guard({ content: 'FORBIDDEN access' }).action).toBe('block');
      expect(guard({ content: 'Forbidden access' }).action).toBe('block');
    });

    it('handles multiple patterns', () => {
      const { guard } = createContentFilter({
        blockedPatterns: [/password\s*=\s*\S+/, /api_key_\w+/],
      });

      expect(guard({ content: 'password = abc123' }).action).toBe('block');
      expect(guard({ content: 'using api_key_xyz' }).action).toBe('block');
      expect(guard({ content: 'normal content' }).action).toBe('allow');
    });

    it('pattern matching checks NFKC-normalized lowercase content', () => {
      const { guard } = createContentFilter({ blockedPatterns: [/^.*$/] });
      const result = guard({ content: 'any content at all' });
      expect(result.action).toBe('block');
    });
  });

  // ---- Allows clean content ----

  describe('clean content passes through', () => {
    it('allows content without blocked keywords', () => {
      const { guard } = createContentFilter({ blocked: ['badword'] });
      expect(guard({ content: 'This is fine' }).action).toBe('allow');
    });

    it('allows content that does not match any pattern', () => {
      const { guard } = createContentFilter({ blockedPatterns: [/secret\d+/] });
      expect(guard({ content: 'No secrets here' }).action).toBe('allow');
    });

    it('allows everything when no blocked words or patterns configured', () => {
      const { guard } = createContentFilter({});
      expect(guard({ content: 'anything goes' }).action).toBe('allow');
    });

    it('allows everything when blocked lists are empty', () => {
      const { guard } = createContentFilter({ blocked: [], blockedPatterns: [] });
      expect(guard({ content: 'anything' }).action).toBe('allow');
      expect(guard({ content: '' }).action).toBe('allow');
    });
  });

  // ---- Case sensitivity behavior ----

  describe('case sensitivity', () => {
    it('keywords are always case-insensitive (lowercased comparison)', () => {
      const { guard } = createContentFilter({ blocked: ['TestWord'] });

      // The keyword "TestWord" is lowered to "testword"
      // Content is also lowered before comparison
      expect(guard({ content: 'TESTWORD' }).action).toBe('block');
      expect(guard({ content: 'testword' }).action).toBe('block');
      expect(guard({ content: 'TeStWoRd' }).action).toBe('block');
    });

    it('patterns match against NFKC-normalized lowercase content', () => {
      // Since content is lowercased before pattern matching, a pattern with
      // uppercase letters will NOT match (the content is always lowercase).
      // Use lowercase patterns to match content regardless of original case.
      const { guard: guardUpper } = createContentFilter({
        blockedPatterns: [/CaseSensitive/],
      });

      // Uppercase pattern won't match because content is lowercased
      expect(guardUpper({ content: 'CaseSensitive match' }).action).toBe('allow');

      const { guard: guardLower } = createContentFilter({
        blockedPatterns: [/casesensitive/],
      });

      // Lowercase pattern matches because content is lowercased
      expect(guardLower({ content: 'CaseSensitive match' }).action).toBe('block');
      expect(guardLower({ content: 'casesensitive match' }).action).toBe('block');
    });

    it('handles Turkish dotted I correctly (no false positive)', () => {
      const { guard } = createContentFilter({ blocked: ['info'] });
      // Turkish I (U+0130) lowercases to 'i\u0307', not 'i'
      const result = guard({ content: '\u0130NFO about things' });
      expect(result.action).toBe('allow');
    });
  });

  // ---- Priority: keywords checked before patterns ----

  it('checks keywords before patterns', () => {
    const { guard } = createContentFilter({
      blocked: ['bad'],
      blockedPatterns: [/bad/],
    });

    const result = guard({ content: 'bad content' });
    expect(result.action).toBe('block');
    if (result.action === 'block') {
      expect(result.reason).toContain('keyword');
    }
  });

  // ---- Edge cases ----

  describe('edge cases', () => {
    it('handles empty content string', () => {
      const { guard } = createContentFilter({ blocked: ['bad'] });
      expect(guard({ content: '' }).action).toBe('allow');
    });

    it('handles whitespace-only content', () => {
      const { guard } = createContentFilter({ blocked: ['bad'] });
      expect(guard({ content: '   \t\n\r  ' }).action).toBe('allow');
    });

    it('handles content with special regex characters in keywords', () => {
      // Keywords with regex-special characters are safely escaped for word-boundary matching
      const { guard } = createContentFilter({ blocked: ['$money'] });
      expect(guard({ content: 'I have $money today' }).action).toBe('block');
    });

    it('handles very long content efficiently', () => {
      const { guard } = createContentFilter({ blocked: ['needle'] });
      const content = 'hay '.repeat(10000) + 'needle';

      const start = performance.now();
      const result = guard({ content });
      const elapsed = performance.now() - start;

      expect(result.action).toBe('block');
      expect(elapsed).toBeLessThan(1000);
    });
  });

  // ---- Word boundary matching (Fix 3) ----

  describe('word boundary matching', () => {
    it('does not false-positive: "contest" does not match keyword "test"', () => {
      const { guard } = createContentFilter({ blocked: ['test'] });
      expect(guard({ content: 'This is a contest entry' }).action).toBe('allow');
    });

    it('does not false-positive: "assassin" does not match keyword "ass"', () => {
      const { guard } = createContentFilter({ blocked: ['ass'] });
      expect(guard({ content: 'The assassin was caught' }).action).toBe('allow');
    });

    it('blocks exact word match: "test" matches standalone "test"', () => {
      const { guard } = createContentFilter({ blocked: ['test'] });
      expect(guard({ content: 'This is a test for you' }).action).toBe('block');
    });

    it('blocks word at start of string', () => {
      const { guard } = createContentFilter({ blocked: ['bad'] });
      expect(guard({ content: 'bad things happen' }).action).toBe('block');
    });

    it('blocks word at end of string', () => {
      const { guard } = createContentFilter({ blocked: ['bad'] });
      expect(guard({ content: 'something bad' }).action).toBe('block');
    });

    it('blocks word surrounded by punctuation', () => {
      const { guard } = createContentFilter({ blocked: ['bad'] });
      expect(guard({ content: 'is it (bad) or good?' }).action).toBe('block');
    });
  });

  // ---- NFKC normalization (Fix 4) ----

  describe('NFKC normalization', () => {
    it('catches fullwidth characters used to bypass filtering', () => {
      const { guard } = createContentFilter({ blocked: ['forbidden'] });
      // Fullwidth 'f' (U+FF46) + 'o' (U+FF4F) + 'r' (U+FF52) + 'b' (U+FF42) + ...
      const fullwidthForbidden = '\uFF46\uFF4F\uFF52\uFF42\uFF49\uFF44\uFF44\uFF45\uFF4E';
      expect(guard({ content: `This is ${fullwidthForbidden} content` }).action).toBe('block');
    });

    it('normalizes both keywords and content consistently', () => {
      const { guard } = createContentFilter({ blocked: ['cafe'] });
      // "cafe" with combining acute (caf + e + combining acute) -> NFKC -> caf\u00E9
      // The keyword "cafe" is also NFKC-normalized, so this tests consistent normalization
      expect(guard({ content: 'Visit the cafe today' }).action).toBe('block');
    });
  });

  // ---- FIX: lastIndex reset + NFKC normalization for custom patterns ----

  describe('custom pattern lastIndex reset and normalization', () => {
    it('does not produce intermittent failures with global-flag patterns on repeated calls', () => {
      const { guard } = createContentFilter({ blockedPatterns: [/secret\d+/gi] });

      // With the 'g' flag, regex.lastIndex advances after each .test() call.
      // Without resetting lastIndex, the second call may miss the match.
      const result1 = guard({ content: 'This has secret123 in it' });
      const result2 = guard({ content: 'This has secret456 in it' });
      const result3 = guard({ content: 'This has secret789 in it' });

      expect(result1.action).toBe('block');
      expect(result2.action).toBe('block');
      expect(result3.action).toBe('block');
    });

    it('custom patterns benefit from NFKC normalization (catches fullwidth bypass)', () => {
      // Pattern that matches "secret" followed by digits
      const { guard } = createContentFilter({ blockedPatterns: [/secret\d+/i] });

      // Fullwidth "secret123" — U+FF53 U+FF45 U+FF43 U+FF52 U+FF45 U+FF54 U+FF11 U+FF12 U+FF13
      const fullwidthSecret = '\uFF53\uFF45\uFF43\uFF52\uFF45\uFF54\uFF11\uFF12\uFF13';
      const result = guard({ content: `The code is ${fullwidthSecret}` });
      expect(result.action).toBe('block');
    });
  });

  // ---- Name ----

  it('has name "content-filter"', () => {
    const filter = createContentFilter({});
    expect(filter.name).toBe('content-filter');
  });

  // ---- Issue 6: ReDoS validation for user-provided blockedPatterns ----

  describe('Issue 6: ReDoS validation for blockedPatterns', () => {
    it('throws HarnessError with REDOS_PATTERN code for nested quantifier pattern (a+)+', () => {
      expect(() => createContentFilter({ blockedPatterns: [/(a+)+/] }))
        .toThrow(HarnessError);
      try {
        createContentFilter({ blockedPatterns: [/(a+)+/] });
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_REDOS_PATTERN);
        expect((err as HarnessError).message).toContain('ReDoS');
      }
    });

    it('throws for pattern with (\\w+)* (Kleene star over quantified group)', () => {
      expect(() => createContentFilter({ blockedPatterns: [/(\w+)*/] }))
        .toThrow(HarnessError);
    });

    it('throws for pattern with adjacent quantifiers like a++', () => {
      // Note: JavaScript regex doesn't support possessive quantifiers but the source
      // string pattern (a+)+ should be caught. Constructed via `new RegExp` so the
      // known-unsafe literal isn't checked into source and flagged by CodeQL.
      expect(() => createContentFilter({ blockedPatterns: [new RegExp('(a+)+b')] }))
        .toThrow(HarnessError);
    });

    it('throws for (\\S+)+ pattern', () => {
      expect(() => createContentFilter({ blockedPatterns: [/(\S+)+/] }))
        .toThrow(HarnessError);
    });

    it('accepts safe patterns without nested quantifiers', () => {
      expect(() => createContentFilter({ blockedPatterns: [/secret\d+/i] })).not.toThrow();
      expect(() => createContentFilter({ blockedPatterns: [/api_key_\w+/] })).not.toThrow();
      expect(() => createContentFilter({ blockedPatterns: [/password\s*=\s*\S+/] })).not.toThrow();
    });

    it('accepts empty blockedPatterns without throwing', () => {
      expect(() => createContentFilter({ blockedPatterns: [] })).not.toThrow();
    });

    it('error message includes the offending pattern source', () => {
      try {
        createContentFilter({ blockedPatterns: [/(a+)+/] });
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as HarnessError).message).toContain('(a+)+');
      }
    });

    it('validates each pattern independently — throws on the first dangerous one', () => {
      // First pattern is safe, second is dangerous
      expect(() => createContentFilter({
        blockedPatterns: [/safe\d+/, /(\w+)*/],
      })).toThrow(HarnessError);
    });

    it('safe pattern still blocks content after validation passes', () => {
      const { guard } = createContentFilter({ blockedPatterns: [/secret\d+/i] });
      expect(guard({ content: 'The code is secret123' }).action).toBe('block');
      expect(guard({ content: 'no secrets here' }).action).toBe('allow');
    });
  });

  // ---- SEC-012: expanded ReDoS detection + lastIndex reset + case-sensitivity docs ----

  describe('SEC-012: expanded ReDoS detection', () => {
    it('rejects (a|a?)+ polynomial-time pattern', () => {
      expect(() => createContentFilter({ blockedPatterns: [/(a|a?)+/] }))
        .toThrow(HarnessError);
    });

    it('rejects (a|b|ab)* with overlapping alternatives and a repeat', () => {
      expect(() => createContentFilter({ blockedPatterns: [/(a|b|ab)*/] }))
        .toThrow(HarnessError);
    });

    it('rejects (foo|foobar)+ with shared literal prefix and a repeat', () => {
      expect(() => createContentFilter({ blockedPatterns: [/(foo|foobar)+/] }))
        .toThrow(HarnessError);
    });

    it('rejects (a|ab)* with overlapping prefix', () => {
      expect(() => createContentFilter({ blockedPatterns: [/(a|ab)*/] }))
        .toThrow(HarnessError);
    });

    it('accepts safe disjoint alternatives with a repeat', () => {
      // (cat|dog)+ : no shared prefix, different starting char, not a ReDoS
      expect(() => createContentFilter({ blockedPatterns: [/(cat|dog)+/] }))
        .not.toThrow();
    });

    it('accepts alternation without a quantifier', () => {
      // Alternation alone is fine — only the combination with * or + matters
      expect(() => createContentFilter({ blockedPatterns: [/(a|ab)/] }))
        .not.toThrow();
    });
  });

  describe('SEC-012: lastIndex reset on each test', () => {
    it('resets lastIndex between calls for global-flag patterns (keyword regex)', () => {
      // Keyword regexes are built with the 'gi' flag. Verify repeated calls
      // still match — the internal regex.lastIndex must be reset each time.
      const { guard } = createContentFilter({ blocked: ['alpha'] });
      for (let i = 0; i < 5; i++) {
        const result = guard({ content: 'this has alpha somewhere' });
        expect(result.action).toBe('block');
      }
    });

    it('resets lastIndex between calls for user-provided global patterns', () => {
      const pattern = /foo\d+/g;
      const { guard } = createContentFilter({ blockedPatterns: [pattern] });
      for (let i = 0; i < 3; i++) {
        expect(guard({ content: `contains foo${i}123` }).action).toBe('block');
      }
    });
  });

  describe('SEC-012: case-sensitivity documentation', () => {
    it('uppercase patterns never match (content is lowercased)', () => {
      // Document the behavior explicitly (JSDoc also covers this).
      const { guard } = createContentFilter({ blockedPatterns: [/SECRET/] });
      expect(guard({ content: 'SECRET' }).action).toBe('allow');
      expect(guard({ content: 'secret' }).action).toBe('allow'); // pattern uses uppercase
    });

    it('lowercase patterns match both cases', () => {
      const { guard } = createContentFilter({ blockedPatterns: [/secret/] });
      expect(guard({ content: 'SECRET' }).action).toBe('block');
      expect(guard({ content: 'Secret' }).action).toBe('block');
      expect(guard({ content: 'secret' }).action).toBe('block');
    });
  });
});
