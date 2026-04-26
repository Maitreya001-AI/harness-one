import { describe, expect, it } from 'vitest';
import { HarnessError } from 'harness-one/core';

import { parseArgs, parseDuration } from '../../src/cli/args.js';

describe('parseArgs', () => {
  it('returns empty prompt with all-false flags by default', () => {
    const r = parseArgs([]);
    expect(r.prompt).toBe('');
    expect(r.help).toBe(false);
    expect(r.dryRun).toBe(false);
  });

  it('parses --help / -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('parses --version / -v', () => {
    expect(parseArgs(['--version']).version).toBe(true);
    expect(parseArgs(['-v']).version).toBe(true);
  });

  it('joins positional tokens into prompt', () => {
    expect(parseArgs(['fix', 'parse.ts', 'now']).prompt).toBe('fix parse.ts now');
  });

  it('parses each flag with a value', () => {
    const r = parseArgs([
      '--workspace',
      '/tmp/ws',
      '--model',
      'claude',
      '--max-tokens',
      '1000',
      '--max-iterations',
      '50',
      '--max-duration',
      '15m',
      '--budget',
      '0.5',
      '--approval',
      'auto',
      '--output',
      'r.json',
      '--resume',
      't_123',
      '--plan-only',
      '--dry-run',
      'fix',
      'it',
    ]);
    expect(r).toMatchObject({
      workspace: '/tmp/ws',
      model: 'claude',
      maxTokens: 1000,
      maxIterations: 50,
      maxDurationMs: 15 * 60_000,
      budgetUsd: 0.5,
      approval: 'auto',
      output: 'r.json',
      resume: 't_123',
      planOnly: true,
      dryRun: true,
      prompt: 'fix it',
    });
  });

  it('throws on unknown flag', () => {
    expect(() => parseArgs(['--quux'])).toThrow(HarnessError);
  });

  it('throws when a flag is missing its value', () => {
    expect(() => parseArgs(['--workspace'])).toThrow(HarnessError);
  });

  it('throws when --max-tokens is non-positive', () => {
    expect(() => parseArgs(['--max-tokens', '0'])).toThrow(HarnessError);
  });

  it('throws when --approval is invalid', () => {
    expect(() => parseArgs(['--approval', 'oops'])).toThrow(HarnessError);
  });

  it('detects ls subcommand', () => {
    expect(parseArgs(['ls']).listMode).toBe(true);
  });
});

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['10s', 10_000],
    ['2m', 120_000],
    ['1h', 3_600_000],
    ['250', 250],
  ])('parses %s', (raw, expected) => {
    expect(parseDuration(raw)).toBe(expected);
  });

  it('throws on garbage', () => {
    expect(() => parseDuration('foo')).toThrow();
    expect(() => parseDuration('-1m')).toThrow();
  });
});
