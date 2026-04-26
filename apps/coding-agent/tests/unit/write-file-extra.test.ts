import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineWriteFileTool } from '../../src/tools/write_file.js';

let workspace: string;

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-wf-extra-')));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('write_file extra branches', () => {
  it('skips approval gate when ctx.requireApproval is undefined', async () => {
    const tool = defineWriteFileTool({
      workspace,
      dryRun: false,
      maxOutputBytes: 64 * 1024,
      defaultTimeoutMs: 1000,
    });
    const big = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n');
    const r = await tool.execute({ path: 'a.txt', content: big });
    expect(r.kind).toBe('success');
  });

  it('does not pre-create parent dir when createDirs=false', async () => {
    const tool = defineWriteFileTool({
      workspace,
      dryRun: false,
      maxOutputBytes: 64 * 1024,
      defaultTimeoutMs: 1000,
    });
    const r = await tool.execute({
      path: 'nested/missing/a.txt',
      content: 'hi',
      createDirs: false,
    });
    expect(r.kind).toBe('error');
  });
});
