import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineReadFileTool } from '../../src/tools/read_file.js';
import type { ToolContext } from '../../src/tools/context.js';

let workspace: string;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-rf-')));
  await fs.writeFile(path.join(workspace, 'small.txt'), 'hello world');
  await fs.writeFile(path.join(workspace, 'big.txt'), 'x'.repeat(1024));
  await fs.mkdir(path.join(workspace, 'sub'));
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return { workspace, dryRun: false, maxOutputBytes: 64 * 1024, defaultTimeoutMs: 1000 };
}

describe('read_file', () => {
  it('reads small file content', async () => {
    const tool = defineReadFileTool(ctx());
    const r = await tool.execute({ path: 'small.txt' });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { content: string; truncated: boolean };
      expect(data.content).toBe('hello world');
      expect(data.truncated).toBe(false);
    }
  });

  it('truncates when content exceeds maxBytes', async () => {
    const tool = defineReadFileTool(ctx());
    const r = await tool.execute({ path: 'big.txt', maxBytes: 16 });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { content: string; truncated: boolean; bytes: number };
      expect(data.bytes).toBe(16);
      expect(data.truncated).toBe(true);
    }
  });

  it('returns not_found for missing file', async () => {
    const tool = defineReadFileTool(ctx());
    const r = await tool.execute({ path: 'nope.txt' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.error.category).toBe('not_found');
    }
  });

  it('rejects directory path with validation error', async () => {
    const tool = defineReadFileTool(ctx());
    const r = await tool.execute({ path: 'sub' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.error.category).toBe('validation');
    }
  });

  it('throws-then-catches when path escapes the workspace (via tool wrapper)', async () => {
    const tool = defineReadFileTool(ctx());
    const r = await tool.execute({ path: '../outside.txt' });
    // defineTool wraps thrown errors into a structured result.
    expect(r.kind).toBe('error');
  });
});
