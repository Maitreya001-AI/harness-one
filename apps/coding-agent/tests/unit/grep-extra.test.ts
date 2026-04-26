import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineGrepTool } from '../../src/tools/grep.js';

let workspace: string;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-grep-extra-')));
  await fs.mkdir(path.join(workspace, 'src'));
  await fs.writeFile(path.join(workspace, 'src/a.ts'), 'A\nB\nC');
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('grep extra branches', () => {
  it('falls back to default limit when omitted', async () => {
    const tool = defineGrepTool({
      workspace,
      dryRun: false,
      maxOutputBytes: 64 * 1024,
      defaultTimeoutMs: 1000,
    });
    const r = await tool.execute({ pattern: 'A' });
    expect(r.kind).toBe('success');
  });

  it('honours ignoreCase', async () => {
    const tool = defineGrepTool({
      workspace,
      dryRun: false,
      maxOutputBytes: 64 * 1024,
      defaultTimeoutMs: 1000,
    });
    const r = await tool.execute({ pattern: 'a', ignoreCase: true });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { matches: unknown[] };
      expect(data.matches.length).toBeGreaterThan(0);
    }
  });
});
