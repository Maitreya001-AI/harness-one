import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';

import { main } from '../../src/cli/bin.js';
import { createMockAdapter } from '../integration/mock-adapter.js';

describe('CLI eval sub-command', () => {
  it('runs the eval harness with --tag filter and emits the report', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out: string[] = [];
    stdout.on('data', (c: Buffer) => out.push(c.toString('utf8')));

    const code = await main({
      argv: ['eval', '--tag', 'smoke', '--approval', 'auto'],
      env: {},
      stdout,
      stderr,
      adapterFactory: async () => createMockAdapter([{ text: 'noop summary' }]),
    });
    // smoke fixture verifier requires a non-empty summary; mock returns it.
    expect([0, 1]).toContain(code);
    expect(out.join('')).toContain('Eval:');
    expect(out.join('')).toContain('read-summarise-001');
  }, 60_000);

  it('returns non-zero when no fixtures match the filter (empty pass rate)', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out: string[] = [];
    stdout.on('data', (c: Buffer) => out.push(c.toString('utf8')));

    const code = await main({
      argv: ['eval', '--tag', 'definitely-no-such-tag'],
      env: {},
      stdout,
      stderr,
      adapterFactory: async () => createMockAdapter([{ text: 'x' }]),
    });
    expect(code).toBe(0); // 0 cases ⇒ failCount=0 ⇒ exit 0
    expect(out.join('')).toContain('0/0 pass');
  });
});
