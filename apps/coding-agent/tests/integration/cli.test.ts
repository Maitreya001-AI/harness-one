import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { main } from '../../src/cli/bin.js';
import { createMockAdapter } from './mock-adapter.js';

let workspace: string;
let checkpointDir: string;

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-cli-ws-')));
  checkpointDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-cli-cp-')));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(checkpointDir, { recursive: true, force: true });
});

describe('main', () => {
  it('prints help and returns 0 on --help', async () => {
    const stdout = new PassThrough();
    const out: string[] = [];
    stdout.on('data', (c: Buffer) => out.push(c.toString('utf8')));
    const code = await main({
      argv: ['--help'],
      env: {},
      stdout,
      stderr: new PassThrough(),
    });
    expect(code).toBe(0);
    expect(out.join('')).toContain('harness-coding');
  });

  it('prints version on --version', async () => {
    const stdout = new PassThrough();
    const out: string[] = [];
    stdout.on('data', (c: Buffer) => out.push(c.toString('utf8')));
    await main({
      argv: ['--version'],
      env: {},
      stdout,
      stderr: new PassThrough(),
    });
    expect(out.join('')).toMatch(/\d+\.\d+\.\d+/);
  });

  it('returns 64 (EX_USAGE) on invalid flag', async () => {
    const stderr = new PassThrough();
    const code = await main({
      argv: ['--frobnicate'],
      env: {},
      stdout: new PassThrough(),
      stderr,
    });
    expect(code).toBe(64);
  });

  it('runs an end-to-end task with a mock adapter (planOnly)', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out: string[] = [];
    stdout.on('data', (c: Buffer) => out.push(c.toString('utf8')));

    const factory = async () => createMockAdapter([{ text: 'noop' }]);

    const code = await main({
      argv: [
        '--workspace',
        workspace,
        '--approval',
        'auto',
        '--plan-only',
        'plan it',
      ],
      env: { HARNESS_CODING_DIR_OVERRIDE_FOR_TEST: checkpointDir },
      stdout,
      stderr,
      adapterFactory: factory,
    });
    // plan-only finishes with reason=completed
    expect(code).toBe(0);
    expect(out.join('')).toContain('planning');
  });

  it('writes JSON report when --output is given', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const reportPath = path.join(workspace, 'report.json');
    const factory = async () => createMockAdapter([{ text: 'done' }]);
    const code = await main({
      argv: [
        '--workspace',
        workspace,
        '--approval',
        'auto',
        '--plan-only',
        '--output',
        reportPath,
        'plan',
      ],
      env: {},
      stdout,
      stderr,
      adapterFactory: factory,
    });
    expect(code).toBe(0);
    const written = await fs.readFile(reportPath, 'utf8');
    expect(JSON.parse(written).state).toBeDefined();
  });

  it('returns 64 when no prompt and not a sub-command', async () => {
    const code = await main({
      argv: [],
      env: {},
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(code).toBe(64);
  });
});
