import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  allOf,
  changedFilesEqual,
  fileContains,
} from '../../../src/eval/verifier.js';
import type { TaskResult } from '../../../src/agent/types.js';

let workspace: string;

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-eval-v-')));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

const baseResult: TaskResult = {
  taskId: 't',
  state: 'done',
  summary: '',
  changedFiles: ['src/a.ts', 'src/b.ts'],
  cost: { usd: 0, tokens: 0 },
  iterations: 1,
  durationMs: 0,
  reason: 'completed',
};

describe('fileContains', () => {
  it('passes when content matches', async () => {
    await fs.writeFile(path.join(workspace, 'README.md'), 'hello world\n');
    const verdict = await fileContains('README.md', 'hello')({
      workspace,
      result: baseResult,
    });
    expect(verdict.pass).toBe(true);
  });

  it('fails when content missing', async () => {
    await fs.writeFile(path.join(workspace, 'README.md'), 'goodbye\n');
    const verdict = await fileContains('README.md', 'hello')({
      workspace,
      result: baseResult,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('hello');
  });

  it('fails when file absent', async () => {
    const verdict = await fileContains('missing.md', 'x')({
      workspace,
      result: baseResult,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('unreadable');
  });
});

describe('changedFilesEqual', () => {
  it('passes on exact match (any order)', async () => {
    const verdict = await changedFilesEqual(['src/b.ts', 'src/a.ts'])({
      workspace,
      result: baseResult,
    });
    expect(verdict.pass).toBe(true);
  });

  it('fails on subset', async () => {
    const verdict = await changedFilesEqual(['src/a.ts'])({
      workspace,
      result: baseResult,
    });
    expect(verdict.pass).toBe(false);
  });

  it('fails on different length', async () => {
    const verdict = await changedFilesEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])({
      workspace,
      result: baseResult,
    });
    expect(verdict.pass).toBe(false);
  });
});

describe('allOf', () => {
  it('passes when every verifier passes', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'x');
    const verdict = await allOf(
      fileContains('a.txt', 'x'),
      changedFilesEqual(['src/a.ts', 'src/b.ts']),
    )({ workspace, result: baseResult });
    expect(verdict.pass).toBe(true);
  });

  it('aggregates failures', async () => {
    const verdict = await allOf(
      fileContains('missing.txt', 'x'),
      changedFilesEqual(['nope']),
    )({ workspace, result: baseResult });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('/'); // aggregator joins with " / "
  });
});
