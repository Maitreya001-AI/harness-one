/**
 * HTML / text sanitization helpers used by the web-fetch tool.
 *
 * Deliberately *not* a full HTML parser. We extract a title tag (when
 * present) and stripped body text, drop scripts / styles / comments, then
 * collapse whitespace. That's enough signal for the Specialist to summarize
 * without dragging in `cheerio` or `parse5`.
 */

const SCRIPT_OR_STYLE_OR_HEAD = /<\s*(script|style|head)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const TITLE_TAG = /<\s*title[^>]*>([\s\S]*?)<\s*\/\s*title\s*>/i;
const HTML_TAG = /<[^>]+>/g;
const ENTITY_PATTERNS: Array<[RegExp, string]> = [
  [/&nbsp;/gi, ' '],
  [/&amp;/gi, '&'],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#39;/gi, "'"],
  [/&apos;/gi, "'"],
];

export interface SanitizedDocument {
  /** Best-effort `<title>` content. Empty string when no title was present. */
  readonly title: string;
  /** Whitespace-collapsed plain text body. */
  readonly text: string;
}

/**
 * Strip an HTML document down to a title + plain-text body.
 *
 * `maxBytes` is enforced *after* sanitization so we don't double-count
 * markup. UTF-8 surrogate pairs at the boundary are tolerated (we slice the
 * UTF-16 string and let the lossy edge fall on the floor).
 */
export function sanitizeHtml(raw: string, maxBytes: number): SanitizedDocument {
  let titleMatch: string | undefined;
  const t = TITLE_TAG.exec(raw);
  if (t && t[1] !== undefined) titleMatch = t[1].trim();

  const stripped = raw
    .replace(HTML_COMMENT, ' ')
    .replace(SCRIPT_OR_STYLE_OR_HEAD, ' ')
    .replace(HTML_TAG, ' ');

  let decoded = stripped;
  for (const [pattern, replacement] of ENTITY_PATTERNS) {
    decoded = decoded.replace(pattern, replacement);
  }
  // Generic numeric entity decoder — catches &#1234; / &#x4d2;
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCharCode(parseInt(hex, 16)));
  decoded = decoded.replace(/&#(\d+);/g, (_, dec) => safeFromCharCode(parseInt(dec, 10)));

  // First collapse runs of whitespace, then drop the spurious space tag-strip
  // inserts immediately before sentence punctuation (`Hello world !` → `Hello world!`).
  const collapsed = decoded
    .replace(/\s+/g, ' ')
    .replace(/\s+([!?.,;:])/g, '$1')
    .trim();
  const truncated = truncateUtf8(collapsed, maxBytes);
  const titleText = (titleMatch ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);

  return { title: titleText, text: truncated };
}

/** Reject codepoints outside the BMP exclusion set; substitute U+FFFD. */
function safeFromCharCode(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '�';
  return String.fromCodePoint(cp);
}

/**
 * Truncate a string so its UTF-8 byte length is `<= maxBytes`. Cuts at the
 * nearest grapheme-cluster-ish boundary by trimming dangling surrogates.
 */
export function truncateUtf8(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = new TextEncoder().encode(input);
  if (buf.byteLength <= maxBytes) return input;
  let end = maxBytes;
  // Walk back over UTF-8 continuation bytes (10xxxxxx) — those can't start
  // a code point, so the last "real" boundary is past them.
  while (end > 0) {
    const tail = buf[end - 1];
    if (tail === undefined || (tail & 0xc0) !== 0x80) break;
    end -= 1;
  }
  // Inspect the byte we just landed on. ASCII (<0x80) → boundary already clean.
  // Otherwise it's a lead byte; check whether the full sequence fits.
  if (end > 0) {
    const lead = buf[end - 1];
    if (lead !== undefined && lead >= 0x80) {
      const expected =
        (lead & 0xe0) === 0xc0 ? 2 :
        (lead & 0xf0) === 0xe0 ? 3 :
        (lead & 0xf8) === 0xf0 ? 4 :
        1; // shouldn't happen for valid UTF-8 input
      const seqStart = end - 1;
      const have = maxBytes - seqStart;
      // Include the full sequence if every continuation byte is present;
      // otherwise drop the incomplete lead.
      end = have >= expected ? seqStart + expected : seqStart;
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, end));
}
