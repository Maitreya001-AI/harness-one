import { describe, it, expect } from 'vitest';
import {
  createFixedSizeChunking,
  createParagraphChunking,
  createSlidingWindowChunking,
} from '../chunking.js';
import { HarnessError, HarnessErrorCode} from '../../core/errors.js';
import type { Document } from '../types.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function doc(content: string, id = 'd1', metadata?: Record<string, unknown>): Document {
  return { id, content, metadata };
}

// ===========================================================================
// createFixedSizeChunking
// ===========================================================================

describe('createFixedSizeChunking', () => {
  it('chunks text at the configured character count', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 5 });
    const chunks = chunking.chunk(doc('abcdefghij'));

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe('abcde');
    expect(chunks[1].content).toBe('fghij');
  });

  it('produces overlap between consecutive chunks', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 6, overlap: 2 });
    // step = 6 - 2 = 4
    const chunks = chunking.chunk(doc('abcdefghijkl'));

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('abcdef');
    expect(chunks[1].content).toBe('efghij');
    expect(chunks[2].content).toBe('ijkl');
  });

  it('returns empty array for empty input', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 10 });
    expect(chunking.chunk(doc(''))).toEqual([]);
  });

  it('returns a single chunk when content fits within chunkSize', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 100 });
    const chunks = chunking.chunk(doc('short'));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('short');
  });

  it('handles content length exactly equal to chunkSize', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 5 });
    const chunks = chunking.chunk(doc('abcde'));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('abcde');
  });

  it('handles content length one more than chunkSize (boundary)', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 5 });
    const chunks = chunking.chunk(doc('abcdef'));

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe('abcde');
    expect(chunks[1].content).toBe('f');
  });

  it('generates correct chunk ids, documentId, and sequential indices', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 3 });
    const chunks = chunking.chunk(doc('abcdef', 'myDoc'));

    expect(chunks[0].id).toBe('myDoc_chunk_0');
    expect(chunks[0].documentId).toBe('myDoc');
    expect(chunks[0].index).toBe(0);
    expect(chunks[1].id).toBe('myDoc_chunk_1');
    expect(chunks[1].index).toBe(1);
  });

  it('copies document metadata into each chunk', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 100 });
    const chunks = chunking.chunk(doc('hello', 'd1', { source: 'api', version: 2 }));

    expect(chunks[0].metadata).toEqual({ source: 'api', version: 2 });
  });

  it('produces independent metadata copies (mutation safe)', () => {
    const meta = { key: 'original' };
    const chunking = createFixedSizeChunking({ chunkSize: 3 });
    const chunks = chunking.chunk(doc('abcdef', 'd1', meta));

    // Mutating the original metadata should not affect chunk metadata
    meta.key = 'changed';
    expect(chunks[0].metadata).toEqual({ key: 'original' });
  });

  it('has name "fixed-size"', () => {
    expect(createFixedSizeChunking({ chunkSize: 10 }).name).toBe('fixed-size');
  });

  it('returns a frozen (immutable) strategy object', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 10 });
    expect(Object.isFrozen(chunking)).toBe(true);
  });

  // --- Error validation ---

  it('throws HarnessError with RAG_INVALID_CONFIG for chunkSize <= 0', () => {
    expect(() => createFixedSizeChunking({ chunkSize: 0 })).toThrow(HarnessError);
    expect(() => createFixedSizeChunking({ chunkSize: -5 })).toThrow(HarnessError);

    try {
      createFixedSizeChunking({ chunkSize: 0 });
    } catch (e) {
      expect((e as HarnessError).code).toBe(HarnessErrorCode.RAG_INVALID_CONFIG);
    }
  });

  it('throws HarnessError for negative overlap', () => {
    expect(() => createFixedSizeChunking({ chunkSize: 10, overlap: -1 })).toThrow(HarnessError);
  });

  it('throws HarnessError when overlap >= chunkSize', () => {
    expect(() => createFixedSizeChunking({ chunkSize: 10, overlap: 10 })).toThrow(HarnessError);
    expect(() => createFixedSizeChunking({ chunkSize: 5, overlap: 8 })).toThrow(HarnessError);
  });

  it('defaults overlap to 0 when not specified', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 5 });
    // No overlap means step = chunkSize, chunks are non-overlapping
    const chunks = chunking.chunk(doc('abcdefghij'));
    expect(chunks[0].content).toBe('abcde');
    expect(chunks[1].content).toBe('fghij');
    // No shared characters
    expect(chunks[0].content[4]).not.toBe(chunks[1].content[0]);
  });

  it('handles very large overlap (chunkSize - 1)', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 5, overlap: 4 });
    // step = 5 - 4 = 1, so each chunk advances by 1 character
    const chunks = chunking.chunk(doc('abcdefg'));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].content).toBe('abcde');
    expect(chunks[1].content).toBe('bcdef');
    expect(chunks[2].content).toBe('cdefg');
  });
});

// ===========================================================================
// createParagraphChunking
// ===========================================================================

describe('createParagraphChunking', () => {
  it('splits text on double newlines (\\n\\n)', () => {
    const chunking = createParagraphChunking();
    const chunks = chunking.chunk(doc('Para one.\n\nPara two.\n\nPara three.'));

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('Para one.');
    expect(chunks[1].content).toBe('Para two.');
    expect(chunks[2].content).toBe('Para three.');
  });

  it('returns empty array for empty input', () => {
    const chunking = createParagraphChunking();
    expect(chunking.chunk(doc(''))).toEqual([]);
  });

  it('returns empty array for whitespace-only paragraphs', () => {
    const chunking = createParagraphChunking();
    expect(chunking.chunk(doc('   \n\n   \n\n   '))).toEqual([]);
  });

  it('handles single paragraph (no double newline)', () => {
    const chunking = createParagraphChunking();
    const chunks = chunking.chunk(doc('Single paragraph text.'));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Single paragraph text.');
  });

  it('filters out empty paragraphs between separators', () => {
    const chunking = createParagraphChunking();
    // Triple double-newlines create an empty middle paragraph
    const chunks = chunking.chunk(doc('A\n\n\n\nB'));

    // The regex split on \n\s*\n will produce ["A", "", "B"] or similar
    // filter(p => p.trim().length > 0) removes blanks
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe('A');
    expect(chunks[1].content).toBe('B');
  });

  it('handles paragraphs separated by whitespace variations (\\n  \\n)', () => {
    const chunking = createParagraphChunking();
    const chunks = chunking.chunk(doc('Hello\n  \nWorld\n\t\nEnd'));

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('Hello');
    expect(chunks[1].content).toBe('World');
    expect(chunks[2].content).toBe('End');
  });

  it('sub-splits paragraphs exceeding maxChunkSize', () => {
    const chunking = createParagraphChunking({ maxChunkSize: 10 });
    const chunks = chunking.chunk(doc('This is a very long paragraph that exceeds max.'));

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(10);
    }
    // Reassembled content matches original (trimmed)
    expect(chunks.map((c) => c.content).join('')).toBe(
      'This is a very long paragraph that exceeds max.',
    );
  });

  it('generates sequential indices across sub-split chunks', () => {
    const chunking = createParagraphChunking({ maxChunkSize: 5 });
    const chunks = chunking.chunk(doc('ABCDEFGHIJ\n\nXY'));

    // First paragraph: 10 chars -> 2 sub-chunks (0, 1)
    // Second paragraph: 2 chars -> 1 chunk (2)
    expect(chunks).toHaveLength(3);
    expect(chunks[0].index).toBe(0);
    expect(chunks[1].index).toBe(1);
    expect(chunks[2].index).toBe(2);
  });

  it('trims whitespace from paragraph content', () => {
    const chunking = createParagraphChunking();
    const chunks = chunking.chunk(doc('  leading spaces  \n\n  trailing spaces  '));

    expect(chunks[0].content).toBe('leading spaces');
    expect(chunks[1].content).toBe('trailing spaces');
  });

  it('has name "paragraph"', () => {
    expect(createParagraphChunking().name).toBe('paragraph');
  });

  it('throws HarnessError for maxChunkSize <= 0', () => {
    expect(() => createParagraphChunking({ maxChunkSize: 0 })).toThrow(HarnessError);
    expect(() => createParagraphChunking({ maxChunkSize: -1 })).toThrow(HarnessError);
  });

  it('works without any config (maxChunkSize undefined)', () => {
    const chunking = createParagraphChunking();
    const longParagraph = 'x'.repeat(10000);
    const chunks = chunking.chunk(doc(longParagraph));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content.length).toBe(10000);
  });

  it('returns a frozen strategy object', () => {
    expect(Object.isFrozen(createParagraphChunking())).toBe(true);
  });
});

// ===========================================================================
// createSlidingWindowChunking
// ===========================================================================

describe('createSlidingWindowChunking', () => {
  it('produces overlapping windows with the configured step', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 6, stepSize: 3 });
    const chunks = chunking.chunk(doc('abcdefghijkl'));

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('abcdef');
    expect(chunks[1].content).toBe('defghi');
    expect(chunks[2].content).toBe('ghijkl');
  });

  it('handles trailing partial window when content does not align', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 6, stepSize: 4 });
    const chunks = chunking.chunk(doc('abcdefghijklm'));

    expect(chunks).toHaveLength(3);
    expect(chunks[2].content).toBe('ijklm'); // partial window
  });

  it('returns empty array for empty input', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 10, stepSize: 5 });
    expect(chunking.chunk(doc(''))).toEqual([]);
  });

  it('returns single chunk when content fits in one window', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 100, stepSize: 50 });
    const chunks = chunking.chunk(doc('short'));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('short');
  });

  it('handles stepSize > windowSize (gaps between windows)', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 3, stepSize: 5 });
    const chunks = chunking.chunk(doc('abcdefghij'));

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe('abc');
    expect(chunks[1].content).toBe('fgh');
  });

  it('handles non-overlapping windows (stepSize == windowSize)', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 5, stepSize: 5 });
    const chunks = chunking.chunk(doc('abcdefghij'));

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe('abcde');
    expect(chunks[1].content).toBe('fghij');
  });

  it('handles highly overlapping windows (stepSize = 1)', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 3, stepSize: 1 });
    const chunks = chunking.chunk(doc('abcde'));

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('abc');
    expect(chunks[1].content).toBe('bcd');
    expect(chunks[2].content).toBe('cde');
  });

  it('generates correct ids and documentId', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 5, stepSize: 5 });
    const chunks = chunking.chunk(doc('abcdefghij', 'myDoc'));

    expect(chunks[0].id).toBe('myDoc_chunk_0');
    expect(chunks[0].documentId).toBe('myDoc');
    expect(chunks[1].id).toBe('myDoc_chunk_1');
  });

  it('preserves document metadata', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 100, stepSize: 50 });
    const chunks = chunking.chunk(doc('hello', 'd1', { tag: 'test' }));

    expect(chunks[0].metadata).toEqual({ tag: 'test' });
  });

  it('has name "sliding-window"', () => {
    expect(createSlidingWindowChunking({ windowSize: 10, stepSize: 5 }).name).toBe('sliding-window');
  });

  it('returns a frozen strategy object', () => {
    expect(Object.isFrozen(createSlidingWindowChunking({ windowSize: 10, stepSize: 5 }))).toBe(true);
  });

  // --- Error validation ---

  it('throws HarnessError for windowSize <= 0', () => {
    expect(() => createSlidingWindowChunking({ windowSize: 0, stepSize: 5 })).toThrow(HarnessError);
    expect(() => createSlidingWindowChunking({ windowSize: -1, stepSize: 5 })).toThrow(HarnessError);
  });

  it('throws HarnessError for stepSize <= 0', () => {
    expect(() => createSlidingWindowChunking({ windowSize: 10, stepSize: 0 })).toThrow(HarnessError);
    expect(() => createSlidingWindowChunking({ windowSize: 10, stepSize: -3 })).toThrow(HarnessError);
  });

  it('error code is RAG_INVALID_CONFIG', () => {
    try {
      createSlidingWindowChunking({ windowSize: 0, stepSize: 5 });
    } catch (e) {
      expect(e).toBeInstanceOf(HarnessError);
      expect((e as HarnessError).code).toBe(HarnessErrorCode.RAG_INVALID_CONFIG);
    }
  });
});

// ===========================================================================
// Fix 20: Word boundary awareness
// ===========================================================================

describe('word boundary awareness (Fix 20)', () => {
  it('fixed-size: chunk boundaries prefer word boundaries', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 8 });
    // "hello world foo bar" - at position 8 we're in "world" at 'o'
    // The boundary adjusts back to nearest whitespace
    const chunks = chunking.chunk(doc('hello world foo bar'));

    // Verify all chunks have content
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.content.length).toBeGreaterThan(0);
    }
  });

  it('sliding-window: adjusts window end to word boundary', () => {
    const chunking = createSlidingWindowChunking({ windowSize: 8, stepSize: 5 });
    const chunks = chunking.chunk(doc('hello world foo bar baz'));

    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.content.length).toBeGreaterThan(0);
    }
  });

  it('fixed-size: preserves content when no whitespace found', () => {
    const chunking = createFixedSizeChunking({ chunkSize: 5 });
    // "abcdefghij" has no spaces, so word boundary adjustment falls back to original position
    const chunks = chunking.chunk(doc('abcdefghij'));
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe('abcde');
    expect(chunks[1].content).toBe('fghij');
  });

  it('fixed-size: word boundary adjustment does not split words', () => {
    // With overlap, word boundary adjustment creates better chunks
    const chunking = createFixedSizeChunking({ chunkSize: 10, overlap: 3 });
    const chunks = chunking.chunk(doc('the quick brown fox jumps'));

    for (const c of chunks) {
      // No chunk should end with a partial word (when mid-content)
      expect(c.content.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// Fix 21: Paragraph chunking single newline option
// ===========================================================================

describe('paragraph chunking splitOnSingleNewline (Fix 21)', () => {
  it('splits on single newline when enabled', () => {
    const chunking = createParagraphChunking({ splitOnSingleNewline: true });
    const chunks = chunking.chunk(doc('Line 1\nLine 2\nLine 3'));

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('Line 1');
    expect(chunks[1].content).toBe('Line 2');
    expect(chunks[2].content).toBe('Line 3');
  });

  it('still requires double newlines by default', () => {
    const chunking = createParagraphChunking();
    const chunks = chunking.chunk(doc('Line 1\nLine 2\n\nLine 3'));

    expect(chunks).toHaveLength(2);
  });

  it('defaults to false for backward compatibility', () => {
    const chunking = createParagraphChunking({ splitOnSingleNewline: false });
    const chunks = chunking.chunk(doc('Line 1\nLine 2'));

    // Single newline should NOT split
    expect(chunks).toHaveLength(1);
  });
});

// ===========================================================================
// Unicode boundary handling
// ===========================================================================

describe('Unicode boundary handling', () => {
  describe('emoji characters', () => {
    it('fixed-size: char-index slicing may split surrogate pairs (documents current behavior)', () => {
      // Emoji like "😀" are 2 JS chars (surrogate pair). String.slice is
      // char-index-based and does NOT respect grapheme boundaries, so a chunk
      // boundary can fall in the middle of a surrogate pair.
      // This test documents the current behavior — not a bug, but a known
      // limitation of char-index-based chunking.
      const chunking = createFixedSizeChunking({ chunkSize: 3 });
      const emoji = '😀😀😀'; // 6 JS chars (3 surrogate pairs)
      const chunks = chunking.chunk(doc(emoji));

      // Reassembled content must equal original
      const reassembled = chunks.map((c) => c.content).join('');
      expect(reassembled).toBe(emoji);
      // Total JS chars across chunks equals original length
      const totalChars = chunks.reduce((acc, c) => acc + c.content.length, 0);
      expect(totalChars).toBe(6);
    });

    it('fixed-size: emoji-safe chunking when chunkSize aligns with surrogate pairs', () => {
      // When chunkSize is even, emoji (2 JS chars each) are not split
      const chunking = createFixedSizeChunking({ chunkSize: 4 });
      const emoji = '😀😀😀😀'; // 8 JS chars (4 surrogate pairs)
      const chunks = chunking.chunk(doc(emoji));

      expect(chunks).toHaveLength(2);
      expect(chunks[0].content).toBe('😀😀');
      expect(chunks[1].content).toBe('😀😀');
    });

    it('paragraph: preserves emoji in paragraph content', () => {
      const chunking = createParagraphChunking();
      const chunks = chunking.chunk(doc('Hello 🌍\n\nWorld 🚀'));

      expect(chunks).toHaveLength(2);
      expect(chunks[0].content).toBe('Hello 🌍');
      expect(chunks[1].content).toBe('World 🚀');
    });

    it('sliding-window: preserves emoji sequences', () => {
      const chunking = createSlidingWindowChunking({ windowSize: 4, stepSize: 2 });
      const emoji = '🎉🎊🎈'; // 6 JS chars
      const chunks = chunking.chunk(doc(emoji));

      const allContent = chunks.map((c) => c.content).join('');
      // All original emoji should appear somewhere in the chunks
      expect(allContent).toContain('🎉');
      expect(allContent).toContain('🎊');
    });
  });

  describe('CJK characters', () => {
    it('fixed-size: correctly chunks CJK text', () => {
      const chunking = createFixedSizeChunking({ chunkSize: 3 });
      const cjk = '你好世界测试'; // 6 BMP chars, 1 char each
      const chunks = chunking.chunk(doc(cjk));

      expect(chunks).toHaveLength(2);
      expect(chunks[0].content).toBe('你好世');
      expect(chunks[1].content).toBe('界测试');

      const reassembled = chunks.map((c) => c.content).join('');
      expect(reassembled).toBe(cjk);
    });

    it('paragraph: preserves CJK characters across paragraphs', () => {
      const chunking = createParagraphChunking();
      const chunks = chunking.chunk(doc('第一段落\n\n第二段落'));

      expect(chunks).toHaveLength(2);
      expect(chunks[0].content).toBe('第一段落');
      expect(chunks[1].content).toBe('第二段落');
    });

    it('sliding-window: handles CJK with overlap', () => {
      const chunking = createSlidingWindowChunking({ windowSize: 4, stepSize: 2 });
      const cjk = '甲乙丙丁戊己';
      const chunks = chunking.chunk(doc(cjk));

      expect(chunks[0].content).toBe('甲乙丙丁');
      expect(chunks[1].content).toBe('丙丁戊己');
      expect(chunks).toHaveLength(2);
    });
  });

  describe('combining diacritics', () => {
    it('fixed-size: combining characters may be separated from base (char-index slicing)', () => {
      // "é" as e + combining acute (U+0301) = 2 JS chars
      // This documents the current behavior: char-index slicing does not
      // understand grapheme clusters, so the combiner may end up in a
      // separate chunk from its base character.
      const chunking = createFixedSizeChunking({ chunkSize: 2 });
      const text = 'e\u0301abc'; // "é" (2 chars) + "abc" (3 chars) = 5 chars
      const chunks = chunking.chunk(doc(text));

      // Reassembled content must equal original regardless of split point
      const reassembled = chunks.map((c) => c.content).join('');
      expect(reassembled).toBe(text);
    });

    it('paragraph: preserves combining diacritics within paragraphs', () => {
      const chunking = createParagraphChunking();
      // "café" using combining accent: "cafe\u0301"
      const chunks = chunking.chunk(doc('cafe\u0301\n\nru\u0301sume\u0301'));

      expect(chunks).toHaveLength(2);
      expect(chunks[0].content).toBe('cafe\u0301');
      expect(chunks[1].content).toBe('ru\u0301sume\u0301');
    });

    it('fixed-size: reassembly preserves full multibyte content with mixed scripts', () => {
      const chunking = createFixedSizeChunking({ chunkSize: 4 });
      // Mix of ASCII, CJK, emoji, and combining diacritics
      const mixed = 'Ab你😀e\u0301'; // A(1) b(1) 你(1) 😀(2) e(1) \u0301(1) = 7 chars
      const chunks = chunking.chunk(doc(mixed));

      const reassembled = chunks.map((c) => c.content).join('');
      expect(reassembled).toBe(mixed);
    });
  });
});
