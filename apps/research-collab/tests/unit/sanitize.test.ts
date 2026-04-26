import { describe, expect, it } from 'vitest';

import { sanitizeHtml, truncateUtf8 } from '../../src/tools/sanitize.js';

describe('sanitizeHtml', () => {
  it('extracts the title and strips tags', () => {
    const html = '<html><head><title>  My Page  </title></head><body><p>Hello <b>world</b>!</p></body></html>';
    const { title, text } = sanitizeHtml(html, 1024);
    expect(title).toBe('My Page');
    expect(text).toBe('Hello world!');
  });

  it('removes scripts, styles, and comments', () => {
    const html = `
      <html>
        <head><style>body { color: red; }</style><title>T</title></head>
        <body><script>alert('x')</script><!-- secret --><p>Content</p></body>
      </html>
    `;
    const { title, text } = sanitizeHtml(html, 1024);
    expect(title).toBe('T');
    expect(text).toBe('Content');
  });

  it('decodes common HTML entities', () => {
    const html = '<p>5&nbsp;&lt; 10 &amp;&gt; foo &quot;bar&quot; &#39;baz&#39;</p>';
    const { text } = sanitizeHtml(html, 1024);
    expect(text).toBe('5 < 10 &> foo "bar" \'baz\'');
  });

  it('decodes numeric entities including hex', () => {
    const html = '<p>&#65;&#x42;&#67;</p>';
    const { text } = sanitizeHtml(html, 1024);
    expect(text).toBe('ABC');
  });

  it('returns empty title when no <title> tag is present', () => {
    const { title } = sanitizeHtml('<p>x</p>', 1024);
    expect(title).toBe('');
  });

  it('caps the body to maxBytes', () => {
    const big = '<p>' + 'a'.repeat(2_000) + '</p>';
    const { text } = sanitizeHtml(big, 100);
    expect(text.length).toBeLessThanOrEqual(100);
  });

  it('replaces invalid numeric entities with U+FFFD', () => {
    const html = '<p>&#999999999;</p>';
    const { text } = sanitizeHtml(html, 1024);
    expect(text).toBe('�');
  });
});

describe('truncateUtf8', () => {
  it('returns the original string when shorter than maxBytes', () => {
    expect(truncateUtf8('hello', 100)).toBe('hello');
  });

  it('returns empty string when maxBytes <= 0', () => {
    expect(truncateUtf8('hello', 0)).toBe('');
    expect(truncateUtf8('hello', -1)).toBe('');
  });

  it('cuts cleanly on multi-byte boundaries', () => {
    const s = '日本語'; // 3 chars × 3 bytes = 9 bytes
    const cut = truncateUtf8(s, 4);
    // Should NOT contain a partial multi-byte sequence
    expect(new TextEncoder().encode(cut).byteLength).toBeLessThanOrEqual(4);
    expect(cut).toBe('日');
  });

  it('truncates ASCII at the byte boundary', () => {
    expect(truncateUtf8('abcdef', 3)).toBe('abc');
  });
});
