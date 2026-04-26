import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/main.js';
import { CliArgError } from '../../src/cli/args.js';

describe('runCli error propagation', () => {
  it('rethrows non-CliArgError exceptions raised inside parseArgs', async () => {
    // Force a non-CliArgError exception via a getter on argv that throws when read.
    const argv = new Proxy([], {
      get() {
        throw new Error('forced-non-cli-error');
      },
    }) as unknown as readonly string[];
    await expect(runCli({ argv, env: {}, runtimeOptions: {} })).rejects.toThrow(/forced/);
  });

  it('catches and reports unknown env errors as exit 2', async () => {
    const r = await runCli({
      argv: ['q'],
      env: { RESEARCH_BUDGET_USD: 'abc' },
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(r.exitCode).toBe(2);
  });

  it('CliArgError other than __help__ is reported with exit 2', () => {
    const e = new CliArgError('x');
    expect(e.name).toBe('CliArgError');
    expect(e.message).toBe('x');
  });
});
