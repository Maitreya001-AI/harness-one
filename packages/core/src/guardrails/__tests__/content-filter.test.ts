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

    it('blocks on partial match within a word', () => {
      const { guard } = createContentFilter({ blocked: ['bad'] });
      // "bad" appears within "badge"
      expect(guard({ content: 'My badge is here' }).action).toBe('block');
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
      // Keywords are matched with .includes(), not regex
      const { guard } = createContentFilter({ blocked: ['$money'] });
      expect(guard({ content: 'I have $money' }).action).toBe('block');
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

  // ---- Name ----

  it('has name "content-filter"', () => {
    const filter = createContentFilter({});
    expect(filter.name).toBe('content-filter');
  });
});
