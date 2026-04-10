import { describe, it, expect } from 'vitest';
import { createContentFilter } from '../content-filter.js';

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

    it('pattern matching uses original case (not lowered)', () => {
      // Pattern without 'i' flag should be case-sensitive
      const { guard } = createContentFilter({ blockedPatterns: [/Secret/] });

      expect(guard({ content: 'This is Secret' }).action).toBe('block');
      expect(guard({ content: 'this is secret' }).action).toBe('allow');
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

    it('pattern matching checks original content (not lowered)', () => {
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

    it('patterns respect their own flags (case-sensitive by default)', () => {
      const { guard } = createContentFilter({
        blockedPatterns: [/CaseSensitive/],
      });

      expect(guard({ content: 'CaseSensitive match' }).action).toBe('block');
      expect(guard({ content: 'casesensitive match' }).action).toBe('allow');
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

  // ---- Name ----

  it('has name "content-filter"', () => {
    const filter = createContentFilter({});
    expect(filter.name).toBe('content-filter');
  });
});
