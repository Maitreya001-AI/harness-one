/**
 * Negative-path coverage for the CLI's adapter-construction edge cases.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';

import { main } from '../../src/cli/bin.js';

describe('CLI adapter wiring', () => {
  it('surfaces adapter-factory errors to stderr with non-zero exit', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const errs: string[] = [];
    stderr.on('data', (c: Buffer) => errs.push(c.toString('utf8')));

    const code = await main({
      argv: ['--workspace', '/tmp', '--approval', 'auto', 'do something'],
      env: {},
      stdout,
      stderr,
      adapterFactory: async () => {
        throw new Error('no api key configured');
      },
    });
    expect(code).toBe(1);
    expect(errs.join('')).toContain('no api key configured');
  });

  it('exposes ANTHROPIC_API_KEY to the adapter factory', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let receivedKey: string | undefined;

    const code = await main({
      argv: ['--approval', 'auto', '--plan-only', 'do thing'],
      env: { ANTHROPIC_API_KEY: 'sk-test-12345' },
      stdout,
      stderr,
      adapterFactory: async (_model, apiKey) => {
        receivedKey = apiKey;
        return {
          name: 'noop',
          async chat() {
            return {
              message: { role: 'assistant', content: 'noop' },
              usage: { inputTokens: 0, outputTokens: 0 },
            };
          },
        };
      },
    });
    // plan-only path returns 0; we just want to verify the env was forwarded.
    expect(code).toBe(0);
    expect(receivedKey).toBe('sk-test-12345');
  });
});
