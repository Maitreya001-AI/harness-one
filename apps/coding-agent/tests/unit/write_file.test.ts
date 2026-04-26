import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeDiffStats,
  defineWriteFileTool,
} from '../../src/tools/write_file.js';
import type { ToolContext } from '../../src/tools/context.js';

let workspace: string;

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-wf-')));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspace,
    dryRun: false,
    maxOutputBytes: 64 * 1024,
    defaultTimeoutMs: 1000,
    ...overrides,
  };
}

describe('computeDiffStats', () => {
  it('counts added when target is empty', () => {
    expect(computeDiffStats('', 'a\nb\nc')).toEqual({ added: 3, removed: 0 });
  });
  it('counts removed when next is empty', () => {
    expect(computeDiffStats('a\nb', '')).toEqual({ added: 0, removed: 2 });
  });
  it('counts both add+remove on full replacement', () => {
    expect(computeDiffStats('a\nb', 'c\nd')).toEqual({ added: 2, removed: 2 });
  });
  it('returns zeros on identical content', () => {
    expect(computeDiffStats('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
  });
});

describe('write_file', () => {
  it('writes new file and records change', async () => {
    const changed: string[] = [];
    const tool = defineWriteFileTool(
      ctx({ recordChangedFile: (p) => changed.push(p) }),
    );
    const r = await tool.execute({ path: 'a.txt', content: 'hi' });
    expect(r.kind).toBe('success');
    expect(changed).toEqual(['a.txt']);
    expect(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('hi');
  });

  it('overwrites existing file atomically', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'old');
    const tool = defineWriteFileTool(ctx());
    const r = await tool.execute({ path: 'a.txt', content: 'new' });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { preExisted: boolean };
      expect(data.preExisted).toBe(true);
    }
    expect(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('new');
  });

  it('does not write in dry-run mode', async () => {
    const tool = defineWriteFileTool(ctx({ dryRun: true }));
    const r = await tool.execute({ path: 'a.txt', content: 'hi' });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { dryRun: boolean };
      expect(data.dryRun).toBe(true);
    }
    await expect(fs.access(path.join(workspace, 'a.txt'))).rejects.toThrow();
  });

  it('creates parent directories by default', async () => {
    const tool = defineWriteFileTool(ctx());
    const r = await tool.execute({ path: 'nested/deep/a.txt', content: 'hi' });
    expect(r.kind).toBe('success');
    expect(await fs.readFile(path.join(workspace, 'nested/deep/a.txt'), 'utf8')).toBe('hi');
  });

  it('asks approval for large diffs and respects deny', async () => {
    await fs.writeFile(
      path.join(workspace, 'a.txt'),
      Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n'),
    );
    const calls: unknown[] = [];
    const tool = defineWriteFileTool(
      ctx({
        requireApproval: async (req) => {
          calls.push(req);
          return { allow: false, reason: 'too big' };
        },
      }),
    );
    const r = await tool.execute({
      path: 'a.txt',
      content: Array.from({ length: 200 }, (_, i) => `replaced${i}`).join('\n'),
    });
    expect(calls).toHaveLength(1);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.category).toBe('permission');
  });

  it('asks approval for large diffs and proceeds when allowed', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), '');
    const tool = defineWriteFileTool(
      ctx({
        requireApproval: async () => ({ allow: true }),
      }),
    );
    const big = Array.from({ length: 150 }, (_, i) => `l${i}`).join('\n');
    const r = await tool.execute({ path: 'a.txt', content: big });
    expect(r.kind).toBe('success');
  });

  it('rejects sensitive paths via the path layer', async () => {
    const tool = defineWriteFileTool(ctx());
    const r = await tool.execute({ path: '.env', content: 'SECRET=1' });
    expect(r.kind).toBe('error');
  });

  it('refuses workspace-escape paths', async () => {
    const tool = defineWriteFileTool(ctx());
    const r = await tool.execute({ path: '../escape.txt', content: 'x' });
    expect(r.kind).toBe('error');
  });
});
