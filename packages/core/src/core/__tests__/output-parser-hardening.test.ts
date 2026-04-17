/**
 * Wave-13 Track D — output parser fix
 *
 *   D-12: regex literals that were previously recompiled per `parse()` call
 *         (CRLF normaliser, code-block matcher, unclosed-block probes) are
 *         now module-level constants. Behaviour must be byte-identical.
 */

import { describe, it, expect } from 'vitest';
import { createJsonOutputParser } from '../output-parser.js';

describe('createJsonOutputParser — Wave-13 D-12 behaviour preserved after regex hoisting', () => {
  it('parses a plain JSON string (no code block)', () => {
    const parser = createJsonOutputParser<{ name: string }>();
    expect(parser.parse('{"name":"Alice"}')).toEqual({ name: 'Alice' });
  });

  it('parses JSON inside a ```json ... ``` code block', () => {
    const parser = createJsonOutputParser<{ x: number }>();
    expect(parser.parse('```json\n{"x":1}\n```')).toEqual({ x: 1 });
  });

  it('parses JSON inside a bare ``` ... ``` code block (no language tag)', () => {
    const parser = createJsonOutputParser<{ x: number }>();
    expect(parser.parse('```\n{"x":2}\n```')).toEqual({ x: 2 });
  });

  it('throws CORE_PARSE_EMPTY_CODEBLOCK when the code block is empty', () => {
    const parser = createJsonOutputParser();
    expect(() => parser.parse('```json\n\n```')).toThrowError(/Empty code block/);
  });

  it('throws CORE_PARSE_UNCLOSED_CODEBLOCK for an unclosed code block', () => {
    const parser = createJsonOutputParser();
    expect(() => parser.parse('```json\n{"x":1}\n')).toThrowError(/Unclosed/);
  });

  it('normalises CRLF line endings so an empty \\r\\n-only block still throws empty', () => {
    const parser = createJsonOutputParser();
    expect(() => parser.parse('```json\r\n\r\n```')).toThrowError(/Empty code block/);
  });

  it('is callable many times in a row without regex state leaking (stateless match)', () => {
    const parser = createJsonOutputParser<{ n: number }>();
    for (let i = 0; i < 20; i++) {
      expect(parser.parse(`{"n":${i}}`)).toEqual({ n: i });
    }
  });

  it('parses 1000 times in under 500ms (smoke perf check — no pathological regex alloc)', () => {
    const parser = createJsonOutputParser<{ n: number }>();
    const started = Date.now();
    for (let i = 0; i < 1000; i++) {
      parser.parse('```json\n{"n":1}\n```');
    }
    // Very generous budget — just ensures we're not allocating regexes per call
    // in a way that trips up GC under load.
    expect(Date.now() - started).toBeLessThan(500);
  });
});
