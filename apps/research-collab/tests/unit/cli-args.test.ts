import { describe, expect, it } from 'vitest';

import { CliArgError, parseArgs, printHelp } from '../../src/cli/args.js';
import { findBenchmarkQuery } from '../../src/config/benchmark-queries.js';

describe('parseArgs', () => {
  it('accepts a positional question', () => {
    const out = parseArgs(['What', 'is', 'X?']);
    expect(out.question).toBe('What is X?');
    expect(out.skipMarkdown).toBe(false);
    expect(out.noReport).toBe(false);
  });

  it('accepts --question over positional when both supplied', () => {
    const out = parseArgs(['--question', 'A?', 'leftover']);
    expect(out.question).toBe('A?');
  });

  it('parses --benchmark and resolves the question from the corpus', () => {
    const slug = 'langgraph-vs-mastra';
    const out = parseArgs(['--benchmark', slug]);
    expect(out.benchmarkSlug).toBe(slug);
    expect(out.question).toBe(findBenchmarkQuery(slug)?.question);
  });

  it('parses flags', () => {
    const out = parseArgs(['q', '--no-report', '--no-markdown', '--print', '--reports-root', '/tmp/r']);
    expect(out.noReport).toBe(true);
    expect(out.skipMarkdown).toBe(true);
    expect(out.print).toBe(true);
    expect(out.reportsRoot).toBe('/tmp/r');
  });

  it('throws on unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown flag/);
  });

  it('throws when no question supplied', () => {
    expect(() => parseArgs([])).toThrow(/required/);
  });

  it('throws when --question lacks a value', () => {
    expect(() => parseArgs(['--question'])).toThrow(/Missing value/);
  });

  it('throws on unknown benchmark slug', () => {
    expect(() => parseArgs(['--benchmark', 'nope'])).toThrow(/Unknown benchmark/);
  });

  it('throws when --benchmark lacks a value', () => {
    expect(() => parseArgs(['--benchmark'])).toThrow(/Missing value/);
  });

  it('throws when --reports-root lacks a value', () => {
    expect(() => parseArgs(['q', '--reports-root'])).toThrow(/Missing value/);
  });

  it('throws CliArgError(__help__) on --help', () => {
    expect(() => parseArgs(['--help'])).toThrow(CliArgError);
    try {
      parseArgs(['-h']);
    } catch (e) {
      expect((e as CliArgError).message).toBe('__help__');
    }
  });

  it('printHelp writes to the supplied sink', () => {
    const calls: string[] = [];
    printHelp((s) => calls.push(s));
    expect(calls.join('')).toContain('Usage: harness-research');
  });

  it('default printHelp delegates to process.stdout.write when no sink given', () => {
    // process.stdout.write is non-configurable in some node versions, so
    // we patch the property instead of using vi.spyOn.
    const original = process.stdout.write;
    let called = false;
    Object.defineProperty(process.stdout, 'write', {
      configurable: true,
      writable: true,
      value: ((s: string | Uint8Array) => {
        called = true;
        void s;
        return true;
      }) as typeof process.stdout.write,
    });
    try {
      printHelp();
    } finally {
      Object.defineProperty(process.stdout, 'write', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
    expect(called).toBe(true);
  });

  it('uses positional words when --question omitted with --benchmark', () => {
    const out = parseArgs(['some', 'positional', '--benchmark', 'langgraph-vs-mastra']);
    expect(out.benchmarkSlug).toBe('langgraph-vs-mastra');
    expect(out.question).toBe('some positional');
  });
});
