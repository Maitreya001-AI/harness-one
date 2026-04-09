import { describe, it, expect, vi } from 'vitest';
import { createJsonOutputParser, parseWithRetry } from '../output-parser.js';
import type { OutputParser } from '../output-parser.js';
import type { JsonSchema } from '../types.js';
import { HarnessError } from '../errors.js';

describe('createJsonOutputParser', () => {
  describe('parse', () => {
    it('parses raw JSON string', () => {
      const parser = createJsonOutputParser();
      const result = parser.parse('{"name":"Alice","age":30}');
      expect(result).toEqual({ name: 'Alice', age: 30 });
    });

    it('extracts JSON from markdown code block with json tag', () => {
      const parser = createJsonOutputParser();
      const input = 'Here is the result:\n```json\n{"status":"ok"}\n```\nDone.';
      expect(parser.parse(input)).toEqual({ status: 'ok' });
    });

    it('extracts JSON from markdown code block without json tag', () => {
      const parser = createJsonOutputParser();
      const input = '```\n{"key":"value"}\n```';
      expect(parser.parse(input)).toEqual({ key: 'value' });
    });

    it('parses JSON arrays', () => {
      const parser = createJsonOutputParser();
      expect(parser.parse('[1,2,3]')).toEqual([1, 2, 3]);
    });

    it('handles whitespace around JSON', () => {
      const parser = createJsonOutputParser();
      expect(parser.parse('  \n  {"a":1}  \n  ')).toEqual({ a: 1 });
    });

    it('throws on invalid JSON', () => {
      const parser = createJsonOutputParser();
      expect(() => parser.parse('not json at all')).toThrow();
    });

    it('throws HarnessError on empty string with descriptive message', () => {
      const parser = createJsonOutputParser();
      expect(() => parser.parse('')).toThrow(HarnessError);
      expect(() => parser.parse('')).toThrow('Cannot parse empty string as JSON');
    });

    it('throws HarnessError on whitespace-only string', () => {
      const parser = createJsonOutputParser();
      expect(() => parser.parse('   \n\t  ')).toThrow(HarnessError);
      expect(() => parser.parse('   \n\t  ')).toThrow('Cannot parse empty string as JSON');
    });

    it('parses nested objects', () => {
      const parser = createJsonOutputParser<{ outer: { inner: number } }>();
      const result = parser.parse('{"outer":{"inner":42}}');
      expect(result.outer.inner).toBe(42);
    });

    it('extracts first code block when multiple are present', () => {
      const parser = createJsonOutputParser();
      const input = '```json\n{"first":true}\n```\nsome text\n```json\n{"second":true}\n```';
      expect(parser.parse(input)).toEqual({ first: true });
    });

    it('throws HarnessError on unclosed code block', () => {
      const parser = createJsonOutputParser();
      const input = '```json\n{"incomplete": true';
      expect(() => parser.parse(input)).toThrow(HarnessError);
      expect(() => parser.parse(input)).toThrow('Unclosed markdown code block');
    });

    it('throws HarnessError on empty code block', () => {
      const parser = createJsonOutputParser();
      const input = '```json\n```';
      expect(() => parser.parse(input)).toThrow(HarnessError);
      expect(() => parser.parse(input)).toThrow('Empty code block contains no JSON');
    });

    it('throws HarnessError on code block with only whitespace', () => {
      const parser = createJsonOutputParser();
      const input = '```json\n   \n```';
      expect(() => parser.parse(input)).toThrow(HarnessError);
      expect(() => parser.parse(input)).toThrow('Empty code block contains no JSON');
    });

    it('throws HarnessError on empty code block without json tag', () => {
      const parser = createJsonOutputParser();
      const input = '```\n```';
      expect(() => parser.parse(input)).toThrow(HarnessError);
      expect(() => parser.parse(input)).toThrow('Empty code block contains no JSON');
    });
  });

  describe('getFormatInstructions', () => {
    it('returns generic instruction without schema', () => {
      const parser = createJsonOutputParser();
      expect(parser.getFormatInstructions()).toBe('Respond with valid JSON.');
    });

    it('returns schema-specific instruction with schema', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      };
      const parser = createJsonOutputParser(schema);
      const instructions = parser.getFormatInstructions();
      expect(instructions).toContain('JSON object matching this schema');
      expect(instructions).toContain('"name"');
    });
  });
});

describe('parseWithRetry', () => {
  it('succeeds on first attempt with valid input', async () => {
    const parser = createJsonOutputParser<{ x: number }>();
    const regenerate = vi.fn();
    const { result, attempts } = await parseWithRetry(parser, '{"x":1}', regenerate);
    expect(result).toEqual({ x: 1 });
    expect(attempts).toBe(1);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('retries and succeeds on second attempt', async () => {
    const parser = createJsonOutputParser<{ x: number }>();
    const regenerate = vi.fn().mockResolvedValue('{"x":2}');
    const { result, attempts } = await parseWithRetry(parser, 'bad json', regenerate);
    expect(result).toEqual({ x: 2 });
    expect(attempts).toBe(2);
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerate.mock.calls[0][0]).toContain('Parse failed');
  });

  it('retries and succeeds on third attempt', async () => {
    const parser = createJsonOutputParser();
    const regenerate = vi.fn()
      .mockResolvedValueOnce('still bad')
      .mockResolvedValueOnce('{"ok":true}');
    const { result, attempts } = await parseWithRetry(parser, 'bad', regenerate);
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(3);
    expect(regenerate).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all retries', async () => {
    const parser = createJsonOutputParser();
    const regenerate = vi.fn().mockResolvedValue('still bad');
    await expect(parseWithRetry(parser, 'bad', regenerate, 3)).rejects.toThrow();
    expect(regenerate).toHaveBeenCalledTimes(2);
  });

  it('respects custom maxRetries', async () => {
    const parser = createJsonOutputParser();
    const regenerate = vi.fn().mockResolvedValue('bad');
    await expect(parseWithRetry(parser, 'bad', regenerate, 1)).rejects.toThrow();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('passes format instructions in feedback', async () => {
    const schema: JsonSchema = { type: 'object', properties: { name: { type: 'string' } } };
    const parser = createJsonOutputParser(schema);
    const regenerate = vi.fn().mockResolvedValue('{"name":"Alice"}');
    await parseWithRetry(parser, 'bad', regenerate);
    expect(regenerate.mock.calls[0][0]).toContain('JSON object matching this schema');
  });

  it('defaults maxRetries to 3', async () => {
    const parser = createJsonOutputParser();
    const regenerate = vi.fn()
      .mockResolvedValueOnce('bad1')
      .mockResolvedValueOnce('{"done":true}');
    const { attempts } = await parseWithRetry(parser, 'bad', regenerate);
    expect(attempts).toBe(3);
  });

  it('works with a custom OutputParser', async () => {
    const custom: OutputParser<number> = {
      parse(text: string): number {
        const n = Number(text.trim());
        if (Number.isNaN(n)) throw new Error('Not a number');
        return n;
      },
      getFormatInstructions() {
        return 'Respond with a single number.';
      },
    };
    const regenerate = vi.fn().mockResolvedValue('42');
    const { result, attempts } = await parseWithRetry(custom, 'abc', regenerate);
    expect(result).toBe(42);
    expect(attempts).toBe(2);
    expect(regenerate.mock.calls[0][0]).toContain('Respond with a single number');
  });
});
