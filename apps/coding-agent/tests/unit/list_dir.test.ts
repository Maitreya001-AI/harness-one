import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineListDirTool } from '../../src/tools/list_dir.js';
import type { ToolContext } from '../../src/tools/context.js';

let workspace: string;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-ld-')));
  await fs.mkdir(path.join(workspace, 'sub'));
  await fs.writeFile(path.join(workspace, 'a.txt'), 'a');
  await fs.writeFile(path.join(workspace, 'b.txt'), 'b');
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return { workspace, dryRun: false, maxOutputBytes: 64 * 1024, defaultTimeoutMs: 1000 };
}

describe('list_dir', () => {
  it('lists entries with kinds', async () => {
    const tool = defineListDirTool(ctx());
    const r = await tool.execute({ path: '.' });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as {
        entries: Array<{ name: string; kind: string }>;
        totalEntries: number;
      };
      const names = data.entries.map((e) => e.name).sort();
      expect(names).toEqual(['a.txt', 'b.txt', 'sub']);
      const sub = data.entries.find((e) => e.name === 'sub');
      expect(sub?.kind).toBe('directory');
    }
  });

  it('returns truncated=true when entries exceed limit', async () => {
    const tool = defineListDirTool(ctx());
    const r = await tool.execute({ path: '.', limit: 1 });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { truncated: boolean; entries: unknown[] };
      expect(data.truncated).toBe(true);
      expect(data.entries).toHaveLength(1);
    }
  });

  it('returns not_found for missing dir', async () => {
    const tool = defineListDirTool(ctx());
    const r = await tool.execute({ path: 'nope' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.category).toBe('not_found');
  });

  it('refuses non-directory targets', async () => {
    const tool = defineListDirTool(ctx());
    const r = await tool.execute({ path: 'a.txt' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.category).toBe('validation');
  });
});
